import { Logger } from '@nestjs/common';
import axios, { type AxiosInstance } from 'axios';
import { REQUEST_TIMEOUT_MS } from '../common/http';
import { Account, Connector, PaymentData, ServiceData } from '../connector.interface';
import {
  billedByUuid,
  mapProcloudPayments,
  mapProcloudServer,
  money,
  nextMarker,
  projectNameOf,
} from './procloud.mapper';
import {
  KeystoneService,
  NovaServer,
  NovaServersPage,
  PROCLOUD_CURRENCY,
  PROCLOUD_DEFAULT_IDENTITY_URL,
  PROCLOUD_KEYCLOAK_CLIENT_ID,
  PROCLOUD_PANEL_URL,
  PROCLOUD_REGIONS,
  PROCLOUD_TOKEN_URL,
  ProcloudAccount,
  ProcloudActiveBilling,
  ProcloudBilling,
  ProcloudBillingSummary,
  ProcloudBilledItem,
  ProcloudCredentials,
  ProcloudHistoryEntry,
  ProcloudRegion,
} from './procloud.types';

// The panel lists servers in pages of 300 as well.
const PAGE_SIZE = 300;

/** Panel session: the Keycloak access token and the account (contract) it bills. */
interface PanelSession {
  accessToken: string;
  account: ProcloudAccount;
}

/** The panel refused the email/password: the owner has to fix the credentials. */
class SignInRejected extends Error {}

function pathOf(url: string | undefined): string {
  try {
    return url ? new URL(url).pathname : '';
  } catch {
    return url ?? '';
  }
}

/**
 * ProCloud connector. ProCloud is a white-label of 3HCloud, so the cloud side is plain OpenStack:
 * Keystone v3 password auth (token in the `X-Subject-Token` header) and Nova `servers/detail`.
 * Every location runs its own Keystone and gets its own API user, so one provider covers one
 * location and its identity URL is picked from an allowlist — the password never leaves it.
 *
 * Nova has no price and ProCloud publishes no plan catalog, so the balance, the monthly prices and
 * the ledger come from the billing panel behind a Keycloak password grant (email + password of the
 * website sign-in). Without those the account reports no balance and servers sync unpriced.
 */
export class ProcloudConnector implements Connector {
  private readonly logger = new Logger(ProcloudConnector.name);
  private readonly http: AxiosInstance;
  private readonly identityUrl: string;
  private readonly region: ProcloudRegion;
  private readonly creds: ProcloudCredentials;
  private token: string | null = null;
  private computeUrl: string | null = null;
  private panel: Promise<PanelSession | null> | null = null;

  constructor(creds: ProcloudCredentials) {
    const identityUrl = (creds.baseUrl ?? PROCLOUD_DEFAULT_IDENTITY_URL).replace(/\/+$/, '');
    const region = PROCLOUD_REGIONS[identityUrl];
    if (!region) {
      throw new Error(`ProCloud: unsupported identity URL (${Object.keys(PROCLOUD_REGIONS)[0]}…)`);
    }
    this.identityUrl = identityUrl;
    this.region = region;
    this.creds = creds;
    // Neither API legitimately redirects; refuse rather than re-send the token elsewhere.
    this.http = axios.create({ timeout: REQUEST_TIMEOUT_MS, maxRedirects: 0 });
    this.http.interceptors.response.use(undefined, (e) => {
      // Never rethrow the AxiosError itself: its config carries the token or the password, and
      // sync errors end up in logs/DB. Keep only the status and the path.
      if (axios.isAxiosError(e)) {
        const status = e.response?.status;
        throw new Error(
          `ProCloud: ${status ? `HTTP ${status}` : e.message} ${pathOf(e.config?.url)}`,
        );
      }
      throw e;
    });
  }

  kind(): string {
    return 'procloud';
  }

  async fetchAccount(signal: AbortSignal): Promise<Account> {
    const session = await this.panelSession(signal);
    if (!session) return { balance: null, currency: PROCLOUD_CURRENCY };
    const billing = await this.panelGet<ProcloudBilling>(
      session,
      '/api/billing',
      { accountId: session.account.id },
      signal,
    );
    // The account page is authoritative; the dashboard summary is the fallback.
    const balance =
      money(billing?.balance) ??
      money(
        (
          await this.panelGet<ProcloudBillingSummary>(
            session,
            '/api/dashboard/billing',
            undefined,
            signal,
          )
        )?.balance,
      );
    return { balance: balance ?? null, currency: PROCLOUD_CURRENCY };
  }

  async fetchServices(signal: AbortSignal): Promise<ServiceData[]> {
    const token = await this.keystone(signal);
    const servers = await this.listServers(token, signal);
    const billed = await this.billedItems(signal);
    return servers.map((s) =>
      mapProcloudServer(s, this.region, billed.get(s.id), PROCLOUD_CURRENCY),
    );
  }

  /** Payments and invoices of the account; needs the panel sign-in. */
  async fetchPayments(signal: AbortSignal): Promise<PaymentData[]> {
    const session = await this.panelSession(signal);
    if (!session) return [];
    const rows = await this.panelGet<ProcloudHistoryEntry[]>(
      session,
      '/api/billing/history',
      { accountId: session.account.id },
      signal,
    );
    return mapProcloudPayments(Array.isArray(rows) ? rows : [], PROCLOUD_CURRENCY);
  }

  /**
   * Panel session, opened once per sync and shared by the balance, the prices and the ledger: the
   * Keycloak password grant rate-limits, so a phase retry must not sign in again — the promise,
   * rejection included, is kept for the connector's lifetime. Rejected credentials fail the sync;
   * anything else (rate limit, outage) only costs this run its balance and prices.
   */
  private panelSession(signal: AbortSignal): Promise<PanelSession | null> {
    if (!this.creds.email || !this.creds.webPassword) return Promise.resolve(null);
    this.panel ??= this.signIn(signal).catch((e) => {
      if (signal.aborted || e instanceof SignInRejected) throw e;
      const reason = e instanceof Error ? e.message : String(e);
      this.logger.warn(`ProCloud: panel sign-in unavailable, no balance this run: ${reason}`);
      return null;
    });
    return this.panel;
  }

  private async signIn(signal: AbortSignal): Promise<PanelSession> {
    const form = new URLSearchParams({
      client_id: PROCLOUD_KEYCLOAK_CLIENT_ID,
      grant_type: 'password',
      username: this.creds.email as string,
      password: this.creds.webPassword as string,
    });
    const res = await this.http.post(PROCLOUD_TOKEN_URL, form.toString(), {
      signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      validateStatus: () => true,
    });
    const body = (res.data ?? {}) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };
    if (res.status >= 400 || !body.access_token) {
      const reason =
        body.error_description || body.error || (res.status ? `HTTP ${res.status}` : 'no token');
      // Keycloak answers 401/400 with `invalid_grant` to a wrong password; anything else (5xx, a
      // challenge) says nothing about the credentials.
      if (res.status === 400 || res.status === 401) {
        throw new SignInRejected(`ProCloud: panel sign-in rejected — ${reason}`);
      }
      throw new Error(`ProCloud: panel sign-in failed — ${reason}`);
    }

    const accessToken = String(body.access_token);
    const accounts = await this.panelGet<ProcloudAccount[]>(
      { accessToken, account: {} },
      '/api/account',
      undefined,
      signal,
    );
    const list = (Array.isArray(accounts) ? accounts : []).filter((a) => a.externalId || a.id);
    if (list.length === 0) throw new Error('ProCloud: panel returned no account');
    if (list.length > 1) {
      this.logger.warn(
        `ProCloud: the panel user holds ${list.length} accounts, syncing the first one (${list[0].dognum ?? list[0].externalId})`,
      );
    }
    return { accessToken, account: list[0] };
  }

  private async panelGet<T>(
    session: PanelSession,
    path: string,
    params: Record<string, unknown> | undefined,
    signal: AbortSignal,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${session.accessToken}`,
    };
    // The panel selects the billed account with this header on every call.
    if (session.account.externalId) headers['X-Account-Id'] = String(session.account.externalId);
    const { data } = await this.http.get<T>(`${PROCLOUD_PANEL_URL}${path}`, {
      signal,
      headers,
      params,
    });
    return data;
  }

  /**
   * Billed resources of the account, keyed by the OpenStack id they bill for. Best-effort: without
   * the panel (or without a sign-in) servers stay unpriced and the sync keeps their cost.
   */
  private async billedItems(signal: AbortSignal): Promise<Map<string, ProcloudBilledItem>> {
    try {
      const session = await this.panelSession(signal);
      if (!session?.account.externalId) return new Map();
      const data = await this.panelGet<ProcloudActiveBilling>(
        session,
        '/api/billing/active',
        { contractId: session.account.externalId },
        signal,
      );
      const items = (data?.groups ?? []).flatMap((g) => g.items ?? []);
      return billedByUuid(items);
    } catch (e) {
      if (signal.aborted) throw e;
      // Best-effort even for rejected credentials: the servers are worth syncing unpriced, and the
      // balance phase reports the rejection.
      const reason = e instanceof Error ? e.message : String(e);
      this.logger.warn(
        `ProCloud: billed resources unavailable, servers keep their cost: ${reason}`,
      );
      return new Map();
    }
  }

  /**
   * Project-scoped Keystone token, cached for the connector's lifetime (one sync). The RC file's
   * auth URL is the bare host, so the v3 path is not known: the panel's deployments answer under
   * `/v3`, and `/identity/v3` is tried when that path is not served.
   */
  private async keystone(signal: AbortSignal): Promise<string> {
    if (this.token) return this.token;
    const { username, password } = this.creds;
    const projectName = this.creds.projectName || projectNameOf(username);
    const body = {
      auth: {
        identity: {
          methods: ['password'],
          password: { user: { name: username, domain: { name: 'Default' }, password } },
        },
        // The API user is scoped to the account's project, not to its own name.
        scope: { project: { name: projectName, domain: { name: 'Default' } } },
      },
    };
    let lastStatus = 0;
    for (const path of ['/v3/auth/tokens', '/identity/v3/auth/tokens']) {
      const res = await this.http.post(`${this.identityUrl}${path}`, body, {
        signal,
        validateStatus: () => true,
      });
      if (res.status === 404) {
        lastStatus = res.status;
        continue;
      }
      if (res.status === 401) {
        throw new Error(
          'ProCloud: invalid OpenStack login, password or project (panel → API access)',
        );
      }
      if (res.status >= 400) {
        throw new Error(`ProCloud: authorization failed (HTTP ${res.status})`);
      }
      const token = res.headers['x-subject-token'];
      if (!token) throw new Error('ProCloud: token was not obtained (no X-Subject-Token header)');
      this.token = String(token);
      this.computeUrl = this.computeFromCatalog(
        (res.data?.token?.catalog ?? []) as KeystoneService[],
      );
      return this.token;
    }
    throw new Error(
      `ProCloud: no Keystone v3 endpoint at ${this.identityUrl} (HTTP ${lastStatus || 'n/a'})`,
    );
  }

  /**
   * Nova endpoint from the token catalog, restricted to this location's region and to the
   * allowlisted host — a catalog entry pointing elsewhere would leak the token.
   */
  private computeFromCatalog(services: KeystoneService[]): string | null {
    const endpoints = services
      .filter((s) => s.type === 'compute')
      .flatMap((s) => s.endpoints ?? [])
      .filter((e) => (e.interface ?? 'public') === 'public');
    const wanted = endpoints.find((e) => (e.region_id ?? e.region) === this.region.region);
    for (const endpoint of [wanted, ...endpoints]) {
      if (!endpoint?.url) continue;
      const host = this.hostOf(endpoint.url);
      if (host && host === new URL(this.region.compute).host) return this.region.compute;
    }
    return null;
  }

  private hostOf(url: string): string | null {
    try {
      return new URL(url).host;
    } catch {
      return null;
    }
  }

  private async listServers(token: string, signal: AbortSignal): Promise<NovaServer[]> {
    const base = this.computeUrl ?? this.region.compute;
    const url = `${base}/compute/v2.1/servers/detail`;
    const servers: NovaServer[] = [];
    let marker: string | undefined;
    do {
      const { data } = await this.http.get<NovaServersPage>(url, {
        signal,
        headers: { 'X-Auth-Token': token },
        params: marker ? { limit: PAGE_SIZE, marker } : { limit: PAGE_SIZE },
      });
      servers.push(...(data.servers ?? []));
      const next = nextMarker(data.servers_links);
      marker = next && next !== marker ? next : undefined;
    } while (marker);
    return servers;
  }
}

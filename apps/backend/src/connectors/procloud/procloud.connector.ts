import { Logger } from '@nestjs/common';
import axios, { type AxiosInstance } from 'axios';
import { createHttp, REQUEST_TIMEOUT_MS } from '../common/http';
import { Account, Connector, PaymentData, ServiceData } from '../connector.interface';
import {
  mapProcloudBilledItem,
  mapProcloudPayments,
  mapProcloudServer,
  money,
  splitBilledItems,
} from './procloud.mapper';
import {
  PROCLOUD_CURRENCY,
  PROCLOUD_KEYCLOAK_CLIENT_ID,
  PROCLOUD_PANEL_URL,
  PROCLOUD_TOKEN_URL,
  ProcloudAccount,
  ProcloudActiveBilling,
  ProcloudBilling,
  ProcloudBillingSummary,
  ProcloudBilledItem,
  ProcloudCredentials,
  ProcloudHistoryEntry,
  ProcloudServersPage,
} from './procloud.types';

/** Panel session: the Keycloak access token and the account (contract) it bills. */
interface PanelSession {
  accessToken: string;
  account: ProcloudAccount;
  /** Contract id (`externalId`) the panel selects with `X-Account-Id`. */
  accountId: string;
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
 * ProCloud connector, built on the customer panel (my.procloud.ru).
 *
 * ProCloud is a white-label of 3HCloud and does publish a per-location OpenStack cloud, but those
 * clouds are useless on their own: Nova has no price, ProCloud publishes no plan catalog, and every
 * location needs its own API user — so one provider could only ever see one location and could
 * never say what it costs. The panel exposes all locations at once, with the prices, the balance and
 * the ledger, so it is the only source the connector uses. It signs in with the website credentials
 * through the realm's password grant and reads the same JSON the SPA does.
 *
 * Every data call needs the contract twice: as the `X-Account-Id` header and as an `accountId` (or
 * `contractId`) parameter. Which form the id takes differs per endpoint — the contract number for
 * the resource and billing calls, the panel's internal uuid for the ledger — so both are kept.
 */
export class ProcloudConnector implements Connector {
  private readonly logger = new Logger(ProcloudConnector.name);
  private readonly http: AxiosInstance;
  private readonly creds: ProcloudCredentials;
  private panel: Promise<PanelSession> | null = null;

  constructor(creds: ProcloudCredentials) {
    if (!creds.email || !creds.webPassword) {
      throw new Error('ProCloud: the panel email and password are required');
    }
    this.creds = creds;
    // Neither API legitimately redirects; refuse rather than re-send the token elsewhere.
    this.http = createHttp({ timeout: REQUEST_TIMEOUT_MS, maxRedirects: 0 });
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
    const billing = await this.panelGet<ProcloudBilling>(
      session,
      '/api/billing',
      { accountId: session.accountId },
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
            { accountId: session.accountId },
            signal,
          )
        )?.balance,
      );
    return { balance: balance ?? null, currency: PROCLOUD_CURRENCY };
  }

  /**
   * Servers of every location, priced by the account's active billing. Resources the panel bills
   * without a server row (extra IP addresses, standalone disks) are synced as services of their
   * own — leaving them out would make the services add up to less than the panel's total.
   */
  async fetchServices(signal: AbortSignal): Promise<ServiceData[]> {
    const session = await this.panelSession(signal);
    const [page, billed] = await Promise.all([
      this.panelGet<ProcloudServersPage>(
        session,
        '/api/server',
        { accountId: session.accountId },
        signal,
      ),
      this.billedItems(session, signal),
    ]);
    const servers = (page?.items ?? []).filter((s) => s?.id);
    const { byServer, standalone } = splitBilledItems(
      billed,
      new Set(servers.map((s) => String(s.id))),
    );
    if (page?.failedRegions?.length) {
      this.logger.warn(
        `ProCloud: ${page.failedRegions.length} location(s) did not answer, the list may be incomplete`,
      );
    }
    const services: ServiceData[] = servers.map((s) =>
      mapProcloudServer(s, byServer.get(String(s.id)), PROCLOUD_CURRENCY),
    );
    for (const item of standalone) {
      const service = mapProcloudBilledItem(item, PROCLOUD_CURRENCY);
      // A billed resource without a price is nothing to track; the ledger still shows its charge.
      if (service?.cost) services.push(service);
    }
    return services;
  }

  /** Payments and invoices of the account. */
  async fetchPayments(signal: AbortSignal): Promise<PaymentData[]> {
    const session = await this.panelSession(signal);
    // The ledger is the one endpoint keyed by the panel's internal uuid rather than the contract id.
    const rows = await this.panelGet<ProcloudHistoryEntry[]>(
      session,
      '/api/billing/history',
      { accountId: session.account.id ?? session.accountId },
      signal,
    );
    return mapProcloudPayments(Array.isArray(rows) ? rows : [], PROCLOUD_CURRENCY);
  }

  /**
   * Panel session, opened once per sync and shared by every phase: the Keycloak password grant
   * rate-limits, so a phase retry must not sign in again — the promise, rejection included, is kept
   * for the connector's lifetime. Rejected credentials fail the sync, since without the panel there
   * is nothing to sync at all.
   */
  private panelSession(signal: AbortSignal): Promise<PanelSession> {
    this.panel ??= this.signIn(signal);
    return this.panel;
  }

  private async signIn(signal: AbortSignal): Promise<PanelSession> {
    const form = new URLSearchParams({
      client_id: PROCLOUD_KEYCLOAK_CLIENT_ID,
      grant_type: 'password',
      username: this.creds.email,
      password: this.creds.webPassword,
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
      { accessToken, account: {}, accountId: '' },
      '/api/account',
      undefined,
      signal,
    );
    const list = (Array.isArray(accounts) ? accounts : []).filter((a) => a.externalId || a.id);
    if (list.length === 0) throw new Error('ProCloud: the panel account has no contract');
    if (list.length > 1) {
      this.logger.warn(
        `ProCloud: the panel user holds ${list.length} contracts, syncing the first one (${list[0].dognum ?? list[0].externalId})`,
      );
    }
    const account = list[0];
    const accountId = String(account.externalId ?? account.id);
    return { accessToken, account, accountId };
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
    // The panel selects the billed contract with this header on every call.
    if (session.accountId) headers['X-Account-Id'] = session.accountId;
    const { data } = await this.http.get<T>(`${PROCLOUD_PANEL_URL}${path}`, {
      signal,
      headers,
      params,
    });
    return data;
  }

  /** Resources the contract is billed for this month, servers and everything else alike. */
  private async billedItems(
    session: PanelSession,
    signal: AbortSignal,
  ): Promise<ProcloudBilledItem[]> {
    const data = await this.panelGet<ProcloudActiveBilling>(
      session,
      '/api/billing/active',
      { contractId: session.accountId },
      signal,
    );
    if (!data?.groups) throw new Error('ProCloud: unexpected /api/billing/active response');
    return (data.groups ?? []).flatMap((g) => g.items ?? []);
  }
}

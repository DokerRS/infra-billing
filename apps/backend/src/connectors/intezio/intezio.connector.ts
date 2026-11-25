import { Logger } from '@nestjs/common';
import axios, { type AxiosInstance } from 'axios';
import { REQUEST_TIMEOUT_MS } from '../common/http';
import { Account, Connector, PaymentData, ServiceData } from '../connector.interface';
import { mapIntezioPayments, mapIntezioService, money } from './intezio.mapper';
import {
  INTEZIO_CURRENCY,
  INTEZIO_PANEL_URL,
  IntezioCredentials,
  IntezioPayment,
  IntezioService,
  IntezioUser,
  describeIntezioShape,
} from './intezio.types';

/** The refused-credentials case, which has to fail the sync instead of being retried. */
class SignInRejected extends Error {}

function storeCookies(jar: Map<string, string>, setCookie: unknown): void {
  for (const line of Array.isArray(setCookie) ? setCookie : []) {
    const pair = String(line).split(';', 1)[0];
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}

function cookieHeader(jar: Map<string, string>): string {
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * Intezio (https://intezio.net) connector, built on the customer cabinet.
 *
 * Intezio publishes no public API — the Nuxt cabinet is the only programmatic surface, and it is a
 * plain cookie session: `POST /api/auth/login` sets `access_token`, and every `/api` call then
 * answers with the `{ code, data }` envelope the page renders. The site sits behind DDoS-Guard,
 * whose clearance cookies arrive on the same response, so the whole jar is kept and re-sent rather
 * than only the session cookie.
 *
 * `/api/auth/me` carries the balance, `/api/services/user` the servers with their monthly cost and
 * `/api/pay/list` the whole balance history, which is what `fetchPayments` reads.
 */
export class IntezioConnector implements Connector {
  private readonly logger = new Logger(IntezioConnector.name);
  private readonly http: AxiosInstance;
  private readonly creds: IntezioCredentials;
  private readonly cookies = new Map<string, string>();
  private signIn: Promise<void> | null = null;

  constructor(creds: IntezioCredentials) {
    if (!creds.email || !creds.webPassword) {
      throw new Error('Intezio: the cabinet email and password are required');
    }
    this.creds = creds;
    this.http = axios.create({
      baseURL: INTEZIO_PANEL_URL,
      timeout: REQUEST_TIMEOUT_MS,
      maxRedirects: 0,
      headers: { Accept: 'application/json', 'User-Agent': 'infra-billing/1.0' },
    });
    // Never rethrow the AxiosError itself: its config carries the password, and sync errors end up
    // in the logs and the database.
    this.http.interceptors.response.use(undefined, (e) => {
      if (axios.isAxiosError(e)) {
        const status = e.response?.status;
        throw new Error(`Intezio: ${status ? `HTTP ${status}` : e.message} ${e.config?.url ?? ''}`);
      }
      throw e;
    });
  }

  kind(): string {
    return 'intezio';
  }

  async fetchAccount(signal: AbortSignal): Promise<Account> {
    const user = await this.get<IntezioUser>('/api/auth/me', signal);
    if (!user || user.balance === undefined) {
      throw new Error(`Intezio: unexpected /api/auth/me response (${describeIntezioShape(user)})`);
    }
    return { balance: money(user.balance) ?? null, currency: INTEZIO_CURRENCY };
  }

  async fetchServices(signal: AbortSignal): Promise<ServiceData[]> {
    const services: ServiceData[] = [];
    for (const s of await this.serviceRows(signal)) {
      const service = s ? mapIntezioService(s, INTEZIO_CURRENCY) : null;
      if (service) services.push(service);
    }
    return services;
  }

  /**
   * The ledger is keyed by the server's short name in the description, so the orders are read too
   * in order to resolve those names to service ids. A row whose server was since deleted simply
   * stays unlinked.
   */
  async fetchPayments(signal: AbortSignal): Promise<PaymentData[]> {
    const rows = await this.get<IntezioPayment[]>('/api/pay/list', signal);
    if (!Array.isArray(rows)) {
      throw new Error(`Intezio: unexpected /api/pay/list response (${describeIntezioShape(rows)})`);
    }
    const serviceIdsByName = new Map<string, string>();
    for (const s of await this.serviceRows(signal)) {
      const name = s?.name?.trim().toLowerCase();
      if (name && s.id !== undefined && s.id !== null) serviceIdsByName.set(name, String(s.id));
    }
    return mapIntezioPayments(rows, INTEZIO_CURRENCY, serviceIdsByName);
  }

  private async serviceRows(signal: AbortSignal): Promise<IntezioService[]> {
    const rows = await this.get<IntezioService[]>('/api/services/user', signal);
    if (!Array.isArray(rows)) {
      throw new Error(
        `Intezio: unexpected /api/services/user response (${describeIntezioShape(rows)})`,
      );
    }
    return rows;
  }

  /** GET with the session cookie, signing in first and retrying once on an expired session. */
  private async get<T>(path: string, signal: AbortSignal): Promise<T> {
    await this.session(signal);
    let res = await this.raw(path, signal);
    if (res.status === 401) {
      this.cookies.clear();
      this.signIn = null;
      await this.session(signal);
      res = await this.raw(path, signal);
    }
    if (res.status >= 400) throw new Error(`Intezio: HTTP ${res.status} ${path}`);
    // The cabinet answers 200 with an error code when the cookie was accepted but has no user
    // behind it, so the envelope is unwrapped rather than trusted.
    const envelope = res.data as { code?: string; data?: unknown } | null;
    if (envelope && typeof envelope === 'object' && 'code' in envelope) {
      const code = String(envelope.code ?? '');
      if (!code.endsWith('.ok')) throw new Error(`Intezio: ${code || 'request failed'} (${path})`);
      return envelope.data as T;
    }
    return res.data as T;
  }

  private raw(path: string, signal: AbortSignal) {
    const headers: Record<string, string> = {};
    if (this.cookies.size) headers.Cookie = cookieHeader(this.cookies);
    return this.http.get(path, { signal, headers, validateStatus: () => true });
  }

  /**
   * Session cookie, opened once per sync: the login is the only credentialed call, so a phase retry
   * must not sign in again. Rejected credentials fail the sync — without a session there is nothing
   * to read at all.
   */
  private session(signal: AbortSignal): Promise<void> {
    this.signIn ??= this.signInNow(signal).catch((e) => {
      // Only a failed sign-in is dropped from the cache, so a later call can retry after a blip.
      this.signIn = null;
      throw e;
    });
    return this.signIn;
  }

  private async signInNow(signal: AbortSignal): Promise<void> {
    const res = await this.http.post(
      '/api/auth/login',
      { email: this.creds.email, password: this.creds.webPassword },
      {
        signal,
        headers: { 'Content-Type': 'application/json' },
        validateStatus: () => true,
      },
    );
    storeCookies(this.cookies, res.headers['set-cookie']);
    const body = (res.data ?? {}) as { code?: string; message?: string };
    const code = String(body.code ?? '');
    if (res.status === 401 || res.status === 403 || code.includes('err')) {
      throw new SignInRejected(
        `Intezio: cabinet sign-in rejected — ${body.message || code || `HTTP ${res.status}`}`,
      );
    }
    if (res.status >= 400 || !this.cookies.has('access_token')) {
      throw new Error(
        `Intezio: cabinet sign-in failed (HTTP ${res.status}${
          this.cookies.has('access_token') ? '' : ', no session cookie'
        })`,
      );
    }
    this.logger.log('Intezio: cabinet session opened');
  }
}

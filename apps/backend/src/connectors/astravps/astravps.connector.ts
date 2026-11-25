import { Logger } from '@nestjs/common';
import axios, { type AxiosInstance } from 'axios';
import { REQUEST_TIMEOUT_MS } from '../common/http';
import { Account, Connector, PaymentData, ServiceData } from '../connector.interface';
import { mapAstravpsPayments, mapAstravpsService, money } from './astravps.mapper';
import {
  ASTRAVPS_CURRENCY,
  ASTRAVPS_PANEL_URL,
  AstravpsCredentials,
  AstravpsOperation,
  AstravpsService,
  AstravpsUser,
  describeAstravpsShape,
} from './astravps.types';

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
 * AstraVPS (https://astravps.co) connector, built on the customer cabinet.
 *
 * AstraVPS publishes no public API — the cabinet at astravps.co is the only programmatic surface,
 * and it is a plain cookie session: `POST /api/auth/login` sets `astra_session`, and every `/api`
 * call then answers with the JSON the page renders. So the connector signs in the way the site does
 * and reads `/api/me` (the balance), `/api/services` (servers with their monthly price, expiry and
 * location) and `/api/operations` (the balance ledger).
 *
 * The session is opened once per sync and re-opened once if a call comes back 401, since the panel
 * expires an idle session without warning.
 */
export class AstravpsConnector implements Connector {
  private readonly logger = new Logger(AstravpsConnector.name);
  private readonly http: AxiosInstance;
  private readonly creds: AstravpsCredentials;
  private readonly cookies = new Map<string, string>();
  private signIn: Promise<void> | null = null;

  constructor(creds: AstravpsCredentials) {
    if (!creds.email || !creds.webPassword) {
      throw new Error('AstraVPS: the cabinet email and password are required');
    }
    this.creds = creds;
    this.http = axios.create({
      baseURL: ASTRAVPS_PANEL_URL,
      timeout: REQUEST_TIMEOUT_MS,
      maxRedirects: 0,
      headers: { Accept: 'application/json', 'User-Agent': 'infra-billing/1.0' },
    });
    // Never rethrow the AxiosError itself: its config carries the password, and sync errors end up
    // in the logs and the database.
    this.http.interceptors.response.use(undefined, (e) => {
      if (axios.isAxiosError(e)) {
        const status = e.response?.status;
        throw new Error(
          `AstraVPS: ${status ? `HTTP ${status}` : e.message} ${e.config?.url ?? ''}`,
        );
      }
      throw e;
    });
  }

  kind(): string {
    return 'astravps';
  }

  async fetchAccount(signal: AbortSignal): Promise<Account> {
    const data = await this.get<{ user?: AstravpsUser }>('/api/me', signal);
    const user = data?.user;
    if (!user || user.balance === undefined) {
      throw new Error(`AstraVPS: unexpected /api/me response (${describeAstravpsShape(data)})`);
    }
    return { balance: money(user.balance) ?? null, currency: ASTRAVPS_CURRENCY };
  }

  async fetchServices(signal: AbortSignal): Promise<ServiceData[]> {
    const data = await this.get<{ services?: AstravpsService[] }>('/api/services', signal);
    if (!Array.isArray(data?.services)) {
      throw new Error(
        `AstraVPS: unexpected /api/services response (${describeAstravpsShape(data)})`,
      );
    }
    const services: ServiceData[] = [];
    for (const s of data.services) {
      const service = s ? mapAstravpsService(s, ASTRAVPS_CURRENCY) : null;
      if (service) services.push(service);
    }
    return services;
  }

  async fetchPayments(signal: AbortSignal): Promise<PaymentData[]> {
    const data = await this.get<{ operations?: AstravpsOperation[] }>('/api/operations', signal);
    if (!Array.isArray(data?.operations)) {
      throw new Error(
        `AstraVPS: unexpected /api/operations response (${describeAstravpsShape(data)})`,
      );
    }
    return mapAstravpsPayments(data.operations, ASTRAVPS_CURRENCY);
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
    if (res.status >= 400) throw new Error(`AstraVPS: HTTP ${res.status} ${path}`);
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
      { login: this.creds.email, password: this.creds.webPassword },
      {
        signal,
        headers: { 'Content-Type': 'application/json' },
        validateStatus: () => true,
      },
    );
    storeCookies(this.cookies, res.headers['set-cookie']);
    const body = (res.data ?? {}) as { ok?: boolean; error?: string };
    if (res.status === 401 || res.status === 403 || body.ok === false) {
      throw new SignInRejected(
        `AstraVPS: cabinet sign-in rejected — ${body.error || `HTTP ${res.status}`}`,
      );
    }
    if (res.status >= 400 || this.cookies.size === 0) {
      throw new Error(
        `AstraVPS: cabinet sign-in failed (HTTP ${res.status}${
          this.cookies.size ? '' : ', no session cookie'
        })`,
      );
    }
    this.logger.log('AstraVPS: cabinet session opened');
  }
}

import axios, { type AxiosInstance } from 'axios';
import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { normalizeCurrency } from '../common/currency';
import { createHttp, REQUEST_TIMEOUT_MS } from '../common/http';
import { Account, Connector, PaymentData, ServiceData } from '../connector.interface';
import {
  mapOvhBill,
  mapOvhMovement,
  mapOvhService,
  ovhPriceValue,
  OVH_FALLBACK_CURRENCY,
} from './ovh.mapper';
import {
  isOvhEndpoint,
  ovhAccountDetailsSchema,
  ovhBalanceSchema,
  ovhBillIdListSchema,
  ovhBillSchema,
  ovhErrorSchema,
  ovhIdListSchema,
  ovhMovementSchema,
  ovhServiceSchema,
  OVH_DEFAULT_ENDPOINT,
  type OvhCredentials,
} from './ovh.types';

/**
 * OVHcloud connector. API v1 (https://api.ovh.com/1.0), no SDK: a thin axios client that signs
 * every request with the application key / application secret / consumer key trio created at
 * https://api.ovhcloud.com/createToken/.
 *
 * Signing is the whole trick. `X-Ovh-Signature` is `$1$` + sha1 of
 * `appSecret+consumerKey+METHOD+fullUrlWithQuery+body+timestamp`, so the URL that gets signed must
 * be byte-identical to the one actually fetched (query strings are therefore built here rather
 * than serialised by axios) and the timestamp must be close to OVH's clock — hence the `/auth/time`
 * drift correction done once per sync.
 *
 * v1 has no pagination: list endpoints return every id at once. The cost is a fan-out of
 * `1 + N_services + N_bills + N_movements` GETs, bounded by the caps below and spread over a small
 * pool behind a throttle to stay clear of OVH's per-IP rate limits.
 */

/** Minimum spacing between two requests, whatever the pool does. ~8 req/s. */
const THROTTLE_MS = 125;
/** Details are fetched a few at a time; a sync has a 120 s budget to spend. */
const CONCURRENCY = 4;
/** Newest ledger rows kept per sync. Older history is already in the database once imported. */
const MAX_BILLS = 60;
const MAX_MOVEMENTS = 120;
/** How far back the ledger is asked for. */
const LEDGER_WINDOW_DAYS = 400;
/** OVH hands out prepaid accounts; the first two are enough (a reseller's are noise). */
const MAX_BALANCE_ACCOUNTS = 2;

/** What a 403 tells the operator to do about it. */
const OVH_RIGHTS_HINT =
  '; the consumer key needs GET access to /me, /me/ovhAccount, /me/ovhAccount/*/movements, ' +
  '/me/bill, /me/bill/*, /services, /services/*';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class OvhConnector implements Connector {
  private readonly http: AxiosInstance;
  private readonly endpoint: string;
  private readonly applicationKey: string;
  private readonly applicationSecret: string;
  private readonly consumerKey: string;
  /** local clock - OVH clock, in seconds; OVH rejects signatures more than a minute out. */
  private clockDelta: number | null = null;
  /** Promise chain that spaces outgoing requests. */
  private gate: Promise<unknown> = Promise.resolve();
  private accountCurrency = OVH_FALLBACK_CURRENCY;

  constructor(creds: OvhCredentials) {
    const endpoint = creds.baseUrl?.trim() ?? '';
    this.endpoint = isOvhEndpoint(endpoint) ? endpoint : OVH_DEFAULT_ENDPOINT;
    this.applicationKey = creds.applicationKey.trim();
    this.applicationSecret = creds.applicationSecret.trim();
    this.consumerKey = creds.consumerKey.trim();
    this.http = createHttp({ timeout: REQUEST_TIMEOUT_MS, maxRedirects: 0 });
  }

  kind(): string {
    return 'ovh';
  }

  private sign(method: string, url: string, body: string, timestamp: number): string {
    const payload = [
      this.applicationSecret,
      this.consumerKey,
      method,
      url,
      body,
      String(timestamp),
    ].join('+');
    return `$1$${createHash('sha1').update(payload).digest('hex')}`;
  }

  /** Reserves the next slot: keeps the request rate flat regardless of the pool size. */
  private slot(): Promise<void> {
    const wait = this.gate.then(() => undefined);
    this.gate = wait.then(() => sleep(THROTTLE_MS));
    return wait;
  }

  private async now(signal: AbortSignal): Promise<number> {
    if (this.clockDelta === null) {
      // /auth/time is unsigned and answers with a bare unix timestamp. It lives under the same
      // version prefix as everything else, so the endpoint is used verbatim.
      let data: unknown;
      try {
        ({ data } = await this.http.get(`${this.endpoint}/auth/time`, {
          signal,
          transformResponse: [(v) => v],
        }));
      } catch (e) {
        throw new Error(
          axios.isAxiosError(e)
            ? `OVH: cannot read the API clock (${e.response ? `HTTP ${e.response.status}` : e.code || e.message})`
            : (e as Error).message,
        );
      }
      const server = Number(String(data).trim());
      if (!Number.isFinite(server)) throw new Error('OVH: /auth/time returned no clock');
      this.clockDelta = Math.floor(Date.now() / 1000) - server;
    }
    return Math.floor(Date.now() / 1000) - this.clockDelta;
  }

  /**
   * Signed GET. `path` may carry a query string and is signed verbatim. Errors are rethrown as
   * OVH's own message so axios' error — which carries the signed request headers — never reaches
   * the sync logs.
   */
  private async get<T>(
    path: string,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    attempt = 0,
  ): Promise<T> {
    const url = `${this.endpoint}${path}`;
    await this.slot();
    const timestamp = await this.now(signal);
    try {
      const { data } = await this.http.get(url, {
        signal,
        headers: {
          'X-Ovh-Application': this.applicationKey,
          'X-Ovh-Consumer': this.consumerKey,
          'X-Ovh-Timestamp': String(timestamp),
          'X-Ovh-Signature': this.sign('GET', url, '', timestamp),
          Accept: 'application/json',
        },
      });
      const parsed = schema.safeParse(data);
      if (!parsed.success) {
        // Which field OVH changed, not just that something did.
        const detail = parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ');
        throw new Error(`OVH: unexpected ${path} response (${detail})`);
      }
      return parsed.data;
    } catch (e) {
      if (axios.isAxiosError(e)) {
        const status = e.response?.status;
        // 429/5xx are transient: one retry, honouring Retry-After when OVH sends it.
        if (attempt === 0 && status !== undefined && (status === 429 || status >= 500)) {
          const retryAfter = Number(e.response?.headers?.['retry-after']);
          await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 1500);
          return this.get(path, schema, signal, attempt + 1);
        }
        const body = ovhErrorSchema.safeParse(e.response?.data);
        const queryId = e.response?.headers?.['x-ovh-queryid'];
        const message = body.success ? body.data.message : undefined;
        // A 403 is always about the consumer key's rights, and the caller cannot tell which path
        // was refused without the path — name it, otherwise the fix is guesswork.
        const hint =
          status === 403 ? ` — grant GET ${path} to the consumer key${OVH_RIGHTS_HINT}` : '';
        throw new Error(
          `OVH: ${message || e.code || 'request failed'} [HTTP ${status ?? '?'}] GET ${path}${
            queryId ? ` (queryId ${queryId})` : ''
          }${hint}`,
        );
      }
      throw e;
    }
  }

  /** Bounded fan-out over ids, keeping the order the API returned. */
  private async gather<I, T, R>(
    ids: I[],
    pathFor: (id: I) => string,
    schema: z.ZodType<T>,
    map: (item: T) => R | null,
    signal: AbortSignal,
  ): Promise<R[]> {
    const out: (R | null)[] = new Array(ids.length).fill(null);
    let cursor = 0;
    const workerCount = Math.max(1, Math.min(CONCURRENCY, ids.length));
    const workers = Array.from({ length: workerCount }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= ids.length) return;
        const item = await this.get(pathFor(ids[i]), schema, signal);
        out[i] = map(item);
      }
    });
    await Promise.all(workers);
    return out.filter((r): r is R => r !== null);
  }

  /** Ledger window as `?date.from=YYYY-MM-DD`. */
  private static sinceParam(days: number): string {
    const from = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    return `?date.from=${from}`;
  }

  async fetchAccount(signal: AbortSignal): Promise<Account> {
    const me = await this.get('/me', ovhAccountDetailsSchema, signal);
    this.accountCurrency = normalizeCurrency(me.currency?.code ?? undefined, OVH_FALLBACK_CURRENCY);
    const accountIds = await this.get('/me/ovhAccount', ovhBillIdListSchema, signal);
    if (accountIds.length === 0) return { balance: null, currency: this.accountCurrency };
    const account = await this.get(
      `/me/ovhAccount/${encodeURIComponent(accountIds[0])}`,
      ovhBalanceSchema,
      signal,
    );
    const balance = ovhPriceValue(account.balance);
    return {
      balance: balance ?? new Decimal(0),
      currency: normalizeCurrency(account.balance?.currencyCode ?? undefined, this.accountCurrency),
    };
  }

  async fetchServices(signal: AbortSignal): Promise<ServiceData[]> {
    const ids = await this.get('/services', ovhIdListSchema, signal);
    return this.gather(
      ids,
      (id) => `/services/${id}`,
      ovhServiceSchema,
      (s) => mapOvhService(s, this.accountCurrency),
      signal,
    );
  }

  /**
   * Bills are the spend (one bill can cover many services, so they stay unlinked); `credit`
   * movements are the top-ups. Balance *debits* are skipped on purpose — they are the balance
   * paying a bill that is already imported as a `bill:` charge.
   */
  async fetchPayments(signal: AbortSignal): Promise<PaymentData[]> {
    const since = OvhConnector.sinceParam(LEDGER_WINDOW_DAYS);
    const billIds = (await this.get(`/me/bill${since}`, ovhBillIdListSchema, signal))
      .slice(-MAX_BILLS)
      .reverse();
    const payments: PaymentData[] = await this.gather(
      billIds,
      (id) => `/me/bill/${encodeURIComponent(id)}`,
      ovhBillSchema,
      (b) => mapOvhBill(b, this.accountCurrency),
      signal,
    );

    const accountIds = await this.get('/me/ovhAccount', ovhBillIdListSchema, signal);
    for (const accountId of accountIds.slice(0, MAX_BALANCE_ACCOUNTS)) {
      const id = encodeURIComponent(accountId);
      const movementIds = (
        await this.get(`/me/ovhAccount/${id}/movements${since}`, ovhIdListSchema, signal)
      )
        .slice(-MAX_MOVEMENTS)
        .reverse();
      const movements = await this.gather(
        movementIds,
        (mid) => `/me/ovhAccount/${id}/movements/${mid}`,
        ovhMovementSchema,
        (m) => mapOvhMovement(m, this.accountCurrency),
        signal,
      );
      payments.push(...movements);
    }
    return payments;
  }
}

import axios, { type AxiosInstance } from 'axios';
import Decimal from 'decimal.js';
import { REQUEST_TIMEOUT_MS } from '../common/http';
import { Account, Connector, PaymentData, ServiceData } from '../connector.interface';
import { SKRIME_FALLBACK_CURRENCY, mapSkrimeProduct, mapSkrimeTransaction } from './skrime.mapper';
import {
  describeSkrimeShape,
  readSkrimeError,
  readSkrimeProduct,
  readSkrimeTransaction,
  readSkrimeUser,
} from './skrime.types';

const BASE_URL = 'https://skrime.eu/api';

/**
 * SKRIME (https://skrime.eu) connector for its REST API (https://skrime.eu/docs). The key comes
 * from the dashboard's "API Schnittstelle" page and is sent as `Authorization: Bearer <key>`.
 *
 * Every answer is `{ response, state, data }` with the code in the HTTP status, so `unwrap` returns
 * the payload and a non-success envelope becomes an error naming the API's own message. Services
 * are `GET /product/all` (all product types at once, `price` + `duration` give the cost), the
 * balance is `balance.amount` of `GET /account/user`, and the ledger is `GET /account/transactions`
 * (a flat list, no pagination). SKRIME bills in EUR.
 */
export class SkrimeConnector implements Connector {
  private readonly http: AxiosInstance;

  constructor(token: string) {
    this.http = axios.create({
      baseURL: BASE_URL,
      timeout: REQUEST_TIMEOUT_MS,
      maxRedirects: 0,
      headers: {
        Authorization: `Bearer ${token.trim()}`,
        Accept: 'application/json',
        // The whole site sits behind Cloudflare; a bare axios UA gets challenged on some routes.
        'User-Agent': 'infra-billing/1.0 (+https://github.com/DokerRS/infra-billing)',
      },
    });
    // Surface the API's own message instead of axios' error, which carries the request headers
    // (the API key) and would end up in the sync logs.
    this.http.interceptors.response.use(undefined, (error) => {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const message = readSkrimeError(error.response?.data).response;
        if (status === 401) {
          throw new Error('SKRIME: invalid or revoked API key');
        }
        throw new Error(
          `SKRIME: ${message || error.code || 'request failed'}${status ? ` [HTTP ${status}]` : ''}`,
        );
      }
      throw error;
    });
  }

  kind(): string {
    return 'skrime';
  }

  /** Return `data` of the envelope; an answer without one becomes an empty object. */
  private unwrap(data: unknown): unknown {
    const envelope = data as { state?: unknown; response?: unknown; data?: unknown } | null;
    if (envelope && typeof envelope === 'object' && 'state' in envelope) {
      if (envelope.state !== 'success') {
        const reason = typeof envelope.response === 'string' ? envelope.response : undefined;
        throw new Error(`SKRIME: ${reason || 'request failed'}`);
      }
      return envelope.data === undefined ? {} : envelope.data;
    }
    return data;
  }

  async fetchAccount(signal: AbortSignal): Promise<Account> {
    const { data } = await this.http.get('/account/user', { signal });
    const payload = this.unwrap(data);
    const user = readSkrimeUser(payload);
    // A key without the account scope answers with an unrelated payload; refuse rather than sync a
    // balance of zero.
    if (!user.amount && !user.email) {
      throw new Error(
        `SKRIME: unexpected /account/user response (${describeSkrimeShape(payload)})`,
      );
    }
    const balance = user.amount ? new Decimal(user.amount) : null;
    return { balance: balance?.isFinite() ? balance : null, currency: SKRIME_FALLBACK_CURRENCY };
  }

  async fetchServices(signal: AbortSignal): Promise<ServiceData[]> {
    const { data } = await this.http.get('/product/all', { signal });
    const payload = this.unwrap(data);
    // The documented payload is a flat array; `[]` stands for "no products".
    if (!Array.isArray(payload) && Object.keys(payload as object).length > 0) {
      throw new Error(`SKRIME: unexpected /product/all response (${describeSkrimeShape(payload)})`);
    }
    const services: ServiceData[] = [];
    for (const raw of Array.isArray(payload) ? payload : []) {
      const product = readSkrimeProduct(raw);
      const service = product ? mapSkrimeProduct(product, SKRIME_FALLBACK_CURRENCY) : null;
      if (service) services.push(service);
    }
    return services;
  }

  async fetchPayments(signal: AbortSignal): Promise<PaymentData[]> {
    const { data } = await this.http.get('/account/transactions', { signal });
    const payload = this.unwrap(data);
    // Documented as `{ transactions, externalInvoices }`; accept a bare list too.
    const rows = Array.isArray(payload)
      ? payload
      : ((payload as { transactions?: unknown } | null)?.transactions ?? []);
    if (!Array.isArray(rows)) {
      throw new Error(
        `SKRIME: unexpected /account/transactions response (${describeSkrimeShape(payload)})`,
      );
    }
    const payments: PaymentData[] = [];
    for (const raw of rows) {
      const transaction = readSkrimeTransaction(raw);
      const payment = transaction
        ? mapSkrimeTransaction(transaction, SKRIME_FALLBACK_CURRENCY)
        : null;
      if (payment) payments.push(payment);
    }
    return payments;
  }
}

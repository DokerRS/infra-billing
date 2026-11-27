import axios, { type AxiosInstance } from 'axios';
import Decimal from 'decimal.js';
import { normalizeCurrency } from '../common/currency';
import { createHttp, REQUEST_TIMEOUT_MS } from '../common/http';
import { Account, Connector, PaymentData, ServiceData } from '../connector.interface';
import { mapCent1Service, mapCent1Transaction, CENT1_FALLBACK_CURRENCY } from './1cent.mapper';
import {
  cent1AccountSchema,
  cent1ErrorSchema,
  cent1ServicesSchema,
  cent1TransactionsPageSchema,
} from './1cent.types';

const BASE_URL = 'https://bill.1cent.host/api';
const PAGE_SIZE = 100; // API max for /account/transactions
const MAX_PAGES = 100; // safety cap so a broken pagination contract can't loop forever

/**
 * 1Cent.host connector (https://bill.1cent.host → Настройки → API): no SDK, so a thin axios
 * client with `Authorization: Bearer <cx_… key>`. A read-only key is enough. Money is a decimal
 * string, the account currency is RUB. Balance: GET /account. Services: GET /services (a plain
 * array). Ledger: GET /account/transactions (`page`/`pageSize`, capped at 100 per page) — the
 * /payments feed always returns the 20 newest external payments only, so it can't be a ledger.
 */
export class Cent1Connector implements Connector {
  private readonly http: AxiosInstance;
  private currency = CENT1_FALLBACK_CURRENCY;

  constructor(token: string) {
    this.http = createHttp({
      baseURL: BASE_URL,
      timeout: REQUEST_TIMEOUT_MS,
      maxRedirects: 0,
      headers: { Authorization: `Bearer ${token.trim()}`, Accept: 'application/json' },
    });
    // Surface the API's own message instead of axios' error, which carries the request headers
    // (the API key) and would end up in the sync logs.
    this.http.interceptors.response.use(undefined, (e) => {
      if (axios.isAxiosError(e)) {
        const body = cent1ErrorSchema.safeParse(e.response?.data);
        const status = e.response?.status;
        const message = body.success ? body.data.message : undefined;
        const reason = Array.isArray(message) ? message.join('; ') : message;
        throw new Error(
          `1Cent: ${reason || e.code || 'request failed'}${status ? ` [HTTP ${status}]` : ''}`,
        );
      }
      throw e;
    });
  }

  kind(): string {
    return '1cent';
  }

  async fetchAccount(signal: AbortSignal): Promise<Account> {
    const { data } = await this.http.get('/account', { signal });
    const parsed = cent1AccountSchema.safeParse(data);
    if (!parsed.success) throw new Error('1Cent: unexpected /account response');
    this.currency = normalizeCurrency(parsed.data.currency ?? undefined, CENT1_FALLBACK_CURRENCY);
    return { balance: new Decimal(parsed.data.balance), currency: this.currency };
  }

  async fetchServices(signal: AbortSignal): Promise<ServiceData[]> {
    const { data } = await this.http.get('/services', { signal });
    const parsed = cent1ServicesSchema.safeParse(data);
    if (!parsed.success) throw new Error('1Cent: unexpected /services response');
    return parsed.data.map((s) => mapCent1Service(s, this.currency));
  }

  async fetchPayments(signal: AbortSignal): Promise<PaymentData[]> {
    const payments: PaymentData[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data } = await this.http.get('/account/transactions', {
        params: { page, pageSize: PAGE_SIZE },
        signal,
      });
      const parsed = cent1TransactionsPageSchema.safeParse(data);
      if (!parsed.success) throw new Error('1Cent: unexpected /account/transactions response');
      const { items, total, pageSize } = parsed.data;
      for (const t of items) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        const payment = mapCent1Transaction(t, this.currency);
        if (payment) payments.push(payment);
      }
      if (items.length === 0 || page * pageSize >= total) return payments;
    }
    throw new Error('1Cent: /account/transactions pagination limit exceeded');
  }
}

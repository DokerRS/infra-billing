import axios, { type AxiosInstance } from 'axios';
import { Logger } from '@nestjs/common';
import { REQUEST_TIMEOUT_MS } from '../common/http';
import { Account, Connector, PaymentData, ServiceData } from '../connector.interface';
import { mapInfomaniakInvoice, mapInfomaniakProduct } from './infomaniak.mapper';
import {
  describeInfomaniakIssue,
  describeInfomaniakShape,
  infomaniakErrorSchema,
  infomaniakInvoicesResponseSchema,
  infomaniakProfileSchema,
  infomaniakProductsResponseSchema,
  readInfomaniakInvoice,
  readInfomaniakProduct,
} from './infomaniak.types';

const BASE_URL = 'https://api.infomaniak.com';
const PAGE_SIZE = 200; // `per_page`
/** The billing routes have their own pagination; 100 is what has been observed to work there. */
const INVOICE_PAGE_SIZE = 100;
const MAX_PAGES = 50; // safety cap against a misbehaving pagination contract

/** Infomaniak bills in francs or euros depending on the account's country. */
const CURRENCY_BY_COUNTRY: Record<string, string> = { CH: 'CHF', LI: 'CHF' };
const DEFAULT_CURRENCY = 'EUR';

/**
 * Infomaniak (https://www.infomaniak.com) through the Public Cloud API
 * (https://developer.infomaniak.com/docs/api). Auth is a single personal access token issued by
 * the Manager (profile → "API"), sent as `Authorization: Bearer <token>` — the same shape every
 * third-party Infomaniak integration uses (acme.sh, DNSControl, win-acme).
 *
 * `GET /1/products` lists every subscription of the account across all services (hosting, domain,
 * cloud, dedicated_server, ksuite, …), which is the whole inventory in one paginated call.
 * The API exposes no balance and no per-product price (only per-catalogue calculators), so the
 * balance is null and services carry no cost. The billing account behind the Manager does have an
 * invoice ledger, reachable through the undocumented `/1/invoicing/*` routes, which is where
 * `fetchPayments` reads the real spend from.
 */
export class InfomaniakConnector implements Connector {
  private readonly logger = new Logger(InfomaniakConnector.name);
  private readonly http: AxiosInstance;
  /** Billing account id for the `/1/invoicing/{account}/*` routes; resolved on first use. */
  private accountId?: string;

  constructor(token: string) {
    this.http = axios.create({
      baseURL: BASE_URL,
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        Authorization: `Bearer ${token.trim()}`,
        Accept: 'application/json',
      },
    });
    // Surface Infomaniak's own error description instead of a bare HTTP status.
    this.http.interceptors.response.use(undefined, (error) => {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const parsed = infomaniakErrorSchema.safeParse(error.response?.data);
        const detail = parsed.success ? parsed.data.error : undefined;
        const message = detail?.description || detail?.code;
        if (message) throw new Error(`Infomaniak: ${message}`);
        if (status === 401) {
          throw new Error('Infomaniak: invalid or expired API token');
        }
      }
      throw error;
    });
  }

  kind(): string {
    return 'infomaniak';
  }

  async fetchAccount(signal: AbortSignal): Promise<Account> {
    // No balance endpoint exists; /2/profile doubles as the token check and tells the billing
    // country, which is what picks CHF vs EUR for the account.
    const profile = await this.readProfile(signal);
    const country = profile.preferences?.country?.short_name?.toUpperCase();
    return {
      balance: null,
      currency: (country && CURRENCY_BY_COUNTRY[country]) || DEFAULT_CURRENCY,
    };
  }

  async fetchServices(signal: AbortSignal): Promise<ServiceData[]> {
    const services: ServiceData[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data } = await this.http.get('/1/products', {
        params: { page, per_page: PAGE_SIZE, with: 'fqdn' },
        signal,
      });
      // A failure can arrive as HTTP 200 with `result: 'error'`; report its reason, not the shape.
      if (data && typeof data === 'object' && !Array.isArray(data) && data.result === 'error') {
        const parsed = infomaniakErrorSchema.safeParse(data);
        const detail = parsed.success ? parsed.data.error : undefined;
        throw new Error(`Infomaniak: ${detail?.description || detail?.code || 'error'}`);
      }
      const parsed = infomaniakProductsResponseSchema.safeParse(data);
      if (!parsed.success) {
        throw new Error(
          `Infomaniak: unexpected /1/products response [${describeInfomaniakIssue(
            parsed.error,
          )}] (fields: ${describeInfomaniakShape(data)})`,
        );
      }
      const batch = parsed.data.data;
      for (const raw of batch) {
        const product = readInfomaniakProduct(raw);
        if (product) services.push(mapInfomaniakProduct(product));
      }
      const pages = Number(parsed.data.pages);
      if (Number.isFinite(pages) ? page >= pages : batch.length < PAGE_SIZE) break;
    }
    return services;
  }

  /**
   * Invoices from the undocumented `GET /1/invoicing/{account}/invoice/list`.
   *
   * Infomaniak's public API has no expense ledger, but the billing account behind the Manager does,
   * and the `invoicing:invoice:read` scope grants it. An invoice is a total for a whole billing
   * account and carries no per-product prices, so it is imported as a `charge` — which makes the
   * real monthly spend visible even though per-service prices stay manual. A failure here only loses
   * the ledger: the sync service keeps invoices non-fatal, so services still sync.
   */
  async fetchPayments(signal: AbortSignal): Promise<PaymentData[]> {
    const accountId = await this.resolveAccountId(signal);
    if (!accountId) {
      this.logger.warn('Infomaniak: billing account id unavailable, invoices not imported');
      return [];
    }
    const payments: PaymentData[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data } = await this.http.get(`/1/invoicing/${accountId}/invoice/list`, {
        params: { page, per_page: INVOICE_PAGE_SIZE },
        signal,
      });
      if (data && typeof data === 'object' && !Array.isArray(data) && data.result === 'error') {
        const parsed = infomaniakErrorSchema.safeParse(data);
        const detail = parsed.success ? parsed.data.error : undefined;
        throw new Error(`Infomaniak: ${detail?.description || detail?.code || 'error'}`);
      }
      const parsed = infomaniakInvoicesResponseSchema.safeParse(data);
      if (!parsed.success) {
        throw new Error(
          `Infomaniak: unexpected /1/invoicing/${accountId}/invoice/list response [${describeInfomaniakIssue(
            parsed.error,
          )}] (fields: ${describeInfomaniakShape(data)})`,
        );
      }
      const batch = parsed.data.data;
      for (const raw of batch) {
        const invoice = readInfomaniakInvoice(raw);
        const payment = invoice ? mapInfomaniakInvoice(invoice) : null;
        if (payment) payments.push(payment);
      }
      const pages = Number(parsed.data.pages);
      if (Number.isFinite(pages) ? page >= pages : batch.length < INVOICE_PAGE_SIZE) break;
    }
    return payments;
  }

  /** `GET /2/profile`, parsed leniently — the token already proved valid if the call returned. */
  private async readProfile(signal: AbortSignal) {
    const { data } = await this.http.get('/2/profile', { signal });
    const parsed = infomaniakProfileSchema.safeParse(data?.data ?? data);
    return parsed.success ? parsed.data : {};
  }

  /**
   * The billing account that invoices belong to. `/2/profile` reports it as `current_account_id`;
   * a token without that field falls back to the single account of `GET /1/accounts`.
   */
  private async resolveAccountId(signal: AbortSignal): Promise<string | undefined> {
    if (this.accountId) return this.accountId;
    const profile = await this.readProfile(signal);
    const fromProfile = profile.current_account_id ?? profile.preferences?.current_account_id;
    let resolved = fromProfile != null ? String(fromProfile) : undefined;
    if (!resolved) {
      const { data } = await this.http.get('/1/accounts', { signal });
      const rows = Array.isArray(data?.data) ? (data.data as unknown[]) : [];
      const first = rows.find(
        (row) => row && typeof row === 'object' && (row as { id?: unknown }).id != null,
      ) as { id?: number | string } | undefined;
      resolved = first?.id != null ? String(first.id) : undefined;
    }
    this.accountId = resolved;
    return resolved;
  }
}

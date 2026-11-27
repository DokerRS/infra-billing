import axios, { type AxiosInstance } from 'axios';
import { Logger } from '@nestjs/common';
import { createHttp, REQUEST_TIMEOUT_MS } from '../common/http';
import { Account, Connector, PaymentData, ServiceData } from '../connector.interface';
import {
  mapInfomaniakInvoice,
  mapInfomaniakProduct,
  latestInfomaniakLinesByProduct,
} from './infomaniak.mapper';
import {
  describeInfomaniakIssue,
  describeInfomaniakShape,
  infomaniakErrorSchema,
  infomaniakInvoicesResponseSchema,
  infomaniakProfileSchema,
  infomaniakProductsResponseSchema,
  type InfomaniakInvoice,
  type InfomaniakInvoiceLine,
  type InfomaniakProduct,
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
 * A product row carries no price, but the invoice ledger does: every invoice line names the product
 * it bills (`item_id`, the same id `/1/products` reports as `id`) together with the amount and the
 * period it covers. So the ledger — reachable through the undocumented `/1/invoicing/*` routes with
 * the `invoicing:invoice:read` scope — is read once per sync and used both to price the services and
 * to import the spend history. Without that scope the services still sync, just without a cost.
 * The API exposes no balance at all, so the balance is null.
 */
export class InfomaniakConnector implements Connector {
  private readonly logger = new Logger(InfomaniakConnector.name);
  private readonly http: AxiosInstance;
  /** Billing account id for the `/1/invoicing/{account}/*` routes; resolved on first use. */
  private accountId?: string;
  /**
   * The invoice ledger, fetched once per sync. A connector instance lives for a single sync run, so
   * this only avoids asking for the same pages twice — services and payments read the same data.
   */
  private invoices?: InfomaniakInvoice[];
  /** Invoice `item_id` → the service externalId of that product, to link charges to services. */
  private readonly externalIdByProductRef = new Map<string, string>();

  constructor(token: string) {
    this.http = createHttp({
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
    const products: InfomaniakProduct[] = [];
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
        if (product) products.push(product);
      }
      const pages = Number(parsed.data.pages);
      if (Number.isFinite(pages) ? page >= pages : batch.length < PAGE_SIZE) break;
    }

    // Prices live only in the invoice ledger, and that route needs a scope the token may not have.
    // Losing the price must never lose the inventory, so a ledger failure is logged and ignored.
    let lineByProductRef = new Map<string, InfomaniakInvoiceLine>();
    try {
      lineByProductRef = latestInfomaniakLinesByProduct(await this.loadInvoices(signal));
    } catch (e) {
      this.logger.warn(
        `Infomaniak: invoice ledger unavailable, services synced without cost: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }

    const services: ServiceData[] = [];
    for (const product of products) {
      const service = mapInfomaniakProduct(product, this.lineFor(product, lineByProductRef));
      services.push(service);
      // Invoice lines reference the product `id`, while the service is keyed by `unique_id`; keep
      // the translation so imported charges can be attached to the right service.
      if (product.id) this.externalIdByProductRef.set(product.id, service.externalId);
    }
    return services;
  }

  /**
   * Invoices from the undocumented `GET /1/invoicing/{account}/invoice/list`, which also carry the
   * per-product prices `fetchServices` reads.
   *
   * An invoice is a total for a whole billing account, so it is imported as a `charge`; it is linked
   * to a service when it has a single line naming a product the account owns. A failure here only
   * loses the ledger: the sync service keeps invoices non-fatal, so services still sync.
   */
  async fetchPayments(signal: AbortSignal): Promise<PaymentData[]> {
    const payments: PaymentData[] = [];
    for (const invoice of await this.loadInvoices(signal)) {
      const payment = mapInfomaniakInvoice(invoice);
      if (!payment) continue;
      if (payment.serviceExternalId) {
        payment.serviceExternalId =
          this.externalIdByProductRef.get(payment.serviceExternalId) ?? undefined;
      }
      payments.push(payment);
    }
    return payments;
  }

  /** The invoice ledger of this account, fetched once and reused by services and payments. */
  private async loadInvoices(signal: AbortSignal): Promise<InfomaniakInvoice[]> {
    if (this.invoices) return this.invoices;
    const accountId = await this.resolveAccountId(signal);
    if (!accountId) {
      throw new Error('billing account id unavailable');
    }
    const invoices: InfomaniakInvoice[] = [];
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
        if (invoice) invoices.push(invoice);
      }
      const pages = Number(parsed.data.pages);
      if (Number.isFinite(pages) ? page >= pages : batch.length < INVOICE_PAGE_SIZE) break;
    }
    this.invoices = invoices;
    return invoices;
  }

  /**
   * The line that prices a product: invoice lines reference a product by its `id`, which is what
   * `latestInfomaniakLinesByProduct` keys them by.
   */
  private lineFor(
    product: InfomaniakProduct,
    byProductRef: Map<string, InfomaniakInvoiceLine>,
  ): InfomaniakInvoiceLine | undefined {
    return product.id ? byProductRef.get(product.id) : undefined;
  }

  /** `GET /2/profile`, parsed leniently — the token already proved valid if the call returned. */
  private async readProfile(signal: AbortSignal) {
    const { data } = await this.http.get('/2/profile', { signal });
    const parsed = infomaniakProfileSchema.safeParse(data);
    return parsed.success ? parsed.data : {};
  }

  /**
   * The billing account that invoices belong to. `/2/profile` reports it as `current_account_id`,
   * nested under `preferences.account` on current builds; a token without that field falls back to
   * the single account of `GET /1/accounts`.
   */
  private async resolveAccountId(signal: AbortSignal): Promise<string | undefined> {
    if (this.accountId) return this.accountId;
    const profile = await this.readProfile(signal);
    const fromProfile =
      profile.current_account_id ??
      profile.preferences?.current_account_id ??
      profile.preferences?.account?.current_account_id;
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

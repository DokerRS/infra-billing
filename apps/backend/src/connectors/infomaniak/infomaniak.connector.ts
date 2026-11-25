import axios, { type AxiosInstance } from 'axios';
import { REQUEST_TIMEOUT_MS } from '../common/http';
import { Account, Connector, ServiceData } from '../connector.interface';
import { mapInfomaniakProduct } from './infomaniak.mapper';
import {
  describeInfomaniakIssue,
  infomaniakErrorSchema,
  infomaniakProfileSchema,
  infomaniakProductsResponseSchema,
  type InfomaniakProduct,
} from './infomaniak.types';

const BASE_URL = 'https://api.infomaniak.com';
const PAGE_SIZE = 200; // `per_page`
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
 * The API exposes no balance and no invoice ledger — only per-catalogue price calculators — so the
 * balance is null, services carry no cost, and there is no `fetchPayments`.
 */
export class InfomaniakConnector implements Connector {
  private readonly http: AxiosInstance;

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
    const { data } = await this.http.get('/2/profile', { signal });
    // Only the currency is read here, so a shape change must not fail the sync — the token already
    // proved valid, otherwise the call would have answered 401.
    const parsed = infomaniakProfileSchema.safeParse(data?.data ?? data);
    const country = parsed.success
      ? parsed.data.preferences?.country?.short_name?.toUpperCase()
      : undefined;
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
      const parsed = infomaniakProductsResponseSchema.safeParse(data);
      if (!parsed.success) {
        const shape = data && typeof data === 'object' ? Object.keys(data).join(',') : typeof data;
        throw new Error(
          `Infomaniak: unexpected /1/products response [${describeInfomaniakIssue(
            parsed.error,
          )}] (fields: ${shape})`,
        );
      }
      const batch = parsed.data.data;
      products.push(...batch);
      const pages = parsed.data.pages;
      if (pages != null ? page >= pages : batch.length < PAGE_SIZE) break;
    }
    return products.map(mapInfomaniakProduct);
  }
}

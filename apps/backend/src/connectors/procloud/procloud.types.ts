// ProCloud API shapes. ProCloud is a white-label of 3HCloud: OpenStack (Keystone v3 + Nova) per
// location, plus a billing panel (my.procloud.ru) behind a Keycloak login. Only consumed fields
// are typed.

export interface ProcloudRegion {
  /** Nova endpoint of the location, used when the Keystone catalog has no compute entry. */
  compute: string;
  /** Catalog region name of the location ("Moscow"), as the RC file's OS_REGION_NAME spells it. */
  region: string;
  /** ISO 3166-1 alpha-2 of the location, for the service's country flag. */
  countryCode: string;
  /** Label shown in the provider form. */
  label: string;
}

// Keys are the only accepted identity URLs: the OpenStack password must not reach another host.
// One provider covers one location — ProCloud issues a separate API user (RC file) per location.
export const PROCLOUD_REGIONS: Record<string, ProcloudRegion> = {
  'https://identity.api.os.msk.3hcloud.com': {
    compute: 'https://compute.api.os.msk.3hcloud.com',
    region: 'Moscow',
    countryCode: 'RU',
    label: 'Moscow',
  },
  'https://identity.api.os.waw.3hcloud.com': {
    compute: 'https://compute.api.os.waw.3hcloud.com',
    region: 'Warsaw',
    countryCode: 'PL',
    label: 'Warsaw',
  },
  'https://identity.api.os.mnl.3hcloud.com': {
    compute: 'https://compute.api.os.mnl.3hcloud.com',
    region: 'Manila',
    countryCode: 'PH',
    label: 'Manila',
  },
  'https://identity.api.os.mia.3hcloud.com': {
    compute: 'https://compute.api.os.mia.3hcloud.com',
    region: 'Miami',
    countryCode: 'US',
    label: 'Miami',
  },
  'https://identity.api.os.mia2.3hcloud.com': {
    compute: 'https://compute.api.os.mia2.3hcloud.com',
    region: 'Miami-2',
    countryCode: 'US',
    label: 'Miami-2',
  },
  'https://identity.api.os.dfw.3hcloud.com': {
    compute: 'https://compute.api.os.dfw.3hcloud.com',
    region: 'Dallas',
    countryCode: 'US',
    label: 'Dallas',
  },
  'https://identity.api.os.sfo.3hcloud.com': {
    compute: 'https://compute.api.os.sfo.3hcloud.com',
    region: 'San Francisco',
    countryCode: 'US',
    label: 'San Francisco',
  },
  'https://identity.api.os.ala.3hcloud.com': {
    compute: 'https://compute.api.os.ala.3hcloud.com',
    region: 'Almaty',
    countryCode: 'KZ',
    label: 'Almaty',
  },
};

export const PROCLOUD_DEFAULT_IDENTITY_URL = 'https://identity.api.os.msk.3hcloud.com';

/** Billing panel and its Keycloak realm. Both are single-tenant hosts, fixed in code. */
export const PROCLOUD_PANEL_URL = 'https://my.procloud.ru';
export const PROCLOUD_TOKEN_URL =
  'https://login.procloud.ru/auth/realms/procloud/protocol/openid-connect/token';
/** The SPA's public client — it has no secret, the realm allows the password grant. */
export const PROCLOUD_KEYCLOAK_CLIENT_ID = 'web';

/** ProCloud bills in roubles. */
export const PROCLOUD_CURRENCY = 'RUB';

export interface ProcloudCredentials {
  username: string; // OpenStack login from the location's RC file (api-<account>-…)
  password: string;
  baseUrl?: string; // one of PROCLOUD_REGIONS keys; default — Moscow
  projectName?: string; // Keystone project; default — derived from the login (proj-<account>)
  // Optional panel sign-in: enables the balance, the prices and the payment ledger.
  email?: string;
  webPassword?: string;
}

/** Keystone v3 token response: only the catalog entries endpoints are resolved from. */
export interface KeystoneService {
  type?: string;
  endpoints?: Array<{ interface?: string; region?: string; region_id?: string; url?: string }>;
}

export interface KeystoneToken {
  catalog?: KeystoneService[];
}

export interface ProcloudAccount {
  /** Panel's internal id, the `accountId` of the billing endpoints. */
  id?: string | number;
  /** Contract id, sent as `X-Account-Id` and used by `/api/billing/active`. */
  externalId?: string;
  /** Account number shown to the customer. */
  dognum?: string;
  description?: string;
}

/** `GET /api/billing?accountId=<id>` (panel). */
export interface ProcloudBilling {
  balance?: number | string;
  creditLimit?: number | string;
}

/** `GET /api/dashboard/billing` (panel). */
export interface ProcloudBillingSummary {
  balance?: number | string;
  unbilledAmount?: number | string;
}

/**
 * `GET /api/billing/active?contractId=<externalId>` (panel). One group per product class; an item
 * is one billed resource, `uuid` being the OpenStack id of an instance.
 */
export interface ProcloudBilledItem {
  uuid?: string;
  name?: string;
  description?: string;
  location?: string;
  price?: number | string; // per month, after discounts
  priceHour?: number | string;
  fullPrice?: number | string; // per month, before discounts
  discount?: number | string;
}

export interface ProcloudBilledGroup {
  id?: string | number;
  productClassId?: string | number;
  items?: ProcloudBilledItem[];
}

export interface ProcloudActiveBilling {
  groups?: ProcloudBilledGroup[];
}

/**
 * `GET /api/billing/history?accountId=<id>` (panel). `bill` is a settled charge, `pay` a payment,
 * `unbilled` the current period's accrual (money that has not moved yet).
 */
export interface ProcloudHistoryEntry {
  id?: string | number;
  entryType?: string; // "bill" | "pay" | "unbilled"
  historyDate?: string;
  historyName?: string;
  amount?: number | string;
  dateFrom?: string;
  dateTo?: string;
}

export interface NovaAddress {
  addr?: string;
  version?: number;
}

/** Nova `GET /servers/detail` without a microversion header: `flavor` is `{id}`. */
export interface NovaServer {
  id: string;
  name?: string;
  status?: string;
  created?: string;
  flavor?: { id?: string };
  addresses?: Record<string, NovaAddress[]>;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface NovaServersPage {
  servers?: NovaServer[];
  servers_links?: Array<{ rel?: string; href?: string }>;
}

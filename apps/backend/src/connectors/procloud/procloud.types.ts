// ProCloud panel (my.procloud.ru) API shapes. The panel sits behind a Keycloak login and answers
// for every location at once, so it — not the per-location OpenStack clouds — is what the connector
// talks to. Only consumed fields are typed.

/** Billing panel and its Keycloak realm. Both are single-tenant hosts, fixed in code. */
export const PROCLOUD_PANEL_URL = 'https://my.procloud.ru';
export const PROCLOUD_TOKEN_URL =
  'https://login.procloud.ru/auth/realms/procloud/protocol/openid-connect/token';
/** The SPA's public client — it has no secret, the realm allows the password grant. */
export const PROCLOUD_KEYCLOAK_CLIENT_ID = 'web';

/** ProCloud bills in roubles. */
export const PROCLOUD_CURRENCY = 'RUB';

/**
 * Country of a panel location. The panel reports `endpointRegion` ("SanFrancisco") and an
 * `availabilityZone` ("SFO-1"); both are accepted, since a location name is not always spelled the
 * same way in both fields.
 */
export const PROCLOUD_LOCATION_COUNTRY: Record<string, string> = {
  moscow: 'RU',
  msk: 'RU',
  warsaw: 'PL',
  waw: 'PL',
  manila: 'PH',
  mnl: 'PH',
  miami: 'US',
  mia: 'US',
  dallas: 'US',
  dfw: 'US',
  'san francisco': 'US',
  sanfrancisco: 'US',
  sfo: 'US',
  almaty: 'KZ',
  ala: 'KZ',
};

export interface ProcloudCredentials {
  /** The email and password the owner signs in to my.procloud.ru with. */
  email: string;
  webPassword: string;
}

/**
 * `GET /api/account` (panel). A user may hold several, but a cabinet normally bills one contract.
 * `id` is the panel's internal uuid (what `/api/billing/history` wants), `externalId` the contract
 * id sent as `X-Account-Id` and used by the resource and billing endpoints.
 */
export interface ProcloudAccount {
  id?: string | number;
  externalId?: string;
  /** Account number shown to the customer. */
  dognum?: string;
  accountNumber?: string;
  name?: string;
  isActive?: boolean;
}

/** `GET /api/billing?accountId=<externalId>` (panel). */
export interface ProcloudBilling {
  balance?: number | string;
  creditLimit?: number | string;
  creditLimitRemainder?: number | string;
  nextBillingDate?: string;
}

/** `GET /api/dashboard/billing?accountId=<externalId>` (panel). */
export interface ProcloudBillingSummary {
  balance?: number | string;
  unbilledAmount?: number | string;
}

/**
 * `GET /api/server?accountId=<externalId>` (panel). One row per cloud server, in every location the
 * account has servers in — status, addresses and flavour included, which Nova needed a per-location
 * API user for.
 */
export interface ProcloudServer {
  id: string;
  name?: string;
  status?: string;
  createdAt?: string;
  imageName?: string;
  imageVersion?: string;
  /** Tariff plan name ("Enterprise cloud"). */
  tariff?: string;
  ipAddresses?: string[];
  flavor?: { originalName?: string; ram?: number; vcpus?: number; disk?: number };
  securityGroups?: string[];
  availabilityZone?: string;
  endpointRegion?: string;
}

export interface ProcloudServersPage {
  items?: ProcloudServer[];
  /** Locations whose cloud did not answer; the list is then incomplete. */
  failedRegions?: unknown[];
}

/**
 * `GET /api/billing/active?contractId=<externalId>` (panel). One group per product class; an item is
 * one billed resource, `uuid` being the OpenStack id of the instance it bills for. `price` is the
 * month's total after discounts (`unit: "hour"` only says it accrues hourly).
 */
export interface ProcloudBilledItem {
  uuid?: string;
  name?: string;
  description?: string;
  location?: string;
  /** Product name ("Виртуальный сервер", "IP-адрес"). */
  product?: string;
  productPl?: string;
  /** Product group ("Облачная платформа", "IP-адреса"). */
  productGroup?: string;
  price?: number | string; // per month, after discounts
  priceHour?: number | string;
  fullPrice?: number | string; // per month, before discounts
  discount?: number | string;
  dateStart?: string;
}

export interface ProcloudBilledGroup {
  id?: string | number;
  productClassId?: string | number;
  title?: string;
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
  /** The panel's history rows are keyed by contract, not by a per-row id. */
  contractId?: string;
  dogId?: string;
  docId?: string;
  entryType?: string; // "bill" | "pay" | "unbilled"
  historyDate?: string;
  historyName?: string;
  amount?: number | string;
  dateFrom?: string;
  dateTo?: string;
}

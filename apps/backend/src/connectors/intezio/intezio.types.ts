// Intezio (https://intezio.net) customer cabinet API shapes. Intezio publishes no public API, so
// the connector reads the JSON the Nuxt cabinet fetches: a cookie session opened by `POST
// /api/auth/login` and plain GETs under `/api`. Every answer is an envelope `{ code, data }`.
// Only the consumed fields are typed.

/** Single-tenant host, fixed in code. */
export const INTEZIO_PANEL_URL = 'https://intezio.net';

/** Intezio bills in roubles — the catalogue prices every plan as `cost_rub`. */
export const INTEZIO_CURRENCY = 'RUB';

export interface IntezioCredentials {
  /** The email and password the owner signs in to intezio.net with. */
  email: string;
  webPassword: string;
}

/** `POST /api/auth/login` and `GET /api/auth/me`. */
export interface IntezioUser {
  id?: number;
  email?: string;
  username?: string;
  balance?: number | string;
  role?: number;
  banned?: boolean;
  email_verified?: boolean;
}

/**
 * `GET /api/services/user`. One row per ordered VPS. `id` is the order id and `service_id` the
 * catalogue plan it ordered; `cost` is what one month costs and `paid_up_to` when it runs out.
 */
export interface IntezioService {
  id?: number | string;
  service_id?: number;
  cost?: number | string;
  /** 1 while the service runs. */
  status?: number;
  paid_up_to?: string;
  /** Short location tag of the order ("pl", "ee"). */
  name?: string;
  is_stopped_by_admin?: boolean;
  created_at?: string;
  auto_renew?: boolean;
  vm6_ip?: string;
  /** Root password — never persisted. */
  password?: string;
  edges?: {
    service?: {
      id?: number;
      /** Plan name ("PL-1"), whose prefix is the location's country code. */
      name?: string;
      cpu?: number;
      /** MiB. */
      ram?: number;
      /** MiB. */
      disk?: number;
      cpu_model?: string;
      /** English location name ("Poland"). */
      location_name?: string;
    };
  };
}

/**
 * Country of a location, keyed by the lowercased English `location_name`. The catalogue also names
 * locations in Russian, but the rows the connector reads always carry the English one.
 */
export const INTEZIO_LOCATION_COUNTRY: Record<string, string> = {
  poland: 'PL',
  estonia: 'EE',
  germany: 'DE',
  netherlands: 'NL',
  finland: 'FI',
  switzerland: 'CH',
  sweden: 'SE',
  czechia: 'CZ',
  latvia: 'LV',
  lithuania: 'LT',
};

/** Top-level keys of a payload, for the "unexpected response" error text. */
export function describeIntezioShape(raw: unknown): string {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const keys = Object.keys(raw as Record<string, unknown>);
    return `keys: ${keys.join(', ') || 'none'}`;
  }
  if (Array.isArray(raw)) return `array of ${raw.length}`;
  return typeof raw;
}

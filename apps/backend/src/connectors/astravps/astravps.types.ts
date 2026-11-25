// AstraVPS (https://astravps.co) customer panel API shapes. AstraVPS publishes no public API, so
// the connector reads the JSON the cabinet itself fetches: a cookie session opened by `POST
// /api/auth/login` and plain GETs under `/api`. Only the consumed fields are typed.

/** Single-tenant host, fixed in code. */
export const ASTRAVPS_PANEL_URL = 'https://astravps.co';

/** AstraVPS bills in roubles; the panel renders every amount with a ₽ suffix. */
export const ASTRAVPS_CURRENCY = 'RUB';

export interface AstravpsCredentials {
  /** The email and password the owner signs in to astravps.co with. */
  email: string;
  webPassword: string;
}

/** `POST /api/auth/login` and `GET /api/me`. `balance` is the only billing figure of the user. */
export interface AstravpsUser {
  id?: number;
  username?: string;
  email?: string;
  balance?: number | string;
  tg_linked?: boolean;
  email_verified?: boolean;
}

/** `GET /api/services`. One row per VPS, priced by `monthly`. */
export interface AstravpsService {
  id?: number | string;
  name?: string;
  plan_key?: string;
  status?: string;
  ip?: string;
  extra_ips?: string[];
  /** Node hostname ("pl1"); its prefix is the location. */
  node?: string;
  spec?: {
    cpu?: number;
    ram?: number; // GiB
    disk?: number; // GiB
    os?: string;
    /** Two-letter country code of the location ("pl", "nl", "ee"). */
    location?: string;
  };
  /** The plan's price per month. */
  monthly?: number | string;
  expires_at?: string;
  created_at?: string;
  /** Root credentials — never persisted. */
  conn?: { ip?: string; login?: string; password?: string };
  provisioning?: boolean;
}

/**
 * `GET /api/operations`. One row per movement of the balance. `kind` is open-ended: the panel's own
 * renderer knows `renew`/`provision` and a handful of paid service actions (charges), `topup`,
 * `refund` and `bonus` (money in), `price_change` (no money at all), and treats everything else it
 * has never seen as a top-up. `id` is the *service* id on the service rows — so it repeats — and the
 * payment id on top-ups.
 */
export interface AstravpsOperation {
  kind?: string;
  id?: number | string;
  pay_id?: number | string;
  status?: string;
  /** Service name, present on every row that concerns one service. */
  service?: string;
  amount?: number | string;
  /** `price_change` only: the price before the change. */
  amount_from?: number | string;
  method?: string;
  pay_url?: string | null;
  created_at?: string;
}

/** Statuses the panel counts as "the money moved". */
const SETTLED_STATUS = new Set(['ok', 'completed', 'refunded']);

/** Whether an operation row is a settled movement of the balance. */
export function astravpsOperationSettled(status: string | undefined): boolean {
  // An absent status counts as settled: every row a real account has ever returned carries one.
  return status === undefined || SETTLED_STATUS.has(status);
}

/** Operation kinds that are charges for a service. */
export const ASTRAVPS_CHARGE_KINDS = new Set([
  'renew',
  'provision',
  'change_ip',
  'ip_change',
  'add_ip',
  'reinstall',
  'upgrade',
  'channel',
]);

/** Kinds that bring money onto the balance. */
export const ASTRAVPS_TOPUP_KINDS = new Set(['topup', 'refund', 'bonus']);

/** Kinds that move no money and must never become a payment. */
export const ASTRAVPS_NEUTRAL_KINDS = new Set(['price_change', 'password', 'abuse']);

/** Top-level keys of a payload, for the "unexpected response" error text. */
export function describeAstravpsShape(raw: unknown): string {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const keys = Object.keys(raw as Record<string, unknown>);
    return `keys: ${keys.join(', ') || 'none'}`;
  }
  if (Array.isArray(raw)) return `array of ${raw.length}`;
  return typeof raw;
}

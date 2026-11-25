// SKRIME API shapes (https://skrime.eu/docs, spec at https://skrime.eu/docs/openapi.json). Only the
// fields consumed here are typed.
//
// Every answer is wrapped in `{ response, state, data }` and the HTTP status carries the code, so the
// connector unwraps `data` and checks the container. Product and transaction rows are read field by
// field instead of being schema-validated: money and durations arrive as decimal strings, ids as UUID
// strings and timestamps as `"Y-m-d H:i:s"`, but a row that differs from the documented example must
// cost a field, never the whole sync.

/** A scalar read as text; numbers are stringified, anything else (objects, null) becomes undefined. */
function asText(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw.trim() || undefined;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return undefined;
}

/** A decimal string ("12.50") or a number read as text, so decimal.js can consume it. */
function asMoney(raw: unknown): string | undefined {
  const text = asText(raw);
  return text && /^-?\d+(\.\d+)?$/.test(text) ? text : undefined;
}

/** A boolean flag the API may send as a bool, 0/1 or "0"/"1". */
function asBool(raw: unknown): boolean | undefined {
  if (typeof raw === 'boolean') return raw;
  if (raw === 1 || raw === '1') return true;
  if (raw === 0 || raw === '0') return false;
  return undefined;
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

/** On failure `data` is an empty array and `response` names the reason; the status carries the code. */
export interface SkrimeError {
  response?: string;
  state?: string;
}

export function readSkrimeError(raw: unknown): SkrimeError {
  const rec = asRecord(raw);
  return {
    response: rec ? asText(rec.response) : undefined,
    state: rec ? asText(rec.state) : undefined,
  };
}

/** `GET /account/user` — the credential probe, and the only place the balance is exposed. */
export interface SkrimeUser {
  email?: string;
  country?: string;
  /** `balance.amount`, the usable balance. */
  amount?: string;
}

export function readSkrimeUser(raw: unknown): SkrimeUser {
  const rec = asRecord(raw) ?? {};
  const profile = asRecord(rec.profile);
  const balance = asRecord(rec.balance);
  return {
    email: asText(rec.email),
    country: profile ? asText(profile.country) : undefined,
    amount: balance ? asMoney(balance.amount) : undefined,
  };
}

/** One row of `GET /product/all`: one subscription of any SKRIME product type. */
export interface SkrimeProduct {
  id?: string;
  type?: string;
  state?: string;
  price?: string;
  discount?: string;
  priceBeforeDiscount?: string;
  /** Billing cycle length in months. */
  duration?: string;
  customName?: string;
  autoRenew?: boolean;
  expireAt?: string;
  deletedAt?: string;
  createdAt?: string;
  /** Attached IPv4 addresses; only `GET /product/search` returns them. */
  ipAddresses: string[];
}

export function readSkrimeProduct(raw: unknown): SkrimeProduct | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const ipAddresses: string[] = [];
  if (Array.isArray(rec.ipv4)) {
    for (const entry of rec.ipv4) {
      const ip = asText(asRecord(entry)?.ipAddress);
      if (ip) ipAddresses.push(ip);
    }
  }
  return {
    id: asText(rec.id),
    type: asText(rec.type),
    state: asText(rec.state),
    price: asMoney(rec.price),
    discount: asMoney(rec.discount),
    priceBeforeDiscount: asMoney(rec.priceBeforeDiscount),
    duration: asMoney(rec.duration),
    customName: asText(rec.customName),
    autoRenew: asBool(rec.autoRenew),
    expireAt: asText(rec.expireAt),
    deletedAt: asText(rec.deletedAt),
    createdAt: asText(rec.createdAt),
    ipAddresses,
  };
}

/** `GET /account/transactions`: service debits (`transaction`) and balance top-ups (`credit`). */
export interface SkrimeTransaction {
  id?: string;
  productId?: string;
  type?: string;
  state?: string;
  amount?: string;
  description?: string;
  invoiceId?: string;
  createdAt?: string;
}

export function readSkrimeTransaction(raw: unknown): SkrimeTransaction | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  return {
    id: asText(rec.id),
    productId: asText(rec.productId),
    type: asText(rec.type),
    state: asText(rec.state),
    amount: asMoney(rec.amount),
    description: asText(rec.description),
    invoiceId: asText(rec.invoiceId),
    createdAt: asText(rec.createdAt),
  };
}

/** Top-level keys of a payload, for the "unexpected response" error text. */
export function describeSkrimeShape(raw: unknown): string {
  const rec = asRecord(raw);
  if (rec) return `keys: ${Object.keys(rec).join(', ') || 'none'}`;
  if (Array.isArray(raw)) return `array of ${raw.length}`;
  return typeof raw;
}

import Decimal from 'decimal.js';
import { z } from 'zod';

// Infomaniak Public Cloud API shapes (https://developer.infomaniak.com/docs/api, machine-readable
// spec at https://developer.infomaniak.com/openapi.json). Only the fields consumed here are typed.
//
// The envelope is validated with zod; the product rows are read field by field instead. The spec
// marks most Product fields `required`, but the live API omits them per service type, returns ids
// and counters as strings (its own examples are quoted, e.g. "1234"), answers `null` for absent
// text, and gates conditional fields behind scopes/`?with=`. A strict row schema made one odd row
// fail the whole sync, so a row is never rejected — an unexpected type only drops that field.

/** Ids, which the API mixes between numbers and strings. */
function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** Unix timestamps and counters, sometimes delivered as numeric strings. */
function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value);
  return undefined;
}

/** Flags that some service types deliver as 0/1 instead of true/false. */
function asBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 0 || value === '0') return false;
  if (value === 1 || value === '1') return true;
  return undefined;
}

/** Text, which the API returns as `null` or `''` instead of omitting. */
function asText(value: unknown): string | undefined {
  const s = typeof value === 'string' ? value.trim() : undefined;
  return s ? s : undefined;
}

/** Every response is wrapped: `{ result, data }`; a failure is `{ result: 'error', error }`. */
export const infomaniakErrorSchema = z.object({
  result: z.string().optional(),
  error: z
    .object({
      code: z.string().optional(),
      description: z.string().optional(),
    })
    .optional(),
});

/** `GET /2/profile` — the credential probe, and where the billing country is read from. */
export const infomaniakProfileSchema = z
  .object({
    current_account_id: z.union([z.number(), z.string()]).optional(),
    preferences: z
      .object({
        current_account_id: z.union([z.number(), z.string()]).optional(),
        country: z
          .object({
            short_name: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** One subscription of any Infomaniak service, as read out of `GET /1/products`. */
export interface InfomaniakProduct {
  id?: string;
  uniqueId?: string;
  accountId?: string;
  serviceId?: string;
  serviceName?: string;
  customerName?: string;
  internalName?: string;
  createdAt?: number;
  expiredAt?: number;
  version?: number;
  isFree?: boolean;
  isZeroPrice?: boolean;
  isTrial?: boolean;
  isLocked?: boolean;
  operationInProgress?: boolean;
  isManagedByPartner?: boolean;
  isTransferable?: boolean;
  billReference?: string;
  description?: string;
  parentServiceName?: string;
  tags?: unknown[];
  /** Returned only with `?with=` / the matching scope. */
  status?: string;
  fqdn?: string;
}

/**
 * Read one product row. Never fails: a row is discarded only when it is not an object at all, so a
 * new, renamed or differently typed field changes what is displayed but can never break a sync.
 */
export function readInfomaniakProduct(raw: unknown): InfomaniakProduct | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  return {
    id: asString(p.id),
    uniqueId: asString(p.unique_id),
    accountId: asString(p.account_id),
    serviceId: asString(p.service_id),
    serviceName: asText(p.service_name),
    customerName: asText(p.customer_name),
    internalName: asText(p.internal_name),
    createdAt: asNumber(p.created_at),
    expiredAt: asNumber(p.expired_at),
    version: asNumber(p.version),
    isFree: asBool(p.is_free),
    isZeroPrice: asBool(p.is_zero_price),
    isTrial: asBool(p.is_trial),
    isLocked: asBool(p.is_locked),
    operationInProgress: asBool(p.has_operation_in_progress),
    isManagedByPartner: asBool(p.is_managed_by_partner),
    isTransferable: asBool(p.is_transferable),
    billReference: asText(p.bill_reference),
    description: asText(p.description),
    parentServiceName: asText(p.parent_service_name),
    tags: Array.isArray(p.tags) ? p.tags : undefined,
    status: asText(p.status),
    fqdn: asText(p.fqdn),
  };
}

// Accepts the documented `{ result, data, ...pagination }` envelope and a bare array, which is what
// the endpoint answers when the pagination counters are left out. Only the container is checked —
// the rows go through `readInfomaniakProduct`, so the sync fails solely when the payload is not a
// list at all.
export const infomaniakProductsResponseSchema = z.preprocess(
  (value) => (Array.isArray(value) ? { data: value } : value),
  z
    .object({
      result: z.string().optional(),
      data: z.array(z.unknown()),
      pages: z.union([z.number(), z.string()]).optional(),
      total: z.union([z.number(), z.string()]).optional(),
      page: z.union([z.number(), z.string()]).optional(),
      items_per_page: z.union([z.number(), z.string()]).optional(),
    })
    .passthrough(),
);

export type InfomaniakProfile = z.infer<typeof infomaniakProfileSchema>;

/**
 * `GET /1/invoicing/{account}/invoice/list` — invoices of one billing account.
 *
 * This route is **not** in the public OpenAPI spec (nor is any other `/1/invoicing/*` route), so
 * nothing here is guaranteed. The field names come from the `woob`/`weboob` Infomaniak billing
 * module, which has parsed Infomaniak's billing JSON since 2017 and was patched against it as
 * recently as 2021 — the only field-verified source in the wild. Everything is read field by field
 * and every field is optional, so when Infomaniak renames something the cost simply goes missing
 * instead of the sync failing.
 */
export interface InfomaniakInvoice {
  /** Invoice number, e.g. `202612345`. */
  number?: string;
  /** Invoice date. The API has delivered this as a unix timestamp. */
  createdAt?: number;
  /** Total incl. tax. */
  amountInclTax?: Decimal;
  /** Amount excl. tax, when the API sends it separately. */
  amount?: Decimal;
  currency?: string;
  /** Paid / cancelled / … — only used to skip invoices that were never charged. */
  status?: string;
  /** Line items, if the payload carries them. Never assumed to exist. */
  lines: InfomaniakInvoiceLine[];
}

/** One billed position of an invoice, when the response exposes them. */
export interface InfomaniakInvoiceLine {
  description?: string;
  /** What the line bills, e.g. `vps`, `cloud`, `domain`. */
  productType?: string;
  /** Product/service reference, used to attach the line to a service. */
  productRef?: string;
  amount?: Decimal;
  currency?: string;
  /** Subscription period the line covers, in months. */
  periodMonths?: number;
}

/** Decimal from anything the API might deliver for money: number, numeric string, or null. */
function asMoney(value: unknown): Decimal | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? new Decimal(value) : undefined;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    return new Decimal(value.trim());
  }
  return undefined;
}

/** Money and currency, which the API nests under `amount` and (older builds) sends flat. */
function readMoney(row: Record<string, unknown>): {
  amount?: Decimal;
  inclTax?: Decimal;
  currency?: string;
} {
  const nested =
    row.amount && typeof row.amount === 'object' && !Array.isArray(row.amount)
      ? (row.amount as Record<string, unknown>)
      : undefined;
  const currency =
    asText(nested?.currency_code) ??
    asText(nested?.currency) ??
    asText(row.currency_code) ??
    asText(row.currency);
  return {
    inclTax: asMoney(nested?.amount_incl_tax) ?? asMoney(row.amount_incl_tax) ?? asMoney(row.total),
    amount: asMoney(nested?.amount) ?? asMoney(row.amount_excl_tax) ?? asMoney(row.amount_ht),
    currency,
  };
}

/** Unix seconds or a date string → Date. */
function readDate(value: unknown): Date | undefined {
  const ts = asNumber(value);
  if (ts != null) {
    // Some builds deliver milliseconds; a plausible invoice is never older than 1990 in seconds.
    const d = new Date(ts > 1e11 ? ts : ts * 1000);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  const s = asText(value);
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * Read one invoice row. Never fails, and returns null only for a row that is not an object — the
 * same rule as products, so an undocumented shape costs a field, never a sync.
 */
export function readInfomaniakInvoice(raw: unknown): InfomaniakInvoice | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  // The verified shape nests the number and the PDF link under `document`.
  const doc =
    p.document && typeof p.document === 'object' && !Array.isArray(p.document)
      ? (p.document as Record<string, unknown>)
      : undefined;
  const money = readMoney(p);
  const linesRaw = Array.isArray(p.lines)
    ? p.lines
    : Array.isArray(p.items)
      ? p.items
      : Array.isArray(p.products)
        ? p.products
        : [];
  const lines: InfomaniakInvoiceLine[] = [];
  for (const rawLine of linesRaw) {
    if (!rawLine || typeof rawLine !== 'object' || Array.isArray(rawLine)) continue;
    const l = rawLine as Record<string, unknown>;
    const lineMoney = readMoney(l);
    lines.push({
      description: asText(l.description) ?? asText(l.label) ?? asText(l.name),
      productType: asText(l.product_type) ?? asText(l.type) ?? asText(l.service_name),
      productRef:
        asText(l.product_id) ?? asText(l.service_id) ?? asText(l.reference) ?? asText(l.unique_id),
      amount: lineMoney.inclTax ?? lineMoney.amount,
      currency: lineMoney.currency ?? money.currency,
      periodMonths: asNumber(l.period) ?? asNumber(l.months) ?? asNumber(l.unit),
    });
  }
  return {
    number: asString(doc?.id) ?? asString(p.id) ?? asString(p.reference) ?? asString(p.number),
    createdAt: readDate(p.created_at)?.getTime(),
    amountInclTax: money.inclTax,
    amount: money.amount,
    currency: money.currency,
    status: asText(p.status) ?? asText(p.state),
    lines,
  };
}

/**
 * Accepts the `{ result, data }` envelope and a bare array, like the products response. Only the
 * container is checked; rows go through `readInfomaniakInvoice`.
 */
export const infomaniakInvoicesResponseSchema = infomaniakProductsResponseSchema;

/** Short summary of a failed parse — enough to tell which field the API changed on. */
export function describeInfomaniakIssue(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || 'body'}: ${i.code}`)
    .join(', ');
}

/** Top-level keys / type of a payload, for the "unexpected response" message. */
export function describeInfomaniakShape(value: unknown): string {
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value && typeof value === 'object') return Object.keys(value).join(',') || 'empty object';
  return typeof value;
}

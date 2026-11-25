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
    preferences: z
      .object({
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

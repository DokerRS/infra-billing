import { z } from 'zod';

// Infomaniak Public Cloud API shapes (https://developer.infomaniak.com/docs/api, machine-readable
// spec at https://developer.infomaniak.com/openapi.json). Only the fields consumed here are typed.
//
// Deliberately loose: the spec marks most Product fields `required`, but the live API omits some of
// them depending on the service type and returns ids as strings as often as numbers (its own
// examples are quoted, e.g. "1234"). A strict schema made the whole sync fail on one odd row, so
// ids are coerced to strings and everything the mapper can live without is optional.

const looseId = z
  .union([z.number(), z.string()])
  .transform((v) => (typeof v === 'number' ? String(v) : v))
  .optional();

/** Pagination counters, which the API sometimes hands back as strings. */
const looseCount = z
  .union([z.number(), z.string().regex(/^\d+$/)])
  .transform((v) => (typeof v === 'number' ? v : Number(v)))
  .optional();

/** Flags that some service types deliver as 0/1 instead of true/false. */
const looseBool = z
  .union([z.boolean(), z.literal(0), z.literal(1), z.literal('0'), z.literal('1')])
  .transform((v) => v === true || v === 1 || v === '1')
  .optional();

/** Text the API sometimes returns as null instead of omitting. */
const looseStr = z
  .union([z.string(), z.null()])
  .transform((v) => v ?? undefined)
  .optional();

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

/** One row of `GET /1/products`: one subscription of any Infomaniak service. */
export const infomaniakProductSchema = z
  .object({
    id: looseId,
    unique_id: looseId,
    account_id: looseId,
    service_id: looseId,
    service_name: looseStr,
    customer_name: looseStr,
    internal_name: looseStr,
    created_at: looseCount,
    expired_at: z
      .union([z.number(), z.string().regex(/^\d+$/)])
      .nullable()
      .transform((v) => (typeof v === 'string' ? Number(v) : v))
      .optional(),
    version: looseCount,
    is_free: looseBool,
    is_zero_price: looseBool,
    is_trial: looseBool,
    is_locked: looseBool,
    has_operation_in_progress: looseBool,
    bill_reference: looseStr,
    description: looseStr,
    parent_service_name: looseStr,
    is_managed_by_partner: looseBool,
    is_transferable: looseBool,
    tags: z.array(z.unknown()).nullish(),
    // Returned only with `?with=`: kept optional so a scope-restricted token still parses.
    status: looseStr,
    fqdn: looseStr,
  })
  .passthrough();

// Accepts the documented `{ result, data, ...pagination }` envelope and a bare array, which is what
// the endpoint answers when the pagination counters are left out.
export const infomaniakProductsResponseSchema = z.preprocess(
  (value) => (Array.isArray(value) ? { data: value } : value),
  z.object({
    result: z.string().optional(),
    data: z.array(infomaniakProductSchema),
    total: looseCount,
    page: looseCount,
    pages: looseCount,
    items_per_page: looseCount,
  }),
);

export type InfomaniakProfile = z.infer<typeof infomaniakProfileSchema>;
export type InfomaniakProduct = z.infer<typeof infomaniakProductSchema>;

/** Short summary of a failed parse — enough to tell which field the API changed on. */
export function describeInfomaniakIssue(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || 'body'}: ${i.code}`)
    .join(', ');
}

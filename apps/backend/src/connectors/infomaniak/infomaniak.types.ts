import { z } from 'zod';

// Infomaniak Public Cloud API shapes (https://developer.infomaniak.com/docs/api, machine-readable
// spec at https://developer.infomaniak.com/openapi.json). Only the fields consumed here are typed.

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
    id: z.number().optional(),
    display_name: z.string().optional(),
    email: z.string().optional(),
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
    id: z.number(),
    unique_id: z.number().optional(),
    account_id: z.number().optional(),
    service_id: z.number().optional(),
    service_name: z.string(),
    customer_name: z.string(),
    internal_name: z.string().nullable().optional(),
    created_at: z.number().optional(),
    expired_at: z.number().nullable().optional(),
    version: z.number().optional(),
    is_free: z.boolean().optional(),
    is_zero_price: z.boolean().optional(),
    is_trial: z.boolean().optional(),
    is_locked: z.boolean().optional(),
    has_operation_in_progress: z.boolean().optional(),
    bill_reference: z.string().optional(),
    description: z.string().optional(),
    parent_service_name: z.string().optional(),
    is_managed_by_partner: z.boolean().optional(),
    is_transferable: z.boolean().optional(),
    tags: z.array(z.unknown()).optional(),
    // Returned only with `?with=`: kept optional so a scope-restricted token still parses.
    status: z.string().optional(),
    fqdn: z.string().optional(),
  })
  .passthrough();

export const infomaniakProductsResponseSchema = z.object({
  result: z.string().optional(),
  data: z.array(infomaniakProductSchema),
  total: z.number().optional(),
  page: z.number().optional(),
  pages: z.number().optional(),
  items_per_page: z.number().optional(),
});

export type InfomaniakProfile = z.infer<typeof infomaniakProfileSchema>;
export type InfomaniakProduct = z.infer<typeof infomaniakProductSchema>;

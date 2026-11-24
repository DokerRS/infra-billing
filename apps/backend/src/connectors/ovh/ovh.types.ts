import { z } from 'zod';

// OVHcloud API v1 (self-describing schemas at https://api.ovh.com/1.0/{me,services}.json).
// Only the fields the connector reads are declared; zod strips the rest, so anything OVH adds
// later cannot reach the mapper, the database or the logs.

/**
 * Official API endpoints. The request signature is hashed over the full URL, so the endpoint
 * belongs to the credentials: a free-form value would let a hostile base URL leak the application
 * secret into a hash an attacker controls. Hence a hard allowlist.
 * (`ca.api.ovhcloud.com` is deliberately absent — it does not answer TLS.)
 */
export const OVH_ENDPOINTS = [
  'https://api.ovh.com/1.0',
  'https://api.eu.ovhcloud.com/1.0',
  'https://ca.api.ovh.com/1.0',
  'https://api.ca.ovhcloud.com/1.0',
  'https://api.us.ovhcloud.com/1.0',
] as const;
export type OvhEndpoint = (typeof OVH_ENDPOINTS)[number];
export const OVH_DEFAULT_ENDPOINT: OvhEndpoint = OVH_ENDPOINTS[0];

export function isOvhEndpoint(value: string): value is OvhEndpoint {
  return (OVH_ENDPOINTS as readonly string[]).includes(value);
}

export interface OvhCredentials {
  applicationKey: string;
  applicationSecret: string;
  consumerKey: string;
  /** One of OVH_ENDPOINTS; the account's subsidiary decides which one holds the data. */
  baseUrl?: string;
}

/**
 * `order.Price`: OVH's money envelope. `value` is the decimal amount, `priceInUcents` the same
 * amount in micro-centimes (1e-8 of a unit), `currencyCode` is an OVH enum that also carries the
 * placeholders "N/A" and "points" for priceless or loyalty-priced lines.
 */
export const ovhPriceSchema = z.object({
  value: z.number().nullish(),
  currencyCode: z.string().nullish(),
  priceInUcents: z.number().nullish(),
  text: z.string().nullish(),
});
export type OvhPrice = z.infer<typeof ovhPriceSchema>;

/** GET /me → nichandle.Nichandle (identity, account currency, subsidiary). */
export const ovhAccountDetailsSchema = z.object({
  nichandle: z.string().nullish(),
  email: z.string().nullish(),
  country: z.string().nullish(),
  currency: z.string().nullish(),
  ovhCompany: z.string().nullish(),
  ovhSubsidiary: z.string().nullish(),
});
export type OvhAccountDetails = z.infer<typeof ovhAccountDetailsSchema>;

/** GET /me/ovhAccount/{id} → billing.OvhAccount (prepaid balance). */
export const ovhBalanceSchema = z.object({
  ovhAccountId: z.string().nullish(),
  balance: ovhPriceSchema.nullish(),
  isActive: z.boolean().nullish(),
});
export type OvhBalance = z.infer<typeof ovhBalanceSchema>;

/** GET /services/{id} → services.expanded.Service. Carries pricing, so one call per service. */
export const ovhServiceSchema = z.object({
  serviceId: z.number().int(),
  parentServiceId: z.number().int().nullish(),
  tags: z.array(z.string()).nullish(),
  resource: z
    .object({
      displayName: z.string().nullish(),
      name: z.string().nullish(),
      state: z.string().nullish(),
      resellingProvider: z.string().nullish(),
      product: z
        .object({ name: z.string().nullish(), description: z.string().nullish() })
        .nullish(),
    })
    .nullish(),
  route: z
    .object({
      path: z.string().nullish(),
      vars: z.array(z.object({ key: z.string(), value: z.string() })).nullish(),
    })
    .nullish(),
  billing: z
    .object({
      nextBillingDate: z.string().nullish(),
      expirationDate: z.string().nullish(),
      plan: z.object({ code: z.string().nullish(), invoiceName: z.string().nullish() }).nullish(),
      renew: z
        .object({
          current: z
            .object({
              mode: z.string().nullish(),
              nextDate: z.string().nullish(),
              /** ISO-8601 duration actually configured for the next renewal. */
              period: z.string().nullish(),
            })
            .nullish(),
        })
        .nullish(),
      lifecycle: z
        .object({
          current: z
            .object({
              creationDate: z.string().nullish(),
              state: z.string().nullish(),
              terminationDate: z.string().nullish(),
            })
            .nullish(),
        })
        .nullish(),
      pricing: z
        .object({
          price: ovhPriceSchema.nullish(),
          priceInUcents: z.number().nullish(),
          /** ISO-8601 renew interval of this pricing. */
          duration: z.string().nullish(),
          pricingType: z.string().nullish(),
          description: z.string().nullish(),
        })
        .nullish(),
    })
    .nullish(),
});
export type OvhService = z.infer<typeof ovhServiceSchema>;

/** GET /me/bill/{billId} → billing.Bill. */
export const ovhBillSchema = z.object({
  billId: z.string(),
  date: z.string().nullish(),
  category: z.string().nullish(),
  orderId: z.number().int().nullish(),
  priceWithTax: ovhPriceSchema.nullish(),
});
export type OvhBill = z.infer<typeof ovhBillSchema>;

/** GET /me/ovhAccount/{id}/movements/{movementId} → billing.Movement. */
export const ovhMovementSchema = z.object({
  movementId: z.number().int(),
  amount: ovhPriceSchema.nullish(),
  date: z.string().nullish(),
  description: z.string().nullish(),
  operation: z.string().nullish(), // credit | debit | pre-credit | pre-debit | cancel-*
  order: z.number().int().nullish(),
});
export type OvhMovement = z.infer<typeof ovhMovementSchema>;

/** Error body: { class, message }. */
export const ovhErrorSchema = z.object({
  class: z.string().optional(),
  message: z.string().optional(),
});

export const ovhIdListSchema = z.array(z.number().int());
export const ovhBillIdListSchema = z.array(z.string());

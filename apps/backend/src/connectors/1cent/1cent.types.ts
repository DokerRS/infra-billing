import { z } from 'zod';

// 1Cent.host client API (https://bill.1cent.host/api/docs). Only the fields the connector uses are
// declared; zod strips the rest, so anything the API adds later never reaches the mapper, the
// database or the logs. Money is a string with two decimals ("470.00"), time is ISO 8601 UTC.

const money = z.string().regex(/^-?\d+(\.\d+)?$/);
/** Ledger amounts are signed: "+200.00" for a top-up, "-470.00" for a charge. */
const signedMoney = z.string().regex(/^[+-]?\d+(\.\d+)?$/);

export const cent1AccountSchema = z.object({
  balance: money,
  currency: z.string().nullish(),
});

export const cent1ServiceSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  productType: z.string().nullish(), // VPS is the only kind the client API sells
  tariff: z.object({ code: z.string().nullish(), name: z.string().nullish() }).nullish(),
  datacenter: z.object({ code: z.string().nullish(), name: z.string().nullish() }).nullish(),
  status: z.string().nullish(), // ACTIVE / SUSPENDED / ...
  periodMonths: z.number().int().positive().nullish(),
  autoRenew: z.boolean().nullish(),
  expiresAt: z.string().nullish(),
  resources: z
    .object({
      cpuCores: z.number().nullish(),
      ramMib: z.number().nullish(),
      diskGib: z.number().nullish(),
      trafficGib: z.number().nullish(),
      bandwidthMbit: z.number().nullish(),
    })
    .nullish(),
  addons: z.record(z.string(), z.number()).nullish(),
  osImage: z.string().nullish(),
  ipv4: z.string().nullish(),
  createdAt: z.string().nullish(),
  /** Price of the next renewal, personal discounts included. */
  renewalPrice: money.nullish(),
  /** Absent when auto-renew is off; then `expiresAt` is the date the service runs out. */
  nextCharge: z.object({ amount: money.nullish(), at: z.string().nullish() }).nullish(),
});

/** GET /api/services returns a bare array (no envelope, no pagination). */
export const cent1ServicesSchema = z.array(cent1ServiceSchema);

export const cent1TransactionSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['DEPOSIT', 'CHARGE', 'CREDIT']),
  signedAmount: signedMoney,
  description: z.string().nullish(),
  serviceId: z.string().nullish(),
  createdAt: z.string(),
});

/** GET /api/account/transactions envelope (the API caps `pageSize` at 100). */
export const cent1TransactionsPageSchema = z.object({
  items: z.array(cent1TransactionSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});

/** Error body: { statusCode, message }; `message` is a list on field errors. */
export const cent1ErrorSchema = z.object({
  message: z.union([z.string(), z.array(z.string())]).optional(),
});

export type Cent1Account = z.infer<typeof cent1AccountSchema>;
export type Cent1Service = z.infer<typeof cent1ServiceSchema>;
export type Cent1Transaction = z.infer<typeof cent1TransactionSchema>;

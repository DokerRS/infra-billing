import Decimal from 'decimal.js';
import { PaymentData, ServiceData } from '../connector.interface';
import { OvhBill, OvhMovement, OvhPrice, OvhService } from './ovh.types';

/**
 * OVH accounts are priced in their subsidiary's currency (EUR for most of Europe, USD, GBP, CAD...).
 * EUR is the safer default when neither a price envelope nor /me carries a usable code.
 */
export const OVH_FALLBACK_CURRENCY = 'EUR';

/** OVH's `currencyCode` placeholders that are not currencies. */
const NON_CURRENCIES = new Set(['N/A', 'POINTS', '']);

/** Currency of a price envelope, or the fallback when it carries a placeholder. */
export function ovhPriceCurrency(price: OvhPrice | null | undefined, fallback: string): string {
  const code = price?.currencyCode?.trim().toUpperCase();
  return code && !NON_CURRENCIES.has(code) ? code : fallback;
}

function parseDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * OVH money arrives as `order.Price`. `priceInUcents` (1e-8 of a unit) is exact while `value` is a
 * double, so prefer the integer: 4.99 stays 4.99 instead of 4.9899999999999998.
 */
export function ovhPriceValue(price: OvhPrice | null | undefined): Decimal | null {
  if (!price) return null;
  if (price.priceInUcents != null) return new Decimal(price.priceInUcents).div(1e8);
  if (price.value != null) return new Decimal(price.value);
  return null;
}

/** How many months a supported period label spans. */
const PERIOD_MONTHS: Record<string, Decimal> = {
  hourly: new Decimal(1).div(720),
  daily: new Decimal(1).div(30),
  monthly: new Decimal(1),
  quarterly: new Decimal(3),
  yearly: new Decimal(12),
};

/**
 * OVH spells billing cycles as ISO-8601 durations ("P1M", "P3M", "P1Y", "P1D", "PT1H"). Cycles we
 * don't model (half a year, two years) collapse to the nearest supported label and keep their real
 * length in `months`, so the caller can pro-rate the price onto the label it reports.
 */
export function resolveOvhPeriod(duration: string | null | undefined): {
  period: string;
  months: Decimal;
} | null {
  if (!duration) return null;
  const m =
    /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(
      duration.trim(),
    );
  if (!m) return null;
  const [, years, months, weeks, days, hours, minutes, seconds] = m;
  const n = (v: string | undefined) => Number(v ?? 0);
  const totalMonths =
    n(years) * 12 +
    n(months) +
    n(weeks) / 4.345 +
    n(days) / 30.44 +
    n(hours) / 720 +
    n(minutes) / 43200;
  if (totalMonths <= 0) {
    // "PT0S"/"P0D" is how OVH marks consumption-based products: no recurring cycle at all.
    return n(seconds) > 0 ? { period: 'onetime', months: new Decimal(1) } : null;
  }
  if (totalMonths >= 12) return { period: 'yearly', months: new Decimal(totalMonths) };
  if (totalMonths >= 3) return { period: 'quarterly', months: new Decimal(totalMonths) };
  if (totalMonths >= 1) return { period: 'monthly', months: new Decimal(totalMonths) };
  if (totalMonths >= 1 / 30) return { period: 'daily', months: new Decimal(totalMonths) };
  return { period: 'hourly', months: new Decimal(totalMonths) };
}

/**
 * Product kind from the expanded-service route (`/vps/{serviceName}`, `/hosting/web/{id}`...) or,
 * when there is no route, from the plan code prefix. Unrecognised products keep OVH's own segment
 * as the type — the panel renders unknown types as free-form labels.
 */
const TYPE_BY_SEGMENT: Record<string, string> = {
  vps: 'vps',
  dedicated: 'dedicated',
  dedicatedserver: 'dedicated',
  hosting: 'hosting',
  web: 'hosting',
  domain: 'domain',
  cdn: 'cdn',
  storage: 'storage',
  database: 'db',
  db: 'db',
  pci: 'other',
  cloud: 'other',
  license: 'license',
  ssl: 'license',
  email: 'other',
  telephony: 'other',
  sms: 'other',
  ip: 'other',
  vrail: 'other',
};

function typeOf(s: OvhService): string {
  const path = s.route?.path ?? '';
  const segments = path
    .split('/')
    .filter((seg) => seg.length > 0 && !seg.startsWith('{') && !seg.startsWith(':'));
  for (const seg of segments) {
    const mapped = TYPE_BY_SEGMENT[seg.toLowerCase()];
    if (mapped) return mapped;
  }
  const last = segments[segments.length - 1];
  if (last) return last.toLowerCase();
  const head = (s.billing?.plan?.code ?? '').split(/[./_-]/)[0]?.toLowerCase() ?? '';
  return TYPE_BY_SEGMENT[head] ?? (head || 'other');
}

/** Two-letter country from the region/datacenter route var OVH attaches to region-scoped products. */
function countryOf(s: OvhService): string | undefined {
  for (const v of s.route?.vars ?? []) {
    const key = v.key.toLowerCase();
    if (key !== 'region' && key !== 'datacenter' && key !== 'country') continue;
    const head = v.value.toLowerCase().split(/[-_.]/)[0];
    if (/^[a-z]{2}$/.test(head)) return head.toUpperCase();
  }
  return undefined;
}

export function mapOvhService(s: OvhService, accountCurrency: string): ServiceData {
  const pricing = s.billing?.pricing;
  const currency = ovhPriceCurrency(pricing?.price, accountCurrency);
  const rawCost = ovhPriceValue(pricing?.price);
  const cycle = resolveOvhPeriod(pricing?.duration ?? s.billing?.renew?.current?.period);
  // `pricing.price` is the price of one `pricing.duration`; scale it onto the label we report.
  let cost: Decimal | undefined;
  const labelMonths = cycle ? PERIOD_MONTHS[cycle.period] : undefined;
  if (rawCost && cycle && labelMonths) cost = rawCost.mul(labelMonths).div(cycle.months);
  const nextBilling =
    parseDate(s.billing?.nextBillingDate) ??
    parseDate(s.billing?.renew?.current?.nextDate) ??
    parseDate(s.billing?.expirationDate);
  const name = s.resource?.displayName?.trim() || s.resource?.name?.trim() || String(s.serviceId);
  return {
    externalId: String(s.serviceId),
    name,
    type: typeOf(s),
    countryCode: countryOf(s),
    cost,
    currency,
    period: cycle?.period,
    nextBilling,
    // Explicit allowlist: never persist raw API payloads.
    meta: {
      serviceId: s.serviceId,
      product: s.resource?.product?.name ?? null,
      productName: s.resource?.product?.description ?? null,
      resourceName: s.resource?.name ?? null,
      state: s.resource?.state ?? null,
      plan: s.billing?.plan?.code ?? null,
      invoiceName: s.billing?.plan?.invoiceName ?? null,
      renewMode: s.billing?.renew?.current?.mode ?? null,
      renewPeriod: s.billing?.renew?.current?.period ?? null,
      pricingType: pricing?.pricingType ?? null,
      pricingDescription: pricing?.description ?? null,
      expirationDate: s.billing?.expirationDate ?? null,
      terminationDate: s.billing?.lifecycle?.current?.terminationDate ?? null,
      createdAt: s.billing?.lifecycle?.current?.creationDate ?? null,
      resellingProvider: s.resource?.resellingProvider ?? null,
      tags: s.tags ?? [],
    },
  };
}

/**
 * A bill is money that left the account → `charge`. Bills are not linked to a single service (one
 * bill can cover many), so they stay unlinked and OVH's category goes into the description.
 */
export function mapOvhBill(bill: OvhBill, accountCurrency: string): PaymentData | null {
  const amount = ovhPriceValue(bill.priceWithTax);
  const date = parseDate(bill.date);
  if (!amount || amount.isZero() || !date) return null;
  return {
    externalId: `bill:${bill.billId}`,
    type: 'charge',
    amount,
    currency: ovhPriceCurrency(bill.priceWithTax, accountCurrency),
    date,
    description: bill.category ? `Bill ${bill.billId} (${bill.category})` : `Bill ${bill.billId}`,
  };
}

/**
 * Money that came *into* the balance (a top-up, a refund, a voucher). Only `credit` rows are kept:
 * a `debit` is the balance paying a bill, and that same money is already imported as a `bill:`
 * charge, so importing both would double-count the spend. `pre-credit`/`pre-debit` are
 * reservations and `cancel-*` reverse an already-recorded row — none of them are settled cash.
 */
export function mapOvhMovement(m: OvhMovement, accountCurrency: string): PaymentData | null {
  if ((m.operation ?? '').trim().toLowerCase() !== 'credit') return null;
  const amount = ovhPriceValue(m.amount);
  const date = parseDate(m.date);
  if (!amount || amount.isZero() || !date) return null;
  return {
    externalId: `movement:${m.movementId}`,
    type: 'topup',
    amount,
    currency: ovhPriceCurrency(m.amount, accountCurrency),
    date,
    description: m.description ?? undefined,
  };
}

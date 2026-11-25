import Decimal from 'decimal.js';
import { PaymentData, ServiceData } from '../connector.interface';
import { InfomaniakInvoice, InfomaniakInvoiceLine, InfomaniakProduct } from './infomaniak.types';

const DAY_MS = 86_400_000;

function fromUnix(ts?: number): Date | null {
  if (ts == null) return null;
  const d = new Date(ts * 1000);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Statuses of a line that never charged the account. A denylist — see `mapInfomaniakInvoice`. */
const UNCHARGED_STATUSES = [
  'cancelled',
  'canceled',
  'void',
  'draft',
  'aborted',
  'refused',
  'rejected',
];

export function isChargedInfomaniakLine(line: InfomaniakInvoiceLine): boolean {
  const status = line.status?.toLowerCase();
  return !status || !UNCHARGED_STATUSES.includes(status);
}

/**
 * The cycle a line bills for. `/1/products` carries no price, but an invoice line does, and it
 * states the period it covers — either as a month count or as a start/end pair in
 * `amount.period`. A period the panel does not model becomes the equivalent monthly figure.
 */
export function resolveInfomaniakBilling(line: InfomaniakInvoiceLine): {
  period: string;
  cost: Decimal;
} | null {
  const price = line.amount?.abs();
  if (!price || price.isZero() || !price.isFinite()) return null;

  const months = line.periodMonths;
  if (months != null && months > 0) {
    if (months === 1) return { period: 'monthly', cost: price };
    if (months === 3) return { period: 'quarterly', cost: price };
    if (months === 12) return { period: 'yearly', cost: price };
    return { period: 'monthly', cost: price.div(months) };
  }

  const start = line.periodStart;
  const end = line.periodEnd;
  if (start != null && end != null && end > start) {
    const days = (end - start) / DAY_MS;
    if (days >= 28 && days <= 31) return { period: 'monthly', cost: price };
    if (days >= 89 && days <= 92) return { period: 'quarterly', cost: price };
    if (days >= 360 && days <= 366) return { period: 'yearly', cost: price };
    return { period: 'monthly', cost: price.mul(30).div(days).toDecimalPlaces(2) };
  }
  return { period: 'monthly', cost: price };
}

/**
 * The line that prices each product, keyed by the product id the line bills (`item_id`).
 *
 * A renewal is billed once per cycle, so the newest dated invoice that mentions a product is the one
 * that states what it currently costs. Lines without a product reference or without an amount are
 * ignored, and an invoice without a date cannot be ordered, so it is skipped.
 */
export function latestInfomaniakLinesByProduct(
  invoices: InfomaniakInvoice[],
): Map<string, InfomaniakInvoiceLine> {
  const newest = new Map<string, { at: number; line: InfomaniakInvoiceLine }>();
  for (const inv of invoices) {
    if (inv.createdAt == null) continue;
    for (const line of inv.lines) {
      if (!line.productRef || !line.amount) continue;
      if (!isChargedInfomaniakLine(line)) continue;
      const prev = newest.get(line.productRef);
      if (!prev || inv.createdAt >= prev.at)
        newest.set(line.productRef, { at: inv.createdAt, line });
    }
  }
  return new Map([...newest].map(([ref, { line }]) => [ref, line]));
}

/**
 * An invoice bills a whole billing account at once, so it is imported as a `charge` and linked to a
 * service only when it has exactly one line. The line's product id is translated into the service's
 * externalId by the connector, since `/1/products` keys a product by `unique_id`, not by `id`.
 */
export function mapInfomaniakInvoice(inv: InfomaniakInvoice): PaymentData | null {
  if (!inv.number) return null;
  const date = inv.createdAt != null ? new Date(inv.createdAt) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  // A cancelled/draft invoice never charged the account. Deliberately a denylist: the status
  // vocabulary of this undocumented route is unverified, and dropping a real charge because of an
  // unknown word would hide spend.
  const status = inv.status?.toLowerCase();
  if (status && UNCHARGED_STATUSES.includes(status)) {
    return null;
  }
  const amount = (inv.amountInclTax ?? inv.amount)?.abs();
  if (!amount || amount.isZero() || !amount.isFinite()) return null;
  const lines = inv.lines.filter(isChargedInfomaniakLine);
  const onlyLine = lines.length === 1 && inv.lines.length === 1 ? lines[0] : undefined;
  return {
    externalId: `invoice:${inv.number}`,
    type: 'charge',
    amount,
    currency: inv.currency ?? 'EUR',
    date,
    description: `Infomaniak invoice ${inv.number}`,
    serviceExternalId: onlyLine?.productRef,
  };
}

/**
 * Map an Infomaniak product to our Service. The product payload exposes no price, so the cost comes
 * from the invoice ledger: `line` is the product's most recent billed position, matched by product
 * id. Without it (no `invoicing:invoice:read` scope, or a product that was never billed) cost stays
 * unset for the owner to fill in. `expired_at` is the renewal date, and `service_name` is the
 * product class used as the service type.
 */
export function mapInfomaniakProduct(
  p: InfomaniakProduct,
  line?: InfomaniakInvoiceLine,
): ServiceData {
  const externalId = p.uniqueId ?? p.id;
  const name =
    p.customerName || p.internalName || `${p.serviceName ?? 'product'} #${externalId ?? '?'}`;
  const billing = line ? resolveInfomaniakBilling(line) : null;
  return {
    externalId: externalId ?? `product-${name}`,
    name,
    type: p.serviceName ?? 'product',
    cost: billing?.cost,
    currency: billing ? line?.currency : undefined,
    period: billing?.period,
    nextBilling: fromUnix(p.expiredAt),
    meta: {
      serviceId: p.serviceId ?? null,
      accountId: p.accountId ?? null,
      productName: p.internalName ?? null,
      isFree: p.isFree ?? null,
      isTrial: p.isTrial ?? null,
      isZeroPrice: p.isZeroPrice ?? null,
      isLocked: p.isLocked ?? null,
      operationInProgress: p.operationInProgress ?? null,
      ...(billing ? { billedPeriod: billing.period } : {}),
      ...(line?.description ? { billDescription: line.description } : {}),
      ...(p.status ? { status: p.status } : {}),
      ...(p.fqdn ? { fqdn: p.fqdn } : {}),
      ...(p.description ? { description: p.description } : {}),
      ...(p.billReference ? { billReference: p.billReference } : {}),
      ...(p.parentServiceName ? { parentServiceName: p.parentServiceName } : {}),
      ...(p.tags?.length ? { tags: p.tags } : {}),
    },
  };
}

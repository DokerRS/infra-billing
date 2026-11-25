import { PaymentData, ServiceData } from '../connector.interface';
import { InfomaniakInvoice, InfomaniakProduct } from './infomaniak.types';

function fromUnix(ts?: number): Date | null {
  if (ts == null) return null;
  const d = new Date(ts * 1000);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * An invoice bills a whole billing account at once and the payload carries no per-product prices,
 * so it is imported as a `charge` that is only linked to a service when the invoice has exactly one
 * line. That is still the only way Infomaniak's real spend becomes visible, since the API publishes
 * no per-product price.
 */
export function mapInfomaniakInvoice(inv: InfomaniakInvoice): PaymentData | null {
  if (!inv.number) return null;
  const date = inv.createdAt != null ? new Date(inv.createdAt) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  // A cancelled/draft invoice never charged the account. Deliberately a denylist: the status
  // vocabulary of this undocumented route is unverified, and dropping a real charge because of an
  // unknown word would hide spend.
  const status = inv.status?.toLowerCase();
  if (
    status &&
    ['cancelled', 'canceled', 'void', 'draft', 'aborted', 'refused', 'rejected'].includes(status)
  ) {
    return null;
  }
  const amount = (inv.amountInclTax ?? inv.amount)?.abs();
  if (!amount || amount.isZero() || !amount.isFinite()) return null;
  const onlyLine = inv.lines.length === 1 ? inv.lines[0] : undefined;
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
 * Map an Infomaniak product to our Service. The API exposes no renewal price for a product
 * (only per-catalogue calculators), so cost stays unset for the owner to fill in; `expired_at`
 * is the renewal date, and `service_name` is the product class used as the service type.
 */
export function mapInfomaniakProduct(p: InfomaniakProduct): ServiceData {
  const externalId = p.uniqueId ?? p.id;
  const name =
    p.customerName || p.internalName || `${p.serviceName ?? 'product'} #${externalId ?? '?'}`;
  return {
    externalId: externalId ?? `product-${name}`,
    name,
    type: p.serviceName ?? 'product',
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
      ...(p.status ? { status: p.status } : {}),
      ...(p.fqdn ? { fqdn: p.fqdn } : {}),
      ...(p.description ? { description: p.description } : {}),
      ...(p.billReference ? { billReference: p.billReference } : {}),
      ...(p.parentServiceName ? { parentServiceName: p.parentServiceName } : {}),
      ...(p.tags?.length ? { tags: p.tags } : {}),
    },
  };
}

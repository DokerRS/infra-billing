import { ServiceData } from '../connector.interface';
import { InfomaniakProduct } from './infomaniak.types';

function fromUnix(ts?: number | null): Date | null {
  if (ts == null) return null;
  const d = new Date(ts * 1000);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Map an Infomaniak product to our Service. The API exposes no renewal price for a product
 * (only per-catalogue calculators), so cost stays unset for the owner to fill in; `expired_at`
 * is the renewal date, and `service_name` is the product class used as the service type.
 */
export function mapInfomaniakProduct(p: InfomaniakProduct): ServiceData {
  const externalId = p.unique_id ?? p.id;
  const name =
    p.customer_name || p.internal_name || `${p.service_name ?? 'product'} #${externalId ?? '?'}`;
  return {
    externalId: externalId ?? `product-${name}`,
    name,
    type: p.service_name ?? 'product',
    nextBilling: fromUnix(p.expired_at),
    meta: {
      serviceId: p.service_id,
      accountId: p.account_id,
      productName: p.internal_name ?? null,
      isFree: p.is_free,
      isTrial: p.is_trial,
      isZeroPrice: p.is_zero_price,
      isLocked: p.is_locked,
      operationInProgress: p.has_operation_in_progress,
      ...(p.status ? { status: p.status } : {}),
      ...(p.fqdn ? { fqdn: p.fqdn } : {}),
      ...(p.description ? { description: p.description } : {}),
      ...(p.bill_reference ? { billReference: p.bill_reference } : {}),
      ...(p.parent_service_name ? { parentServiceName: p.parent_service_name } : {}),
      ...(p.tags?.length ? { tags: p.tags } : {}),
    },
  };
}

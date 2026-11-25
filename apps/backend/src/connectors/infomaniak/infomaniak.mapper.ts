import { ServiceData } from '../connector.interface';
import { InfomaniakProduct } from './infomaniak.types';

function fromUnix(ts?: number): Date | null {
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

import Decimal from 'decimal.js';
import { PaymentData, ServiceData } from '../connector.interface';
import { SkrimeProduct, SkrimeTransaction } from './skrime.types';

/** SKRIME is a German reseller; the spec states its prices are in EUR. */
export const SKRIME_FALLBACK_CURRENCY = 'EUR';

// Product types of the API (server, dedicated, instance, webspace, domain, dns, ssl,
// proxmox-backup, ipv4, ipv6, asn, status). Anything unknown keeps its own name as the type.
const SERVICE_TYPE_BY_PRODUCT: Record<string, string> = {
  server: 'vps',
  dedicated: 'dedicated',
  domain: 'domain',
  webspace: 'hosting',
  instance: 'other',
  dns: 'dns',
  ssl: 'certificate',
  'proxmox-backup': 'backup',
  ipv4: 'network',
  ipv6: 'network',
  asn: 'network',
  status: 'monitoring',
};

/** "2024-01-01 00:00:00" (no zone) → a Date; anything unparseable becomes null. */
function parseDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d;
}

function money(raw: string | undefined): Decimal | undefined {
  if (!raw) return undefined;
  try {
    const value = new Decimal(raw);
    return value.isFinite() ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `price` is what one billing cycle costs and `duration` is that cycle in months ("1", "12"), so a
 * longer cycle is pro-rated down to the monthly cost the panel aggregates.
 */
export function resolveSkrimeBilling(p: SkrimeProduct): { period: string; cost: Decimal } | null {
  const price = money(p.price);
  if (!price || price.isZero()) return null;
  const months = Number(p.duration);
  if (!Number.isFinite(months) || months <= 1) {
    return { period: 'monthly', cost: price };
  }
  if (months === 12) return { period: 'yearly', cost: price };
  if (months === 3) return { period: 'quarterly', cost: price };
  return { period: 'monthly', cost: price.div(months) };
}

export function mapSkrimeProduct(p: SkrimeProduct, currency: string): ServiceData | null {
  if (!p.id) return null;
  const billing = resolveSkrimeBilling(p);
  // With auto-renew off nothing is charged on the expiry date, but that is still when it runs out.
  const nextBilling = parseDate(p.expireAt);
  const type = SERVICE_TYPE_BY_PRODUCT[p.type ?? ''] ?? (p.type || 'other');
  return {
    externalId: p.id,
    name: p.customName || `${p.type ?? 'product'} ${p.id.slice(0, 8)}`,
    type,
    cost: billing?.cost,
    currency,
    period: billing?.period,
    nextBilling,
    // Explicit allowlist: never persist the raw API row.
    meta: {
      productType: p.type ?? null,
      state: p.state ?? null,
      price: p.price ?? null,
      discount: p.discount ?? null,
      durationMonths: p.duration ?? null,
      autoRenew: p.autoRenew ?? null,
      expireAt: p.expireAt ?? null,
      createdAt: p.createdAt ?? null,
      ...(p.ipAddresses.length ? { ip: p.ipAddresses[0] } : {}),
    },
  };
}

/**
 * A `credit` row is a top-up of the balance, a `transaction` row a debit for one product. Amounts
 * come unsigned from the API, so the row type alone decides the direction.
 */
export function mapSkrimeTransaction(t: SkrimeTransaction, currency: string): PaymentData | null {
  if (!t.id || !t.createdAt) return null;
  const date = parseDate(t.createdAt);
  if (!date) return null;
  const amount = money(t.amount)?.abs();
  if (!amount || amount.isZero()) return null;
  // A failed top-up never moved money.
  if (t.state && t.state !== 'success' && t.state !== 'paid') return null;
  const type = t.type === 'credit' ? 'topup' : 'charge';
  return {
    externalId: `transaction:${t.id}`,
    type,
    amount,
    currency,
    date,
    description: t.description || undefined,
    serviceExternalId: type === 'charge' ? t.productId : undefined,
  };
}

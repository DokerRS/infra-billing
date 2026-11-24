import Decimal from 'decimal.js';
import { PaymentData, ServiceData } from '../connector.interface';
import { Cent1Service, Cent1Transaction } from './1cent.types';

/** 1Cent.host bills in RUB. */
export const CENT1_FALLBACK_CURRENCY = 'RUB';

// Datacenter codes are not ISO country codes (`fi-hicpu`, `nl`). Unknown/new codes stay unset.
const COUNTRY_BY_DATACENTER: Record<string, string> = {
  nl: 'NL',
  de: 'DE',
  se: 'SE',
  'fi-hicpu': 'FI',
  ru: 'RU',
};

/** `fi-hicpu` and friends carry the ISO code as their first segment. */
function countryOf(code: string | null | undefined): string | undefined {
  if (!code) return undefined;
  const key = code.toLowerCase();
  if (COUNTRY_BY_DATACENTER[key]) return COUNTRY_BY_DATACENTER[key];
  const head = key.split('-')[0];
  return /^[a-z]{2}$/.test(head) ? head.toUpperCase() : undefined;
}

function parseDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Billing cycles we don't model (half a year) collapse to the nearest one with a pro-rated cost.
 * `renewalPrice` is what the next renewal costs, so it is the cost of `periodMonths` months.
 */
export function resolveCent1Billing(
  s: Cent1Service,
): { period: string; cost: Decimal } | undefined {
  if (!s.renewalPrice) return undefined;
  const price = new Decimal(s.renewalPrice);
  switch (s.periodMonths ?? 1) {
    case 1:
      return { period: 'monthly', cost: price };
    case 3:
      return { period: 'quarterly', cost: price };
    case 12:
      return { period: 'yearly', cost: price };
    case 6:
      return { period: 'monthly', cost: price.div(6) };
    default:
      return { period: 'monthly', cost: price.div(s.periodMonths ?? 1) };
  }
}

export function mapCent1Service(s: Cent1Service, currency: string): ServiceData {
  const billing = resolveCent1Billing(s);
  // With auto-renew off there is no scheduled charge; `expiresAt` is when the service runs out.
  const nextBilling = parseDate(s.nextCharge?.at) ?? parseDate(s.expiresAt);
  return {
    externalId: s.id,
    name: s.name || s.id,
    type: 'vps',
    countryCode: countryOf(s.datacenter?.code),
    cost: billing?.cost,
    currency,
    period: billing?.period,
    nextBilling,
    // Explicit allowlist: never persist account details or arbitrary API responses.
    meta: {
      status: s.status ?? null,
      tariff: s.tariff?.name ?? s.tariff?.code ?? null,
      datacenter: s.datacenter?.name ?? s.datacenter?.code ?? null,
      os: s.osImage ?? null,
      ip: s.ipv4 ?? null,
      cpuCores: s.resources?.cpuCores ?? null,
      ramMib: s.resources?.ramMib ?? null,
      diskGib: s.resources?.diskGib ?? null,
      trafficGib: s.resources?.trafficGib ?? null,
      bandwidthMbit: s.resources?.bandwidthMbit ?? null,
      addons: s.addons ?? {},
      periodMonths: s.periodMonths ?? null,
      autoRenew: s.autoRenew ?? null,
      expiresAt: s.expiresAt ?? null,
      nextChargeAmount: s.nextCharge?.amount ?? null,
      createdAt: s.createdAt ?? null,
    },
  };
}

/**
 * A top-up into the balance → `topup`; a debit for a service → `charge` linked to that service.
 * `CREDIT` rows are refunds of already-counted money (unused days of a removed add-on), and the
 * ledger model has no representation for them (amounts are unsigned), so they are left out.
 */
export function mapCent1Transaction(t: Cent1Transaction, currency: string): PaymentData | null {
  if (t.type === 'CREDIT') return null;
  const date = parseDate(t.createdAt);
  if (!date) return null;
  const amount = new Decimal(t.signedAmount).abs();
  if (amount.isZero()) return null;
  const type = t.type === 'DEPOSIT' ? 'topup' : 'charge';
  return {
    externalId: `transaction:${t.id}`,
    type,
    amount,
    currency,
    date,
    description: t.description ?? undefined,
    serviceExternalId: type === 'charge' ? (t.serviceId ?? undefined) : undefined,
  };
}

import Decimal from 'decimal.js';
import { PaymentData, ServiceData } from '../connector.interface';
import {
  ASTRAVPS_CHARGE_KINDS,
  ASTRAVPS_NEUTRAL_KINDS,
  ASTRAVPS_TOPUP_KINDS,
  AstravpsOperation,
  AstravpsService,
  astravpsOperationSettled,
} from './astravps.types';

export function money(raw: unknown): Decimal | undefined {
  if ((typeof raw !== 'number' && typeof raw !== 'string') || raw === '') return;
  if (!Number.isFinite(Number(raw))) return;
  return new Decimal(String(raw));
}

function parseDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  // `expires_at` and `created_at` of a service come without a zone while the operations carry a
  // `Z`; the cabinet shows both in the owner's own time, so reading the naive ones as UTC keeps
  // the two consistent with each other.
  const zoned = /Z|[+-]\d\d:?\d\d$/.test(raw);
  const d = new Date(zoned ? raw : `${raw}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Country of a server. `spec.location` is already the two-letter country code of the location; the
 * node hostname ("pl1") is the fallback for a row whose spec is missing.
 */
export function astravpsCountryCode(s: AstravpsService): string | undefined {
  const spec = s.spec?.location?.trim().toLowerCase();
  if (spec && /^[a-z]{2}$/.test(spec)) return spec.toUpperCase();
  const fromNode = s.node?.trim().toLowerCase().match(/^([a-z]{2})\d/)?.[1];
  return fromNode ? fromNode.toUpperCase() : undefined;
}

export function mapAstravpsService(s: AstravpsService, currency: string): ServiceData | null {
  if (s.id === undefined || s.id === null) return null;
  return {
    externalId: String(s.id),
    name: s.name || `vps-${s.id}`,
    type: 'vps',
    countryCode: astravpsCountryCode(s),
    cost: money(s.monthly)?.toDecimalPlaces(2),
    currency,
    period: 'monthly',
    nextBilling: parseDate(s.expires_at),
    // Explicit allowlist: never persist the raw API row — `conn` carries the root password.
    meta: {
      status: s.status ?? null,
      provisioning: s.provisioning ?? null,
      plan: s.plan_key ?? null,
      node: s.node ?? null,
      location: s.spec?.location ?? null,
      vcpus: s.spec?.cpu ?? null,
      ramGb: s.spec?.ram ?? null,
      diskGb: s.spec?.disk ?? null,
      os: s.spec?.os ?? null,
      ipv4: s.ip ?? null,
      extraIpv4: s.extra_ips ?? [],
      created: s.created_at ?? null,
    },
  };
}

/** What an operation row is, in our terms; `null` means it moved no money. */
export function astravpsOperationType(o: AstravpsOperation): 'topup' | 'charge' | null {
  const kind = o.kind ?? '';
  if (ASTRAVPS_NEUTRAL_KINDS.has(kind)) return null;
  if (ASTRAVPS_TOPUP_KINDS.has(kind)) return 'topup';
  if (ASTRAVPS_CHARGE_KINDS.has(kind)) return 'charge';
  // AstraVPS keeps inventing operation kinds (an outage compensation showed up as
  // `outage_pl1_20261025`). The cabinet itself falls back to "top-up" for the ones it does not
  // know; naming a service is the safer signal that a row is a charge for it.
  return o.service ? 'charge' : 'topup';
}

/**
 * The balance ledger as payments. Rows are keyed by the service they concern (or by the payment id)
 * rather than per row, so the timestamp is part of the identity — a server renewed monthly then
 * yields one payment per renewal. Zero-amount rows (the outage compensations) are skipped, since
 * nothing moved.
 */
export function mapAstravpsPayments(rows: AstravpsOperation[], currency: string): PaymentData[] {
  const out: PaymentData[] = [];
  const seen = new Set<string>();
  for (const o of rows) {
    if (!astravpsOperationSettled(o.status)) continue;
    const amount = money(o.amount);
    if (!amount || amount.isZero()) continue;
    const date = parseDate(o.created_at);
    if (!date) continue;
    const type = astravpsOperationType(o);
    if (!type) continue;
    const base = type === 'topup' ? (o.pay_id ?? o.id) : o.id;
    let externalId = `${type}:${base ?? ''}:${o.created_at}`;
    for (let n = 0; seen.has(externalId); n += 1) externalId = `${externalId}#${n + 1}`;
    seen.add(externalId);
    out.push({
      externalId,
      type,
      // The ledger stores every movement as a positive figure; a charge is money leaving.
      amount: amount.abs().toDecimalPlaces(2),
      currency,
      date,
      description: o.service || o.method || o.kind,
      serviceExternalId: type === 'charge' && o.id !== undefined ? String(o.id) : undefined,
    });
  }
  return out;
}

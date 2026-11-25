import Decimal from 'decimal.js';
import { PaymentData, ServiceData } from '../connector.interface';
import { INTEZIO_LOCATION_COUNTRY, IntezioPayment, IntezioService } from './intezio.types';

export function money(raw: unknown): Decimal | undefined {
  if ((typeof raw !== 'number' && typeof raw !== 'string') || raw === '') return;
  if (!Number.isFinite(Number(raw))) return;
  return new Decimal(String(raw));
}

function parseDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Country of a server. `edges.service.location_name` is the location's English name; the plan name
 * ("PL-1") is the fallback, since its prefix is the same country code. The catalogue's own
 * `location_short` is deliberately unused — Intezio spells Germany "ge", which is Georgia.
 */
export function intezioCountryCode(s: IntezioService): string | undefined {
  const plan = s.edges?.service;
  const named = plan?.location_name?.trim().toLowerCase();
  if (named && INTEZIO_LOCATION_COUNTRY[named]) return INTEZIO_LOCATION_COUNTRY[named];
  const fromPlan = plan?.name?.trim().match(/^([A-Z]{2})-\d/)?.[1];
  return fromPlan && INTEZIO_LOCATION_COUNTRY[fromPlan.toLowerCase()] === fromPlan
    ? fromPlan
    : undefined;
}

/**
 * An ordered VPS as our domain Service. `cost` is what one month costs and `paid_up_to` when the
 * current period runs out.
 */
export function mapIntezioService(s: IntezioService, currency: string): ServiceData | null {
  if (s.id === undefined || s.id === null) return null;
  const plan = s.edges?.service;
  return {
    externalId: String(s.id),
    name: plan?.name || s.name || `vps-${s.id}`,
    type: 'vps',
    countryCode: intezioCountryCode(s),
    cost: money(s.cost)?.toDecimalPlaces(2),
    currency,
    period: 'monthly',
    nextBilling: parseDate(s.paid_up_to),
    // Explicit allowlist: never persist the raw API row — `password` is the root password.
    meta: {
      status: s.status ?? null,
      stoppedByAdmin: s.is_stopped_by_admin ?? null,
      autoRenew: s.auto_renew ?? null,
      plan: plan?.name ?? null,
      planId: plan?.id ?? s.service_id ?? null,
      location: plan?.location_name ?? null,
      vcpus: plan?.cpu ?? null,
      ramMb: plan?.ram ?? null,
      diskGb: plan?.disk !== undefined ? plan.disk / 1024 : null,
      cpuModel: plan?.cpu_model ?? null,
      ipv4: s.vm6_ip ?? null,
      created: s.created_at ?? null,
    },
  };
}

/**
 * The server a ledger row concerns, from its description. Intezio names the server in every
 * per-server text ("Продление сервера pl на 1 мес.", "Дополнительный трафик для сервера pl: 2 ТБ")
 * and that token is exactly the order's `name`, so it is what links a charge to its service.
 */
export function intezioPaymentServerName(description: string | undefined): string | undefined {
  const token = description?.match(/сервера\s+([^:\s]+)/i)?.[1];
  return token?.toLowerCase();
}

/**
 * The balance ledger as payments. `amount` is signed and the cabinet itself splits the rows purely
 * by its sign, so the sign decides the type; the figure is stored as a positive amount either way.
 * Rows with no id or no date are skipped — neither can be upserted idempotently.
 */
export function mapIntezioPayments(
  rows: IntezioPayment[],
  currency: string,
  serviceIdsByName: Map<string, string>,
): PaymentData[] {
  const out: PaymentData[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row?.id === undefined || row.id === null) continue;
    const amount = money(row.amount);
    if (!amount || amount.isZero()) continue;
    const date = parseDate(row.created_at);
    if (!date) continue;
    let externalId = `pay:${row.id}`;
    for (let n = 0; seen.has(externalId); n += 1) externalId = `pay:${row.id}#${n + 1}`;
    seen.add(externalId);
    const server = intezioPaymentServerName(row.description);
    out.push({
      externalId,
      type: amount.isNegative() ? 'charge' : 'topup',
      amount: amount.abs().toDecimalPlaces(2),
      currency,
      date,
      description: row.description,
      serviceExternalId: server ? serviceIdsByName.get(server) : undefined,
    });
  }
  return out;
}

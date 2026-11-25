import Decimal from 'decimal.js';
import { ServiceData } from '../connector.interface';
import { INTEZIO_LOCATION_COUNTRY, IntezioService } from './intezio.types';

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
 * An ordered VPS as our domain Service. The cabinet has no ledger, so `cost` of the order is the
 * only price there is; `paid_up_to` is when the current period runs out.
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

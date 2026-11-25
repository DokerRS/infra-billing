import Decimal from 'decimal.js';
import { PaymentData, ServiceData } from '../connector.interface';
import {
  NovaServer,
  NovaServersPage,
  ProcloudBilledItem,
  ProcloudHistoryEntry,
  ProcloudRegion,
} from './procloud.types';

export function money(raw: unknown): Decimal | undefined {
  if ((typeof raw !== 'number' && typeof raw !== 'string') || raw === '') return;
  if (!Number.isFinite(Number(raw))) return;
  return new Decimal(String(raw));
}

/**
 * Keystone project of an API user. ProCloud's RC files scope the token to `proj-<account>`, while
 * the login is `api-<account>-<token>` — the account number is the only shared part, so the
 * project is rebuilt from it. An unexpected login shape falls back to the login itself.
 */
export function projectNameOf(username: string): string {
  const account = /(\d{2,})/.exec(username)?.[1];
  return account ? `proj-${account}` : username;
}

function ips(server: NovaServer, version: number): string[] {
  return Object.values(server.addresses ?? {})
    .flat()
    .filter((a) => a?.version === version && a.addr)
    .map((a) => a.addr as string);
}

/**
 * Map a Nova server to our domain Service. Nova has no price: it comes from the panel's active
 * billing (`/api/billing/active`), whose instance rows carry the OpenStack id in `uuid`. Without a
 * panel sign-in — or when the instance is not billed yet — the cost stays empty and the sync keeps
 * the previous one, since a wrong price is worse than a missing one.
 */
export function mapProcloudServer(
  server: NovaServer,
  region: ProcloudRegion,
  billed: ProcloudBilledItem | undefined,
  currency: string,
): ServiceData {
  return {
    externalId: server.id,
    name: server.name || `server-${server.id}`,
    type: 'vps',
    countryCode: region.countryCode,
    cost: money(billed?.price)?.toDecimalPlaces(2),
    currency,
    period: 'monthly',
    // Curated meta. Never copy `metadata` whole: OpenStack images may keep secrets there.
    meta: {
      region: region.region,
      status: server.status,
      created: server.created,
      flavorId: server.flavor?.id,
      priceHour: billed?.priceHour,
      ipv4: ips(server, 4),
      ipv6: ips(server, 6),
    },
  };
}

/** Billed rows of the account, indexed by the OpenStack id they bill for. */
export function billedByUuid(items: ProcloudBilledItem[]): Map<string, ProcloudBilledItem> {
  const map = new Map<string, ProcloudBilledItem>();
  for (const item of items) {
    if (item.uuid) map.set(item.uuid, item);
  }
  return map;
}

/** Marker of the next Nova page from `servers_links`, or undefined on the last page. */
export function nextMarker(links: NovaServersPage['servers_links']): string | undefined {
  const href = links?.find((l) => l.rel === 'next' && l.href)?.href;
  if (!href) return;
  try {
    return new URL(href).searchParams.get('marker') || undefined;
  } catch {
    return;
  }
}

/**
 * The panel's billing history as payments. `pay` rows are payments (a negative one is a refund),
 * `bill` rows are the invoices of a period, `unbilled` rows repeat the current period's accrual of
 * an invoice that is already in the ledger, so they are skipped. Only rows with an id and a date
 * are stable enough to import once.
 */
export function mapProcloudPayments(rows: ProcloudHistoryEntry[], currency: string): PaymentData[] {
  const out: PaymentData[] = [];
  for (const row of rows) {
    if (row.id === undefined || row.id === null) continue;
    const amount = money(row.amount);
    const date = row.historyDate ? new Date(row.historyDate) : undefined;
    if (!amount || !date || Number.isNaN(date.getTime())) continue;
    const type = row.entryType === 'pay' ? 'topup' : row.entryType === 'bill' ? 'charge' : null;
    if (!type) continue;
    const period = row.dateFrom && row.dateTo ? `${row.dateFrom} — ${row.dateTo}` : undefined;
    out.push({
      externalId: `${type}:${row.id}`,
      type,
      amount: amount.toDecimalPlaces(2),
      currency,
      date,
      description: row.historyName || period,
    });
  }
  return out;
}

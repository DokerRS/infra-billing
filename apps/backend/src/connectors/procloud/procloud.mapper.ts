import Decimal from 'decimal.js';
import { PaymentData, ServiceData } from '../connector.interface';
import {
  PROCLOUD_LOCATION_COUNTRY,
  ProcloudBilledItem,
  ProcloudHistoryEntry,
  ProcloudServer,
} from './procloud.types';

export function money(raw: unknown): Decimal | undefined {
  if ((typeof raw !== 'number' && typeof raw !== 'string') || raw === '') return;
  if (!Number.isFinite(Number(raw))) return;
  return new Decimal(String(raw));
}

/**
 * Country of a server's location. The panel names the location in `endpointRegion` and codes it in
 * `availabilityZone` ("SFO-1"); the code's prefix is checked first, since a location can be renamed
 * for customers while its zone id stays.
 */
export function countryCodeOf(server: ProcloudServer): string | undefined {
  const zone = server.availabilityZone?.split(/[-_\s]/)[0]?.toLowerCase();
  if (zone && PROCLOUD_LOCATION_COUNTRY[zone]) return PROCLOUD_LOCATION_COUNTRY[zone];
  const region = server.endpointRegion?.trim().toLowerCase();
  return region ? PROCLOUD_LOCATION_COUNTRY[region] : undefined;
}

/**
 * Split of the account's billed resources: the rows that bill for a server (keyed by its OpenStack
 * id) and the rows that bill for something the server list does not contain — extra IP addresses,
 * disks, backups. The latter are services of their own, otherwise the panel's total would exceed
 * the sum of the synced services.
 */
export function splitBilledItems(
  items: ProcloudBilledItem[],
  serverIds: Set<string>,
): { byServer: Map<string, ProcloudBilledItem>; standalone: ProcloudBilledItem[] } {
  const byServer = new Map<string, ProcloudBilledItem>();
  const standalone: ProcloudBilledItem[] = [];
  for (const item of items) {
    if (item.uuid && serverIds.has(item.uuid)) {
      // Several rows can bill for one server (a base plan plus an option); keep the total.
      const prev = byServer.get(item.uuid);
      byServer.set(
        item.uuid,
        prev
          ? {
              ...item,
              price: money(prev.price)
                ?.plus(money(item.price) ?? 0)
                .toString(),
            }
          : item,
      );
    } else {
      standalone.push(item);
    }
  }
  return { byServer, standalone };
}

/** Service type of a billed resource that is not a server. */
export function billedServiceType(item: ProcloudBilledItem): string {
  const text =
    `${item.productGroup ?? ''} ${item.product ?? ''} ${item.productPl ?? ''} ${item.name ?? ''}`.toLowerCase();
  if (/ip[-_ ]?address|ip-адрес|адрес/i.test(text)) return 'other';
  if (/disk|диск|storage|хранили|backup|резерв|object/i.test(text)) return 'storage';
  if (/server|сервер|vps|vm/i.test(text)) return 'vps';
  if (/domain|домен/i.test(text)) return 'domain';
  if (/ssl|certificat|сертификат/i.test(text)) return 'license';
  return 'other';
}

/**
 * A panel server as our domain Service. The price comes from the account's active billing (`/api/
 * billing/active`), whose rows carry the server's OpenStack id; without a matching row the cost
 * stays empty and the sync keeps the previous one, since a wrong price is worse than a missing one.
 */
export function mapProcloudServer(
  server: ProcloudServer,
  billed: ProcloudBilledItem | undefined,
  currency: string,
): ServiceData {
  const label = server.flavor?.originalName || server.tariff;
  return {
    externalId: String(server.id),
    name: server.name || label || `server-${server.id}`,
    type: 'vps',
    countryCode: countryCodeOf(server),
    cost: money(billed?.price)?.toDecimalPlaces(2),
    currency,
    period: 'monthly',
    meta: {
      location: server.endpointRegion,
      availabilityZone: server.availabilityZone,
      status: server.status,
      created: server.createdAt,
      plan: label,
      tariff: server.tariff,
      image: server.imageName
        ? `${server.imageName}${server.imageVersion ? ` ${server.imageVersion}` : ''}`
        : undefined,
      vcpus: server.flavor?.vcpus,
      ramMb: server.flavor?.ram,
      diskGb: server.flavor?.disk,
      priceHour: billed?.priceHour,
      ipv4: (server.ipAddresses ?? []).filter((a) => !a.includes(':')),
      ipv6: (server.ipAddresses ?? []).filter((a) => a.includes(':')),
    },
  };
}

/**
 * A billed resource the server list has no row for (an extra IP address, a standalone disk). Named
 * after the resource itself — the panel's own description of what is billed.
 */
export function mapProcloudBilledItem(
  item: ProcloudBilledItem,
  currency: string,
): ServiceData | undefined {
  const id = item.uuid || item.name;
  if (!id) return;
  const label = item.product || item.productPl || item.productGroup;
  return {
    externalId: String(id),
    name: item.name || label || `billed-${id}`,
    type: billedServiceType(item),
    cost: money(item.price)?.toDecimalPlaces(2),
    currency,
    period: 'monthly',
    meta: {
      location: item.location,
      product: item.product,
      productGroup: item.productGroup,
      description: item.description,
      priceHour: item.priceHour,
      billedSince: item.dateStart,
    },
  };
}

/**
 * The panel's billing history as payments. `pay` rows are payments (a negative one is a refund),
 * `bill` rows are the invoices of a period, `unbilled` rows repeat the current period's accrual of
 * an invoice that is already in the ledger, so they are skipped. The rows carry no id of their own,
 * so the identity is built from what makes a row unique: the document it belongs to, its date and
 * its kind.
 */
export function mapProcloudPayments(rows: ProcloudHistoryEntry[], currency: string): PaymentData[] {
  const out: PaymentData[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const amount = money(row.amount);
    const date = row.historyDate ? new Date(row.historyDate) : undefined;
    if (!amount || !date || Number.isNaN(date.getTime())) continue;
    const type = row.entryType === 'pay' ? 'topup' : row.entryType === 'bill' ? 'charge' : null;
    if (!type) continue;
    const doc = row.id ?? row.docId ?? row.historyName ?? '';
    const period = row.dateFrom && row.dateTo ? `${row.dateFrom} — ${row.dateTo}` : undefined;
    let externalId = `${type}:${doc}`;
    // Rows of one document (several positions of an invoice) must not collapse into one payment.
    for (let n = 0; seen.has(externalId); n += 1) externalId = `${type}:${doc}#${n + 1}`;
    seen.add(externalId);
    out.push({
      externalId,
      type,
      amount: amount.toDecimalPlaces(2),
      currency,
      date,
      description: row.historyName || period,
    });
  }
  return out;
}

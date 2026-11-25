import { Injectable } from '@nestjs/common';
import { AezaConnector } from './aeza/aeza.connector';
import { parseAezaCredentials } from './aeza/aeza.types';
import { FourVpsConnector } from './4vps/4vps.connector';
import type { FourVpsCredentials } from './4vps/4vps.types';
import { BegetConnector } from './beget/beget.connector';
import type { BegetCredentials } from './beget/beget.types';
import { BillmgrConnector } from './billmgr/billmgr.connector';
import type { BillmgrCredentials } from './billmgr/billmgr.types';
import { BillmgrCookieConnector } from './billmgr-cookie/billmgr-cookie.connector';
import type { BillmgrCookieCredentials } from './billmgr-cookie/billmgr-cookie.types';
import { Cent1Connector } from './1cent/1cent.connector';
import { CloudflareConnector } from './cloudflare/cloudflare.connector';
import type { CloudflareCredentials } from './cloudflare/cloudflare.types';
import { Connector } from './connector.interface';
import { DatapacketConnector } from './datapacket/datapacket.connector';
import { DoubleServersConnector } from './doubleservers/doubleservers.connector';
import type { DoubleServersCredentials } from './doubleservers/doubleservers.types';
import { GcoreConnector } from './gcore/gcore.connector';
import { HetznerConnector } from './hetzner/hetzner.connector';
import { HostkeyConnector } from './hostkey/hostkey.connector';
import { HostbillConnector } from './hostbill/hostbill.connector';
import type { HostbillCredentials } from './hostbill/hostbill.types';
import { HostvdsConnector } from './hostvds/hostvds.connector';
import type { HostvdsCredentials } from './hostvds/hostvds.types';
import { HostupConnector } from './hostup/hostup.connector';
import { InfomaniakConnector } from './infomaniak/infomaniak.connector';
import { LinodeConnector } from './linode/linode.connector';
import { NetcupConnector } from './netcup/netcup.connector';
import { NetangelsConnector } from './netangels/netangels.connector';
import { NetlenConnector } from './netlen/netlen.connector';
import { NodehostConnector } from './nodehost/nodehost.connector';
import { OpenRouterConnector } from './openrouter/openrouter.connector';
import { parseOpenRouterCredentials } from './openrouter/openrouter.types';
import { OvhConnector } from './ovh/ovh.connector';
import type { OvhCredentials } from './ovh/ovh.types';
import { PorkbunConnector } from './porkbun/porkbun.connector';
import type { PorkbunCredentials } from './porkbun/porkbun.types';
import { ProcloudConnector } from './procloud/procloud.connector';
import type { ProcloudCredentials } from './procloud/procloud.types';
import { SelectelConnector } from './selectel/selectel.connector';
import type { SelectelCredentials } from './selectel/selectel.types';
import { SkrimeConnector } from './skrime/skrime.connector';
import { SpaceshipConnector } from './spaceship/spaceship.connector';
import type { SpaceshipCredentials } from './spaceship/spaceship.types';
import { StormwallConnector } from './stormwall/stormwall.connector';
import { TimewebConnector } from './timeweb/timeweb.connector';
import { TubeHostingConnector } from './tubehosting/tubehosting.connector';
import type { TubeHostingCredentials } from './tubehosting/tubehosting.types';
import { VdsinaConnector } from './vdsina/vdsina.connector';
import type { VdsinaCredentials } from './vdsina/vdsina.types';
import { VultrConnector } from './vultr/vultr.connector';
import { YandexConnector } from './yandex/yandex.connector';
import type { YandexCredentials } from './yandex/yandex.types';

@Injectable()
export class ConnectorFactory {
  /**
   * Build a connector for a syncable provider kind. Throws for unknown kinds and
   * for `manual` (manual providers are not synced; the sync skips them upstream).
   */
  create(kind: string, token: string): Connector {
    switch (kind) {
      case 'timeweb':
        return new TimewebConnector(token);
      case 'hetzner':
        return new HetznerConnector(token);
      case 'hostkey':
        return new HostkeyConnector(token);
      case 'netlen':
        // Netlen secret is the raw API key (single string, sent as the X-API-Key header).
        return new NetlenConnector(token);
      case 'netcup':
        // netcup secret is the OAuth2 offline refresh token (single string, like timeweb).
        return new NetcupConnector(token);
      case 'hostbill':
        // For HostBill the decrypted secret is JSON: { baseUrl, username, password }.
        return new HostbillConnector(JSON.parse(token) as HostbillCredentials);
      case 'billmgr':
        // BILLmanager secret is JSON: { baseUrl, username, password }.
        return new BillmgrConnector(JSON.parse(token) as BillmgrCredentials);
      case 'billmgr-cookie':
        // Cookie BILLmanager secret is JSON: { baseUrl, cookie, userAgent?, username?, password?,
        // totpSecret? } — the session cookie + User-Agent copied from a logged-in panel tab.
        return new BillmgrCookieConnector(JSON.parse(token) as BillmgrCookieCredentials);
      case 'selectel':
        // Selectel secret is JSON: { accountId, username, password } (Keystone service user).
        return new SelectelConnector(JSON.parse(token) as SelectelCredentials);
      case '4vps':
        // 4VPS secret is JSON: { token, panelId? }.
        return new FourVpsConnector(JSON.parse(token) as FourVpsCredentials);
      case 'beget':
        // Beget secret is JSON: { username (login), password, totpSecret?, apiPassword? }.
        return new BegetConnector(JSON.parse(token) as BegetCredentials);
      case 'porkbun':
        // Porkbun secret is JSON: { apiKey, secretApiKey } (X-API-Key / X-Secret-API-Key headers).
        return new PorkbunConnector(JSON.parse(token) as PorkbunCredentials);
      case 'spaceship':
        // Spaceship secret is JSON: { apiKey, apiSecret } (X-API-Key / X-API-Secret headers).
        return new SpaceshipConnector(JSON.parse(token) as SpaceshipCredentials);
      case 'vultr':
        // Vultr secret is the raw API key (single string, sent as the Authorization Bearer header).
        return new VultrConnector(token);
      case 'linode':
        // Linode secret is the raw Personal Access Token (sent as the Authorization Bearer header).
        return new LinodeConnector(token);
      case 'aeza':
        // Aeza secret is JSON: { token, baseUrl? } — baseUrl picks the .net/.ru branch. Providers
        // saved before the branch field hold the bare API key; the parser accepts both.
        return new AezaConnector(parseAezaCredentials(token));
      case 'vdsina':
        // VDSina secret is JSON: { token, baseUrl? } — baseUrl picks the .ru/.com branch.
        return new VdsinaConnector(JSON.parse(token) as VdsinaCredentials);
      case 'cloudflare':
        // Cloudflare secret is JSON: { accountId, apiToken } (account-scoped registrar + billing).
        return new CloudflareConnector(JSON.parse(token) as CloudflareCredentials);
      case 'netangels':
        return new NetangelsConnector(token);
      case 'stormwall':
        // StormWall secret is the raw API key (single string, sent as the x-api-key header).
        return new StormwallConnector(token);
      case 'yandex':
        // Yandex Cloud secret is JSON: { keyId, serviceAccountId, privateKey, folderId?,
        // billingAccountId? }, normalized from the service-account authorized key.
        return new YandexConnector(JSON.parse(token) as YandexCredentials);
      case 'doubleservers':
        // Double Servers secret is JSON: { username (email), password, totpSecret? }.
        return new DoubleServersConnector(JSON.parse(token) as DoubleServersCredentials);
      case 'openrouter':
        return new OpenRouterConnector(parseOpenRouterCredentials(token));
      case 'hostup':
        // HostUp secret is the raw API key (single string, sent as the Authorization Bearer header).
        return new HostupConnector(token);
      case 'infomaniak':
        // Infomaniak secret is the raw personal access token (Authorization Bearer header).
        return new InfomaniakConnector(token);
      case 'hostvds':
        // HostVDS / CloudCore secret is JSON: { username, password, baseUrl? } — the OpenStack
        // user from the panel's API tab; baseUrl picks the brand.
        return new HostvdsConnector(JSON.parse(token) as HostvdsCredentials);
      case 'procloud':
        // ProCloud secret is JSON: { username, password, baseUrl?, projectName?, email?,
        // webPassword? } — the OpenStack user of one location's RC file; the optional panel
        // login adds the balance, the prices and the ledger.
        return new ProcloudConnector(JSON.parse(token) as ProcloudCredentials);
      case 'datapacket':
        // DataPacket secret is the raw API key (single string, sent as the Authorization Bearer header).
        return new DatapacketConnector(token);
      case 'tubehosting':
        // Tube-Hosting secret is JSON: { username (email), password, totpSecret? } (panel login).
        return new TubeHostingConnector(JSON.parse(token) as TubeHostingCredentials);
      case 'gcore':
        // Gcore secret is the raw permanent API token (sent as `Authorization: APIKey <token>`).
        return new GcoreConnector(token);
      case 'nodehost':
        // NodeHost secret is the raw API key (single string, sent as the Authorization Bearer header).
        return new NodehostConnector(token);
      case '1cent':
        // 1Cent secret is the raw API key (single string, sent as the Authorization Bearer header).
        return new Cent1Connector(token);
      case 'ovh':
        // OVH secret is JSON: { applicationKey, applicationSecret, consumerKey, baseUrl? } — the
        // trio from https://api.ovhcloud.com/createToken/; baseUrl picks the API zone.
        return new OvhConnector(JSON.parse(token) as OvhCredentials);
      case 'skrime':
        // SKRIME secret is the raw API key (single string, sent as the Authorization Bearer header).
        return new SkrimeConnector(token);
      default:
        throw new Error(`Connector for kind="${kind}" is not supported`);
    }
  }
}

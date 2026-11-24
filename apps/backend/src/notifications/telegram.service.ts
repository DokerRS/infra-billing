import { Injectable, Logger } from '@nestjs/common';
import { SettingsRepository } from '@repositories/settings/settings.repository';
import { Api } from 'grammy';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import type { Agent } from 'node:http';
import { CryptoService } from '../crypto/crypto.service';

interface TelegramConfig {
  token: string;
  chatId: string;
  topicId: string;
  proxyUrl: string;
}

/**
 * The agent for a proxy URL, or null when it cannot be parsed. grammY talks through node-fetch on
 * Node, which honours `agent` for both http: and https: targets, so one agent per scheme is all
 * that is needed. An http: proxy is used as a plain forward proxy for http targets and via
 * CONNECT for https ones, which is what api.telegram.org (https) requires.
 */
function proxyAgent(url: string): Agent | null {
  try {
    return /^https?:\/\//i.test(url) ? new HttpsProxyAgent(url) : new SocksProxyAgent(url);
  } catch {
    return null;
  }
}

// Outbound-only: grammY `Api`, no Bot/polling/webhook. Config (token AES-GCM encrypted) read from
// panel settings on every send so edits apply without a restart. No env fallback. Settings in DB.
@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);

  constructor(
    private readonly settings: SettingsRepository,
    private readonly crypto: CryptoService,
  ) {}

  /** Effective Telegram config (token/chat) from the panel settings; null if not configured. */
  private resolveConfig(
    s: {
      telegramBotTokenEnc: Uint8Array | null;
      telegramChatId: string | null;
      telegramTopicId: string | null;
      telegramProxyUrl: string | null;
    } | null,
  ): TelegramConfig | null {
    if (s?.telegramBotTokenEnc && s.telegramChatId) {
      try {
        return {
          token: this.crypto.decrypt(s.telegramBotTokenEnc),
          chatId: s.telegramChatId,
          topicId: s.telegramTopicId ?? '',
          proxyUrl: s.telegramProxyUrl ?? '',
        };
      } catch {
        this.logger.error('Failed to decrypt the Telegram token from settings');
      }
    }
    return null;
  }

  /** Automatic notifications are on only when the master switch is on AND config exists. */
  async isEnabled(): Promise<boolean> {
    const s = await this.settings.find();
    if (s && !s.notificationsEnabled) return false;
    return this.resolveConfig(s) !== null;
  }

  /** Send a message. Ignores the master switch (used by the manual "test" too). */
  async send(html: string): Promise<boolean> {
    const s = await this.settings.find();
    const cfg = this.resolveConfig(s);
    if (!cfg) return false;
    const options: {
      parse_mode: 'HTML';
      message_thread_id?: number;
      link_preview_options: { is_disabled: true };
    } = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
    if (cfg.topicId) options.message_thread_id = Number(cfg.topicId);

    try {
      const agent = cfg.proxyUrl ? proxyAgent(cfg.proxyUrl) : null;
      if (cfg.proxyUrl && !agent) {
        this.logger.error(
          `Telegram proxy URL could not be parsed, sending directly instead: ${cfg.proxyUrl}`,
        );
      }
      const api = agent
        ? new Api(cfg.token, {
            timeoutSeconds: 10,
            baseFetchConfig: { agent, compress: true },
          })
        : new Api(cfg.token, { timeoutSeconds: 10 });
      await api.sendMessage(cfg.chatId, html, options);
      return true;
    } catch (e) {
      this.logger.error(
        'Failed to send the Telegram notification',
        e instanceof Error ? e.stack : String(e),
      );
      return false;
    }
  }
}

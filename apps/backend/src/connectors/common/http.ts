import { AsyncLocalStorage } from 'node:async_hooks';
import type { Agent } from 'node:http';
import axios, { type CreateAxiosDefaults } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

/** Default per-request timeout for outbound provider API calls (30s). */
export const REQUEST_TIMEOUT_MS = 30_000;

// Accounts sync in parallel, so the proxy travels with the async context, not a global default.
const proxyStore = new AsyncLocalStorage<Agent>();

/** Picks the agent for a proxy URL: http(s):// is an HTTP/CONNECT proxy, anything else SOCKS. */
export function proxyAgentFor(url: string): Agent {
  return /^https?:\/\//i.test(url) ? new HttpsProxyAgent(url) : new SocksProxyAgent(url);
}

/** Run `fn` so that every client made by {@link createHttp} inside it goes through `proxyUrl`. */
export function withProxy<T>(proxyUrl: string | null, fn: () => Promise<T>): Promise<T> {
  return proxyUrl ? proxyStore.run(proxyAgentFor(proxyUrl), fn) : fn();
}

/** Proxy agent (HTTP(S) or SOCKS) of the account being synced, for transports other than axios. */
export const proxyAgent = (): Agent | undefined => proxyStore.getStore();

/** `axios.create` that routes through the current account's proxy when one is set. */
export function createHttp(config: CreateAxiosDefaults = {}) {
  const agent = proxyAgent();
  // proxy: false keeps axios from also applying HTTP(S)_PROXY env vars on top of the agent.
  return axios.create(
    agent ? { ...config, httpAgent: agent, httpsAgent: agent, proxy: false } : config,
  );
}

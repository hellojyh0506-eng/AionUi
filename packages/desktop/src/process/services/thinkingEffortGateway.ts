/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { httpRequest } from '@/common/adapter/httpBridge';
import type { IProvider } from '@/common/config/storage';
import {
  isThinkingGatewayUrl,
  parseThinkingGatewayRequestPath,
  shouldWrapProviderForThinking,
  THINKING_GATEWAY_PATH_PREFIX,
  unwrapThinkingGatewayUrl,
  wrapThinkingGatewayUrl,
} from '@/common/utils/thinkingGatewayUrl';

const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;

const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
  'proxy-connection',
  'accept-encoding',
]);

const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  'connection',
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'keep-alive',
]);

const BUDGET_TOKENS_BY_TIER: Record<string, number> = {
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 24576,
  max: 32768,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalizes a model identifier (strips `vendor/` prefix and lowercases) so
 * persisted slider selections match runtime model payloads uniformly.
 */
export function normalizeModelKey(modelName?: string | null): string {
  if (!modelName) return '';
  const trimmed = modelName.trim();
  const slashIdx = trimmed.lastIndexOf('/');
  const bare = slashIdx >= 0 ? trimmed.slice(slashIdx + 1) : trimmed;
  return bare.toLowerCase();
}

/**
 * Applies protocol-native reasoning/thinking parameters to an outgoing LLM JSON request payload
 * without ever modifying user prompt messages.
 */
export function applyThinkingEffortToRequestBody(
  body: Record<string, unknown>,
  effort: string | undefined,
  requestPath: string
): { modified: boolean; body: Record<string, unknown> } {
  if (!effort || !effort.trim() || typeof body.model !== 'string' || !body.model.trim()) {
    return { modified: false, body };
  }

  const next: Record<string, unknown> = { ...body };
  const rawTier = effort.trim().toLowerCase();
  const tier = rawTier === 'med' ? 'medium' : rawTier;
  const modelKey = normalizeModelKey(body.model);
  const pathLower = requestPath.toLowerCase();

  // 1. Anthropic Messages (/v1/messages)
  if (pathLower.includes('/messages') || 'anthropic_version' in next) {
    if (tier === 'off' || tier === 'none') {
      next.thinking = { type: 'disabled' };
      if (isPlainObject(next.output_config)) {
        const cleaned = { ...next.output_config };
        delete cleaned.effort;
        next.output_config = cleaned;
      }
      return { modified: true, body: next };
    }

    if (tier === 'low' || tier === 'medium' || tier === 'high' || tier === 'xhigh' || tier === 'max') {
      if (/claude-(?:opus-4-[678]|sonnet-4-6|sonnet-5|fable-5)/.test(modelKey)) {
        next.thinking = { type: 'adaptive' };
        next.output_config = {
          ...(isPlainObject(next.output_config) ? next.output_config : {}),
          effort: tier,
        };
      } else {
        const budget = BUDGET_TOKENS_BY_TIER[tier] ?? 8192;
        next.thinking = { type: 'enabled', budget_tokens: budget };
        if (typeof next.max_tokens === 'number' && next.max_tokens <= budget) {
          next.max_tokens = budget + 4096;
        }
      }
      return { modified: true, body: next };
    }

    return { modified: false, body };
  }

  // 2. OpenAI Responses (/v1/responses)
  if (pathLower.includes('/responses') || ('input' in next && !('messages' in next))) {
    const mapped =
      tier === 'off' || tier === 'none'
        ? 'none'
        : tier === 'max'
          ? 'xhigh'
          : tier === 'minimal' || tier === 'low' || tier === 'medium' || tier === 'high' || tier === 'xhigh'
            ? tier
            : null;
    if (!mapped) {
      return { modified: false, body };
    }
    next.reasoning = {
      ...(isPlainObject(next.reasoning) ? next.reasoning : {}),
      effort: mapped,
    };
    return { modified: true, body: next };
  }

  // 3. OpenAI Chat Completions (/v1/chat/completions or generic chat endpoints)
  if (pathLower.includes('/chat/completions') || 'messages' in next) {
    if (tier === 'off' || tier === 'none') {
      if (/deepseek|claude|glm|minimax/.test(modelKey)) {
        // Live probes (2026-11-27): `thinking: { type: 'disabled' }` ALONE is unreliable —
        // New-API/ethantoken.top and local workbuddy gateways still stream reasoning on
        // some routes. The ONLY combination measured to yield reasoning_len=0 on BOTH
        // upstreams is `thinking: disabled` + `reasoning_effort: 'none'` together.
        // NEVER send reasoning_effort: 'off' here — ethantoken.top treats it as ON.
        next.thinking = { type: 'disabled' };
        next.reasoning_effort = 'none';
      } else if (/qwen/.test(modelKey)) {
        next.enable_thinking = false;
        delete next.reasoning_effort;
      } else {
        next.reasoning_effort = 'none';
        delete next.thinking;
      }
      return { modified: true, body: next };
    }

    if (tier === 'minimal' || tier === 'low' || tier === 'medium' || tier === 'high' || tier === 'xhigh' || tier === 'max') {
      if (isPlainObject(next.thinking) && next.thinking.type === 'disabled') {
        delete next.thinking;
      }
      if (next.enable_thinking === false) {
        delete next.enable_thinking;
      }
      if (modelKey.startsWith('grok-')) {
        next.reasoning_effort = tier === 'medium' ? 'low' : tier === 'xhigh' || tier === 'max' ? 'high' : tier;
      } else {
        next.reasoning_effort = tier;
      }
      return { modified: true, body: next };
    }
  }

  return { modified: false, body };
}

interface PersistedThinkingEffortState {
  enabled: boolean;
  modelLevels: Record<string, string>;
}

export interface ThinkingEffortGatewayStatus {
  active: boolean;
  port: number | null;
  enabled: boolean;
  modelLevels: Record<string, string>;
}

export interface ThinkingEffortGatewayOptions {
  storagePath?: string;
  upstreamFetch?: typeof fetch;
}

function mergeNoProxyHosts(current: string | undefined, hosts: string[]): string {
  const parts = (current || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set(parts.map((s) => s.toLowerCase()));
  for (const host of hosts) {
    if (!seen.has(host.toLowerCase())) {
      parts.push(host);
      seen.add(host.toLowerCase());
    }
  }
  return parts.join(',');
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1' || normalized === '[::1]';
}

async function resolveDefaultFetch(targetUrl: string): Promise<typeof fetch> {
  if (process.versions.electron) {
    try {
      const parsed = new URL(targetUrl);
      const host = parsed.hostname.toLowerCase();
      if (!isLoopbackHost(host) && !host.endsWith('ethantoken.top')) {
        const electron = await import('electron');
        if (electron?.net?.fetch) {
          return electron.net.fetch as unknown as typeof fetch;
        }
      }
    } catch {
      // fall through to Node global fetch
    }
  }
  return fetch;
}

async function resolveDefaultStoragePath(): Promise<string | null> {
  if (!process.versions.electron) return null;
  try {
    const electron = await import('electron');
    if (electron?.app) {
      return path.join(electron.app.getPath('userData'), 'thinking-effort-levels.json');
    }
  } catch {
    // ignore outside main process
  }
  return null;
}

export class ThinkingEffortGateway {
  private server: http.Server | null = null;
  private port: number | null = null;
  private token = '';
  private enabled = true;
  private modelLevels: Record<string, string> = {};
  private storagePathOverride?: string;
  private upstreamFetchOverride?: typeof fetch;
  private storageLoaded = false;

  constructor(options: ThinkingEffortGatewayOptions = {}) {
    this.storagePathOverride = options.storagePath;
    this.upstreamFetchOverride = options.upstreamFetch;
    this.loadStateSync(this.storagePathOverride);
  }

  private getStoragePathSync(): string | null {
    if (this.storagePathOverride) return this.storagePathOverride;
    return null;
  }

  private async ensureStoragePath(): Promise<string | null> {
    if (this.storagePathOverride) return this.storagePathOverride;
    const resolved = await resolveDefaultStoragePath();
    if (resolved) {
      this.storagePathOverride = resolved;
      if (!this.storageLoaded) {
        this.loadStateSync(resolved);
      }
    }
    return resolved;
  }

  private loadStateSync(filePath?: string): void {
    if (!filePath) return;
    this.storageLoaded = true;
    try {
      if (!fs.existsSync(filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<PersistedThinkingEffortState>;
      if (typeof parsed.enabled === 'boolean') {
        this.enabled = parsed.enabled;
      }
      if (parsed.modelLevels && typeof parsed.modelLevels === 'object' && !Array.isArray(parsed.modelLevels)) {
        const next: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed.modelLevels)) {
          if (typeof v === 'string' && v.trim()) {
            const key = normalizeModelKey(k);
            if (key) next[key] = v.trim();
          }
        }
        this.modelLevels = next;
      }
    } catch {
      // ignore corrupted persistence file
    }
  }

  private persistState(): void {
    const filePath = this.getStoragePathSync();
    if (!filePath) return;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmpPath = `${filePath}.tmp`;
      const payload: PersistedThinkingEffortState = {
        enabled: this.enabled,
        modelLevels: this.modelLevels,
      };
      fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
      fs.renameSync(tmpPath, filePath);
    } catch {
      // ignore persistence write failures
    }
  }

  public resolveEffortForModel(modelName?: string | null): string | undefined {
    const key = normalizeModelKey(modelName);
    if (!key) return undefined;
    return this.modelLevels[key];
  }

  public async setModelEffort(model: string, effort: string): Promise<void> {
    await this.ensureStoragePath();
    const key = normalizeModelKey(model);
    if (!key) return;
    const trimmed = effort.trim();
    if (!trimmed) {
      delete this.modelLevels[key];
    } else {
      this.modelLevels[key] = trimmed;
    }
    this.persistState();
  }

  public async syncPreferences(prefs: { enabled: boolean; modelLevels: Record<string, string> }): Promise<void> {
    await this.ensureStoragePath();
    this.enabled = Boolean(prefs.enabled);
    const next: Record<string, string> = {};
    if (prefs.modelLevels && typeof prefs.modelLevels === 'object') {
      for (const [k, v] of Object.entries(prefs.modelLevels)) {
        if (typeof v === 'string' && v.trim()) {
          const key = normalizeModelKey(k);
          if (key) next[key] = v.trim();
        }
      }
    }
    this.modelLevels = next;
    this.persistState();
  }

  public getStatus(): ThinkingEffortGatewayStatus {
    return {
      active: Boolean(this.server && this.port),
      port: this.port,
      enabled: this.enabled,
      modelLevels: { ...this.modelLevels },
    };
  }

  public wrapUrlIfActive(url: string): string {
    if (!url || !this.server || !this.port || !this.token) {
      return url;
    }
    const unwrapped = unwrapThinkingGatewayUrl(url);
    if (!unwrapped.startsWith('http://') && !unwrapped.startsWith('https://')) {
      return url;
    }
    return wrapThinkingGatewayUrl(unwrapped, this.port, this.token);
  }

  public async start(): Promise<{ port: number; token: string }> {
    await this.ensureStoragePath();

    process.env.NO_PROXY = mergeNoProxyHosts(process.env.NO_PROXY || process.env.no_proxy, ['127.0.0.1', 'localhost']);
    process.env.no_proxy = process.env.NO_PROXY;

    if (this.server && this.port && this.token) {
      return { port: this.port, token: this.token };
    }

    const token = crypto.randomBytes(16).toString('hex');
    const server = http.createServer((req, res) => {
      void this.handleHttpRequest(req, res);
    });

    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('Failed to bind ThinkingEffortGateway to 127.0.0.1'));
          return;
        }
        resolve(addr.port);
      });
    });

    this.server = server;
    this.port = port;
    this.token = token;
    return { port, token };
  }

  public async close(): Promise<void> {
    const srv = this.server;
    this.server = null;
    this.port = null;
    this.token = '';
    if (!srv) return;
    await new Promise<void>((resolve) => {
      srv.close(() => resolve());
    });
  }

  public async reconcileProvidersWithBackend(): Promise<number> {
    if (!this.server || !this.port || !this.token) return 0;
    const providers = (await httpRequest<IProvider[]>('GET', '/api/providers')) || [];
    const targets = providers.filter((provider) => {
      if (!provider?.id || !shouldWrapProviderForThinking(provider)) return false;
      const desired = this.wrapUrlIfActive(provider.base_url);
      return Boolean(desired && desired !== provider.base_url);
    });
    await Promise.all(
      targets.map((provider) =>
        httpRequest<IProvider>('PUT', `/api/providers/${encodeURIComponent(provider.id)}`, {
          base_url: this.wrapUrlIfActive(provider.base_url),
        })
      )
    );
    return targets.length;
  }

  public async restoreProvidersBeforeQuit(timeoutMs = 2000): Promise<void> {
    const restoreTask = (async () => {
      try {
        const providers = (await httpRequest<IProvider[]>('GET', '/api/providers')) || [];
        const wrapped = providers.filter((provider) => provider?.id && isThinkingGatewayUrl(provider.base_url));
        await Promise.all(
          wrapped.map((provider) => {
            const cleanUrl = unwrapThinkingGatewayUrl(provider.base_url);
            if (!cleanUrl || cleanUrl === provider.base_url) return Promise.resolve();
            return httpRequest<IProvider>('PUT', `/api/providers/${encodeURIComponent(provider.id)}`, {
              base_url: cleanUrl,
            });
          })
        );
      } catch {
        // Backend may already have exited or failed startup; ignore cleanly.
      }
    })();

    await Promise.race([
      restoreTask,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);

    await this.close().catch((): undefined => undefined);
  }

  private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const rawUrl = req.url || '/';
    if (!rawUrl.startsWith(THINKING_GATEWAY_PATH_PREFIX)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Not Found', type: 'thinking_gateway_error' } }));
      return;
    }

    const parsedPath = parseThinkingGatewayRequestPath(rawUrl, this.token);
    if (!parsedPath) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Forbidden: invalid gateway token or target', type: 'thinking_gateway_error' } }));
      return;
    }

    let upstreamUrlObj: URL;
    try {
      upstreamUrlObj = new URL(parsedPath.upstreamBaseUrl);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid upstream URL', type: 'thinking_gateway_error' } }));
      return;
    }

    const upstreamPort =
      upstreamUrlObj.port ? Number(upstreamUrlObj.port) : upstreamUrlObj.protocol === 'https:' ? 443 : 80;
    if (isLoopbackHost(upstreamUrlObj.hostname) && upstreamPort === this.port) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Loopback self-forwarding blocked', type: 'thinking_gateway_error' } }));
      return;
    }

    const targetUrl = `${parsedPath.upstreamBaseUrl}${parsedPath.restPath}${parsedPath.search}`;
    const method = (req.method || 'GET').toUpperCase();

    let rawBody: Buffer | undefined;
    if (method !== 'GET' && method !== 'HEAD') {
      try {
        rawBody = await readRequestBuffer(req, MAX_REQUEST_BODY_BYTES);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to read request body';
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: msg, type: 'thinking_gateway_error' } }));
        return;
      }
    }

    let outgoingBody: BodyInit | undefined = rawBody && rawBody.length > 0 ? new Uint8Array(rawBody) : undefined;
    const contentType = String(req.headers['content-type'] || '').toLowerCase();

    if (
      method === 'POST' &&
      this.enabled &&
      rawBody &&
      rawBody.length > 0 &&
      (contentType.includes('json') || rawBody.subarray(0, 32).toString('utf-8').trimStart().startsWith('{'))
    ) {
      try {
        const parsedJson = JSON.parse(rawBody.toString('utf-8')) as unknown;
        if (isPlainObject(parsedJson)) {
          const effort = this.resolveEffortForModel(
            typeof parsedJson.model === 'string' ? parsedJson.model : undefined
          );
          const result = applyThinkingEffortToRequestBody(parsedJson, effort, parsedPath.restPath);
          if (result.modified) {
            outgoingBody = JSON.stringify(result.body);
          }
        }
      } catch {
        // Non-JSON payload; pass through raw bytes untouched
      }
    }

    const forwardHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      const lower = key.toLowerCase();
      if (HOP_BY_HOP_REQUEST_HEADERS.has(lower)) continue;
      forwardHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
    }

    const controller = new AbortController();
    const onClientClose = () => {
      if (!res.writableEnded) {
        controller.abort();
      }
    };
    res.on('close', onClientClose);

    try {
      const fetchImpl = this.upstreamFetchOverride ?? (await resolveDefaultFetch(targetUrl));
      const upstreamResp = await fetchImpl(targetUrl, {
        method,
        headers: forwardHeaders,
        body: outgoingBody,
        signal: controller.signal,
      });

      const outHeaders: Record<string, string | string[]> = {};
      upstreamResp.headers.forEach((val, key) => {
        if (!HOP_BY_HOP_RESPONSE_HEADERS.has(key.toLowerCase())) {
          outHeaders[key] = val;
        }
      });

      res.writeHead(upstreamResp.status, outHeaders);
      res.flushHeaders?.();

      if (!upstreamResp.body) {
        res.end();
        return;
      }

      const reader = upstreamResp.body.getReader();
      const pumpStream = async (): Promise<void> => {
        const { done, value } = await reader.read();
        if (done) return;
        if (value && value.byteLength > 0 && !res.destroyed) {
          res.write(Buffer.from(value));
        }
        return pumpStream();
      };
      try {
        await pumpStream();
      } finally {
        reader.releaseLock();
      }

      if (!res.writableEnded) {
        res.end();
      }
    } catch (err) {
      if (!res.headersSent && !res.writableEnded) {
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message, type: 'thinking_gateway_error' } }));
      } else if (!res.writableEnded) {
        res.end();
      }
    } finally {
      res.off('close', onClientClose);
    }
  }
}

function readRequestBuffer(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      total += buf.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error(`Request body exceeded ${maxBytes} bytes`));
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export const thinkingEffortGateway = new ThinkingEffortGateway();

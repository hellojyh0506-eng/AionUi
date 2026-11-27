/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { app, BrowserWindow, shell } from 'electron';
import { ipcBridge } from '@/common';
import { httpRequest } from '@/common/adapter/httpBridge';
import type {
  EthanTokenAccountState,
  EthanTokenAccountSummary,
  EthanTokenDailyBonusState,
  EthanTokenLedgerData,
} from '@/common/adapter/ipcBridge';
import {
  BUILTIN_IMAGE_GEN_NAME,
  BUILTIN_KNOWLEDGE_MCP_NAME,
  type IMcpServer,
  type IProvider,
  type ModelSettings,
} from '@/common/config/storage';
import { unwrapThinkingGatewayUrl } from '@/common/utils/thinkingGatewayUrl';
import { thinkingEffortGateway } from '../services/thinkingEffortGateway';
import { IMAGE_GEN_ENV_KEYS } from '@/common/config/imageGenerationMcpEnv';
import { CAPABILITY_PATTERNS, isLikelyVisionChatModel } from '@/common/utils/modelCapabilities';
import { getBuiltinMcpScriptPath } from '../utils/initStorage';
import { setStartOnBootEnabled } from './applicationBridge';
import { writeCloseToTraySetting } from '../utils/closeToTraySetting';
import { createOrUpdateTray, setCloseToTrayEnabled } from '../utils/tray';
import type { Assistant, AssistantDetail, UpdateAssistantRequest } from '@/common/types/agent/assistantTypes';
import type { CreateProviderRequest, UpdateProviderRequest } from '@/common/types/provider/providerApi';
import {
  EthanTokenCatalogCoordinator,
  haveSameModelSet,
  parseRemoteModelCatalogResponse,
  sortCatalogModels,
  type CatalogParseResult,
  type CatalogSyncIdentity,
} from './ethantokenCatalogSync';

const ETHANTOKEN_BASE_URL = (process.env.ETHANTOKEN_BASE_URL || 'https://ethantoken.top').replace(/\/+$/, '');
// Aionrs appends `/chat/completions` directly to provider base_url when is_full_url=false,
// so the provider base_url must end with `/v1`. All models use `openai` protocol so both
// OpenAI-compatible models and Claude models work cleanly on `/v1/chat/completions`.
const ETHANTOKEN_API_BASE_URL = `${ETHANTOKEN_BASE_URL}/v1`;
const QUOTA_PER_USD = 500000;
const PROVIDER_NAME = 'EthanToken';
const catalogCoordinator = new EthanTokenCatalogCoordinator();

const DEFAULT_MODELS = [
  'deepseek-v4.1-flash',
  'gpt-6.2-sol-fast',
  'claude-sonnet-5-5',
  'gpt-6.2-sol',
  'gpt-6.2-sol-pro',
  'gpt-6.2-astra',
  'deepseek-v4-pro',
  'grok-4.7',
  'gpt-image-2.5',
  'gpt-image-2.5-b64',
  'gpt-image-2.6',
];

const PREFERRED_CHAT_ORDER = [
  'deepseek-v4.1-flash',
  'gemini-4-hydrogen',
  'gemini-4-carbon',
  'gemini-4-neon',
  'gpt-6.2-sol-fast',
  'claude-sonnet-5-5',
  'gpt-6.2-sol',
  'deepseek-v4-pro',
  'grok-4.7',
];

const PREFERRED_IMAGE_MODELS = [
  'gpt-image-2.6',
  'gpt-image-2.5',
  'gpt-image-2.5-b64',
  'gpt-image-2.6-flare',
  'gpt-image-2.6-sunburst',
  'grok-imagine-image-2.0',
  'gemini-2.5-flash-image',
];

interface StoredSession {
  baseUrl: string;
  accessToken?: string;
  cookie?: string;
  userId: number;
  username: string;
  group: string;
  quotaUsd: number;
  usedUsd: number;
  affCode?: string;
  affCount?: number;
  affQuotaUsd?: number;
  affHistoryUsd?: number;
  dailyBonus?: EthanTokenDailyBonusState;
  apiKey?: string;
  models?: string[];
  providerId?: string;
  lastSyncedAt: number;
  catalogSyncedAt?: number;
}

interface StoredAccountStore {
  activeUserId?: number;
  accounts: StoredSession[];
}

interface DesktopDailyBonusResponse {
  claimed?: boolean;
  already_claimed?: boolean;
  remain_quota?: number;
  used_quota?: number;
  grant_quota?: number;
  expired_time?: number;
  quota?: number;
}

interface NewApiUser {
  id: number;
  username: string;
  group: string;
  quota: number;
  used_quota: number;
  aff_code?: string;
  aff_count?: number;
  aff_quota?: number;
  aff_history?: number;
  daily_bonus?: DesktopDailyBonusResponse;
}

interface NewApiToken {
  id: number;
  key: string;
  name: string;
  group: string;
  status: number;
}

interface DesktopAuthCallbackPayload {
  state?: string;
  accessToken?: string;
  userId?: number;
  username?: string;
  group?: string;
  quotaUsd?: number;
  usedUsd?: number;
  apiKey?: string;
  models?: string[];
}

function getStorePath(): string {
  return path.join(app.getPath('userData'), 'ethantoken-sessions.json');
}

function getLegacySessionPath(): string {
  return path.join(app.getPath('userData'), 'ethantoken-session.json');
}

function readAccountStore(): StoredAccountStore {
  const storePath = getStorePath();
  try {
    if (fs.existsSync(storePath)) {
      const parsed = JSON.parse(fs.readFileSync(storePath, 'utf-8')) as StoredAccountStore;
      if (Array.isArray(parsed?.accounts)) {
        return parsed;
      }
    }
  } catch {
    // fallback to legacy migration
  }

  try {
    const legacyPath = getLegacySessionPath();
    if (fs.existsSync(legacyPath)) {
      const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf-8')) as StoredSession;
      if (legacy?.userId) {
        const migrated: StoredAccountStore = {
          activeUserId: legacy.userId,
          accounts: [legacy],
        };
        writeAccountStore(migrated);
        return migrated;
      }
    }
  } catch {
    // ignore legacy read failure
  }

  return { accounts: [] };
}

function getSharedConfigPath(): string {
  return path.join(app.getPath('appData'), 'ethantoken', 'config.json');
}

function mapDailyBonusPayload(raw?: DesktopDailyBonusResponse | null): EthanTokenDailyBonusState | undefined {
  if (!raw) return undefined;
  const toUsd = (q?: number) => Math.round(((q ?? 0) / QUOTA_PER_USD) * 10000) / 10000;
  return {
    claimed: Boolean(raw.claimed),
    remainUsd: toUsd(raw.remain_quota),
    usedUsd: toUsd(raw.used_quota),
    grantUsd: toUsd(raw.grant_quota || 100000),
    expiredTime: Number(raw.expired_time || 0),
  };
}

function ensureEthanTokenNoProxy(): void {
  const bypassHosts = ['ethantoken.top', '.ethantoken.top', 'api.2005716.xyz', '127.0.0.1', 'localhost'];
  const merge = (current: string | undefined): string => {
    const parts = (current || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const seen = new Set(parts.map((s) => s.toLowerCase()));
    for (const host of bypassHosts) {
      if (!seen.has(host)) {
        parts.push(host);
        seen.add(host);
      }
    }
    return parts.join(',');
  };
  process.env.NO_PROXY = merge(process.env.NO_PROXY || process.env.no_proxy);
  process.env.no_proxy = process.env.NO_PROXY;
}

function syncSharedEthanTokenConfig(store: StoredAccountStore): void {
  try {
    const active = getActiveSession(store);
    const sharedPath = getSharedConfigPath();
    fs.mkdirSync(path.dirname(sharedPath), { recursive: true });
    const payload = {
      baseUrl: ETHANTOKEN_API_BASE_URL,
      apiKey: active?.apiKey || '',
      defaultImageModel: pickCheapestImageModel(active?.models || DEFAULT_MODELS) || 'gpt-image-2.6',
      userId: active?.userId ?? null,
      username: active?.username ?? '',
      updatedAt: Date.now(),
    };
    fs.writeFileSync(sharedPath, JSON.stringify(payload, null, 2), 'utf-8');
  } catch {
    // ignore shared config mirror write errors
  }
}

function writeAccountStore(store: StoredAccountStore): void {
  const storePath = getStorePath();
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf-8');
  syncSharedEthanTokenConfig(store);
}

function getActiveSession(store: StoredAccountStore): StoredSession | null {
  if (!store.activeUserId) return null;
  return store.accounts.find((a) => a.userId === store.activeUserId) || null;
}

function upsertAccountInStore(session: StoredSession, setActive = true): StoredAccountStore {
  const store = readAccountStore();
  const idx = store.accounts.findIndex((a) => a.userId === session.userId);
  if (idx >= 0) {
    store.accounts[idx] = { ...store.accounts[idx], ...session };
  } else {
    store.accounts.unshift(session);
  }
  if (setActive) {
    store.activeUserId = session.userId;
  }
  writeAccountStore(store);
  return store;
}

function toAccountSummaries(store: StoredAccountStore): EthanTokenAccountSummary[] {
  return store.accounts.map((a) => ({
    userId: a.userId,
    username: a.username,
    group: a.group || '全能主力',
    quotaUsd: a.quotaUsd ?? 0,
  }));
}

function toAccountState(store: StoredAccountStore, error?: string): EthanTokenAccountState {
  const active = getActiveSession(store);
  const accounts = toAccountSummaries(store);
  if (!active) {
    return {
      loggedIn: false,
      baseUrl: ETHANTOKEN_BASE_URL,
      accounts,
      ...(error ? { error } : {}),
    };
  }
  const publicBonus: EthanTokenDailyBonusState | undefined = active.dailyBonus
    ? {
        claimed: active.dailyBonus.claimed,
        remainUsd: active.dailyBonus.remainUsd,
        usedUsd: active.dailyBonus.usedUsd,
        grantUsd: active.dailyBonus.grantUsd,
        expiredTime: active.dailyBonus.expiredTime,
      }
    : undefined;
  return {
    loggedIn: true,
    baseUrl: active.baseUrl || ETHANTOKEN_BASE_URL,
    userId: active.userId,
    username: active.username,
    group: active.group,
    quotaUsd: active.quotaUsd,
    usedUsd: active.usedUsd,
    affCode: active.affCode,
    affCount: active.affCount,
    affQuotaUsd: active.affQuotaUsd,
    affHistoryUsd: active.affHistoryUsd,
    dailyBonus: publicBonus,
    providerId: active.providerId,
    lastSyncedAt: active.lastSyncedAt,
    accounts,
    ...(error ? { error } : {}),
  };
}

export function prioritizeChatModels(models: string[]): string[] {
  return sortCatalogModels(models, PREFERRED_CHAT_ORDER);
}

function pickCheapestImageModel(models: string[]): string | undefined {
  for (const preferred of PREFERRED_IMAGE_MODELS) {
    if (models.includes(preferred)) return preferred;
  }
  return models.find((m) => CAPABILITY_PATTERNS.image_generation.test(m) && !/video/i.test(m));
}

async function newApiFetch<T = unknown>(
  endpoint: string,
  options: { method?: string; accessToken?: string; cookie?: string; userId?: number; body?: unknown } = {}
): Promise<{ json: { success: boolean; message?: string; data?: T }; status: number }> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Origin: ETHANTOKEN_BASE_URL,
    Referer: `${ETHANTOKEN_BASE_URL}/`,
  };
  if (options.accessToken) headers.Authorization = `Bearer ${options.accessToken}`;
  if (options.cookie) headers.Cookie = options.cookie;
  if (options.userId) headers['New-Api-User'] = String(options.userId);
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const resp = await fetch(`${ETHANTOKEN_BASE_URL}${endpoint}`, {
    method: options.method || 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const text = await resp.text();
  let parsed: { success: boolean; message?: string; data?: T };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`服务器返回非 JSON 响应 (HTTP ${resp.status})`);
  }
  return { json: parsed, status: resp.status };
}

async function resolvePlainTokenKey(
  auth: { accessToken?: string; cookie?: string; userId: number },
  token: NewApiToken
): Promise<string> {
  let rawKey = token.key?.trim() || '';
  if (!rawKey || rawKey.includes('*')) {
    const keyRes = await newApiFetch<{ key?: string }>(`/api/token/${token.id}/key`, {
      method: 'POST',
      ...auth,
    });
    if (!keyRes.json.success || !keyRes.json.data?.key) {
      throw new Error(keyRes.json.message || '获取完整 API 密钥失败');
    }
    rawKey = keyRes.json.data.key.trim();
  }
  if (!rawKey || rawKey.includes('*')) {
    throw new Error('未能获取完整 API 密钥（服务端返回了脱敏掩码）');
  }
  return rawKey.startsWith('sk-') ? rawKey : `sk-${rawKey}`;
}

async function ensureApiKey(auth: { accessToken?: string; cookie?: string; userId: number }): Promise<string> {
  const listRes = await newApiFetch<{ items?: NewApiToken[] } | NewApiToken[]>('/api/token/?p=0&size=20', auth);
  const rawData = listRes.json.data;
  const items = Array.isArray(rawData) ? rawData : rawData?.items || [];

  const usable =
    items.find((t) => t.status === 1 && (t.group === '全能主力' || t.group === '')) ||
    items.find((t) => t.status === 1);

  if (usable) {
    return await resolvePlainTokenKey(auth, usable);
  }

  const createRes = await newApiFetch('/api/token/', {
    method: 'POST',
    ...auth,
    body: {
      name: 'AionUi-Desktop',
      remain_quota: 0,
      unlimited_quota: true,
      expired_time: -1,
      group: '全能主力',
      model_limits_enabled: false,
      model_limits: '',
    },
  });
  if (!createRes.json.success) {
    throw new Error(createRes.json.message || '自动创建 API 密钥失败');
  }

  const reList = await newApiFetch<{ items?: NewApiToken[] } | NewApiToken[]>('/api/token/?p=0&size=20', auth);
  const reData = reList.json.data;
  const reItems = Array.isArray(reData) ? reData : reData?.items || [];
  const created = reItems.find((t) => t.status === 1 && t.name === 'AionUi-Desktop') || reItems.find((t) => t.status === 1);
  if (!created) {
    throw new Error('创建令牌后未能读取到可用密钥');
  }
  return await resolvePlainTokenKey(auth, created);
}

async function fetchModelsByApiKey(apiKey: string, baseUrl: string = ETHANTOKEN_BASE_URL): Promise<CatalogParseResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const apiBase = `${baseUrl.replace(/\/+$/, '')}/v1`;
    const resp = await fetch(`${apiBase}/models`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });
    let body: unknown = null;
    try {
      body = await resp.json();
    } catch {
      body = null;
    }
    return parseRemoteModelCatalogResponse(resp.status, body, PREFERRED_CHAT_ORDER);
  } catch (err) {
    return {
      ok: false,
      reason: 'network_error',
      authInvalid: false,
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function findManagedEthanTokenProvider(providers: IProvider[], preferredProviderId?: string): IProvider | undefined {
  if (preferredProviderId) {
    const byId = providers.find((p) => p.id === preferredProviderId);
    if (byId) return byId;
  }
  const expectedBase = ETHANTOKEN_API_BASE_URL.replace(/\/+$/, '');
  return providers.find(
    (p) =>
      p.platform === 'new-api' &&
      (p.name === PROVIDER_NAME ||
        unwrapThinkingGatewayUrl(p.base_url).replace(/\/+$/, '') === expectedBase ||
        unwrapThinkingGatewayUrl(p.base_url).includes('ethantoken.top'))
  );
}

function buildEthanTokenModelSettings(
  models: string[],
  existingSettings?: Record<string, ModelSettings>
): Record<string, ModelSettings> {
  const next: Record<string, ModelSettings> = Object.assign({}, existingSettings || {});
  for (const model of models) {
    if (isLikelyVisionChatModel(model) && !next[model]?.image_input) {
      next[model] = Object.assign({}, next[model], { image_input: 'supported' as const });
    }
  }
  return next;
}

function hasMissingVisionModelSettings(
  models: string[],
  existingSettings?: Record<string, ModelSettings>
): boolean {
  return models.some((model) => isLikelyVisionChatModel(model) && !existingSettings?.[model]?.image_input);
}

async function upsertEthanTokenProvider(
  apiKey: string,
  models: string[],
  preferredProviderId?: string
): Promise<string> {
  const existingList = (await httpRequest<IProvider[]>('GET', '/api/providers')) || [];
  const existing = findManagedEthanTokenProvider(existingList, preferredProviderId);

  const modelProtocols: Record<string, string> = {};
  for (const m of models) {
    modelProtocols[m] = 'openai';
  }
  const modelSettings = buildEthanTokenModelSettings(models, existing?.model_settings);
  const providerBaseUrl = thinkingEffortGateway.wrapUrlIfActive(ETHANTOKEN_API_BASE_URL);

  if (existing) {
    const updateBody: UpdateProviderRequest = {
      name: existing.name || PROVIDER_NAME,
      platform: 'new-api',
      base_url: providerBaseUrl,
      api_key: apiKey,
      models: [...models],
      model_protocols: modelProtocols,
      model_settings: modelSettings,
      enabled: existing.enabled !== false,
    };
    const updated = await httpRequest<IProvider>('PUT', `/api/providers/${existing.id}`, updateBody);
    return updated?.id || existing.id;
  }

  const createBody: CreateProviderRequest = {
    name: PROVIDER_NAME,
    platform: 'new-api',
    base_url: providerBaseUrl,
    api_key: apiKey,
    models: [...models],
    model_protocols: modelProtocols,
    model_settings: modelSettings,
    enabled: true,
  };
  const created = await httpRequest<IProvider>('POST', '/api/providers', createBody);
  return created.id;
}

async function syncManagedEthanTokenCatalog(params: {
  userId: number;
  apiKey: string;
  baseUrl?: string;
  preferredProviderId?: string;
  fallbackSnapshot?: readonly string[];
}) {
  const identity: CatalogSyncIdentity = {
    baseUrl: (params.baseUrl || ETHANTOKEN_BASE_URL).replace(/\/+$/, ''),
    userId: params.userId,
    apiKey: params.apiKey,
  };
  return catalogCoordinator.sync(identity, params.fallbackSnapshot, {
    fetchCatalog: (id) => fetchModelsByApiKey(id.apiKey, id.baseUrl),
    readCurrentProviderModels: async (id) => {
      const providers = (await httpRequest<IProvider[]>('GET', '/api/providers')) || [];
      const existing = findManagedEthanTokenProvider(providers, params.preferredProviderId);
      const expectedWrappedBase = thinkingEffortGateway.wrapUrlIfActive(ETHANTOKEN_API_BASE_URL);
      const needsRepair =
        !existing ||
        !existing.api_key ||
        existing.api_key.includes('*') ||
        unwrapThinkingGatewayUrl(existing.base_url) !== ETHANTOKEN_API_BASE_URL ||
        existing.base_url !== expectedWrappedBase ||
        existing.model_protocols?.['claude-sonnet-5-5'] === 'anthropic' ||
        existing.api_key !== id.apiKey ||
        hasMissingVisionModelSettings(existing.models || [], existing.model_settings);
      return {
        providerId: existing?.id,
        models: existing ? (Array.isArray(existing.models) ? existing.models : []) : undefined,
        needsRepair,
      };
    },
    writeProviderModels: (id, models) => upsertEthanTokenProvider(id.apiKey, models, params.preferredProviderId),
  });
}

async function ensureImageGenerationConfigured(providerId: string, apiKey: string, models: string[]): Promise<void> {
  const chosenModel = pickCheapestImageModel(models);
  if (!chosenModel) return;

  try {
    const clientSettings = await httpRequest<
      Record<string, { id?: string; api_key?: string; use_model?: string; base_url?: string } | null>
    >('GET', '/api/settings/client?keys=tools.imageGenerationModel');
    const currentSetting = clientSettings?.['tools.imageGenerationModel'];
    const needsSettingUpdate =
      !currentSetting ||
      !currentSetting.id ||
      !currentSetting.use_model ||
      !currentSetting.api_key ||
      currentSetting.api_key.includes('*') ||
      (currentSetting.id === providerId &&
        (currentSetting.api_key !== apiKey || currentSetting.base_url !== ETHANTOKEN_API_BASE_URL));

    const targetModel =
      currentSetting?.use_model && models.includes(currentSetting.use_model) ? currentSetting.use_model : chosenModel;

    if (needsSettingUpdate) {
      await httpRequest<void>('PUT', '/api/settings/client', {
        'tools.imageGenerationModel': {
          id: providerId,
          platform: 'new-api',
          name: PROVIDER_NAME,
          base_url: ETHANTOKEN_API_BASE_URL,
          api_key: apiKey,
          use_model: targetModel,
          switch: true,
        },
      });
    }

    const servers = (await httpRequest<IMcpServer[]>('GET', '/api/mcp/servers')) || [];
    const builtinImg = servers.find((s) => s.name === BUILTIN_IMAGE_GEN_NAME);
    const scriptPath = getBuiltinMcpScriptPath('builtin-mcp-image-gen');
    const desiredEnv: Record<string, string> = {
      ...(builtinImg?.transport.type === 'stdio' ? builtinImg.transport.env || {} : {}),
      [IMAGE_GEN_ENV_KEYS.providerId]: providerId,
      [IMAGE_GEN_ENV_KEYS.platform]: 'new-api',
      [IMAGE_GEN_ENV_KEYS.baseUrl]: ETHANTOKEN_API_BASE_URL,
      [IMAGE_GEN_ENV_KEYS.apiKey]: apiKey,
      [IMAGE_GEN_ENV_KEYS.model]: targetModel,
    };

    if (!builtinImg) {
      const serverConfig = { command: 'node', args: [scriptPath], env: desiredEnv };
      const createdServer = await httpRequest<IMcpServer>('POST', '/api/mcp/servers', {
        name: BUILTIN_IMAGE_GEN_NAME,
        description: 'Built-in image generation tool powered by AI models. Configure the model in Settings > Tools.',
        builtin: true,
        transport: { type: 'stdio', ...serverConfig },
        original_json: JSON.stringify({ mcpServers: { [BUILTIN_IMAGE_GEN_NAME]: serverConfig } }, null, 2),
      });
      if (createdServer?.id && !createdServer.enabled) {
        await httpRequest('POST', `/api/mcp/servers/${createdServer.id}/toggle`);
      }
      return;
    }

    if (builtinImg.transport.type === 'stdio') {
      const existingEnv = builtinImg.transport.env || {};
      const envChanged =
        existingEnv[IMAGE_GEN_ENV_KEYS.providerId] !== desiredEnv[IMAGE_GEN_ENV_KEYS.providerId] ||
        existingEnv[IMAGE_GEN_ENV_KEYS.apiKey] !== desiredEnv[IMAGE_GEN_ENV_KEYS.apiKey] ||
        existingEnv[IMAGE_GEN_ENV_KEYS.model] !== desiredEnv[IMAGE_GEN_ENV_KEYS.model] ||
        existingEnv[IMAGE_GEN_ENV_KEYS.baseUrl] !== desiredEnv[IMAGE_GEN_ENV_KEYS.baseUrl] ||
        builtinImg.transport.args?.[0] !== scriptPath;

      if (envChanged) {
        const updatedTransport = { ...builtinImg.transport, command: 'node', args: [scriptPath], env: desiredEnv };
        const original_json = JSON.stringify(
          {
            mcpServers: {
              [builtinImg.name]: {
                command: updatedTransport.command,
                args: updatedTransport.args,
                env: desiredEnv,
              },
            },
          },
          null,
          2
        );
        await httpRequest('PUT', `/api/mcp/servers/${builtinImg.id}`, {
          transport: updatedTransport,
          original_json,
        });
      }

      if (!builtinImg.enabled) {
        await httpRequest('POST', `/api/mcp/servers/${builtinImg.id}/toggle`);
      }
    }
  } catch (err) {
    console.warn('[EthanToken] image generation auto-config skipped:', err);
  }
}

function focusMainWindow(): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.setAlwaysOnTop(true);
  win.focus();
  win.setAlwaysOnTop(false);
  app.focus({ steal: true });
}

async function applyAuthorizedPayload(payload: DesktopAuthCallbackPayload): Promise<StoredAccountStore> {
  const rawKey = (payload.apiKey || '').trim();
  if (!rawKey || rawKey.includes('*')) {
    throw new Error('授权回调未包含有效明文 API 密钥');
  }
  const normalizedKey = rawKey.startsWith('sk-') ? rawKey : `sk-${rawKey}`;
  const userId = Number(payload.userId);
  const fallbackModels = Array.isArray(payload.models)
    ? prioritizeChatModels(payload.models.filter((m): m is string => typeof m === 'string' && m.trim().length > 0))
    : undefined;

  catalogCoordinator.setActiveIdentity({
    baseUrl: ETHANTOKEN_BASE_URL,
    userId,
    apiKey: normalizedKey,
  });

  let desktopMeta: NewApiUser | null = null;
  try {
    const desktopRes = await newApiFetch<NewApiUser>('/api/desktop/quota', {
      accessToken: normalizedKey,
      userId,
    });
    if (desktopRes.status !== 401 && desktopRes.json.success && desktopRes.json.data) {
      desktopMeta = desktopRes.json.data;
    }
  } catch {
    // ignore metadata fetch failure on login callback
  }

  const syncRes = await syncManagedEthanTokenCatalog({
    userId,
    apiKey: normalizedKey,
    baseUrl: ETHANTOKEN_BASE_URL,
    fallbackSnapshot: fallbackModels,
  });

  const models = syncRes.status === 'synced' ? syncRes.models : fallbackModels ?? [];
  let providerId = syncRes.providerId;
  if (!providerId) {
    providerId = await upsertEthanTokenProvider(normalizedKey, models);
  }
  await ensureImageGenerationConfigured(providerId, normalizedKey, models);

  const dailyBonus = mapDailyBonusPayload(desktopMeta?.daily_bonus);
  const session: StoredSession = {
    baseUrl: ETHANTOKEN_BASE_URL,
    accessToken: payload.accessToken,
    userId,
    username: desktopMeta?.username || payload.username || `user_${userId}`,
    group: desktopMeta?.group || payload.group || '全能主力',
    quotaUsd:
      desktopMeta !== null
        ? Math.round((desktopMeta.quota / QUOTA_PER_USD) * 10000) / 10000
        : typeof payload.quotaUsd === 'number'
          ? payload.quotaUsd
          : 0,
    usedUsd:
      desktopMeta !== null
        ? Math.round((desktopMeta.used_quota / QUOTA_PER_USD) * 10000) / 10000
        : typeof payload.usedUsd === 'number'
          ? payload.usedUsd
          : 0,
    affCode: desktopMeta?.aff_code,
    affCount: desktopMeta?.aff_count,
    affQuotaUsd:
      typeof desktopMeta?.aff_quota === 'number'
        ? Math.round((desktopMeta.aff_quota / QUOTA_PER_USD) * 10000) / 10000
        : undefined,
    affHistoryUsd:
      typeof desktopMeta?.aff_history === 'number'
        ? Math.round((desktopMeta.aff_history / QUOTA_PER_USD) * 10000) / 10000
        : undefined,
    dailyBonus,
    apiKey: normalizedKey,
    models,
    providerId,
    lastSyncedAt: Date.now(),
    catalogSyncedAt: syncRes.catalogSyncedAt,
  };

  return upsertAccountInStore(session, true);
}

let activeAuthCancel: ((reason?: string) => void) | null = null;

const ALLOWED_AUTH_ORIGINS = new Set([
  'https://ethantoken.top',
  'https://api.2005716.xyz',
  'https://cf.ethantoken.top',
  'https://ai.dflow.top',
]);

async function loginViaSystemBrowser(): Promise<EthanTokenAccountState> {
  if (activeAuthCancel) {
    activeAuthCancel('已重新发起浏览器授权');
    activeAuthCancel = null;
  }

  const expectedState = crypto.randomBytes(16).toString('hex');

  return await new Promise<EthanTokenAccountState>((resolve) => {
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | null = null;

    const server = http.createServer((req, res) => {
      const requestOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
      const allowedOrigin = ALLOWED_AUTH_ORIGINS.has(requestOrigin) ? requestOrigin : ETHANTOKEN_BASE_URL;
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === 'POST' && req.url?.startsWith('/callback')) {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
          if (body.length > 1024 * 1024) req.destroy();
        });
        req.on('end', () => {
          void (async () => {
            try {
              const payload = JSON.parse(body) as DesktopAuthCallbackPayload;
              if (!payload || payload.state !== expectedState || !payload.userId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Invalid state or user' }));
                return;
              }
              const store = await applyAuthorizedPayload(payload);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true }));
              finish(toAccountState(store));
              focusMainWindow();
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, message: msg }));
              finish(toAccountState(readAccountStore(), msg));
            }
          })();
        });
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    const cleanup = () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (activeAuthCancel === cancel) {
        activeAuthCancel = null;
      }
      try {
        server.close();
      } catch {
        // ignore close error
      }
    };

    const finish = (state: EthanTokenAccountState) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(state);
    };

    const cancel = (reason?: string) => {
      finish(toAccountState(readAccountStore(), reason));
    };

    activeAuthCancel = cancel;

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        finish(toAccountState(readAccountStore(), '无法启动本地授权回调服务'));
        return;
      }
      const callbackUrl = `http://127.0.0.1:${addr.port}/callback`;
      const authUrl = `${ETHANTOKEN_BASE_URL}/desktop-auth?callback=${encodeURIComponent(callbackUrl)}&state=${encodeURIComponent(expectedState)}`;
      void shell.openExternal(authUrl);
    });

    server.on('error', (err) => {
      finish(toAccountState(readAccountStore(), `授权服务启动失败: ${err.message}`));
    });

    timeoutTimer = setTimeout(() => {
      finish(toAccountState(readAccountStore(), '浏览器授权超时，请重试'));
    }, 180000);
  });
}

const DEFAULT_USER_PRESETS: Record<string, unknown> = {
  language: 'zh-CN',
  'upload.saveToWorkspace': true,
  'workspace.pasteConfirm': true,
  'system.notificationEnabled': true,
  'system.closeToTray': true,
  'webui.desktop.enabled': false,
  'pet.enabled': false,
};

let presetsApplied = false;

async function ensureDefaultUserPresets(): Promise<void> {
  if (presetsApplied) return;
  try {
    const keys = [...Object.keys(DEFAULT_USER_PRESETS), 'ethantoken.bootDefaultApplied'];
    const current =
      (await httpRequest<Record<string, unknown>>(
        'GET',
        `/api/settings/client?keys=${encodeURIComponent(keys.join(','))}`
      )) || {};
    const updates: Record<string, unknown> = {};
    for (const [key, defaultValue] of Object.entries(DEFAULT_USER_PRESETS)) {
      if (current[key] === undefined || current[key] === null) {
        updates[key] = defaultValue;
      }
    }

    if (current['system.closeToTray'] === undefined || current['system.closeToTray'] === null) {
      await writeCloseToTraySetting(true);
      setCloseToTrayEnabled(true);
      createOrUpdateTray();
    }

    if (!current['ethantoken.bootDefaultApplied']) {
      if (app.isPackaged) {
        setStartOnBootEnabled(true);
      }
      updates['ethantoken.bootDefaultApplied'] = true;
    }

    if (Object.keys(updates).length > 0) {
      await httpRequest<void>('PUT', '/api/settings/client', updates);
    }
    presetsApplied = true;
  } catch (err) {
    console.warn('[EthanToken] default user presets skipped:', err);
  }
}

const ETHANTOKEN_MEDIA_SKILL_MD = `---
name: ethantoken-media
description: EthanToken 官方生图（含文生图、参考图/图生图编辑）与生视频操作手册。调用媒体工具或写生图/生视频脚本前优先遵循本手册，严禁全盘 Grep、翻找 SQLite 或 .asar。
---

# EthanToken 媒体生成操作手册

## 1. 首选方案：直接调用内置 MCP 工具 \`aionui_image_generation\`
- 工具 schema 已直接暴露并透传 \`prompt\`、\`image_uris\`、\`model\`、\`size\`、\`quality\`、\`n\`，工具描述中已回显当前默认模型（通常为 \`gpt-image-2.6\`）。
- **文生图**：直接传 \`prompt\`（可选 \`model\`、\`size\`如 \`"1024x1536"\`、\`quality\`、\`n\`）。
- **参考图 / 图生图**：同时传 \`prompt\` 与 \`image_uris: ["参考图文件名.jpg"]\`（自动路由至 \`/v1/images/edits\`）。
- 工具会自动将成片保存到当前工作区并返回相对路径。**能用 MCP 一次完成时，不要再写脚本或读取配置文件。**

## 2. 如需脚本调用：HTTP 接口与密钥入口

### 2.1 API 密钥获取（唯一推荐入口，严禁全盘搜索或翻 SQLite）
- 直接读取 \`%APPDATA%\\ethantoken\\config.json\`：
  - \`baseUrl\`：\`https://ethantoken.top/v1\`
  - \`apiKey\`：当前激活账号明文 \`sk-...\`
  - \`defaultImageModel\`：当前推荐生图模型
- 备用只读会话文件：\`%APPDATA%\\AionUi\\ethantoken-sessions.json\` 中 \`activeUserId\` 对应账号的 \`apiKey\`。

### 2.2 文生图接口（Text-to-Image）
- **端点**：\`POST https://ethantoken.top/v1/images/generations\`（Content-Type: \`application/json\`）
- **参数**：\`{ "model": "gpt-image-2.6", "prompt": "...", "size": "1024x1024", "n": 1 }\`
- **常用模型**：\`gpt-image-2.6\`、\`gpt-image-2.5\`、\`grok-imagine-image-2.0\`（勿用无渠道的 \`gpt-image-2.6-b64\`；仅 \`gemini-*-image\` 走 \`/v1/chat/completions\`）。
- **返回处理**：兼容读取 \`data[0].b64_json\`（解码写入工作区）或 \`data[0].url\`（直接 GET 下载落盘）。

### 2.3 参考图 / 图生图接口（Image-to-Image / Edits）
- **端点**：\`POST https://ethantoken.top/v1/images/edits\`（**必须使用 \`multipart/form-data\`**，不要走 JSON \`generations\` 或 \`chat/completions\`）
- **表单字段**：
  - \`image\`：参考图二进制文件（可附带多个同名 \`image\` 字段以传多张参考图）
  - \`model\`：如 \`gpt-image-2.6\`
  - \`prompt\`：英文/中文编辑指令
  - \`size\`（可选）：如 \`1024x1024\`、\`1024x1536\`、\`1536x1024\`
  - \`n\`（可选）：数量，默认 \`1\`

## 3. 生视频接口
- 支持模型：\`grok-imagine-video\`、\`grok-imagine-video-1.5\`、\`muse-video\`。
- **正确端点**：\`POST https://ethantoken.top/v1/videos\` 创建异步任务，拿到 \`id\` 后轮询 \`GET https://ethantoken.top/v1/videos/{id}\` 直到完成并下载视频到工作区。

## 4. Windows Skills CLI 与故障降级提示
- 若内置 \`Skill('ethantoken-media')\` 工具返回 \`Available skills:\` 为空，**不要重复调用 \`Skill()\`**，直接调用 \`aionui_image_generation\` 或直接读取 \`%APPDATA%\\AionUi\\aionui\\skills\\ethantoken-media\\SKILL.md\`。
- 在 Windows PowerShell 中如须调用 \`$env:AIONUI_HELPER_BIN\`，**禁止使用 \`printf\` 或直接 \`$json | & exe\`（会带 BOM 报错）**，请用 Python 或无 BOM UTF-8 写法：
  \`python -c "import os,subprocess; print(subprocess.check_output([os.environ['AIONUI_HELPER_BIN'],'skills','show'], input=b'{\\"name\\":\\"ethantoken-media\\"}').decode('utf-8','replace').replace('\\r',''))"\`

## 5. 结果展示要求
- 成片保存到当前工作区后，最终回复中**必须**附带相对路径 Markdown 图片语法（例如 \`![成片描述](output.png)\`），不要写 \`C:\\\` 绝对路径。
`;

const ETHANTOKEN_KNOWLEDGE_CURATOR_SKILL_MD = `---
name: ethantoken-knowledge-curator
description: EthanToken 本地知识空间智能管家技能。当用户希望从某个本地文件夹中筛选特定类型资料（如 .md/.docx/.xlsx/.txt）并沉淀为客户端知识空间、生成知识导图或进行费曼学习梳理时激活。
---

# EthanToken 本地知识空间整理与助学规范

## 1. 一键整理并导入本地知识空间（严禁全盘乱塞源码和无关文件）
当用户指定了一个本地文件夹并希望将其整理成知识空间时，按以下 3 步执行：
1. **先盘点目录文件分布**：调用内置 MCP 工具 \`knowledge_scan_folder({ folderPath })\`，查看各扩展名文件数量与样例路径。
2. **智能筛选与确认**：
   - 若用户明确指定了后缀（如只要 \`.md\` 或 \`.docx\`），按用户指定筛选；
   - 若未指定，优先推荐笔记/文档类（\`.md\`、\`.mdx\`、\`.txt\`、\`.docx\`、\`.xlsx\`），自动排除源码（\`.js\`/\`.cs\`/\`.ts\`）、构建产物与 JSON 数据文件；如有明显歧义先向用户简短确认。
3. **建库落地**：调用 \`knowledge_create_or_add({ name, description, sourcePaths: [folderPath], allowedExtensions })\` 完成精准建库，并告知用户现在可在对话里用 \`@知识库:<名称>\` 或左下角知识库按钮随时引用。

## 2. AI 助学模式（对标 NotebookLM / Study Mode）
- 梳理知识框架时，给出分级目录、核心概念关联与学习路线，并附引用文档相对路径；
- 开展费曼互动教学时，每次只讲 1 个核心模块，穿插 1 个启发式检验提问，根据用户回答再推进下一阶段，不要一次性倾倒长篇讲义；
- 进行出题自测时，围绕真实索引文档生成 5 道有区分度的思考题/实践题，等待用户作答后再逐题点评。
`;

let skillFileWritten = false;
let skillAttachPromise: Promise<void> | null = null;

function getSkillAttachmentStatePath(): string {
  return path.join(app.getPath('userData'), 'ethantoken-skill-attachments-v2.json');
}

function readHandledSkillAssistantIds(): Set<string> {
  try {
    const file = getSkillAttachmentStatePath();
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (Array.isArray(parsed)) {
        return new Set(parsed.filter((id): id is string => typeof id === 'string'));
      }
    }
  } catch {
    // ignore read error
  }
  return new Set();
}

function writeHandledSkillAssistantIds(ids: Set<string>): void {
  try {
    const file = getSkillAttachmentStatePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(Array.from(ids), null, 2), 'utf-8');
  } catch {
    // ignore write error
  }
}

async function attachEthanTokenSkillToAssistants(): Promise<void> {
  if (skillAttachPromise) {
    return skillAttachPromise;
  }
  skillAttachPromise = (async () => {
    try {
      const [assistants, mcpServers] = await Promise.all([
        httpRequest<Assistant[]>('GET', '/api/assistants'),
        httpRequest<IMcpServer[]>('GET', '/api/mcp/servers').catch((): IMcpServer[] => []),
      ]);
      if (!Array.isArray(assistants) || assistants.length === 0) return;

      const enabledImageGenId = (mcpServers || []).find(
        (s) => s.name === BUILTIN_IMAGE_GEN_NAME && s.enabled
      )?.id;
      const enabledKnowledgeMcpId = (mcpServers || []).find(
        (s) => s.name === BUILTIN_KNOWLEDGE_MCP_NAME && s.enabled
      )?.id;
      const handledIds = readHandledSkillAssistantIds();
      let changed = false;

      for (const assistant of assistants) {
        if (!assistant?.id) continue;
        if (handledIds.has(assistant.id)) continue;

        if (assistant.source === 'builtin') {
          try {
            const detail = await httpRequest<AssistantDetail>(
              'GET',
              `/api/assistants/${encodeURIComponent(assistant.id)}?locale=zh-CN`
            );
            const currentSkillIds = detail?.defaults?.skills?.value ?? detail?.capabilities?.default_skill_ids ?? [];
            const currentMcpIds = detail?.defaults?.mcps?.value ?? [];
            const nextSkillIds = Array.from(
              new Set([...currentSkillIds, 'ethantoken-media', 'ethantoken-knowledge-curator'])
            );
            const extraMcps = [enabledImageGenId, enabledKnowledgeMcpId].filter((id): id is string => Boolean(id));
            const nextMcpIds = extraMcps.length > 0 ? Array.from(new Set([...currentMcpIds, ...extraMcps])) : currentMcpIds;
            const builtinPayload: UpdateAssistantRequest = {
              id: assistant.id,
              agent_id: detail?.engine?.agent_id || assistant.agent_id || undefined,
              defaults: {
                skills: { mode: 'fixed', value: nextSkillIds },
                ...(extraMcps.length > 0 ? { mcps: { mode: 'fixed', value: nextMcpIds } } : {}),
              },
            };
            await httpRequest<Assistant>('PUT', `/api/assistants/${encodeURIComponent(assistant.id)}`, builtinPayload);
            // Keep builtin assistants eligible until both image-gen and knowledge MCPs are attached.
            if (enabledImageGenId && enabledKnowledgeMcpId) {
              handledIds.add(assistant.id);
              changed = true;
            }
          } catch (err) {
            console.warn(`[EthanToken] attach defaults to builtin assistant ${assistant.id} deferred:`, err);
          }
          continue;
        }

        const existingSkills = assistant.enabled_skills ?? [];
        if (existingSkills.includes('ethantoken-media') && existingSkills.includes('ethantoken-knowledge-curator')) {
          handledIds.add(assistant.id);
          changed = true;
          continue;
        }

        const updatePayload: UpdateAssistantRequest = {
          id: assistant.id,
          enabled_skills: Array.from(new Set([...existingSkills, 'ethantoken-media', 'ethantoken-knowledge-curator'])),
        };
        try {
          await httpRequest<Assistant>('PUT', `/api/assistants/${encodeURIComponent(assistant.id)}`, updatePayload);
          handledIds.add(assistant.id);
          changed = true;
        } catch (err) {
          console.warn(`[EthanToken] attach skill to assistant ${assistant.id} deferred:`, err);
        }
      }

      if (changed) {
        writeHandledSkillAssistantIds(handledIds);
      }
    } catch (err) {
      console.warn('[EthanToken] attach ethantoken-media skill to assistants deferred:', err);
    } finally {
      skillAttachPromise = null;
    }
  })();
  return skillAttachPromise;
}

async function ensureEthanTokenSkillInstalled(): Promise<void> {
  try {
    if (!skillFileWritten) {
      const paths = await httpRequest<{ user_skills_dir?: string }>('GET', '/api/skills/paths');
      if (!paths?.user_skills_dir) return;
      const writeBuiltinSkill = (skillName: string, content: string) => {
        const skillDir = path.join(paths.user_skills_dir!, skillName);
        const skillFile = path.join(skillDir, 'SKILL.md');
        fs.mkdirSync(skillDir, { recursive: true });
        if (!fs.existsSync(skillFile) || fs.readFileSync(skillFile, 'utf-8') !== content) {
          fs.writeFileSync(skillFile, content, 'utf-8');
        }
      };
      writeBuiltinSkill('ethantoken-media', ETHANTOKEN_MEDIA_SKILL_MD);
      writeBuiltinSkill('ethantoken-knowledge-curator', ETHANTOKEN_KNOWLEDGE_CURATOR_SKILL_MD);
      skillFileWritten = true;
    }
    await attachEthanTokenSkillToAssistants();
  } catch (err) {
    console.warn('[EthanToken] install ethantoken-media skill deferred:', err);
  }
}

export function initEthanTokenBridge(): void {
  ensureEthanTokenNoProxy();
  const initialStore = readAccountStore();
  syncSharedEthanTokenConfig(initialStore);
  void ensureDefaultUserPresets();
  void ensureEthanTokenSkillInstalled();

  ipcBridge.ethantoken.getStatus.provider(async () => {
    void ensureEthanTokenSkillInstalled();
    void ensureDefaultUserPresets();
    return toAccountState(readAccountStore());
  });

  ipcBridge.ethantoken.login.provider(async () => {
    try {
      const state = await loginViaSystemBrowser();
      void ensureEthanTokenSkillInstalled();
      return state;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return toAccountState(readAccountStore(), msg);
    }
  });

  ipcBridge.ethantoken.cancelLogin.provider(async () => {
    if (activeAuthCancel) {
      activeAuthCancel('已取消登录授权');
    }
    return toAccountState(readAccountStore());
  });

  ipcBridge.ethantoken.switchAccount.provider(async ({ userId }) => {
    const store = readAccountStore();
    const target = store.accounts.find((a) => a.userId === userId);
    if (!target) {
      return toAccountState(store, '未找到该本地账号记录，请重新授权');
    }
    try {
      let apiKey = target.apiKey;
      if ((!apiKey || apiKey.includes('*')) && target.accessToken) {
        const auth = { accessToken: target.accessToken, cookie: target.cookie, userId: target.userId };
        apiKey = await ensureApiKey(auth);
      }
      if (!apiKey || apiKey.includes('*')) {
        return toAccountState(store, '该账号缺少有效密钥，请通过浏览器重新授权');
      }

      catalogCoordinator.setActiveIdentity({
        baseUrl: target.baseUrl || ETHANTOKEN_BASE_URL,
        userId: target.userId,
        apiKey,
      });

      let desktopMeta: NewApiUser | null = null;
      try {
        const desktopRes = await newApiFetch<NewApiUser>('/api/desktop/quota', {
          accessToken: apiKey,
          userId: target.userId,
        });
        if (desktopRes.status !== 401 && desktopRes.json.success && desktopRes.json.data) {
          desktopMeta = desktopRes.json.data;
        }
      } catch {
        // ignore transient desktop quota fetch error when switching accounts
      }

      const syncRes = await syncManagedEthanTokenCatalog({
        userId: target.userId,
        apiKey,
        baseUrl: target.baseUrl || ETHANTOKEN_BASE_URL,
        preferredProviderId: target.providerId,
        fallbackSnapshot: Array.isArray(target.models) ? target.models : undefined,
      });
      if (syncRes.discarded) {
        return toAccountState(readAccountStore());
      }

      const models = syncRes.status === 'synced' ? syncRes.models : Array.isArray(target.models) ? target.models : [];
      let providerId = syncRes.providerId;
      if (!providerId || !syncRes.providerWritten) {
        // When switching accounts and the live fetch failed, still bind the provider to target's apiKey & snapshot
        const providers = (await httpRequest<IProvider[]>('GET', '/api/providers')) || [];
        const existing = findManagedEthanTokenProvider(providers, target.providerId);
        if (!existing || existing.api_key !== apiKey || !haveSameModelSet(existing.models, models)) {
          providerId = await upsertEthanTokenProvider(apiKey, models, target.providerId);
        } else {
          providerId = existing.id;
        }
      }

      const nextBonus = desktopMeta?.daily_bonus ? mapDailyBonusPayload(desktopMeta.daily_bonus) : target.dailyBonus;
      const updated: StoredSession = {
        ...target,
        username: desktopMeta?.username || target.username,
        group: desktopMeta?.group || target.group,
        quotaUsd: desktopMeta ? Math.round((desktopMeta.quota / QUOTA_PER_USD) * 10000) / 10000 : target.quotaUsd,
        usedUsd: desktopMeta ? Math.round((desktopMeta.used_quota / QUOTA_PER_USD) * 10000) / 10000 : target.usedUsd,
        affCode: desktopMeta?.aff_code || target.affCode,
        affCount: desktopMeta?.aff_count ?? target.affCount,
        affQuotaUsd:
          typeof desktopMeta?.aff_quota === 'number'
            ? Math.round((desktopMeta.aff_quota / QUOTA_PER_USD) * 10000) / 10000
            : target.affQuotaUsd,
        affHistoryUsd:
          typeof desktopMeta?.aff_history === 'number'
            ? Math.round((desktopMeta.aff_history / QUOTA_PER_USD) * 10000) / 10000
            : target.affHistoryUsd,
        dailyBonus: nextBonus,
        apiKey,
        models,
        providerId,
        lastSyncedAt: Date.now(),
        catalogSyncedAt: syncRes.catalogSyncedAt ?? target.catalogSyncedAt,
      };
      await ensureImageGenerationConfigured(providerId, apiKey, models);

      const nextStore = upsertAccountInStore(updated, true);
      void ensureEthanTokenSkillInstalled();
      return toAccountState(nextStore);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return toAccountState(readAccountStore(), msg);
    }
  });

  ipcBridge.ethantoken.refresh.provider(async () => {
    const store = readAccountStore();
    const current = getActiveSession(store);
    if (!current) {
      return toAccountState(store);
    }
    try {
      const providers = (await httpRequest<IProvider[]>('GET', '/api/providers')) || [];
      const existing = findManagedEthanTokenProvider(providers, current.providerId);

      // Keep user/self isolated so transient account-profile failures never skip catalog sync.
      let selfRes: { json: { success: boolean; message?: string; data?: NewApiUser }; status: number } | null = null;
      if (current.accessToken) {
        try {
          selfRes = await newApiFetch<NewApiUser>('/api/user/self', {
            accessToken: current.accessToken,
            cookie: current.cookie,
            userId: current.userId,
          });
        } catch {
          selfRes = null;
        }
      }

      let validUser = selfRes && selfRes.status !== 401 && selfRes.json.success ? selfRes.json.data : null;

      let apiKey = current.apiKey;
      if ((!apiKey || apiKey.includes('*')) && existing?.api_key && !existing.api_key.includes('*')) {
        apiKey = existing.api_key;
      }
      if ((!apiKey || apiKey.includes('*')) && validUser && current.accessToken) {
        const auth = { accessToken: current.accessToken, cookie: current.cookie, userId: validUser.id };
        apiKey = await ensureApiKey(auth);
      }

      // Always consult /api/desktop/quota with permanent apiKey so aff_code and daily_bonus stay fresh
      let desktopMeta: NewApiUser | null = null;
      if (apiKey && !apiKey.includes('*')) {
        try {
          const desktopRes = await newApiFetch<NewApiUser>('/api/desktop/quota', {
            accessToken: apiKey,
            userId: current.userId,
          });
          if (desktopRes.status !== 401 && desktopRes.json.success && desktopRes.json.data) {
            desktopMeta = desktopRes.json.data;
            if (!validUser) {
              validUser = desktopMeta;
            }
          }
        } catch {
          // ignore desktop quota error and keep last synced snapshot
        }
      }

      const nextDailyBonus = desktopMeta?.daily_bonus ? mapDailyBonusPayload(desktopMeta.daily_bonus) : current.dailyBonus;

      let providerId = existing?.id || current.providerId;
      let models = Array.isArray(existing?.models)
        ? existing.models
        : Array.isArray(current.models)
          ? current.models
          : [];
      let catalogSyncedAt = current.catalogSyncedAt;
      let catalogAuthInvalid = false;

      if (apiKey && !apiKey.includes('*')) {
        const syncRes = await syncManagedEthanTokenCatalog({
          userId: current.userId,
          apiKey,
          baseUrl: current.baseUrl || ETHANTOKEN_BASE_URL,
          preferredProviderId: providerId,
          fallbackSnapshot: models,
        });
        if (syncRes.discarded) {
          return toAccountState(readAccountStore());
        }
        if (syncRes.status === 'synced') {
          models = syncRes.models;
          providerId = syncRes.providerId || providerId;
          catalogSyncedAt = syncRes.catalogSyncedAt ?? catalogSyncedAt;
        } else if (syncRes.status === 'auth_invalid') {
          catalogAuthInvalid = true;
        }
      }

      if (providerId && apiKey && !apiKey.includes('*')) {
        await ensureImageGenerationConfigured(providerId, apiKey, models);
      }
      void ensureEthanTokenSkillInstalled();

      const latestStore = readAccountStore();
      if (latestStore.activeUserId !== current.userId) {
        return toAccountState(latestStore);
      }

      const quotaSource = desktopMeta || validUser;
      const updated: StoredSession = {
        ...current,
        username: quotaSource?.username || current.username,
        group: quotaSource?.group || current.group,
        quotaUsd: quotaSource ? Math.round((quotaSource.quota / QUOTA_PER_USD) * 10000) / 10000 : current.quotaUsd,
        usedUsd: quotaSource ? Math.round((quotaSource.used_quota / QUOTA_PER_USD) * 10000) / 10000 : current.usedUsd,
        affCode: quotaSource?.aff_code || current.affCode,
        affCount: quotaSource?.aff_count ?? current.affCount,
        affQuotaUsd:
          typeof quotaSource?.aff_quota === 'number'
            ? Math.round((quotaSource.aff_quota / QUOTA_PER_USD) * 10000) / 10000
            : current.affQuotaUsd,
        affHistoryUsd:
          typeof quotaSource?.aff_history === 'number'
            ? Math.round((quotaSource.aff_history / QUOTA_PER_USD) * 10000) / 10000
            : current.affHistoryUsd,
        dailyBonus: nextDailyBonus,
        apiKey,
        models,
        providerId,
        lastSyncedAt: Date.now(),
        catalogSyncedAt,
      };
      const nextStore = upsertAccountInStore(updated, true);

      if (catalogAuthInvalid || !validUser) {
        return toAccountState(nextStore, '登录态已过期');
      }
      return toAccountState(nextStore);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return toAccountState(readAccountStore(), msg);
    }
  });

  ipcBridge.ethantoken.checkin.provider(async () => {
    const store = readAccountStore();
    const current = getActiveSession(store);
    if (!current || !current.apiKey || current.apiKey.includes('*')) {
      return toAccountState(store, '请先登录后再签到');
    }
    try {
      const res = await newApiFetch<DesktopDailyBonusResponse>('/api/desktop/checkin', {
        method: 'POST',
        accessToken: current.apiKey,
        userId: current.userId,
      });
      if (!res.json.success || !res.json.data) {
        return toAccountState(readAccountStore(), res.json.message || '签到失败');
      }
      const nextBonus = mapDailyBonusPayload(res.json.data);
      const updatedQuotaUsd =
        typeof res.json.data.quota === 'number'
          ? Math.round((res.json.data.quota / QUOTA_PER_USD) * 10000) / 10000
          : current.quotaUsd;
      const updated: StoredSession = {
        ...current,
        quotaUsd: updatedQuotaUsd,
        dailyBonus: nextBonus,
        lastSyncedAt: Date.now(),
      };
      const nextStore = upsertAccountInStore(updated, true);
      return toAccountState(nextStore);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return toAccountState(readAccountStore(), msg);
    }
  });

  ipcBridge.ethantoken.getLedger.provider(async ({ range }) => {
    const safeRange = range === 'today' || range === '7d' || range === '30d' ? range : '30d';
    const emptyResult: EthanTokenLedgerData = {
      range: safeRange,
      summary: {
        calls: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        cache_tokens: 0,
        paid_rmb: 0,
        official_rmb: 0,
        saved_rmb: 0,
        save_pct: 0,
      },
      models: [],
      logs: [],
    };
    const store = readAccountStore();
    const current = getActiveSession(store);
    if (!current || !current.apiKey || current.apiKey.includes('*')) {
      return { ...emptyResult, error: '请先登录 EthanToken 账号' };
    }
    try {
      const res = await newApiFetch<EthanTokenLedgerData>(`/api/desktop/ledger?range=${safeRange}`, {
        accessToken: current.apiKey,
        userId: current.userId,
      });
      if (!res.json.success || !res.json.data) {
        return { ...emptyResult, error: res.json.message || '获取用量与账单失败' };
      }
      return res.json.data;
    } catch (err) {
      return { ...emptyResult, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcBridge.ethantoken.openWallet.provider(async () => {
    await shell.openExternal(`${ETHANTOKEN_BASE_URL}/wallet`);
    return toAccountState(readAccountStore());
  });

  ipcBridge.ethantoken.logout.provider(async () => {
    catalogCoordinator.invalidate();
    const store = readAccountStore();
    if (store.activeUserId) {
      store.accounts = store.accounts.filter((a) => a.userId !== store.activeUserId);
      store.activeUserId = undefined;
      writeAccountStore(store);
    }
    return toAccountState(store);
  });
}

/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { httpRequest } from '@/common/adapter/httpBridge';
import type { IMcpServer } from '@/common/config/storage';
import {
  expandMcpToolNameAliases,
  isToolVisibleToApp,
  MCP_APPS_EXTENSION_ID,
  MCP_APPS_MIME_TYPE,
  type CallMcpAppToolRequest,
  type CallMcpAppToolResult,
  type ReadMcpAppResourceRequest,
  type ReadMcpAppResourceResult,
} from '@/common/types/mcpApps';
import { resolveCommandWithManagedRuntime } from '@/process/services/ecosystem/runtimeEnvironment';

const MAX_RESOURCE_HTML_BYTES = 2 * 1024 * 1024;
const CLIENT_IDLE_TTL_MS = 5 * 60 * 1000;

interface PooledClientEntry {
  serverKey: string;
  transportFingerprint: string;
  client: Client;
  idleTimer: ReturnType<typeof setTimeout>;
}

const clientPool = new Map<string, PooledClientEntry>();
const inflightConnect = new Map<string, Promise<Client>>();

function computeFingerprint(server: IMcpServer): string {
  return JSON.stringify(server.transport);
}

function resetIdleTimer(entry: PooledClientEntry): void {
  clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    clientPool.delete(entry.serverKey);
    void entry.client.close().catch((): undefined => undefined);
  }, CLIENT_IDLE_TTL_MS);
  entry.idleTimer.unref?.();
}

async function resolveMcpServer(req: { serverId?: string; serverName?: string }): Promise<IMcpServer | null> {
  const servers = await httpRequest<IMcpServer[]>('GET', '/api/mcp/servers').catch((): IMcpServer[] => []);
  if (req.serverId) {
    const byId = servers.find((s) => s.id === req.serverId);
    if (byId) return byId;
  }
  if (req.serverName) {
    const targetLower = req.serverName.trim().toLowerCase();
    const byExact = servers.find((s) => s.name.toLowerCase() === targetLower);
    if (byExact) return byExact;
  }
  return null;
}

function buildTransportForServer(server: IMcpServer) {
  const t = server.transport;
  if (t.type === 'stdio') {
    const command = resolveCommandWithManagedRuntime(t.command);
    const mergedEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') mergedEnv[k] = v;
    }
    for (const [k, v] of Object.entries(t.env || {})) {
      mergedEnv[k] = v;
    }
    return new StdioClientTransport({
      command,
      args: t.args || [],
      env: mergedEnv,
      stderr: 'pipe',
    });
  }

  const headers = t.headers && Object.keys(t.headers).length > 0 ? t.headers : undefined;
  const reqInit = headers ? { requestInit: { headers } } : undefined;
  if (t.type === 'sse') {
    return new SSEClientTransport(new URL(t.url), reqInit);
  }
  return new StreamableHTTPClientTransport(new URL(t.url), reqInit);
}

async function getOrConnectClient(server: IMcpServer): Promise<Client> {
  const serverKey = server.id || server.name;
  const fingerprint = computeFingerprint(server);
  const existing = clientPool.get(serverKey);
  if (existing) {
    if (existing.transportFingerprint === fingerprint) {
      resetIdleTimer(existing);
      return existing.client;
    }
    clearTimeout(existing.idleTimer);
    clientPool.delete(serverKey);
    await existing.client.close().catch((): undefined => undefined);
  }

  const inflight = inflightConnect.get(serverKey);
  if (inflight) {
    return await inflight;
  }

  const connectPromise = (async () => {
    const client = new Client(
      {
        name: 'EthanToken-Desktop-MCP-Apps-Host',
        version: '1.0.0',
      },
      {
        capabilities: {
          extensions: {
            [MCP_APPS_EXTENSION_ID]: {
              mimeTypes: [MCP_APPS_MIME_TYPE],
            },
          },
        } as Record<string, unknown>,
      }
    );

    const transport = buildTransportForServer(server);
    await client.connect(transport);

    const entry: PooledClientEntry = {
      serverKey,
      transportFingerprint: fingerprint,
      client,
      idleTimer: setTimeout(() => {
        clientPool.delete(serverKey);
        void client.close().catch((): undefined => undefined);
      }, CLIENT_IDLE_TTL_MS),
    };
    entry.idleTimer.unref?.();
    clientPool.set(serverKey, entry);
    return client;
  })();

  inflightConnect.set(serverKey, connectPromise);
  try {
    return await connectPromise;
  } finally {
    inflightConnect.delete(serverKey);
  }
}

function findMatchingServerTool(
  server: IMcpServer,
  requestedToolName: string
): { resolvedName: string; visibleToApp: boolean } {
  const candidateAliases = new Set(expandMcpToolNameAliases(requestedToolName).map((a) => a.toLowerCase()));
  const matched = (server.tools || []).find((tool) => candidateAliases.has(tool.name.toLowerCase()));
  if (!matched) {
    return { resolvedName: requestedToolName, visibleToApp: true };
  }
  return {
    resolvedName: matched.name,
    visibleToApp: isToolVisibleToApp(matched._meta),
  };
}

/**
 * Fetch an interactive MCP App HTML template (`ui://...`) from the owning MCP server.
 */
export async function readMcpAppUiResource(req: ReadMcpAppResourceRequest): Promise<ReadMcpAppResourceResult> {
  const uri = (req.resourceUri || '').trim();
  if (!uri.startsWith('ui://')) {
    return { success: false, error: '仅支持读取 ui:// 协议的 MCP App UI 资源' };
  }

  const server = await resolveMcpServer(req);
  if (!server) {
    return { success: false, error: `未找到对应的 MCP 服务（${req.serverName || req.serverId || 'unknown'}）` };
  }

  try {
    const client = await getOrConnectClient(server);
    const res = await client.readResource({ uri });
    const first = (res.contents || [])[0] as
      | {
          text?: string;
          blob?: string;
          mimeType?: string;
          _meta?: Record<string, unknown>;
        }
      | undefined;
    if (!first) {
      return { success: false, error: `MCP 服务未返回 ${uri} 的视图内容` };
    }

    let html = '';
    if (typeof first.text === 'string') {
      html = first.text;
    } else if (typeof first.blob === 'string') {
      html = Buffer.from(first.blob, 'base64').toString('utf-8');
    }

    if (!html.trim()) {
      return { success: false, error: `UI 资源 ${uri} 内容为空` };
    }
    if (Buffer.byteLength(html, 'utf-8') > MAX_RESOURCE_HTML_BYTES) {
      return { success: false, error: `UI 资源 ${uri} 超过 2MB 安全大小限制` };
    }

    const uiMeta =
      first._meta && typeof first._meta.ui === 'object' && first._meta.ui !== null
        ? (first._meta.ui as Record<string, unknown>)
        : undefined;

    return {
      success: true,
      html,
      mimeType: first.mimeType || MCP_APPS_MIME_TYPE,
      prefersBorder: typeof uiMeta?.prefersBorder === 'boolean' ? uiMeta.prefersBorder : true,
      csp: uiMeta?.csp && typeof uiMeta.csp === 'object' ? (uiMeta.csp as Record<string, unknown>) : undefined,
    };
  } catch (err) {
    const serverKey = server.id || server.name;
    const broken = clientPool.get(serverKey);
    if (broken) {
      clearTimeout(broken.idleTimer);
      clientPool.delete(serverKey);
      await broken.client.close().catch((): undefined => undefined);
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Proxy a `tools/call` request initiated by an embedded MCP App widget back to its owning MCP server.
 */
export async function callMcpAppTool(req: CallMcpAppToolRequest): Promise<CallMcpAppToolResult> {
  const server = await resolveMcpServer(req);
  if (!server) {
    return { success: false, error: `未找到对应的 MCP 服务（${req.serverName || req.serverId || 'unknown'}）` };
  }

  const { resolvedName, visibleToApp } = findMatchingServerTool(server, req.toolName);
  if (!visibleToApp) {
    return { success: false, error: `工具 ${resolvedName} 仅限模型调用，禁止前端组件直接触发` };
  }

  try {
    const client = await getOrConnectClient(server);
    const result = await client.callTool({
      name: resolvedName,
      arguments: req.arguments || {},
    });
    const content = Array.isArray(result.content)
      ? (result.content as Array<Record<string, unknown>>)
      : undefined;
    const structuredContent =
      result.structuredContent && typeof result.structuredContent === 'object'
        ? (result.structuredContent as Record<string, unknown>)
        : undefined;

    return {
      success: true,
      content,
      structuredContent,
      isError: result.isError === true,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Close all pooled MCP App host client connections cleanly during app shutdown.
 */
export async function closeAllMcpAppClients(): Promise<void> {
  const entries = Array.from(clientPool.values());
  clientPool.clear();
  await Promise.all(
    entries.map(async (entry) => {
      clearTimeout(entry.idleTimer);
      await entry.client.close().catch((): undefined => undefined);
    })
  );
}

/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { getDesktopWebuiHandler, type DesktopBridgeHandler } from '@/common/adapter/desktopWebuiRegistry';

const DESKTOP_BRIDGE_PREFIX = '/api/desktop-bridge/';
const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

export const ALLOWED_DESKTOP_WEBUI_CHANNELS = new Set<string>([
  'ethantoken:get-status',
  'ethantoken:refresh',
  'ethantoken:checkin',
  'ethantoken:get-ledger',
  'ethantoken:switch-account',
  'ecosystem:scan-clients',
  'ecosystem:import-scanned',
  'ecosystem:get-global-memory',
  'ecosystem:save-global-memory',
  'ecosystem:search-mcp-marketplace',
  'ecosystem:install-mcp-marketplace',
  'ecosystem:search-skills-marketplace',
  'ecosystem:install-skill-marketplace',
  'ecosystem:sync-marketplace',
  'ecosystem:check-updates',
  'ecosystem:update-all-plugins',
  'ecosystem:attach-to-all-assistants',
  'ecosystem:get-plugin-details',
  'ecosystem:get-runtime-status',
  'ecosystem:install-managed-uv',
  'knowledge:list-collections',
  'knowledge:get-collection-detail',
  'knowledge:create-collection',
  'knowledge:delete-collection',
  'knowledge:add-sources',
  'knowledge:remove-document',
  'knowledge:reindex-collection',
  'knowledge:search',
  'knowledge:read-document',
  'mcp-apps:read-ui-resource',
  'mcp-apps:call-tool',
  'thinking-effort:set-model-effort',
  'thinking-effort:sync-preferences',
  'thinking-effort:wrap-url',
  'thinking-effort:reconcile-providers',
  'thinking-effort:get-status',
]);

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(
  req: IncomingMessage
): Promise<{ ok: true; value: unknown } | { ok: false; status: number; error: string }> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buf.length;
    if (totalBytes > MAX_BODY_BYTES) {
      return { ok: false, status: 413, error: 'PAYLOAD_TOO_LARGE' };
    }
    chunks.push(buf);
  }

  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) {
    return { ok: true, value: undefined };
  }

  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, status: 400, error: 'INVALID_JSON' };
  }
}

export function createDesktopWebuiApiHandler(
  backendPort: number,
  options?: {
    fetchImpl?: typeof fetch;
    getHandler?: (channel: string) => DesktopBridgeHandler | undefined;
  }
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const getHandler = options?.getHandler ?? getDesktopWebuiHandler;

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = req.url || '';
    if (!url.startsWith(DESKTOP_BRIDGE_PREFIX)) {
      return false;
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { success: false, error: 'METHOD_NOT_ALLOWED' });
      return true;
    }

    const rawSegment = url.slice(DESKTOP_BRIDGE_PREFIX.length).split('?')[0];
    let channel: string;
    try {
      channel = decodeURIComponent(rawSegment);
    } catch {
      sendJson(res, 400, { success: false, error: 'INVALID_CHANNEL' });
      return true;
    }

    if (!ALLOWED_DESKTOP_WEBUI_CHANNELS.has(channel)) {
      sendJson(res, 404, { success: false, error: 'CHANNEL_NOT_ALLOWED' });
      return true;
    }

    // Verify WebUI session against backend auth before running any host bridge handler.
    const authHeaders: Record<string, string> = {};
    if (typeof req.headers.cookie === 'string' && req.headers.cookie) {
      authHeaders.cookie = req.headers.cookie;
    }
    if (typeof req.headers.authorization === 'string' && req.headers.authorization) {
      authHeaders.authorization = req.headers.authorization;
    }

    try {
      const authRes = await fetchImpl(`http://127.0.0.1:${backendPort}/api/auth/user`, {
        method: 'GET',
        headers: authHeaders,
      });
      if (!authRes.ok) {
        sendJson(res, 401, { success: false, error: 'UNAUTHORIZED' });
        return true;
      }
    } catch {
      sendJson(res, 502, { success: false, error: 'AUTH_CHECK_FAILED' });
      return true;
    }

    const handler = getHandler(channel);
    if (!handler) {
      sendJson(res, 503, { success: false, error: 'HANDLER_UNAVAILABLE' });
      return true;
    }

    const parsed = await readJsonBody(req);
    if ('error' in parsed) {
      sendJson(res, parsed.status, { success: false, error: parsed.error });
      return true;
    }

    try {
      const data = await handler(parsed.value);
      sendJson(res, 200, { success: true, data });
    } catch (err) {
      sendJson(res, 500, {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return true;
  };
}

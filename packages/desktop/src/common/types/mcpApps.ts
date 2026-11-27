/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

export const MCP_APPS_EXTENSION_ID = 'io.modelcontextprotocol/ui';
export const MCP_APPS_MIME_TYPE = 'text/html;profile=mcp-app';

export interface McpAppToolUiMeta {
  resourceUri: string;
  visibility?: Array<'model' | 'app'>;
}

export interface ReadMcpAppResourceRequest {
  serverId?: string;
  serverName?: string;
  resourceUri: string;
}

export interface ReadMcpAppResourceResult {
  success: boolean;
  html?: string;
  mimeType?: string;
  prefersBorder?: boolean;
  csp?: Record<string, unknown>;
  error?: string;
}

export interface CallMcpAppToolRequest {
  serverId?: string;
  serverName?: string;
  toolName: string;
  arguments?: Record<string, unknown>;
}

export interface CallMcpAppToolResult {
  success: boolean;
  content?: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  error?: string;
}

export interface EmbeddedMcpAppDescriptor {
  resourceUri?: string;
  serverName?: string;
  toolName?: string;
  structuredContent?: Record<string, unknown>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Extract standard `_meta.ui.resourceUri` or legacy `_meta['ui/resourceUri']` metadata
 * from an MCP tool definition or tool result `_meta` object.
 */
export function readMcpAppToolUiMetadata(meta?: Record<string, unknown>): McpAppToolUiMeta | undefined {
  if (!isPlainRecord(meta)) return undefined;

  const uiBlock = meta.ui;
  if (isPlainRecord(uiBlock)) {
    const resourceUri = typeof uiBlock.resourceUri === 'string' ? uiBlock.resourceUri.trim() : '';
    const visibility = Array.isArray(uiBlock.visibility)
      ? uiBlock.visibility.filter((v): v is 'model' | 'app' => v === 'model' || v === 'app')
      : undefined;
    if (resourceUri) {
      return visibility && visibility.length > 0 ? { resourceUri, visibility } : { resourceUri };
    }
  }

  const legacyUri = typeof meta['ui/resourceUri'] === 'string' ? meta['ui/resourceUri'].trim() : '';
  if (legacyUri) {
    return { resourceUri: legacyUri };
  }
  return undefined;
}

/**
 * Determine whether an MCP tool may be called from an interactive MCP App widget UI.
 * Per `@modelcontextprotocol/ext-apps`, tools marked `visibility: ['model']` without `'app'`
 * are hidden from UI direct calls.
 */
export function isToolVisibleToApp(meta?: Record<string, unknown>): boolean {
  if (!isPlainRecord(meta) || !isPlainRecord(meta.ui)) return true;
  const vis = meta.ui.visibility;
  if (!Array.isArray(vis) || vis.length === 0) return true;
  return vis.includes('app');
}

/**
 * Expand normalized/namespaced tool call names (e.g. `mcp__srv__tool`, `srv:tool`, `srv_tool`)
 * into candidate tool names for matching against server tool catalogs.
 */
export function expandMcpToolNameAliases(name: string): string[] {
  const trimmed = name.trim();
  if (!trimmed) return [];
  const aliases = new Set<string>([trimmed]);

  if (trimmed.startsWith('mcp__')) {
    const body = trimmed.slice(5);
    const sep = body.indexOf('__');
    if (sep > 0) {
      aliases.add(body.slice(sep + 2));
      aliases.add(`${body.slice(0, sep)}:${body.slice(sep + 2)}`);
      aliases.add(`${body.slice(0, sep)}_${body.slice(sep + 2)}`);
    }
  }

  const colonIdx = trimmed.indexOf(':');
  if (colonIdx > 0 && colonIdx < trimmed.length - 1) {
    const bare = trimmed.slice(colonIdx + 1);
    aliases.add(bare);
  }

  const slashIdx = trimmed.indexOf('/');
  if (slashIdx > 0 && slashIdx < trimmed.length - 1) {
    aliases.add(trimmed.slice(slashIdx + 1));
  }

  return Array.from(aliases);
}

/**
 * Detect embedded MCP App UI metadata or `ui://` URIs inside serialized tool output JSON.
 */
export function extractEmbeddedMcpAppDescriptor(rawOutput?: string): EmbeddedMcpAppDescriptor | null {
  if (!rawOutput || typeof rawOutput !== 'string') return null;
  const trimmed = rawOutput.trim();
  if (!trimmed.startsWith('{')) return null;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isPlainRecord(parsed)) return null;

    const metaUi = isPlainRecord(parsed._meta) ? readMcpAppToolUiMetadata(parsed._meta) : undefined;
    const directUiUri =
      typeof parsed.resourceUri === 'string' && parsed.resourceUri.trim().startsWith('ui://')
        ? parsed.resourceUri.trim()
        : metaUi?.resourceUri;

    const structuredContent = isPlainRecord(parsed.structuredContent) ? parsed.structuredContent : undefined;

    if (!directUiUri && !structuredContent) return null;
    return {
      ...(directUiUri ? { resourceUri: directUiUri } : {}),
      ...(typeof parsed.serverName === 'string' ? { serverName: parsed.serverName } : {}),
      ...(typeof parsed.toolName === 'string' ? { toolName: parsed.toolName } : {}),
      ...(structuredContent ? { structuredContent } : {}),
    };
  } catch {
    return null;
  }
}

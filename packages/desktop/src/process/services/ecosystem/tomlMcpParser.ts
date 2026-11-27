/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IMcpServerTransport } from '@/common/config/storage';

export interface ParsedTomlMcpEntry {
  name: string;
  transport: IMcpServerTransport;
  originalConfig: Record<string, unknown>;
}

function stripTomlComment(line: string): string {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote === '"' && ch === '\\' && !escaped) {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote && !escaped) quote = null;
      escaped = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#') {
      return line.slice(0, i).trim();
    }
  }
  return line.trim();
}

function splitTopLevel(input: string, delimiter: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let depthBracket = 0;
  let depthBrace = 0;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote === '"' && ch === '\\' && !escaped) {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote && !escaped) quote = null;
      escaped = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '[') depthBracket += 1;
    else if (ch === ']') depthBracket = Math.max(0, depthBracket - 1);
    else if (ch === '{') depthBrace += 1;
    else if (ch === '}') depthBrace = Math.max(0, depthBrace - 1);

    if (ch === delimiter && depthBracket === 0 && depthBrace === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseTomlKey(rawKey: string): string {
  const trimmed = rawKey.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseSectionPath(header: string): string[] {
  const inner = header.slice(1, -1).trim();
  const segments: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '.') {
      if (cur.trim()) segments.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) segments.push(cur.trim());
  return segments;
}

function parseTomlValue(rawValue: string): unknown {
  const val = rawValue.trim();
  if (!val) return '';
  if (val.startsWith('"') && val.endsWith('"')) {
    try {
      return JSON.parse(val);
    } catch {
      return val.slice(1, -1).replace(/\\(["\\])/g, '$1');
    }
  }
  if (val.startsWith("'") && val.endsWith("'")) {
    return val.slice(1, -1);
  }
  if (val === 'true') return true;
  if (val === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(val)) return Number(val);
  if (val.startsWith('[') && val.endsWith(']')) {
    const inner = val.slice(1, -1).trim();
    if (!inner) return [];
    return splitTopLevel(inner, ',').map((item) => parseTomlValue(item));
  }
  if (val.startsWith('{') && val.endsWith('}')) {
    const inner = val.slice(1, -1).trim();
    const obj: Record<string, unknown> = {};
    if (!inner) return obj;
    for (const pair of splitTopLevel(inner, ',')) {
      const eqIdx = pair.indexOf('=');
      if (eqIdx === -1) continue;
      const k = parseTomlKey(pair.slice(0, eqIdx));
      const v = parseTomlValue(pair.slice(eqIdx + 1));
      if (k) obj[k] = v;
    }
    return obj;
  }
  return val;
}

function toStringRecord(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string') out[k] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
  }
  return out;
}

/**
 * Parse `[mcp_servers.<name>]` sections from Codex CLI `config.toml`.
 * Supports stdio (`command`/`args`/`env`) and remote (`url`/`http_headers`/`headers`) entries.
 */
export function parseCodexTomlMcpServers(tomlText: string): ParsedTomlMcpEntry[] {
  if (!tomlText || !tomlText.trim()) return [];

  const servers = new Map<string, Record<string, unknown>>();
  let currentServer: string | null = null;
  let currentSubTable: 'env' | 'headers' | null = null;

  for (const rawLine of tomlText.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine);
    if (!line) continue;

    if (line.startsWith('[') && line.endsWith(']') && !line.startsWith('[[')) {
      const segments = parseSectionPath(line);
      if (segments[0] === 'mcp_servers' && segments[1]) {
        currentServer = segments[1];
        if (!servers.has(currentServer)) servers.set(currentServer, {});
        if (segments[2] === 'env') currentSubTable = 'env';
        else if (segments[2] === 'http_headers' || segments[2] === 'headers') currentSubTable = 'headers';
        else currentSubTable = null;
      } else {
        currentServer = null;
        currentSubTable = null;
      }
      continue;
    }

    if (!currentServer) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = parseTomlKey(line.slice(0, eqIdx));
    if (!key) continue;
    const val = parseTomlValue(line.slice(eqIdx + 1));

    const serverObj = servers.get(currentServer)!;
    if (currentSubTable) {
      const existingSub = (serverObj[currentSubTable] as Record<string, unknown> | undefined) || {};
      existingSub[key] = val;
      serverObj[currentSubTable] = existingSub;
    } else {
      serverObj[key] = val;
    }
  }

  const results: ParsedTomlMcpEntry[] = [];
  for (const [name, cfg] of servers.entries()) {
    if (cfg.enabled === false) continue;

    if (typeof cfg.command === 'string' && cfg.command.trim()) {
      const args = Array.isArray(cfg.args) ? cfg.args.map((a) => String(a)) : [];
      const env = toStringRecord(cfg.env);
      results.push({
        name,
        transport: {
          type: 'stdio',
          command: cfg.command.trim(),
          args,
          env,
        },
        originalConfig: cfg,
      });
      continue;
    }

    if (typeof cfg.url === 'string' && cfg.url.trim()) {
      const url = cfg.url.trim();
      const headers = {
        ...toStringRecord(cfg.http_headers),
        ...toStringRecord(cfg.headers),
      };
      const transportType = url.includes('/sse') ? 'sse' : 'streamable_http';
      results.push({
        name,
        transport: {
          type: transportType,
          url,
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
        },
        originalConfig: cfg,
      });
    }
  }

  return results;
}

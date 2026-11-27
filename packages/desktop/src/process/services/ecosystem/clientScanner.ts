/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IMcpServerTransport } from '@/common/config/storage';
import { parseCodexTomlMcpServers } from './tomlMcpParser';
import type {
  ClientScanReport,
  EcosystemClientId,
  InternalScannedMcpRecord,
  ScannedClientSummary,
  ScannedMcpItem,
  ScannedRuleItem,
  ScannedSkillItem,
} from './types';

const MAX_RULE_FILE_BYTES = 64 * 1024;
const SECRET_KEY_RE = /(key|token|secret|password|passwd|auth|cookie|credential)/i;

interface ClientSpec {
  id: EcosystemClientId;
  name: string;
  rootDirs: (homeDir: string, appDataDir: string) => string[];
  skillDirs: (homeDir: string, appDataDir: string) => string[];
  mcpJsonFiles: (homeDir: string, appDataDir: string) => string[];
  tomlFiles?: (homeDir: string, appDataDir: string) => string[];
  ruleFilesOrDirs: (homeDir: string, appDataDir: string) => Array<{ path: string; kind: 'rule' | 'memory' }>;
  traePluginDirs?: (homeDir: string, appDataDir: string) => string[];
}

export interface ScanClientsOptions {
  homeDir?: string;
  appDataDir?: string;
  existingSkillNames?: Set<string>;
  existingMcpNames?: Set<string>;
}

export interface FullScanOutcome {
  report: ClientScanReport;
  internalMcpsById: Map<string, InternalScannedMcpRecord>;
}

function getDefaultAppDataDir(homeDir: string): string {
  if (process.env.APPDATA) return process.env.APPDATA;
  if (process.platform === 'darwin') return path.join(homeDir, 'Library', 'Application Support');
  return path.join(homeDir, '.config');
}

const CLIENT_SPECS: ClientSpec[] = [
  {
    id: 'trae-cn',
    name: 'Trae CN',
    rootDirs: (h, a) => [path.join(h, '.trae-cn'), path.join(a, 'Trae CN')],
    skillDirs: (h) => [path.join(h, '.trae-cn', 'skills')],
    mcpJsonFiles: (h, a) => [path.join(h, '.trae-cn', 'mcp.json'), path.join(a, 'Trae CN', 'User', 'mcp.json')],
    ruleFilesOrDirs: (h) => [
      { path: path.join(h, '.trae-cn', 'user_rules'), kind: 'rule' },
      { path: path.join(h, '.trae-cn', 'user_rules.md'), kind: 'rule' },
      { path: path.join(h, '.trae-cn', 'rules'), kind: 'rule' },
      { path: path.join(h, '.trae-cn', 'memory'), kind: 'memory' },
    ],
    traePluginDirs: (h) => [path.join(h, '.trae-cn', 'plugins'), path.join(h, '.trae-cn', 'extensions')],
  },
  {
    id: 'trae',
    name: 'Trae',
    rootDirs: (h, a) => [path.join(h, '.trae'), path.join(a, 'Trae')],
    skillDirs: (h) => [path.join(h, '.trae', 'skills')],
    mcpJsonFiles: (h, a) => [path.join(h, '.trae', 'mcp.json'), path.join(a, 'Trae', 'User', 'mcp.json')],
    ruleFilesOrDirs: (h) => [
      { path: path.join(h, '.trae', 'user_rules'), kind: 'rule' },
      { path: path.join(h, '.trae', 'user_rules.md'), kind: 'rule' },
      { path: path.join(h, '.trae', 'rules'), kind: 'rule' },
      { path: path.join(h, '.trae', 'memory'), kind: 'memory' },
    ],
    traePluginDirs: (h) => [path.join(h, '.trae', 'plugins'), path.join(h, '.trae', 'extensions')],
  },
  {
    id: 'workbuddy',
    name: 'WorkBuddy',
    rootDirs: (h, a) => [path.join(h, '.workbuddy'), path.join(a, 'WorkBuddy')],
    skillDirs: (h) => [path.join(h, '.workbuddy', 'skills'), path.join(h, '.workbuddy', 'connectors', 'skills')],
    mcpJsonFiles: (h) => [path.join(h, '.workbuddy', 'mcp.json')],
    ruleFilesOrDirs: (h) => [
      { path: path.join(h, '.workbuddy', 'rules'), kind: 'rule' },
      { path: path.join(h, '.workbuddy', 'memory'), kind: 'memory' },
      { path: path.join(h, '.workbuddy', 'app', 'memory'), kind: 'memory' },
    ],
  },
  {
    id: 'codebuddy',
    name: 'CodeBuddy',
    rootDirs: (h, a) => [path.join(h, '.codebuddy'), path.join(a, 'CodeBuddy')],
    skillDirs: (h) => [path.join(h, '.codebuddy', 'skills')],
    mcpJsonFiles: (h) => [path.join(h, '.codebuddy', '.mcp.json'), path.join(h, '.codebuddy', 'mcp.json')],
    ruleFilesOrDirs: (h) => [
      { path: path.join(h, '.codebuddy', 'rules'), kind: 'rule' },
      { path: path.join(h, '.codebuddy', 'memory'), kind: 'memory' },
    ],
  },
  {
    id: 'qoder-cn',
    name: 'Qoder CN',
    rootDirs: (h, a) => [path.join(h, '.qoder-cn'), path.join(a, 'Qoder CN')],
    skillDirs: (h) => [path.join(h, '.qoder-cn', 'skills')],
    mcpJsonFiles: (h) => [path.join(h, '.qoder-cn', 'settings.json'), path.join(h, '.qoder-cn', 'mcp.json')],
    ruleFilesOrDirs: (h) => [
      { path: path.join(h, '.qoder-cn', 'rules'), kind: 'rule' },
      { path: path.join(h, '.qoder-cn', 'memory'), kind: 'memory' },
      { path: path.join(h, '.qoder-cn', 'memories'), kind: 'memory' },
    ],
  },
  {
    id: 'qoder',
    name: 'Qoder',
    rootDirs: (h, a) => [path.join(h, '.qoder'), path.join(a, 'Qoder')],
    skillDirs: (h) => [path.join(h, '.qoder', 'skills')],
    mcpJsonFiles: (h) => [path.join(h, '.qoder', 'settings.json'), path.join(h, '.qoder', 'mcp.json')],
    ruleFilesOrDirs: (h) => [
      { path: path.join(h, '.qoder', 'rules'), kind: 'rule' },
      { path: path.join(h, '.qoder', 'memory'), kind: 'memory' },
    ],
  },
  {
    id: 'claude',
    name: 'Claude Code / Desktop',
    rootDirs: (h, a) => [path.join(h, '.claude'), path.join(a, 'Claude')],
    skillDirs: (h) => [path.join(h, '.claude', 'skills')],
    mcpJsonFiles: (h, a) => [
      path.join(h, '.claude.json'),
      path.join(h, '.claude', 'mcp.json'),
      path.join(a, 'Claude', 'claude_desktop_config.json'),
    ],
    ruleFilesOrDirs: (h) => [
      { path: path.join(h, '.claude', 'CLAUDE.md'), kind: 'rule' },
      { path: path.join(h, '.claude', 'rules'), kind: 'rule' },
    ],
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    rootDirs: (h) => [path.join(h, '.codex')],
    skillDirs: (h) => [path.join(h, '.codex', 'skills')],
    mcpJsonFiles: () => [],
    tomlFiles: (h) => [path.join(h, '.codex', 'config.toml')],
    ruleFilesOrDirs: (h) => [
      { path: path.join(h, '.codex', 'AGENTS.md'), kind: 'rule' },
      { path: path.join(h, '.codex', 'memories'), kind: 'memory' },
    ],
  },
  {
    id: 'cursor',
    name: 'Cursor',
    rootDirs: (h, a) => [path.join(h, '.cursor'), path.join(a, 'Cursor')],
    skillDirs: (h) => [path.join(h, '.cursor', 'skills'), path.join(h, '.cursor', 'skills-cursor')],
    mcpJsonFiles: (h) => [path.join(h, '.cursor', 'mcp.json')],
    ruleFilesOrDirs: (h) => [{ path: path.join(h, '.cursor', 'rules'), kind: 'rule' }],
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    rootDirs: (h, a) => [path.join(h, '.codeium', 'windsurf'), path.join(a, 'Windsurf')],
    skillDirs: (h) => [path.join(h, '.codeium', 'windsurf', 'skills')],
    mcpJsonFiles: (h) => [path.join(h, '.codeium', 'windsurf', 'mcp_config.json')],
    ruleFilesOrDirs: (h) => [
      { path: path.join(h, '.codeium', 'windsurf', 'memories'), kind: 'memory' },
      { path: path.join(h, '.codeium', 'windsurf', 'rules'), kind: 'rule' },
    ],
  },
  {
    id: 'gemini',
    name: 'Gemini CLI / Antigravity',
    rootDirs: (h) => [path.join(h, '.gemini')],
    skillDirs: (h) => [path.join(h, '.gemini', 'skills'), path.join(h, '.gemini', 'config', 'skills')],
    mcpJsonFiles: (h) => [
      path.join(h, '.gemini', 'settings.json'),
      path.join(h, '.gemini', 'antigravity', 'mcp_config.json'),
    ],
    ruleFilesOrDirs: (h) => [
      { path: path.join(h, '.gemini', 'GEMINI.md'), kind: 'rule' },
      { path: path.join(h, '.gemini', 'config', 'rules'), kind: 'rule' },
      { path: path.join(h, '.gemini', 'antigravity-memory'), kind: 'memory' },
    ],
  },
  {
    id: 'other-agents',
    name: 'Kiro / Roo / Qwen / 灵码 / 通用',
    rootDirs: (h) => [
      path.join(h, '.kiro'),
      path.join(h, '.roo'),
      path.join(h, '.kilocode'),
      path.join(h, '.lingma'),
      path.join(h, '.qwen'),
      path.join(h, '.iflow'),
      path.join(h, '.agents'),
      path.join(h, '.cc-switch'),
    ],
    skillDirs: (h) => [
      path.join(h, '.kiro', 'skills'),
      path.join(h, '.roo', 'skills'),
      path.join(h, '.kilocode', 'skills'),
      path.join(h, '.lingma', 'skills'),
      path.join(h, '.qwen', 'skills'),
      path.join(h, '.iflow', 'skills'),
      path.join(h, '.agents', 'skills'),
      path.join(h, '.cc-switch', 'skills'),
    ],
    mcpJsonFiles: (h) => [
      path.join(h, '.kiro', 'settings', 'mcp.json'),
      path.join(h, '.qwen', 'settings.json'),
      path.join(h, '.iflow', 'settings.json'),
    ],
    ruleFilesOrDirs: (h) => [
      { path: path.join(h, '.kiro', 'steering'), kind: 'rule' },
      { path: path.join(h, '.roo', 'rules'), kind: 'rule' },
      { path: path.join(h, '.qwen', 'QWEN.md'), kind: 'rule' },
    ],
  },
];

function safeExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function safeStatFollow(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function stripFrontmatterQuotes(v?: string): string | undefined {
  return v ? v.trim().replace(/^['"]|['"]$/g, '') : undefined;
}

function extractBodySummary(body: string): string | undefined {
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('```') || line === '---') continue;
    return line.replace(/^[-*]\s+/, '').slice(0, 180);
  }
  return undefined;
}

export function parseSkillFrontmatterMeta(markdown: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/.exec(markdown);
  if (!m) {
    return { description: extractBodySummary(markdown) };
  }

  const yamlLines = m[1].split(/\r?\n/);
  const body = m[2] || '';
  const values: Record<string, string> = {};

  for (let i = 0; i < yamlLines.length; i++) {
    const line = yamlLines[i];
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    const rawVal = kv[2].trim();

    if (/^[|>][-+]?$/.test(rawVal)) {
      const blockLines: string[] = [];
      for (let j = i + 1; j < yamlLines.length; j++) {
        const nextLine = yamlLines[j];
        if (/^\S/.test(nextLine) && /^[A-Za-z0-9_-]+:/.test(nextLine)) {
          break;
        }
        if (nextLine.trim()) {
          blockLines.push(nextLine.trim());
        }
        i = j;
      }
      values[key] = blockLines.join(' ').trim();
    } else {
      const unquoted = stripFrontmatterQuotes(rawVal);
      if (unquoted) values[key] = unquoted;
    }
  }

  const desc = values.description?.trim() || extractBodySummary(body);
  return {
    name: values.name?.trim(),
    description: desc,
  };
}

function findSkillMdFile(skillDir: string): string | null {
  const direct = path.join(skillDir, 'SKILL.md');
  if (safeExists(direct)) return direct;
  try {
    const entries = fs.readdirSync(skillDir);
    const hit = entries.find((f) => f.toLowerCase() === 'skill.md');
    return hit ? path.join(skillDir, hit) : null;
  } catch {
    return null;
  }
}

function scanSkillsDirectory(
  dir: string,
  clientId: EcosystemClientId,
  clientName: string,
  existingSkillNames: Set<string>
): ScannedSkillItem[] {
  if (!safeExists(dir)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: ScannedSkillItem[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const candidatePath = path.join(dir, entry.name);
    const st = safeStatFollow(candidatePath);
    if (!st || !st.isDirectory()) continue;

    const skillMdPath = findSkillMdFile(candidatePath);
    if (!skillMdPath) continue;

    let content = '';
    try {
      content = fs.readFileSync(skillMdPath, 'utf-8');
    } catch {
      continue;
    }

    const meta = parseSkillFrontmatterMeta(content);
    const skillMdStat = safeStatFollow(skillMdPath);
    const skillName = (meta.name || entry.name).trim();
    const description = (meta.description || `${clientName} 本地技能`).trim();
    out.push({
      id: `skill:${clientId}:${skillName}:${candidatePath}`,
      clientId,
      clientName,
      name: skillName,
      description,
      sourcePath: candidatePath,
      installed: existingSkillNames.has(skillName),
      mtimeMs: skillMdStat?.mtimeMs ?? st.mtimeMs,
    });
  }
  return out;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function toStringRecord(v: unknown): Record<string, string> {
  if (!isPlainRecord(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === 'string') out[k] = val;
    else if (typeof val === 'number' || typeof val === 'boolean') out[k] = String(val);
  }
  return out;
}

function parseJsonServerConfig(rawCfg: unknown): IMcpServerTransport | null {
  if (!isPlainRecord(rawCfg)) return null;
  if (rawCfg.disabled === true || rawCfg.enabled === false) return null;

  const command = typeof rawCfg.command === 'string' ? rawCfg.command.trim() : '';
  if (command) {
    const args = Array.isArray(rawCfg.args)
      ? rawCfg.args.map((a) => String(a))
      : typeof rawCfg.args === 'string'
        ? [rawCfg.args]
        : [];
    const env = toStringRecord(rawCfg.env);
    return {
      type: 'stdio',
      command,
      args,
      env,
    };
  }

  const rawUrl =
    (typeof rawCfg.url === 'string' && rawCfg.url) ||
    (typeof rawCfg.serverUrl === 'string' && rawCfg.serverUrl) ||
    (typeof rawCfg.httpUrl === 'string' && rawCfg.httpUrl) ||
    '';
  const url = rawUrl.trim();
  if (!url) return null;

  const rawType = typeof rawCfg.type === 'string' ? rawCfg.type.toLowerCase() : '';
  const headers = toStringRecord(rawCfg.headers);
  const type: IMcpServerTransport['type'] =
    rawType === 'sse' || url.includes('/sse')
      ? 'sse'
      : rawType === 'streamable_http' || rawType === 'streamable-http' || rawType === 'streamablehttp'
        ? 'streamable_http'
        : 'http';
  return {
    type,
    url,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

function buildMcpPreview(transport: IMcpServerTransport): { preview: string; hasSecrets: boolean } {
  let hasSecrets = false;
  if (transport.type === 'stdio') {
    const cmdLine = [transport.command, ...(transport.args || [])].join(' ').trim();
    const envKeys = Object.keys(transport.env || {});
    if (envKeys.some((k) => SECRET_KEY_RE.test(k))) {
      hasSecrets = true;
    }
    const envSuffix =
      envKeys.length > 0
        ? ` · env(${envKeys.map((k) => (SECRET_KEY_RE.test(k) ? `${k}=***` : `${k}`)).join(', ')})`
        : '';
    return { preview: `${cmdLine}${envSuffix}`, hasSecrets };
  }

  const headerKeys = Object.keys(transport.headers || {});
  if (headerKeys.some((k) => SECRET_KEY_RE.test(k))) {
    hasSecrets = true;
  }
  const headerSuffix =
    headerKeys.length > 0
      ? ` · headers(${headerKeys.map((k) => (SECRET_KEY_RE.test(k) ? `${k}=***` : k)).join(', ')})`
      : '';
  return { preview: `${transport.url}${headerSuffix}`, hasSecrets };
}

function scanMcpJsonFile(
  filePath: string,
  clientId: EcosystemClientId,
  clientName: string,
  existingMcpNames: Set<string>
): Array<{ ui: ScannedMcpItem; internal: InternalScannedMcpRecord }> {
  if (!safeExists(filePath)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return [];
  }
  if (!isPlainRecord(parsed)) return [];

  const serversObj = isPlainRecord(parsed.mcpServers)
    ? parsed.mcpServers
    : isPlainRecord(parsed.servers)
      ? parsed.servers
      : null;
  if (!serversObj) return [];

  const out: Array<{ ui: ScannedMcpItem; internal: InternalScannedMcpRecord }> = [];
  for (const [name, cfg] of Object.entries(serversObj)) {
    const transport = parseJsonServerConfig(cfg);
    if (!transport) continue;
    const { preview, hasSecrets } = buildMcpPreview(transport);
    const id = `mcp:${clientId}:${name}:${filePath}`;
    out.push({
      ui: {
        id,
        clientId,
        clientName,
        name,
        description: `来自 ${clientName}`,
        sourcePath: filePath,
        transportType: transport.type,
        preview,
        hasSecrets,
        installed: existingMcpNames.has(name),
      },
      internal: {
        id,
        name,
        description: `Imported from ${clientName}`,
        transport,
        originalConfig: isPlainRecord(cfg) ? cfg : {},
      },
    });
  }
  return out;
}

function scanRulesTarget(
  targetPath: string,
  kind: 'rule' | 'memory',
  clientId: EcosystemClientId,
  clientName: string
): ScannedRuleItem[] {
  if (!safeExists(targetPath)) return [];
  const st = safeStatFollow(targetPath);
  if (!st) return [];

  const files: string[] = [];
  if (st.isFile()) {
    files.push(targetPath);
  } else if (st.isDirectory()) {
    try {
      for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (entry.name.endsWith('.bak') || entry.name.startsWith('.')) continue;
        const lower = entry.name.toLowerCase();
        if (
          lower.endsWith('.md') ||
          lower.endsWith('.mdc') ||
          lower.endsWith('.txt') ||
          lower.endsWith('.rules')
        ) {
          files.push(path.join(targetPath, entry.name));
        }
      }
    } catch {
      return [];
    }
  }

  const out: ScannedRuleItem[] = [];
  for (const file of files) {
    try {
      const fst = fs.statSync(file);
      if (fst.size === 0 || fst.size > MAX_RULE_FILE_BYTES) continue;
      const content = fs.readFileSync(file, 'utf-8').trim();
      if (content.length < 10) continue;
      // Strip cursor .mdc YAML frontmatter cleanly if present? Keep readable text intact.
      const baseName = path.basename(file);
      out.push({
        id: `rule:${clientId}:${file}`,
        clientId,
        clientName,
        title: `${clientName} · ${baseName}`,
        sourcePath: file,
        kind,
        content,
        charCount: content.length,
      });
    } catch {
      // ignore unreadable file
    }
  }
  return out;
}

export function scanInstalledClients(options: ScanClientsOptions = {}): FullScanOutcome {
  const homeDir = options.homeDir || os.homedir();
  const appDataDir = options.appDataDir || getDefaultAppDataDir(homeDir);
  const existingSkillNames = options.existingSkillNames || new Set<string>();
  const existingMcpNames = options.existingMcpNames || new Set<string>();

  const clients: ScannedClientSummary[] = [];
  const allSkills: ScannedSkillItem[] = [];
  const allMcps: ScannedMcpItem[] = [];
  const allRules: ScannedRuleItem[] = [];
  const internalMcpsById = new Map<string, InternalScannedMcpRecord>();

  for (const spec of CLIENT_SPECS) {
    const roots = spec.rootDirs(homeDir, appDataDir);
    const existingRoots = roots.filter((r) => safeExists(r));

    const skillDirList = [...spec.skillDirs(homeDir, appDataDir)];
    const mcpFileList = [...spec.mcpJsonFiles(homeDir, appDataDir)];

    // Support Trae `.trae-plugin` bundles containing `skills/` and `.mcp.json`.
    for (const pluginBase of spec.traePluginDirs?.(homeDir, appDataDir) || []) {
      if (!safeExists(pluginBase)) continue;
      try {
        for (const entry of fs.readdirSync(pluginBase, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const pDir = path.join(pluginBase, entry.name);
          if (safeExists(path.join(pDir, '.trae-plugin', 'plugin.json'))) {
            const pSkills = path.join(pDir, 'skills');
            if (safeExists(pSkills)) skillDirList.push(pSkills);
            const pMcp = path.join(pDir, '.mcp.json');
            if (safeExists(pMcp)) mcpFileList.push(pMcp);
          }
        }
      } catch {
        // ignore plugin scan errors
      }
    }

    const clientSkills: ScannedSkillItem[] = [];
    const seenSkillPath = new Set<string>();
    for (const sDir of skillDirList) {
      for (const item of scanSkillsDirectory(sDir, spec.id, spec.name, existingSkillNames)) {
        if (seenSkillPath.has(item.sourcePath)) continue;
        seenSkillPath.add(item.sourcePath);
        clientSkills.push(item);
      }
    }

    const clientMcps: ScannedMcpItem[] = [];
    const seenMcpNames = new Set<string>();
    for (const mFile of mcpFileList) {
      for (const pair of scanMcpJsonFile(mFile, spec.id, spec.name, existingMcpNames)) {
        if (seenMcpNames.has(pair.ui.name)) continue;
        seenMcpNames.add(pair.ui.name);
        clientMcps.push(pair.ui);
        internalMcpsById.set(pair.internal.id, pair.internal);
      }
    }

    for (const tomlFile of spec.tomlFiles?.(homeDir, appDataDir) || []) {
      if (!safeExists(tomlFile)) continue;
      try {
        const parsed = parseCodexTomlMcpServers(fs.readFileSync(tomlFile, 'utf-8'));
        for (const entry of parsed) {
          if (seenMcpNames.has(entry.name)) continue;
          seenMcpNames.add(entry.name);
          const { preview, hasSecrets } = buildMcpPreview(entry.transport);
          const id = `mcp:${spec.id}:${entry.name}:${tomlFile}`;
          clientMcps.push({
            id,
            clientId: spec.id,
            clientName: spec.name,
            name: entry.name,
            description: `来自 ${spec.name} (config.toml)`,
            sourcePath: tomlFile,
            transportType: entry.transport.type,
            preview,
            hasSecrets,
            installed: existingMcpNames.has(entry.name),
          });
          internalMcpsById.set(id, {
            id,
            name: entry.name,
            description: `Imported from ${spec.name}`,
            transport: entry.transport,
            originalConfig: entry.originalConfig,
          });
        }
      } catch {
        // ignore malformed toml
      }
    }

    const clientRules: ScannedRuleItem[] = [];
    const seenRulePath = new Set<string>();
    for (const rTarget of spec.ruleFilesOrDirs(homeDir, appDataDir)) {
      for (const ruleItem of scanRulesTarget(rTarget.path, rTarget.kind, spec.id, spec.name)) {
        if (seenRulePath.has(ruleItem.sourcePath)) continue;
        seenRulePath.add(ruleItem.sourcePath);
        clientRules.push(ruleItem);
      }
    }

    const detected =
      existingRoots.length > 0 || clientSkills.length > 0 || clientMcps.length > 0 || clientRules.length > 0;

    clients.push({
      clientId: spec.id,
      clientName: spec.name,
      detected,
      rootPaths: existingRoots,
      skillCount: clientSkills.length,
      mcpCount: clientMcps.length,
      ruleCount: clientRules.length,
    });

    allSkills.push(...clientSkills);
    allMcps.push(...clientMcps);
    allRules.push(...clientRules);
  }

  return {
    report: {
      scannedAt: Date.now(),
      clients,
      skills: allSkills,
      mcps: allMcps,
      rules: allRules,
    },
    internalMcpsById,
  };
}

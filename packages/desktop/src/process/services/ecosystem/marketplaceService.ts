/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IMcpServer, IMcpServerTransport } from '@/common/config/storage';
import { getDataPath } from '@process/utils/utils';
import { CURATED_MCP_CATALOG, CURATED_SKILL_CATALOG } from './marketplaceCatalog';
import type {
  InstallMcpRequest,
  InstallMcpResult,
  InstallSkillRequest,
  InstallSkillResult,
  MarketplaceEnvField,
  MarketplaceMcpItem,
  MarketplaceSearchMcpResult,
  MarketplaceSearchSkillsResult,
  MarketplaceSkillItem,
  MarketplaceSyncResult,
  MarketplaceUpdateAllResult,
  MarketplaceUpdateCheckResult,
  MarketplaceUpdateItem,
} from './types';

const REMOTE_TIMEOUT_MS = 8000;
const MAX_SKILL_BYTES = 512 * 1024;
const CACHE_TTL_MS = 6 * 3600 * 1000;
const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

interface McpRegistryPackage {
  registryType?: string;
  identifier?: string;
  version?: string;
  transport?: { type?: string };
  environmentVariables?: Array<{
    name?: string;
    description?: string;
    isRequired?: boolean;
    isSecret?: boolean;
  }>;
}

interface McpRegistryRemote {
  type?: string;
  url?: string;
  headers?: Array<{
    name?: string;
    description?: string;
    value?: string;
    isRequired?: boolean;
    isSecret?: boolean;
  }>;
}

interface McpRegistryServerEntry {
  server?: {
    name?: string;
    title?: string;
    description?: string;
    version?: string;
    repository?: { url?: string };
    packages?: McpRegistryPackage[];
    remotes?: McpRegistryRemote[];
  };
}

interface SkillsShItem {
  id?: string;
  source?: string;
  skillId?: string;
  name?: string;
  installs?: number;
}

export interface MarketplaceMetaCache {
  syncedAt: number;
  repoStars: Record<string, number>;
  skillInstalls: Record<string, number>;
}

export interface InstalledSkillTracking {
  name: string;
  repo: string;
  skillId: string;
  rawPath?: string;
  sha256: string;
  installedAt: number;
}

export interface InstalledMcpTracking {
  id: string;
  name: string;
  source: 'curated' | 'registry';
  version?: string;
  repositoryUrl?: string;
  installedAt: number;
}

export interface InstalledPluginLedger {
  skills: Record<string, InstalledSkillTracking>;
  mcps: Record<string, InstalledMcpTracking>;
}

function getCacheFilePath(overrideDataDir?: string): string {
  return path.join(overrideDataDir || getDataPath(), 'ecosystem-marketplace-cache.json');
}

function getInstalledLedgerPath(overrideDataDir?: string): string {
  return path.join(overrideDataDir || getDataPath(), 'ecosystem-installed.json');
}

export function readMarketplaceCache(overrideDataDir?: string): MarketplaceMetaCache {
  const filePath = getCacheFilePath(overrideDataDir);
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<MarketplaceMetaCache>;
      return {
        syncedAt: typeof parsed.syncedAt === 'number' ? parsed.syncedAt : 0,
        repoStars: parsed.repoStars && typeof parsed.repoStars === 'object' ? parsed.repoStars : {},
        skillInstalls: parsed.skillInstalls && typeof parsed.skillInstalls === 'object' ? parsed.skillInstalls : {},
      };
    }
  } catch {
    // ignore corrupt cache
  }
  return { syncedAt: 0, repoStars: {}, skillInstalls: {} };
}

export function writeMarketplaceCache(cache: MarketplaceMetaCache, overrideDataDir?: string): void {
  const filePath = getCacheFilePath(overrideDataDir);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(cache, null, 2), 'utf-8');
  } catch {
    // ignore write failure
  }
}

export function readInstalledPluginLedger(overrideDataDir?: string): InstalledPluginLedger {
  const filePath = getInstalledLedgerPath(overrideDataDir);
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<InstalledPluginLedger>;
      return {
        skills: parsed.skills && typeof parsed.skills === 'object' ? parsed.skills : {},
        mcps: parsed.mcps && typeof parsed.mcps === 'object' ? parsed.mcps : {},
      };
    }
  } catch {
    // ignore corrupt ledger
  }
  return { skills: {}, mcps: {} };
}

export function writeInstalledPluginLedger(ledger: InstalledPluginLedger, overrideDataDir?: string): void {
  const filePath = getInstalledLedgerPath(overrideDataDir);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(ledger, null, 2), 'utf-8');
  } catch {
    // ignore write failure
  }
}

export function extractGitHubRepoSlug(repositoryUrl?: string): string | null {
  if (!repositoryUrl) return null;
  const m = /github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)/i.exec(repositoryUrl);
  if (!m) return null;
  return `${m[1]}/${m[2].replace(/\.git$/i, '')}`;
}

export function sanitizeSkillDirName(rawName: string): string {
  const cleaned = rawName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    throw new Error('非法的技能名称');
  }
  return cleaned;
}

export function parseRegistryServerEntry(
  entry: McpRegistryServerEntry,
  existingMcpNames: Set<string>,
  cache?: MarketplaceMetaCache
): MarketplaceMcpItem | null {
  const srv = entry?.server;
  if (!srv?.name) return null;

  const shortName = srv.name.includes('/') ? srv.name.split('/').pop() || srv.name : srv.name;
  const title = srv.title?.trim() || shortName;
  const description = (srv.description || '来自官方 MCP Registry').trim();
  const configFields: MarketplaceEnvField[] = [];
  let transport: IMcpServerTransport | null = null;

  const pkg = Array.isArray(srv.packages)
    ? srv.packages.find((p) => p.registryType === 'npm' || p.registryType === 'pypi') || srv.packages[0]
    : undefined;

  if (pkg?.identifier) {
    const env: Record<string, string> = {};
    for (const ev of pkg.environmentVariables || []) {
      if (!ev.name) continue;
      env[ev.name] = '';
      configFields.push({
        key: ev.name,
        label: ev.name,
        placeholder: ev.description || `填写 ${ev.name}`,
        required: Boolean(ev.isRequired),
        secret: ev.isSecret !== false,
        target: 'env',
      });
    }
    if (pkg.registryType === 'pypi') {
      transport = { type: 'stdio', command: 'uvx', args: [pkg.identifier], env };
    } else if (pkg.registryType === 'oci') {
      transport = { type: 'stdio', command: 'docker', args: ['run', '-i', '--rm', pkg.identifier], env };
    } else {
      transport = { type: 'stdio', command: 'npx', args: ['-y', pkg.identifier], env };
    }
  } else if (Array.isArray(srv.remotes) && srv.remotes[0]?.url) {
    const remote = srv.remotes[0];
    const headers: Record<string, string> = {};
    for (const h of remote.headers || []) {
      if (!h.name) continue;
      headers[h.name] = h.value || '';
      if (!h.value || h.value.includes('{')) {
        configFields.push({
          key: `HEADER_${h.name}`,
          label: `${h.name} 请求头`,
          placeholder: h.description || h.value || `填写 ${h.name}`,
          required: Boolean(h.isRequired),
          secret: h.isSecret !== false,
          target: 'header',
          headerName: h.name,
          defaultValue: h.value,
        });
      }
    }
    const rType = (remote.type || '').toLowerCase();
    transport = {
      type: rType === 'sse' ? 'sse' : rType === 'streamable-http' ? 'streamable_http' : 'http',
      url: remote.url!,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
  }

  if (!transport) return null;

  const repoUrl = srv.repository?.url;
  const repoSlug = extractGitHubRepoSlug(repoUrl);
  const stars = repoSlug && cache ? cache.repoStars[repoSlug] : undefined;
  const author = srv.name.includes('/') ? srv.name.split('/')[0] : undefined;

  return {
    id: `registry:${srv.name}`,
    name: shortName,
    title,
    description,
    category: '官方 Registry',
    source: 'registry',
    author,
    transport,
    ...(configFields.length > 0 ? { configFields } : {}),
    repositoryUrl: repoUrl,
    version: srv.version,
    ...(typeof stars === 'number' ? { stars } : {}),
    installed: existingMcpNames.has(shortName),
  };
}

export function applyMcpConfigFields(
  baseTransport: IMcpServerTransport,
  configFields: MarketplaceEnvField[] | undefined,
  fieldValues: Record<string, string> | undefined
): IMcpServerTransport {
  const values = fieldValues || {};
  const transport = structuredClone(baseTransport);

  for (const field of configFields || []) {
    const rawVal = (values[field.key] ?? field.defaultValue ?? '').trim();
    if (!rawVal) continue;
    if (field.target === 'arg' && transport.type === 'stdio' && typeof field.argIndex === 'number') {
      const nextArgs = [...(transport.args || [])];
      nextArgs[field.argIndex] = rawVal;
      transport.args = nextArgs;
    } else if (field.target === 'header' && transport.type !== 'stdio') {
      const headerName = field.headerName || field.key;
      transport.headers = { ...transport.headers, [headerName]: rawVal };
    } else if (transport.type === 'stdio') {
      transport.env = { ...transport.env, [field.key]: rawVal };
    }
  }

  return transport;
}

export async function searchMcpMarketplace(
  query: string,
  existingMcpNames: Set<string>,
  fetchImpl: typeof fetch = fetch,
  overrideDataDir?: string
): Promise<MarketplaceSearchMcpResult> {
  const cache = readMarketplaceCache(overrideDataDir);
  const ledger = readInstalledPluginLedger(overrideDataDir);
  const q = query.trim().toLowerCase();

  const curatedMatches: MarketplaceMcpItem[] = CURATED_MCP_CATALOG.filter(
    (item) =>
      !q ||
      item.name.toLowerCase().includes(q) ||
      item.title.toLowerCase().includes(q) ||
      item.description.toLowerCase().includes(q) ||
      item.category.toLowerCase().includes(q)
  ).map((item) => {
    const repoSlug = extractGitHubRepoSlug(item.repositoryUrl);
    const stars = repoSlug ? cache.repoStars[repoSlug] : undefined;
    const tracked = ledger.mcps[item.name];
    return Object.assign({}, item, {
      ...(typeof stars === 'number' ? { stars } : {}),
      ...(tracked?.version ? { installedVersion: tracked.version } : {}),
      installed: existingMcpNames.has(item.name),
    });
  });

  if (!q) {
    return { items: curatedMatches };
  }

  let remoteUnavailable = false;
  const remoteItems: MarketplaceMcpItem[] = [];
  const seenNames = new Set(curatedMatches.map((i) => i.name.toLowerCase()));

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
    try {
      const url = `https://registry.modelcontextprotocol.io/v0.1/servers?search=${encodeURIComponent(query.trim())}&limit=16`;
      const resp = await fetchImpl(url, { signal: controller.signal });
      if (!resp.ok) {
        remoteUnavailable = true;
      } else {
        const json = (await resp.json()) as { servers?: McpRegistryServerEntry[] };
        for (const entry of json.servers || []) {
          const parsed = parseRegistryServerEntry(entry, existingMcpNames, cache);
          if (!parsed) continue;
          const lowerName = parsed.name.toLowerCase();
          if (seenNames.has(lowerName)) continue;
          seenNames.add(lowerName);
          remoteItems.push(parsed);
        }
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    remoteUnavailable = true;
  }

  return {
    items: [...curatedMatches, ...remoteItems],
    remoteUnavailable,
  };
}

export async function searchSkillsMarketplace(
  query: string,
  existingSkillNames: Set<string>,
  fetchImpl: typeof fetch = fetch,
  overrideDataDir?: string
): Promise<MarketplaceSearchSkillsResult> {
  const cache = readMarketplaceCache(overrideDataDir);
  const q = query.trim().toLowerCase();

  const curatedMatches: MarketplaceSkillItem[] = CURATED_SKILL_CATALOG.filter(
    (item) =>
      !q ||
      item.name.toLowerCase().includes(q) ||
      item.description.toLowerCase().includes(q) ||
      item.category.toLowerCase().includes(q)
  ).map((item) => {
    const stars = cache.repoStars[item.repo];
    const installs = cache.skillInstalls[`${item.repo}/${item.skillId}`] ?? cache.skillInstalls[item.name];
    return Object.assign({}, item, {
      ...(typeof stars === 'number' ? { stars } : {}),
      ...(typeof installs === 'number' ? { installs } : {}),
      installed: existingSkillNames.has(item.name),
    });
  });

  if (!q) {
    return { items: curatedMatches };
  }

  let remoteUnavailable = false;
  const remoteItems: MarketplaceSkillItem[] = [];
  const seenNames = new Set(curatedMatches.map((i) => i.name.toLowerCase()));

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
    try {
      const url = `https://skills.sh/api/search?q=${encodeURIComponent(query.trim())}&limit=16`;
      const resp = await fetchImpl(url, { signal: controller.signal });
      if (!resp.ok) {
        remoteUnavailable = true;
      } else {
        const json = (await resp.json()) as { skills?: SkillsShItem[] };
        for (const row of json.skills || []) {
          const repo = (row.source || '').trim();
          const skillId = (row.skillId || row.name || '').trim();
          const name = (row.name || skillId).trim();
          if (!repo || !skillId || !name) continue;
          if (seenNames.has(name.toLowerCase())) continue;
          seenNames.add(name.toLowerCase());
          const stars = cache.repoStars[repo];
          remoteItems.push({
            id: `skills.sh:${row.id || `${repo}/${skillId}`}`,
            name,
            description: `来自 ${repo}（skills.sh 社区高安装量技能）`,
            category: 'skills.sh 社区',
            source: 'skills.sh',
            author: repo.split('/')[0],
            repo,
            repositoryUrl: `https://github.com/${repo}`,
            skillId,
            ...(typeof stars === 'number' ? { stars } : {}),
            installs: typeof row.installs === 'number' ? row.installs : undefined,
            installed: existingSkillNames.has(name),
          });
        }
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    remoteUnavailable = true;
  }

  return {
    items: [...curatedMatches, ...remoteItems],
    remoteUnavailable,
  };
}

export async function syncMarketplaceMetadata(
  options: {
    force?: boolean;
    fetchImpl?: typeof fetch;
    overrideDataDir?: string;
    existingMcpNames?: Set<string>;
    existingSkillNames?: Set<string>;
  } = {}
): Promise<MarketplaceSyncResult> {
  const fetchImpl = options.fetchImpl || fetch;
  const prevCache = readMarketplaceCache(options.overrideDataDir);
  const isFresh = !options.force && Date.now() - prevCache.syncedAt < CACHE_TTL_MS && Object.keys(prevCache.repoStars).length > 0;

  const repoStars = { ...prevCache.repoStars };
  const skillInstalls = { ...prevCache.skillInstalls };
  let starsUpdated = 0;

  if (!isFresh) {
    const uniqueRepos = new Set<string>();
    for (const m of CURATED_MCP_CATALOG) {
      const slug = extractGitHubRepoSlug(m.repositoryUrl);
      if (slug) uniqueRepos.add(slug);
    }
    for (const s of CURATED_SKILL_CATALOG) {
      if (s.repo) uniqueRepos.add(s.repo);
    }

    const starResults = await Promise.all(
      Array.from(uniqueRepos).map(async (slug) => {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
          try {
            const resp = await fetchImpl(`https://api.github.com/repos/${slug}`, {
              headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'EthanToken-Desktop' },
              signal: controller.signal,
            });
            if (!resp.ok) return null;
            const json = (await resp.json()) as { stargazers_count?: number };
            if (typeof json.stargazers_count === 'number') {
              return { slug, stars: json.stargazers_count };
            }
            return null;
          } finally {
            clearTimeout(timer);
          }
        } catch {
          return null;
        }
      })
    );

    for (const item of starResults) {
      if (item) {
        repoStars[item.slug] = item.stars;
        starsUpdated += 1;
      }
    }

    const skillQueries = ['frontend', 'pdf', 'testing', 'debug'];
    const skillBatches = await Promise.all(
      skillQueries.map(async (term) => {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
          try {
            const resp = await fetchImpl(`https://skills.sh/api/search?q=${encodeURIComponent(term)}&limit=20`, {
              signal: controller.signal,
            });
            if (!resp.ok) return [] as SkillsShItem[];
            const json = (await resp.json()) as { skills?: SkillsShItem[] };
            return json.skills || [];
          } finally {
            clearTimeout(timer);
          }
        } catch {
          return [] as SkillsShItem[];
        }
      })
    );

    for (const batch of skillBatches) {
      for (const row of batch) {
        if (typeof row.installs !== 'number') continue;
        if (row.source && row.skillId) {
          skillInstalls[`${row.source}/${row.skillId}`] = row.installs;
        }
        if (row.name) {
          const prev = skillInstalls[row.name] || 0;
          if (row.installs > prev) skillInstalls[row.name] = row.installs;
        }
      }
    }

    writeMarketplaceCache(
      {
        syncedAt: Date.now(),
        repoStars,
        skillInstalls,
      },
      options.overrideDataDir
    );
  }

  let updatesAvailable = 0;
  try {
    const check = await checkMarketplaceUpdates({
      fetchImpl,
      overrideDataDir: options.overrideDataDir,
      existingMcpNames: options.existingMcpNames,
      existingSkillNames: options.existingSkillNames,
    });
    updatesAvailable = check.updates.length;
  } catch {
    updatesAvailable = 0;
  }

  return {
    syncedAt: readMarketplaceCache(options.overrideDataDir).syncedAt || Date.now(),
    mcpCount: CURATED_MCP_CATALOG.length,
    skillCount: CURATED_SKILL_CATALOG.length,
    starsUpdated,
    updatesAvailable,
  };
}

export function normalizeSkillMarkdownContent(rawMarkdown: string, fallbackName: string): string {
  const normalized = rawMarkdown.replace(/\r\n/g, '\n');
  if (/^---\n[\s\S]*?\n---/.test(normalized)) {
    return normalized;
  }
  const firstHeading = /^#\s+(.+)$/m.exec(normalized)?.[1]?.trim() || fallbackName;
  return [
    '---',
    `name: ${fallbackName}`,
    `description: ${firstHeading.replace(/[:\n]/g, ' ')}`,
    '---',
    '',
    normalized,
  ].join('\n');
}

export function parseGitHubSkillSpecifier(inputRepo: string, inputSkillId?: string): { repo: string; skillId: string } {
  let clean = inputRepo.trim();
  clean = clean.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '');
  let skillId = inputSkillId?.trim() || '';

  if (clean.includes('@')) {
    const [r, s] = clean.split('@', 2);
    clean = r.trim();
    if (!skillId && s) skillId = s.trim();
  }

  const segments = clean.split('/').filter(Boolean);
  if (segments.length < 2) {
    throw new Error('请输入有效仓库名，例如 anthropics/skills 或 owner/repo@skill');
  }
  const owner = segments[0];
  const repoName = segments[1];
  if (
    owner === '.' ||
    owner === '..' ||
    repoName === '.' ||
    repoName === '..' ||
    segments.some((s) => s === '.' || s === '..') ||
    !SAFE_SEGMENT_RE.test(owner) ||
    !SAFE_SEGMENT_RE.test(repoName)
  ) {
    throw new Error('仓库名称包含非法字符');
  }
  if (!skillId && segments.length > 2) {
    skillId = segments[segments.length - 1];
  }
  if (!skillId) {
    skillId = repoName;
  }
  if (skillId === '.' || skillId === '..' || skillId.includes('..') || /[\\/]/.test(skillId)) {
    throw new Error('技能名称包含非法路径字符');
  }
  return { repo: `${owner}/${repoName}`, skillId };
}

export async function downloadSkillMarkdownFromGitHub(
  req: InstallSkillRequest,
  fetchImpl: typeof fetch = fetch
): Promise<{ skillName: string; markdown: string; repo: string; skillId: string; rawPath?: string; sha256: string }> {
  const { repo, skillId } = parseGitHubSkillSpecifier(req.repo, req.skillId);
  const safeName = sanitizeSkillDirName(req.customName || skillId);

  const candidatePaths: string[] = [];
  if (req.rawPath?.trim()) {
    const cleanRaw = req.rawPath.trim().replace(/^\/+/, '');
    if (cleanRaw.includes('..')) throw new Error('非法的技能文件路径');
    candidatePaths.push(cleanRaw);
  }
  candidatePaths.push(
    `skills/${skillId}/SKILL.md`,
    `${skillId}/SKILL.md`,
    `.claude/skills/${skillId}/SKILL.md`,
    `.agents/skills/${skillId}/SKILL.md`,
    'SKILL.md'
  );
  const uniquePaths = Array.from(new Set(candidatePaths));

  const candidateUrls: Array<{ url: string; relPath: string }> = [];
  for (const branch of ['main', 'master']) {
    for (const relPath of uniquePaths) {
      candidateUrls.push({
        url: `https://raw.githubusercontent.com/${repo}/${branch}/${relPath}`,
        relPath,
      });
    }
  }

  const attempts = await Promise.all(
    candidateUrls.map(async ({ url, relPath }) => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
        try {
          const resp = await fetchImpl(url, { signal: controller.signal });
          if (!resp.ok) return null;
          const text = await resp.text();
          if (!text.trim() || Buffer.byteLength(text, 'utf-8') > MAX_SKILL_BYTES) return null;
          return { text, relPath };
        } finally {
          clearTimeout(timer);
        }
      } catch {
        return null;
      }
    })
  );

  const matched = attempts.find((entry): entry is { text: string; relPath: string } => entry !== null);
  if (matched) {
    const markdown = normalizeSkillMarkdownContent(matched.text, safeName);
    const sha256 = crypto.createHash('sha256').update(markdown, 'utf-8').digest('hex');
    return {
      skillName: safeName,
      markdown,
      repo,
      skillId,
      rawPath: matched.relPath,
      sha256,
    };
  }

  throw new Error(`未能在 ${repo} 仓库找到 ${skillId}/SKILL.md，请检查仓库或技能名是否正确`);
}

export async function importSkillMarkdownToBackend(
  skillName: string,
  markdown: string,
  backendImportSkill: (skillPath: string) => Promise<{
    skill_name?: string;
    skill_names?: string[];
    failed?: Array<{ source_name: string; code: string }>;
  }>,
  getUserSkillsDir: () => Promise<string | undefined>,
  tracking?: { repo: string; skillId: string; rawPath?: string; sha256?: string; overrideDataDir?: string }
): Promise<InstallSkillResult> {
  const safeName = sanitizeSkillDirName(skillName);
  const tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), 'ethantoken-skill-'));
  const skillDir = path.join(tmpParent, safeName);
  try {
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), markdown, 'utf-8');

    let finalName = safeName;
    try {
      const res = await backendImportSkill(skillDir);
      if (res?.failed && res.failed.length > 0) {
        const firstErr = res.failed[0];
        return {
          success: false,
          skillName: safeName,
          error: `${firstErr.source_name}: ${firstErr.code}`,
        };
      }
      finalName = res?.skill_name || res?.skill_names?.[0] || safeName;
    } catch {
      const userSkillsDir = await getUserSkillsDir();
      if (!userSkillsDir) {
        return { success: false, skillName: safeName, error: '无法获取本地 Skills 目录' };
      }
      const targetDir = path.join(userSkillsDir, safeName);
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, 'SKILL.md'), markdown, 'utf-8');
    }

    if (tracking?.repo) {
      const ledger = readInstalledPluginLedger(tracking.overrideDataDir);
      ledger.skills[finalName] = {
        name: finalName,
        repo: tracking.repo,
        skillId: tracking.skillId,
        rawPath: tracking.rawPath,
        sha256: tracking.sha256 || crypto.createHash('sha256').update(markdown, 'utf-8').digest('hex'),
        installedAt: Date.now(),
      };
      writeInstalledPluginLedger(ledger, tracking.overrideDataDir);
    }

    return {
      success: true,
      skillName: finalName,
    };
  } finally {
    fs.rmSync(tmpParent, { recursive: true, force: true });
  }
}

export async function installMcpItemToBackend(
  req: InstallMcpRequest,
  importServersFn: (
    servers: Array<Pick<IMcpServer, 'name' | 'description' | 'transport' | 'original_json' | 'builtin'>>
  ) => Promise<IMcpServer[]>,
  overrideDataDir?: string
): Promise<InstallMcpResult> {
  const transport = applyMcpConfigFields(req.item.transport, req.item.configFields, req.fieldValues);
  const originalJson = JSON.stringify({ mcpServers: { [req.item.name]: transport } }, null, 2);
  await importServersFn([
    {
      name: req.item.name,
      description: req.item.description,
      transport,
      original_json: originalJson,
      builtin: false,
    },
  ]);

  const ledger = readInstalledPluginLedger(overrideDataDir);
  ledger.mcps[req.item.name] = {
    id: req.item.id,
    name: req.item.name,
    source: req.item.source,
    version: req.item.version,
    repositoryUrl: req.item.repositoryUrl,
    installedAt: Date.now(),
  };
  writeInstalledPluginLedger(ledger, overrideDataDir);

  return { success: true, name: req.item.name };
}

export async function checkMarketplaceUpdates(
  options: {
    fetchImpl?: typeof fetch;
    overrideDataDir?: string;
    existingSkillNames?: Set<string>;
    existingMcpNames?: Set<string>;
  } = {}
): Promise<MarketplaceUpdateCheckResult> {
  const fetchImpl = options.fetchImpl || fetch;
  const ledger = readInstalledPluginLedger(options.overrideDataDir);
  const updates: MarketplaceUpdateItem[] = [];

  const trackedSkills = Object.values(ledger.skills).filter(
    (s) => !options.existingSkillNames || options.existingSkillNames.has(s.name)
  );

  const skillChecks = await Promise.all(
    trackedSkills.map(async (tracked) => {
      try {
        const latest = await downloadSkillMarkdownFromGitHub(
          {
            repo: tracked.repo,
            skillId: tracked.skillId,
            rawPath: tracked.rawPath,
            customName: tracked.name,
          },
          fetchImpl
        );
        if (latest.sha256 !== tracked.sha256) {
          return {
            kind: 'skill' as const,
            id: `curated:${tracked.name}`,
            name: tracked.name,
            currentVersion: tracked.sha256.slice(0, 7),
            latestVersion: latest.sha256.slice(0, 7),
            repo: tracked.repo,
            skillId: tracked.skillId,
            rawPath: latest.rawPath || tracked.rawPath,
          };
        }
        return null;
      } catch {
        return null;
      }
    })
  );

  for (const hit of skillChecks) {
    if (hit) updates.push(hit);
  }

  const trackedMcps = Object.values(ledger.mcps).filter(
    (m) =>
      m.source === 'registry' &&
      m.version &&
      (!options.existingMcpNames || options.existingMcpNames.has(m.name))
  );

  const mcpChecks = await Promise.all(
    trackedMcps.map(async (tracked) => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
        try {
          const resp = await fetchImpl(
            `https://registry.modelcontextprotocol.io/v0.1/servers?search=${encodeURIComponent(tracked.name)}&limit=5`,
            { signal: controller.signal }
          );
          if (!resp.ok) return null;
          const json = (await resp.json()) as { servers?: McpRegistryServerEntry[] };
          const exact = (json.servers || []).find((entry) => {
            const fullName = entry.server?.name || '';
            const shortName = fullName.includes('/') ? fullName.split('/').pop() : fullName;
            return `registry:${fullName}` === tracked.id || shortName === tracked.name;
          });
          const latestVersion = exact?.server?.version;
          if (latestVersion && latestVersion !== tracked.version) {
            return {
              kind: 'mcp' as const,
              id: tracked.id,
              name: tracked.name,
              currentVersion: tracked.version,
              latestVersion,
            };
          }
          return null;
        } finally {
          clearTimeout(timer);
        }
      } catch {
        return null;
      }
    })
  );

  for (const hit of mcpChecks) {
    if (hit) updates.push(hit);
  }

  return {
    checkedAt: Date.now(),
    updates,
  };
}

export async function updateAllMarketplacePlugins(options: {
  fetchImpl?: typeof fetch;
  overrideDataDir?: string;
  existingSkillNames?: Set<string>;
  existingMcpNames?: Set<string>;
  backendImportSkill: (skillPath: string) => Promise<{
    skill_name?: string;
    skill_names?: string[];
    failed?: Array<{ source_name: string; code: string }>;
  }>;
  getUserSkillsDir: () => Promise<string | undefined>;
}): Promise<MarketplaceUpdateAllResult> {
  const fetchImpl = options.fetchImpl || fetch;
  const check = await checkMarketplaceUpdates({
    fetchImpl,
    overrideDataDir: options.overrideDataDir,
    existingSkillNames: options.existingSkillNames,
    existingMcpNames: options.existingMcpNames,
  });

  const skillUpdates = check.updates.filter((u) => u.kind === 'skill' && u.repo);
  const results = await Promise.all(
    skillUpdates.map(async (u) => {
      try {
        const downloaded = await downloadSkillMarkdownFromGitHub(
          {
            repo: u.repo!,
            skillId: u.skillId || u.name,
            rawPath: u.rawPath,
            customName: u.name,
          },
          fetchImpl
        );
        const imported = await importSkillMarkdownToBackend(
          downloaded.skillName,
          downloaded.markdown,
          options.backendImportSkill,
          options.getUserSkillsDir,
          {
            repo: downloaded.repo,
            skillId: downloaded.skillId,
            rawPath: downloaded.rawPath,
            sha256: downloaded.sha256,
            overrideDataDir: options.overrideDataDir,
          }
        );
        if (!imported.success) {
          return { ok: false as const, name: u.name, reason: imported.error || '更新失败' };
        }
        return { ok: true as const, name: u.name };
      } catch (err) {
        return { ok: false as const, name: u.name, reason: err instanceof Error ? err.message : String(err) };
      }
    })
  );

  let updatedCount = 0;
  const failed: Array<{ name: string; reason: string }> = [];
  for (const r of results) {
    if (r.ok) updatedCount += 1;
    else failed.push({ name: r.name, reason: r.reason });
  }

  return { updatedCount, failed };
}

/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  mergeRuleSegmentsIntoProfile,
  mergeRuleSegmentsWithStats,
  sanitizeAionrsProjectPath,
  upsertMemoryIndexEntry,
  writeAionMemorySnapshot,
} from '@/process/services/ecosystem/globalMemory';
import { CURATED_MCP_CATALOG, CURATED_SKILL_CATALOG } from '@/process/services/ecosystem/marketplaceCatalog';
import {
  applyMcpConfigFields,
  checkMarketplaceUpdates,
  downloadSkillMarkdownFromGitHub,
  getPluginDetails,
  importSkillMarkdownToBackend,
  installMcpItemToBackend,
  parseGitHubSkillSpecifier,
  searchMcpMarketplace,
  searchSkillsMarketplace,
  syncMarketplaceMetadata,
  updateAllMarketplacePlugins,
} from '@/process/services/ecosystem/marketplaceService';

describe('marketplaceCatalog & marketplaceService', () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    while (tmpRoots.length > 0) {
      fs.rmSync(tmpRoots.pop()!, { recursive: true, force: true });
    }
  });

  it('has unique IDs and names in curated MCP and Skills catalogs', () => {
    const mcpIds = new Set(CURATED_MCP_CATALOG.map((i) => i.id));
    const mcpNames = new Set(CURATED_MCP_CATALOG.map((i) => i.name));
    expect(mcpIds.size).toBe(CURATED_MCP_CATALOG.length);
    expect(mcpNames.size).toBe(CURATED_MCP_CATALOG.length);
    expect(CURATED_MCP_CATALOG.length).toBeGreaterThanOrEqual(12);

    const skillIds = new Set(CURATED_SKILL_CATALOG.map((i) => i.id));
    const skillNames = new Set(CURATED_SKILL_CATALOG.map((i) => i.name));
    expect(skillIds.size).toBe(CURATED_SKILL_CATALOG.length);
    expect(skillNames.size).toBe(CURATED_SKILL_CATALOG.length);
  });

  it('parses MCP Registry v0.1 packages/remotes and degrades gracefully on network error', async () => {
    const mockFetch = (async () =>
      new Response(
        JSON.stringify({
          servers: [
            {
              server: {
                name: 'io.github.demo/custom-db',
                title: 'Custom DB MCP',
                description: 'Query databases cleanly',
                version: '1.2.0',
                packages: [
                  {
                    registryType: 'npm',
                    identifier: '@demo/custom-db-mcp',
                    environmentVariables: [{ name: 'DB_TOKEN', isRequired: true, isSecret: true }],
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 }
      )) as unknown as typeof fetch;

    const okRes = await searchMcpMarketplace('custom-db', new Set(['memory']), mockFetch);
    expect(okRes.remoteUnavailable).toBe(false);
    expect(okRes.items.some((i) => i.name === 'custom-db' && i.source === 'registry')).toBe(true);
    const customItem = okRes.items.find((i) => i.name === 'custom-db')!;
    expect(customItem.configFields?.[0]?.key).toBe('DB_TOKEN');

    const failFetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const fallbackRes = await searchMcpMarketplace('tavily', new Set(['tavily']), failFetch);
    expect(fallbackRes.remoteUnavailable).toBe(true);
    expect(fallbackRes.items.some((i) => i.name === 'tavily' && i.installed)).toBe(true);
  });

  it('applies env, arg, and header config fields cleanly', () => {
    const fsItem = CURATED_MCP_CATALOG.find((i) => i.name === 'filesystem')!;
    const appliedFs = applyMcpConfigFields(fsItem.transport, fsItem.configFields, {
      ALLOWED_DIR: 'D:\\Workspace',
    });
    expect(appliedFs.type).toBe('stdio');
    if (appliedFs.type === 'stdio') {
      expect(appliedFs.args?.[2]).toBe('D:\\Workspace');
    }

    const tavilyItem = CURATED_MCP_CATALOG.find((i) => i.name === 'tavily')!;
    const appliedTavily = applyMcpConfigFields(tavilyItem.transport, tavilyItem.configFields, {
      TAVILY_API_KEY: 'tvly-abc',
    });
    if (appliedTavily.type === 'stdio') {
      expect(appliedTavily.env?.TAVILY_API_KEY).toBe('tvly-abc');
    }
  });

  it('searches skills.sh results, validates repo specifiers, and imports skill via fallback', async () => {
    const mockFetch = (async (url: string) => {
      if (url.includes('skills.sh/api/search')) {
        return new Response(
          JSON.stringify({
            skills: [
              { id: 'vercel-labs/agent-skills/react-best', source: 'vercel-labs/agent-skills', skillId: 'react-best', name: 'react-best', installs: 99000 },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.includes('raw.githubusercontent.com/vercel-labs/agent-skills/main/skills/react-best/SKILL.md')) {
        return new Response('# React Best\nUse concise components.', { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    }) as unknown as typeof fetch;

    const searchRes = await searchSkillsMarketplace('react', new Set(), mockFetch);
    expect(searchRes.items.some((i) => i.name === 'react-best' && i.source === 'skills.sh')).toBe(true);

    expect(parseGitHubSkillSpecifier('https://github.com/anthropics/skills@frontend-design')).toEqual({
      repo: 'anthropics/skills',
      skillId: 'frontend-design',
    });
    expect(() => parseGitHubSkillSpecifier('../../evil/repo')).toThrow();

    const downloaded = await downloadSkillMarkdownFromGitHub(
      { repo: 'vercel-labs/agent-skills', skillId: 'react-best' },
      mockFetch
    );
    expect(downloaded.markdown).toContain('name: react-best');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ethantoken-skill-target-'));
    tmpRoots.push(root);
    const imported = await importSkillMarkdownToBackend(
      downloaded.skillName,
      downloaded.markdown,
      async () => {
        throw new Error('backend unavailable');
      },
      async () => root
    );
    expect(imported.success).toBe(true);
    expect(fs.existsSync(path.join(root, 'react-best', 'SKILL.md'))).toBe(true);
  });
});

describe('globalMemory', () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    while (tmpRoots.length > 0) {
      fs.rmSync(tmpRoots.pop()!, { recursive: true, force: true });
    }
  });

  it('writes idempotent user_profile.md and MEMORY.md matching aionrs path sanitization', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ethantoken-mem-'));
    tmpRoots.push(root);
    const memBase = path.join(root, 'memory');
    const workDir = 'C:\\Users\\Admin\\AppData\\Roaming\\AionUi\\aionui';
    expect(sanitizeAionrsProjectPath(workDir)).toBe('C--Users-Admin-AppData-Roaming-AionUi-aionui');

    const merged = mergeRuleSegmentsIntoProfile('', [
      { title: 'Trae 规则', content: '回答简短，先给可执行方案。' },
      { title: 'Trae 规则重复', content: '回答简短，先给可执行方案。' },
    ]);
    expect(merged.match(/回答简短/g)).toHaveLength(1);

    const snap = writeAionMemorySnapshot(memBase, workDir, merged);
    expect(fs.existsSync(snap.globalProfilePath)).toBe(true);
    expect(fs.existsSync(snap.projectMemoryPath)).toBe(true);

    const idxPath = path.join(path.dirname(snap.projectMemoryPath), 'MEMORY.md');
    upsertMemoryIndexEntry(idxPath, 'other_topic.md', '其他项目笔记');
    writeAionMemorySnapshot(memBase, workDir, merged);
    const idxContent = fs.readFileSync(idxPath, 'utf-8');
    expect(idxContent).toContain('other_topic.md');
    expect(idxContent.match(/\(user_profile\.md\)/g)).toHaveLength(1);
  });

  it('deduplicates similar rules line-by-line across multiple clients via mergeRuleSegmentsWithStats', () => {
    const res = mergeRuleSegmentsWithStats('', [
      {
        title: 'WorkBuddy 规则',
        content: 'Always answer concisely in Chinese\nUse TypeScript strict mode across services.',
      },
      {
        title: 'Claude Code 规则',
        content: 'always answer concisely in chinese.\nPrefer small pure functions.',
      },
    ]);
    expect(res.addedSegments).toBe(2);
    expect(res.merged.match(/Always answer concisely/gi)).toHaveLength(1);
    expect(res.merged).toContain('Prefer small pure functions.');

    const fullDup = mergeRuleSegmentsWithStats(res.merged, [
      { title: 'Cursor 重复规则', content: 'Prefer small pure functions.' },
    ]);
    expect(fullDup.addedSegments).toBe(0);
    expect(fullDup.deduplicatedCount).toBe(1);
  });

  it('syncs GitHub stars & skills.sh installs, checks updates, and batch updates outdated skills', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ethantoken-mkt-sync-'));
    tmpRoots.push(root);

    let skillVersion = 1;
    const mockFetch = (async (url: string) => {
      if (url.startsWith('https://api.github.com/repos/')) {
        const stars = url.includes('upstash/context7') ? 4200 : 1850;
        return new Response(JSON.stringify({ stargazers_count: stars }), { status: 200 });
      }
      if (url.includes('skills.sh/api/search')) {
        return new Response(
          JSON.stringify({
            skills: [
              { id: 'anthropics/skills/frontend-design', source: 'anthropics/skills', skillId: 'frontend-design', name: 'frontend-design', installs: 12345 },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.includes('raw.githubusercontent.com/') && url.includes('frontend-design')) {
        return new Response(`# Frontend Design v${skillVersion}\nUpdated skill instructions v${skillVersion}.`, {
          status: 200,
        });
      }
      if (url.includes('registry.modelcontextprotocol.io/v0.1/servers')) {
        return new Response(
          JSON.stringify({
            servers: [{ server: { name: 'io.github.upstash/context7', version: '2.0.0' } }],
          }),
          { status: 200 }
        );
      }
      return new Response('Not Found', { status: 404 });
    }) as unknown as typeof fetch;

    const syncRes = await syncMarketplaceMetadata({
      force: true,
      fetchImpl: mockFetch,
      overrideDataDir: root,
    });
    expect(syncRes.starsUpdated).toBeGreaterThan(0);

    // Search curated MCP should now attach real cached star counts.
    const mcpSearch = await searchMcpMarketplace('context7', new Set(), mockFetch, root);
    const context7 = mcpSearch.items.find((i) => i.name === 'context7');
    expect(context7?.stars).toBe(4200);

    // Install frontend-design skill v1 & context7 MCP so metadata is recorded.
    const installedDir = path.join(root, 'skills');
    const dl1 = await downloadSkillMarkdownFromGitHub({ repo: 'anthropics/skills', skillId: 'frontend-design' }, mockFetch);
    await importSkillMarkdownToBackend(
      dl1.skillName,
      dl1.markdown,
      async () => ({ skill_name: 'frontend-design' }),
      async () => installedDir,
      { repo: dl1.repo, skillId: dl1.skillId, sha256: dl1.sha256, overrideDataDir: root }
    );
    await installMcpItemToBackend(
      { item: context7! },
      async (servers) =>
        servers.map((s) => ({
          id: 'mcp-1',
          name: s.name,
          description: s.description,
          enabled: true,
          transport: s.transport,
          status: 'connected',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })),
      root
    );

    // Bump remote skill content to v2 -> update check should detect frontend-design update.
    skillVersion = 2;
    const checkRes = await checkMarketplaceUpdates({
      fetchImpl: mockFetch,
      overrideDataDir: root,
      existingSkillNames: new Set(['frontend-design']),
      existingMcpNames: new Set(['context7']),
    });
    expect(checkRes.updates.length).toBeGreaterThanOrEqual(1);
    expect(checkRes.updates.some((u) => u.name === 'frontend-design')).toBe(true);

    // Batch update should re-import frontend-design v2.
    let importedMarkdown = '';
    const updateRes = await updateAllMarketplacePlugins({
      fetchImpl: mockFetch,
      overrideDataDir: root,
      existingSkillNames: new Set(['frontend-design']),
      existingMcpNames: new Set(['context7']),
      backendImportSkill: async (skillDir) => {
        importedMarkdown = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
        return { skill_name: 'frontend-design' };
      },
      getUserSkillsDir: async () => installedDir,
    });
    expect(updateRes.updatedCount).toBe(1);
    expect(updateRes.failed).toHaveLength(0);
    expect(importedMarkdown).toContain('v2');
  });

  it('aggregates paginated MCP registry results and multi-topic skills.sh discovery with caching', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-mkt-discover-'));
    tmpRoots.push(root);

    let mcpCalls = 0;
    const mockFetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('registry.modelcontextprotocol.io/v0.1/servers')) {
        mcpCalls += 1;
        if (url.includes('cursor=page2')) {
          return new Response(
            JSON.stringify({
              servers: [
                {
                  server: {
                    name: 'io.example/server-two',
                    title: 'Server Two',
                    description: 'Second page MCP server',
                    version: '1.2.0',
                    packages: [{ registryType: 'npm', identifier: '@example/server-two' }],
                  },
                },
              ],
              metadata: { nextCursor: 'page3' },
            }),
            { status: 200 }
          );
        }
        if (url.includes('cursor=page3')) {
          return new Response(
            JSON.stringify({
              servers: [
                {
                  server: {
                    name: 'io.example/server-three',
                    title: 'Server Three',
                    description: 'Third page MCP server',
                    version: '2.0.0',
                    packages: [{ registryType: 'npm', identifier: '@example/server-three' }],
                  },
                },
              ],
              metadata: {},
            }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify({
            servers: [
              {
                server: {
                  name: 'io.example/server-one',
                  title: 'Server One',
                  description: 'First page MCP server',
                  version: '1.0.0',
                  packages: [{ registryType: 'npm', identifier: '@example/server-one' }],
                },
              },
            ],
            metadata: { nextCursor: 'page2' },
          }),
          { status: 200 }
        );
      }

      if (url.includes('skills.sh/api/search')) {
        const parsedUrl = new URL(url);
        const topic = parsedUrl.searchParams.get('q') || 'agent';
        return new Response(
          JSON.stringify({
            skills: [
              {
                id: `${topic}/skill-one`,
                source: `org/${topic}`,
                skillId: `${topic}-skill`,
                name: `${topic}-skill`,
                installs: 500,
              },
            ],
          }),
          { status: 200 }
        );
      }

      return new Response('', { status: 404 });
    }) as typeof fetch;

    const firstMcp = await searchMcpMarketplace('', new Set(['server-two']), mockFetch, root);
    expect(firstMcp.items.some((i) => i.name === 'server-one' && !i.installed)).toBe(true);
    expect(firstMcp.items.some((i) => i.name === 'server-two' && i.installed)).toBe(true);
    expect(firstMcp.nextCursor).toBe('page3');
    expect(mcpCalls).toBe(2);

    // Second empty search hits fresh cache without extra remote HTTP calls.
    const cachedMcp = await searchMcpMarketplace('', new Set(['server-one']), mockFetch, root);
    expect(cachedMcp.items.some((i) => i.name === 'server-one' && i.installed)).toBe(true);
    expect(mcpCalls).toBe(2);

    // Explicit cursor fetches page 3 directly.
    const page3 = await searchMcpMarketplace('', new Set(), mockFetch, root, 'page3');
    expect(page3.items.map((i) => i.name)).toContain('server-three');
    expect(page3.nextCursor).toBeUndefined();

    // Default skills discover aggregates curated + multi-topic skills.sh items.
    const discoverSkills = await searchSkillsMarketplace('', new Set(['agent-skill']), mockFetch, root);
    expect(discoverSkills.items.some((s) => s.name === 'agent-skill' && s.installed)).toBe(true);
    expect(discoverSkills.items.some((s) => s.name === 'react-skill')).toBe(true);

    // 1-character queries return curated matches cleanly without hitting remote 400.
    const shortQuery = await searchSkillsMarketplace('a', new Set(), mockFetch, root);
    expect(shortQuery.remoteUnavailable).toBeUndefined();
  });

  it('resolves plugin README / SKILL.md details cleanly across local, GitHub, and curated fallbacks', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-mkt-detail-'));
    const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-local-skills-'));
    tmpRoots.push(root, skillsDir);

    const localDir = path.join(skillsDir, 'my-custom-skill');
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(path.join(localDir, 'SKILL.md'), '---\nname: my-custom-skill\n---\n\n# Local Skill Body\n', 'utf-8');

    const mockFetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('raw.githubusercontent.com/upstash/context7/HEAD/README.md')) {
        return new Response('# Context7 Official README\n\nLive docs MCP.', { status: 200 });
      }
      return new Response('', { status: 404 });
    }) as typeof fetch;

    const localDetail = await getPluginDetails(
      { kind: 'skill', id: 'local:my-custom-skill', name: 'my-custom-skill' },
      { fetchImpl: mockFetch, overrideDataDir: root, overrideUserSkillsDir: skillsDir }
    );
    expect(localDetail.resolvedFrom).toBe('local-skill');
    expect(localDetail.readmeMarkdown).toContain('Local Skill Body');

    const mcpDetail = await getPluginDetails(
      {
        kind: 'mcp',
        id: 'curated:context7',
        name: 'context7',
        repositoryUrl: 'https://github.com/upstash/context7',
      },
      { fetchImpl: mockFetch, overrideDataDir: root, overrideUserSkillsDir: skillsDir }
    );
    expect(mcpDetail.resolvedFrom).toBe('github-readme');
    expect(mcpDetail.readmeMarkdown).toContain('Context7 Official README');
    expect(mcpDetail.usageGuide).toBeTruthy();
    expect((mcpDetail.examplePrompts || []).length).toBeGreaterThan(0);

    // Offline curated MCP still returns curated usageGuide and prompts.
    const offlineCurated = await getPluginDetails(
      { kind: 'mcp', id: 'curated:sequential-thinking', name: 'sequential-thinking' },
      {
        fetchImpl: (async () => new Response('', { status: 500 })) as typeof fetch,
        overrideDataDir: root,
        overrideUserSkillsDir: skillsDir,
      }
    );
    expect(offlineCurated.resolvedFrom).toBe('curated');
    expect(offlineCurated.usageGuide).toBeTruthy();
  });
});

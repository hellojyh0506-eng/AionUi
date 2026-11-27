/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import { ipcBridge } from '@/common';
import { httpRequest } from '@/common/adapter/httpBridge';
import type { IMcpServer } from '@/common/config/storage';
import { scanInstalledClients, type FullScanOutcome } from '../services/ecosystem/clientScanner';
import { attachResourcesToAllAssistants, normalizeTransportForBackend } from '../services/ecosystem/assistantMount';
import {
  getGlobalMemoryState,
  mergeRuleSegmentsWithStats,
  resolveGlobalProfilePath,
  resolveMemoryBaseDir,
  saveGlobalMemoryState,
} from '../services/ecosystem/globalMemory';
import {
  checkMarketplaceUpdates,
  downloadSkillMarkdownFromGitHub,
  importSkillMarkdownToBackend,
  installMcpItemToBackend,
  searchMcpMarketplace,
  searchSkillsMarketplace,
  syncMarketplaceMetadata,
  updateAllMarketplacePlugins,
} from '../services/ecosystem/marketplaceService';
import type { EcosystemClientId, ScannedRuleItem, ScannedSkillItem } from '../services/ecosystem/types';

interface BackendSkillInfo {
  name: string;
}

interface BackendSkillImportResponse {
  skill_name?: string;
  skill_names?: string[];
  failed?: Array<{ source_name: string; code: string }>;
}

let cachedScanOutcome: FullScanOutcome | null = null;

async function fetchExistingSkillAndMcpSets(): Promise<{
  existingSkillNames: Set<string>;
  existingMcpNames: Set<string>;
}> {
  const [skillsRes, mcpsRes] = await Promise.all([
    httpRequest<BackendSkillInfo[]>('GET', '/api/skills').catch((): BackendSkillInfo[] => []),
    httpRequest<IMcpServer[]>('GET', '/api/mcp/servers').catch((): IMcpServer[] => []),
  ]);
  return {
    existingSkillNames: new Set((skillsRes || []).map((s) => s.name).filter(Boolean)),
    existingMcpNames: new Set((mcpsRes || []).map((m) => m.name).filter(Boolean)),
  };
}

function getMcpEnvCount(transport: IMcpServer['transport']): number {
  if (transport.type === 'stdio') return Object.keys(transport.env || {}).length;
  return Object.keys(transport.headers || {}).length;
}

export function initEcosystemBridge(): void {
  ipcBridge.ecosystem.scanClients.provider(async () => {
    const { existingSkillNames, existingMcpNames } = await fetchExistingSkillAndMcpSets();
    cachedScanOutcome = scanInstalledClients({
      existingSkillNames,
      existingMcpNames,
    });
    return cachedScanOutcome.report;
  });

  ipcBridge.ecosystem.importScannedItems.provider(async (req) => {
    const { existingSkillNames, existingMcpNames } = await fetchExistingSkillAndMcpSets();
    const outcome =
      cachedScanOutcome ??
      scanInstalledClients({
        existingSkillNames,
        existingMcpNames,
      });
    cachedScanOutcome = outcome;

    const clientFilter = req.clientIds && req.clientIds.length > 0 ? new Set<EcosystemClientId>(req.clientIds) : null;

    // Resolve candidate skills, MCPs, and rules either by clientIds (simple mode) or explicit IDs (advanced mode).
    let rawSelectedSkills: ScannedSkillItem[];
    let rawSelectedMcpIds: string[];
    let rawSelectedRules: ScannedRuleItem[];

    if (clientFilter) {
      rawSelectedSkills = outcome.report.skills.filter((s) => clientFilter.has(s.clientId) && !s.installed);
      rawSelectedMcpIds = outcome.report.mcps.filter((m) => clientFilter.has(m.clientId) && !m.installed).map((m) => m.id);
      rawSelectedRules = outcome.report.rules.filter((r) => clientFilter.has(r.clientId));
    } else {
      const skillMap = new Map(outcome.report.skills.map((s) => [s.id, s]));
      const ruleMap = new Map(outcome.report.rules.map((r) => [r.id, r]));
      rawSelectedSkills = (req.skillIds || []).map((id) => skillMap.get(id)).filter((s): s is ScannedSkillItem => Boolean(s));
      rawSelectedMcpIds = req.mcpIds || [];
      rawSelectedRules = (req.ruleIds || []).map((id) => ruleMap.get(id)).filter((r): r is ScannedRuleItem => Boolean(r));
    }

    // Smart deduplication across multiple selected clients: keep latest mtimeMs per skill name.
    const bestSkillByName = new Map<string, ScannedSkillItem>();
    let deduplicatedSkills = 0;
    for (const item of rawSelectedSkills) {
      const existing = bestSkillByName.get(item.name);
      if (!existing) {
        bestSkillByName.set(item.name, item);
      } else {
        deduplicatedSkills += 1;
        if ((item.mtimeMs || 0) > (existing.mtimeMs || 0)) {
          bestSkillByName.set(item.name, item);
        }
      }
    }

    const skillImportOutcomes = await Promise.all(
      Array.from(bestSkillByName.values()).map(async (item) => {
        let resolvedPath = item.sourcePath;
        try {
          resolvedPath = fs.realpathSync(item.sourcePath);
        } catch {
          // Keep original path if realpath cannot resolve.
        }
        try {
          const res = await httpRequest<BackendSkillImportResponse>('POST', '/api/skills/import', {
            skill_path: resolvedPath,
          });
          if (res?.failed && res.failed.length > 0) {
            return { ok: false as const, name: item.name, reason: res.failed[0].code || '导入失败' };
          }
          return { ok: true as const, name: item.name };
        } catch (err) {
          return {
            ok: false as const,
            name: item.name,
            reason: err instanceof Error ? err.message : String(err),
          };
        }
      })
    );

    let skillsImported = 0;
    const skillsFailed: Array<{ name: string; reason: string }> = [];
    for (const out of skillImportOutcomes) {
      if (out.ok) skillsImported += 1;
      else skillsFailed.push({ name: out.name, reason: out.reason });
    }

    // Smart MCP deduplication: prefer config with more env/header keys configured.
    const bestMcpByName = new Map<
      string,
      Pick<IMcpServer, 'name' | 'description' | 'transport' | 'original_json' | 'builtin'>
    >();
    let deduplicatedMcps = 0;
    for (const mcpId of rawSelectedMcpIds) {
      const internal = outcome.internalMcpsById.get(mcpId);
      if (!internal) continue;
      const existing = bestMcpByName.get(internal.name);
      const candidate: Pick<IMcpServer, 'name' | 'description' | 'transport' | 'original_json' | 'builtin'> = {
        name: internal.name,
        description: internal.description,
        transport: normalizeTransportForBackend(internal.transport) as IMcpServer['transport'],
        original_json: JSON.stringify({ mcpServers: { [internal.name]: internal.originalConfig } }, null, 2),
        builtin: false,
      };
      if (!existing) {
        bestMcpByName.set(internal.name, candidate);
      } else {
        deduplicatedMcps += 1;
        if (getMcpEnvCount(candidate.transport) > getMcpEnvCount(existing.transport)) {
          bestMcpByName.set(internal.name, candidate);
        }
      }
    }

    let mcpsImported = 0;
    const mcpsFailed: Array<{ name: string; reason: string }> = [];
    const importedMcpIds: string[] = [];
    const serversToImport = Array.from(bestMcpByName.values());
    if (serversToImport.length > 0) {
      try {
        const imported = await httpRequest<IMcpServer[]>('POST', '/api/mcp/servers/import', {
          servers: serversToImport,
        });
        if (Array.isArray(imported)) {
          mcpsImported = imported.length;
          for (const srv of imported) {
            if (srv?.id) importedMcpIds.push(srv.id);
          }
        } else {
          mcpsImported = serversToImport.length;
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        for (const s of serversToImport) {
          mcpsFailed.push({ name: s.name, reason });
        }
      }
    }

    const segments: Array<{ title: string; content: string }> = [];
    for (const rule of rawSelectedRules) {
      if (rule.content.trim()) {
        segments.push({ title: rule.title, content: rule.content });
      }
    }
    if (req.extraMemoryText?.trim()) {
      segments.push({ title: '个人沟通偏好与记忆总结', content: req.extraMemoryText.trim() });
    }

    let rulesMerged = 0;
    let deduplicatedRules = 0;
    let assistantSynced = false;
    let globalMemoryPath = resolveGlobalProfilePath(resolveMemoryBaseDir());

    if (segments.length > 0) {
      const currentMem = await getGlobalMemoryState();
      const mergeRes = mergeRuleSegmentsWithStats(currentMem.content, segments);
      deduplicatedRules = mergeRes.deduplicatedCount;
      if (mergeRes.addedSegments > 0) {
        const saved = await saveGlobalMemoryState({
          content: mergeRes.merged,
          syncAssistant: req.syncAssistant !== false,
        });
        rulesMerged = mergeRes.addedSegments;
        assistantSynced = saved.assistantSynced;
        globalMemoryPath = saved.globalProfilePath;
      } else {
        globalMemoryPath = currentMem.globalProfilePath;
      }
    }

    const mountedSkillNames = skillImportOutcomes.filter((o) => o.ok).map((o) => o.name);
    if (rulesMerged > 0) {
      mountedSkillNames.push('ethantoken-user-memory');
    }
    if (mountedSkillNames.length > 0 || importedMcpIds.length > 0 || serversToImport.length > 0) {
      await attachResourcesToAllAssistants({
        skillNames: mountedSkillNames,
        mcpServerIds: importedMcpIds,
        mcpServerNames: serversToImport.map((s) => s.name),
      }).catch((): undefined => undefined);
    }

    cachedScanOutcome = null;

    return {
      skillsImported,
      skillsFailed,
      mcpsImported,
      mcpsFailed,
      rulesMerged,
      deduplicatedSkills,
      deduplicatedMcps,
      deduplicatedRules,
      assistantSynced,
      globalMemoryPath,
    };
  });

  ipcBridge.ecosystem.getGlobalMemory.provider(async () => {
    return await getGlobalMemoryState();
  });

  ipcBridge.ecosystem.saveGlobalMemory.provider(async (req) => {
    const saved = await saveGlobalMemoryState(req);
    if (req.content.trim()) {
      await attachResourcesToAllAssistants({ skillNames: ['ethantoken-user-memory'] }).catch(
        (): undefined => undefined
      );
    }
    return saved;
  });

  ipcBridge.ecosystem.searchMcpMarketplace.provider(async (req) => {
    const { existingMcpNames } = await fetchExistingSkillAndMcpSets();
    return await searchMcpMarketplace(req?.query || '', existingMcpNames);
  });

  ipcBridge.ecosystem.installMcpFromMarketplace.provider(async (req) => {
    try {
      const importedIds: string[] = [];
      const res = await installMcpItemToBackend(req, async (servers) => {
        const normalizedServers = servers.map((s) =>
          Object.assign({}, s, { transport: normalizeTransportForBackend(s.transport) as IMcpServer['transport'] })
        );
        const created = await httpRequest<IMcpServer[]>('POST', '/api/mcp/servers/import', {
          servers: normalizedServers,
        });
        for (const srv of created || []) {
          if (srv?.id) importedIds.push(srv.id);
        }
        return created;
      });
      if (res.success) {
        await attachResourcesToAllAssistants({
          mcpServerIds: importedIds,
          mcpServerNames: [res.name || req.item.name],
        }).catch((): undefined => undefined);
      }
      return res;
    } catch (err) {
      return {
        success: false,
        name: req.item.name,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ipcBridge.ecosystem.searchSkillsMarketplace.provider(async (req) => {
    const { existingSkillNames } = await fetchExistingSkillAndMcpSets();
    return await searchSkillsMarketplace(req?.query || '', existingSkillNames);
  });

  ipcBridge.ecosystem.installSkillFromMarketplace.provider(async (req) => {
    try {
      const downloaded = await downloadSkillMarkdownFromGitHub(req);
      const res = await importSkillMarkdownToBackend(
        downloaded.skillName,
        downloaded.markdown,
        async (skillPath) =>
          await httpRequest<BackendSkillImportResponse>('POST', '/api/skills/import', { skill_path: skillPath }),
        async () => {
          const paths = await httpRequest<{ user_skills_dir?: string }>('GET', '/api/skills/paths');
          return paths?.user_skills_dir;
        },
        {
          repo: downloaded.repo,
          skillId: downloaded.skillId,
          rawPath: downloaded.rawPath,
          sha256: downloaded.sha256,
        }
      );
      if (res.success && res.skillName) {
        await attachResourcesToAllAssistants({ skillNames: [res.skillName] }).catch((): undefined => undefined);
      }
      return res;
    } catch (err) {
      return {
        success: false,
        skillName: req.customName || req.skillId || req.repo,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ipcBridge.ecosystem.syncMarketplace.provider(async (req) => {
    const { existingMcpNames, existingSkillNames } = await fetchExistingSkillAndMcpSets();
    return await syncMarketplaceMetadata({
      force: Boolean(req && 'force' in req && req.force),
      existingMcpNames,
      existingSkillNames,
    });
  });

  ipcBridge.ecosystem.checkUpdates.provider(async () => {
    const { existingMcpNames, existingSkillNames } = await fetchExistingSkillAndMcpSets();
    return await checkMarketplaceUpdates({ existingMcpNames, existingSkillNames });
  });

  ipcBridge.ecosystem.updateAllPlugins.provider(async () => {
    const { existingMcpNames, existingSkillNames } = await fetchExistingSkillAndMcpSets();
    return await updateAllMarketplacePlugins({
      existingMcpNames,
      existingSkillNames,
      backendImportSkill: async (skillPath) =>
        await httpRequest<BackendSkillImportResponse>('POST', '/api/skills/import', { skill_path: skillPath }),
      getUserSkillsDir: async () => {
        const paths = await httpRequest<{ user_skills_dir?: string }>('GET', '/api/skills/paths');
        return paths?.user_skills_dir;
      },
    });
  });

  ipcBridge.ecosystem.attachToAllAssistants.provider(async (req) => {
    return await attachResourcesToAllAssistants(req);
  });
}

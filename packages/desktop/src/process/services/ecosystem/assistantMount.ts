/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { httpRequest } from '@/common/adapter/httpBridge';
import type { IMcpServer, IMcpServerTransport } from '@/common/config/storage';
import type { Assistant, AssistantDefaultsRequest, AssistantDetail, UpdateAssistantRequest } from '@/common/types/agent/assistantTypes';
import type { AttachResourcesRequest, AttachResourcesResult } from '@/common/types/ecosystem';

type BackendMcpTransport = Exclude<IMcpServerTransport, { type: 'streamable_http' }>;

export interface AssistantMountDeps {
  listAssistants: () => Promise<Assistant[]>;
  getAssistantDetail: (id: string) => Promise<AssistantDetail | undefined>;
  updateAssistant: (payload: UpdateAssistantRequest) => Promise<Assistant>;
  listMcpServers: () => Promise<IMcpServer[]>;
  toggleMcpServer: (id: string) => Promise<IMcpServer>;
}

const DEFAULT_DEPS: AssistantMountDeps = {
  listAssistants: () => httpRequest<Assistant[]>('GET', '/api/assistants'),
  getAssistantDetail: (id: string) =>
    httpRequest<AssistantDetail>('GET', `/api/assistants/${encodeURIComponent(id)}?locale=zh-CN`),
  updateAssistant: (payload: UpdateAssistantRequest) =>
    httpRequest<Assistant>('PUT', `/api/assistants/${encodeURIComponent(payload.id)}`, payload),
  listMcpServers: () => httpRequest<IMcpServer[]>('GET', '/api/mcp/servers'),
  toggleMcpServer: (id: string) => httpRequest<IMcpServer>('POST', `/api/mcp/servers/${encodeURIComponent(id)}/toggle`),
};

export function normalizeTransportForBackend(transport: IMcpServerTransport): BackendMcpTransport {
  if (transport.type === 'streamable_http') {
    return {
      type: 'http',
      url: transport.url,
      headers: transport.headers,
    };
  }
  return transport;
}

function dedupeTrimmed(values?: string[]): string[] {
  if (!values || values.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export async function attachResourcesToAllAssistants(
  req: AttachResourcesRequest,
  deps: AssistantMountDeps = DEFAULT_DEPS
): Promise<AttachResourcesResult> {
  const validSkillNames = dedupeTrimmed(req.skillNames);
  const requestedMcpIds = dedupeTrimmed(req.mcpServerIds);
  const requestedMcpNames = dedupeTrimmed(req.mcpServerNames);

  if (validSkillNames.length === 0 && requestedMcpIds.length === 0 && requestedMcpNames.length === 0) {
    return { updatedAssistants: 0, totalAssistants: 0, enabledMcpIds: [] };
  }

  const resolvedMcpIdSet = new Set<string>(requestedMcpIds);

  if (requestedMcpIds.length > 0 || requestedMcpNames.length > 0) {
    const servers = await deps.listMcpServers().catch((): IMcpServer[] => []);
    const lowerRequestedNames = new Set(requestedMcpNames.map((n) => n.toLowerCase()));
    const matchedServers = servers.filter(
      (srv) => resolvedMcpIdSet.has(srv.id) || lowerRequestedNames.has((srv.name || '').trim().toLowerCase())
    );

    const disabledMatches = matchedServers.filter((srv) => srv.enabled === false);
    if (disabledMatches.length > 0) {
      await Promise.all(disabledMatches.map((srv) => deps.toggleMcpServer(srv.id).catch((): undefined => undefined)));
    }

    for (const srv of matchedServers) {
      if (srv.id) resolvedMcpIdSet.add(srv.id);
    }
  }

  const resolvedMcpIds = Array.from(resolvedMcpIdSet);
  const assistants = await deps.listAssistants().catch((): Assistant[] => []);
  if (!Array.isArray(assistants) || assistants.length === 0) {
    return { updatedAssistants: 0, totalAssistants: 0, enabledMcpIds: resolvedMcpIds };
  }

  const updateFlags = await Promise.all(
    assistants.map(async (assistant) => {
      if (!assistant?.id) return false;
      const detail = await deps.getAssistantDetail(assistant.id).catch((): AssistantDetail | undefined => undefined);

      const defaultSkills =
        detail?.defaults?.skills?.mode === 'fixed'
          ? (detail.defaults.skills.value ?? [])
          : (detail?.preferences?.last_skill_ids ?? []);
      const existingSkillSet = new Set<string>([
        ...(assistant.enabled_skills ?? []),
        ...defaultSkills,
        ...(assistant.source === 'builtin' ? (detail?.capabilities?.default_skill_ids ?? []) : []),
      ]);
      const nextSkillIds = Array.from(new Set([...existingSkillSet, ...validSkillNames]));
      const assistantEnabledSkillSet = new Set(assistant.enabled_skills ?? []);
      const skillsNeedUpdate =
        validSkillNames.length > 0 &&
        (validSkillNames.some((n) => !existingSkillSet.has(n)) ||
          detail?.defaults?.skills?.mode !== 'fixed' ||
          (assistant.source !== 'builtin' && validSkillNames.some((n) => !assistantEnabledSkillSet.has(n))));

      const existingMcpList =
        detail?.defaults?.mcps?.mode === 'fixed'
          ? (detail.defaults.mcps.value ?? [])
          : (detail?.preferences?.last_mcp_ids ?? []);
      const existingMcpSet = new Set<string>(existingMcpList);
      const nextMcpIds = Array.from(new Set([...existingMcpSet, ...resolvedMcpIds]));
      const mcpsNeedUpdate =
        resolvedMcpIds.length > 0 &&
        (resolvedMcpIds.some((id) => !existingMcpSet.has(id)) || detail?.defaults?.mcps?.mode !== 'fixed');

      if (!skillsNeedUpdate && !mcpsNeedUpdate) {
        return false;
      }

      const nextDefaults: AssistantDefaultsRequest = {};
      if (skillsNeedUpdate) {
        nextDefaults.skills = { mode: 'fixed', value: nextSkillIds };
      }
      if (mcpsNeedUpdate) {
        nextDefaults.mcps = { mode: 'fixed', value: nextMcpIds };
      }

      const payload: UpdateAssistantRequest =
        assistant.source === 'builtin'
          ? {
              id: assistant.id,
              agent_id: detail?.engine?.agent_id || assistant.agent_id || undefined,
              defaults: nextDefaults,
            }
          : {
              id: assistant.id,
              ...(skillsNeedUpdate ? { enabled_skills: nextSkillIds } : {}),
              defaults: nextDefaults,
            };

      try {
        await deps.updateAssistant(payload);
        return true;
      } catch (err) {
        console.warn(`[Ecosystem] Failed to mount resources onto assistant ${assistant.id}:`, err);
        return false;
      }
    })
  );

  const updatedAssistants = updateFlags.filter(Boolean).length;
  return {
    updatedAssistants,
    totalAssistants: assistants.length,
    enabledMcpIds: resolvedMcpIds,
  };
}

/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { IMcpServer } from '@/common/config/storage';
import type { Assistant, AssistantDetail, UpdateAssistantRequest } from '@/common/types/agent/assistantTypes';
import {
  attachResourcesToAllAssistants,
  normalizeTransportForBackend,
  type AssistantMountDeps,
} from '@/process/services/ecosystem/assistantMount';

function makeAssistant(overrides: Partial<Assistant> & { id: string }): Assistant {
  return {
    source: 'user',
    name: overrides.id,
    name_i18n: {},
    description_i18n: {},
    enabled: true,
    sort_order: 1,
    agent_id: 'aionrs',
    enabled_skills: [],
    custom_skill_names: [],
    disabled_builtin_skills: [],
    context_i18n: {},
    prompts: [],
    prompts_i18n: {},
    models: [],
    agent_status: 'online',
    team_selectable: true,
    deletable: true,
    ...overrides,
  };
}

function makeDetail(overrides: Partial<AssistantDetail> & { id: string }): AssistantDetail {
  return {
    source: 'user',
    agent_status: 'online',
    team_selectable: true,
    deletable: true,
    profile: { name: overrides.id, name_i18n: {}, description_i18n: {} },
    state: { enabled: true, sort_order: 1 },
    engine: { agent_id: 'aionrs' },
    rules: { content: '', storage_mode: 'file' },
    prompts: { recommended: [], recommended_i18n: {} },
    defaults: {
      model: { mode: 'auto' },
      permission: { mode: 'auto' },
      thought_level: { mode: 'auto' },
      skills: { mode: 'auto', value: [] },
      mcps: { mode: 'auto', value: [] },
    },
    capabilities: {
      default_skill_ids: [],
      custom_skill_names: [],
      default_disabled_builtin_skill_ids: [],
    },
    preferences: {
      last_skill_ids: [],
      last_disabled_builtin_skill_ids: [],
      last_mcp_ids: [],
    },
    ...overrides,
  };
}

describe('normalizeTransportForBackend', () => {
  it('converts streamable_http to http while preserving other transports', () => {
    expect(
      normalizeTransportForBackend({
        type: 'streamable_http',
        url: 'https://mcp.example.com',
        headers: { Authorization: 'Bearer abc' },
      })
    ).toEqual({
      type: 'http',
      url: 'https://mcp.example.com',
      headers: { Authorization: 'Bearer abc' },
    });

    const customStdio = { type: 'stdio' as const, command: 'custom-mcp-binary', args: ['--port', '8080'] };
    expect(normalizeTransportForBackend(customStdio)).toEqual(customStdio);

    const npxStdio = normalizeTransportForBackend({ type: 'stdio' as const, command: 'npx', args: ['-y', 'demo'] });
    expect(npxStdio.type).toBe('stdio');
    if (npxStdio.type === 'stdio') {
      expect(npxStdio.args).toEqual(['-y', 'demo']);
      expect(npxStdio.command.toLowerCase()).toContain('npx');
    }
  });
});

describe('attachResourcesToAllAssistants', () => {
  it('mounts skills and MCPs onto builtin and user assistants while auto-enabling disabled MCPs', async () => {
    const updates: UpdateAssistantRequest[] = [];
    const toggled: string[] = [];

    const builtinAssistant = makeAssistant({
      id: 'builtin-butler',
      source: 'builtin',
      deletable: false,
      enabled_skills: [],
    });
    const customAssistant = makeAssistant({
      id: 'user-coder',
      source: 'user',
      enabled_skills: ['ethantoken-media'],
    });

    const servers: IMcpServer[] = [
      {
        id: 'mcp-ctx7',
        name: 'context7',
        enabled: false,
        transport: { type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
        created_at: 1,
        updated_at: 1,
      },
    ];

    const details = new Map<string, AssistantDetail>([
      [
        'builtin-butler',
        makeDetail({
          id: 'builtin-butler',
          source: 'builtin',
          capabilities: {
            default_skill_ids: ['builtin-cron'],
            custom_skill_names: [],
            default_disabled_builtin_skill_ids: [],
          },
          defaults: {
            model: { mode: 'auto' },
            permission: { mode: 'auto' },
            thought_level: { mode: 'auto' },
            skills: { mode: 'fixed', value: ['builtin-cron'] },
            mcps: { mode: 'fixed', value: ['mcp-image'] },
          },
        }),
      ],
      [
        'user-coder',
        makeDetail({
          id: 'user-coder',
          source: 'user',
          defaults: {
            model: { mode: 'fixed', value: 'claude-sonnet' },
            permission: { mode: 'auto' },
            thought_level: { mode: 'auto' },
            skills: { mode: 'auto', value: [] },
            mcps: { mode: 'auto', value: [] },
          },
        }),
      ],
    ]);

    const deps: AssistantMountDeps = {
      listAssistants: async () => [builtinAssistant, customAssistant],
      getAssistantDetail: async (id) => details.get(id),
      updateAssistant: vi.fn(async (payload: UpdateAssistantRequest) => {
        updates.push(payload);
        return makeAssistant({ id: payload.id });
      }),
      listMcpServers: async () => servers,
      toggleMcpServer: vi.fn(async (id: string) => {
        toggled.push(id);
        return { ...servers[0], enabled: true };
      }),
    };

    const result = await attachResourcesToAllAssistants(
      {
        skillNames: ['frontend-design'],
        mcpServerNames: ['context7'],
      },
      deps
    );

    expect(toggled).toEqual(['mcp-ctx7']);
    expect(result.updatedAssistants).toBe(2);
    expect(result.enabledMcpIds).toEqual(['mcp-ctx7']);

    const builtinUpdate = updates.find((u) => u.id === 'builtin-butler');
    expect(builtinUpdate?.enabled_skills).toBeUndefined();
    expect(builtinUpdate?.defaults?.skills).toEqual({
      mode: 'fixed',
      value: ['builtin-cron', 'frontend-design'],
    });
    expect(builtinUpdate?.defaults?.mcps).toEqual({
      mode: 'fixed',
      value: ['mcp-image', 'mcp-ctx7'],
    });

    const userUpdate = updates.find((u) => u.id === 'user-coder');
    expect(userUpdate?.enabled_skills).toEqual(['ethantoken-media', 'frontend-design']);
    expect(userUpdate?.defaults?.skills).toEqual({
      mode: 'fixed',
      value: ['ethantoken-media', 'frontend-design'],
    });
    expect(userUpdate?.defaults?.mcps).toEqual({
      mode: 'fixed',
      value: ['mcp-ctx7'],
    });
  });

  it('skips PUT updates when all resources are already attached and fixed', async () => {
    const updateAssistant = vi.fn(async (payload: UpdateAssistantRequest) => makeAssistant({ id: payload.id }));
    const deps: AssistantMountDeps = {
      listAssistants: async () => [
        makeAssistant({ id: 'a1', source: 'user', enabled_skills: ['frontend-design'] }),
      ],
      getAssistantDetail: async () =>
        makeDetail({
          id: 'a1',
          defaults: {
            model: { mode: 'auto' },
            permission: { mode: 'auto' },
            thought_level: { mode: 'auto' },
            skills: { mode: 'fixed', value: ['frontend-design'] },
            mcps: { mode: 'fixed', value: ['mcp-1'] },
          },
        }),
      updateAssistant,
      listMcpServers: async () => [
        {
          id: 'mcp-1',
          name: 'context7',
          enabled: true,
          transport: { type: 'stdio', command: 'npx', args: [] },
          created_at: 1,
          updated_at: 1,
        },
      ],
      toggleMcpServer: vi.fn(async () => ({
        id: 'mcp-1',
        name: 'context7',
        enabled: true,
        transport: { type: 'stdio', command: 'npx', args: [] },
        created_at: 1,
        updated_at: 1,
      })),
    };

    const res = await attachResourcesToAllAssistants(
      { skillNames: ['frontend-design'], mcpServerIds: ['mcp-1'] },
      deps
    );
    expect(res.updatedAssistants).toBe(0);
    expect(updateAssistant).not.toHaveBeenCalled();
  });
});

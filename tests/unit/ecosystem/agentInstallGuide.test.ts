/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { ManagedAgent } from '@/renderer/utils/model/agentTypes';
import {
  buildAgentInstallButlerPrompt,
  resolveKnownAgentInstallGuide,
} from '@/renderer/pages/settings/AgentSettings/agentInstallGuide';

function makeAgent(partial: Partial<ManagedAgent>): ManagedAgent {
  return {
    id: 'agent-1',
    name: 'Claude Code',
    backend: 'claude',
    agent_type: 'claude',
    command: 'claude',
    status: 'missing',
    ...partial,
  } as ManagedAgent;
}

describe('agentInstallGuide', () => {
  it('resolves known official CLI install commands for claude, codex, and kimi', () => {
    const claude = resolveKnownAgentInstallGuide(makeAgent({ backend: 'claude', command: 'claude' }));
    expect(claude?.installCommand).toContain('@anthropic-ai/claude-code');

    const codex = resolveKnownAgentInstallGuide(makeAgent({ name: 'Codex CLI', backend: 'codex', command: 'codex' }));
    expect(codex?.installCommand).toContain('@openai/codex');

    const kimi = resolveKnownAgentInstallGuide(makeAgent({ name: 'Kimi', backend: 'kimi', command: 'kimi' }));
    expect(kimi?.installCommand).toContain('kimi-cli');
  });

  it('builds structured install and auth walkthrough prompts without guessing unknown commands', () => {
    const installPrompt = buildAgentInstallButlerPrompt(makeAgent({}), 'install');
    expect(installPrompt).toContain('npm install -g @anthropic-ai/claude-code');
    expect(installPrompt).toContain('征得我确认后再代为执行安装');

    const authPrompt = buildAgentInstallButlerPrompt(makeAgent({}), 'auth');
    expect(authPrompt).toContain('claude auth login');
    expect(authPrompt).toContain('测试连接');

    const unknownPrompt = buildAgentInstallButlerPrompt(
      makeAgent({ name: 'MysteryAgent', backend: 'mystery', agent_type: 'mystery', command: 'mystery-cli' }),
      'install'
    );
    expect(unknownPrompt).toContain('不要猜命令或编造包名');
    expect(unknownPrompt).toContain('mystery-cli');
  });
});

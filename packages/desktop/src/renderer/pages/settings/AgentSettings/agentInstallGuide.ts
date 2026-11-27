/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ManagedAgent } from '@/renderer/utils/model/agentTypes';

interface AgentInstallMeta {
  installCommand: string;
  verifyCommand: string;
  loginCommand?: string;
  notes?: string;
}

const KNOWN_AGENT_INSTALL_GUIDES: Record<string, AgentInstallMeta> = {
  claude: {
    installCommand: 'npm install -g @anthropic-ai/claude-code',
    verifyCommand: 'claude --version',
    loginCommand: 'claude auth login',
    notes: '也可直接在系统环境变量或中转站配置 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL。',
  },
  codex: {
    installCommand: 'npm install -g @openai/codex',
    verifyCommand: 'codex --version',
    loginCommand: 'codex login',
  },
  gemini: {
    installCommand: 'npm install -g @google/gemini-cli',
    verifyCommand: 'gemini --version',
    loginCommand: 'gemini',
  },
  kimi: {
    installCommand: 'uv tool install --python 3.13 kimi-cli',
    verifyCommand: 'kimi --version',
    loginCommand: 'kimi login',
    notes: '若本机尚未安装 uv，可先用 winget install --id=astral-sh.uv -e 或 pipx/pip 安装。',
  },
  qwen: {
    installCommand: 'npm install -g @qwen-code/qwen-code',
    verifyCommand: 'qwen --version',
  },
  copilot: {
    installCommand: 'npm install -g @github/copilot',
    verifyCommand: 'copilot --version',
    loginCommand: 'copilot auth login',
  },
  opencode: {
    installCommand: 'npm install -g opencode-ai',
    verifyCommand: 'opencode --version',
  },
  auggie: {
    installCommand: 'npm install -g @augmentcode/auggie',
    verifyCommand: 'auggie --version',
  },
  codebuddy: {
    installCommand: 'npm install -g @tencent-ai/codebuddy-code',
    verifyCommand: 'codebuddy --version',
  },
  amp: {
    installCommand: 'npm install -g @sourcegraph/amp',
    verifyCommand: 'amp --version',
  },
};

export function resolveKnownAgentInstallGuide(agent: Pick<ManagedAgent, 'backend' | 'agent_type' | 'command' | 'name'>): AgentInstallMeta | null {
  const keys = [agent.backend, agent.agent_type, agent.command, agent.name]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map((v) => v.trim().toLowerCase());

  for (const k of keys) {
    if (KNOWN_AGENT_INSTALL_GUIDES[k]) {
      return KNOWN_AGENT_INSTALL_GUIDES[k];
    }
  }
  return null;
}

/**
 * Generates a structured walkthrough prompt for AionUi 管家 so clicking "管家帮装" / "管家帮登录"
 * immediately guides the user through environment checks, user-confirmed installation, and verification.
 */
export function buildAgentInstallButlerPrompt(agent: ManagedAgent, mode: 'install' | 'auth' = 'install'): string {
  const guide = resolveKnownAgentInstallGuide(agent);
  const expectedCmd = agent.command || agent.backend || agent.name;

  if (mode === 'auth') {
    return [
      `我在【设置 → Agents】中看到外部 Agent「${agent.name}」（命令：\`${expectedCmd}\`）已检测到 CLI，但提示【需登录 / 未鉴权】。`,
      guide?.loginCommand ? `参考登录命令：\`${guide.loginCommand}\`` : '',
      guide?.notes ? `补充说明：${guide.notes}` : '',
      '',
      '请你作为 AionUi 管家，一步一步带我完成登录或 API 配置：',
      '1. 先检查当前 CLI 鉴权状态或环境变量是否完整；',
      '2. 告诉我需要登录或填写的关键项（如有命令需执行，请先说明作用并征得我同意再运行）；',
      '3. 完成后指导我回到【设置 → Agents】点击「测试连接」确认状态变为「可用」。',
    ]
      .filter(Boolean)
      .join('\n');
  }

  return [
    `请帮我在本机（Windows）安装并配置外部 Agent「${agent.name}」（预期命令：\`${expectedCmd}\`）。`,
    guide
      ? `已知参考安装命令：\`${guide.installCommand}\`，验证命令：\`${guide.verifyCommand}\`${guide.loginCommand ? `，登录命令：\`${guide.loginCommand}\`` : ''}。${guide.notes ? `\n备注：${guide.notes}` : ''}`
      : `请先核查「${agent.name}」的官方安装文档与适配 Windows 的安装命令（不要猜命令或编造包名）。`,
    '',
    '请按以下步骤逐项带我完成：',
    '1. 先检查我当前电脑的前置环境（如 Node.js / npm / Python / uv 与 PATH），确认是否具备安装条件；',
    '2. 明确列出将要执行的安装命令和耗时/网络注意事项，征得我确认后再代为执行安装（或给出一步步可执行方案）；',
    `3. 安装完成后运行验证命令（确认 \`${expectedCmd}\` 可在终端正常唤起）并提醒如何登录/填 Key；`,
    '4. 提醒我回到【设置 → Agents】点击「测试连接」刷新状态。',
  ]
    .filter(Boolean)
    .join('\n');
}

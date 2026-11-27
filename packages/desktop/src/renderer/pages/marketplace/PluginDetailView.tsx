/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Input, Message, Modal, Spin, Switch, Tag } from '@arco-design/web-react';
import { mutate } from 'swr';
import { ipcBridge } from '@/common';
import type { IMcpServer, IMcpServerTransport, IMcpTool } from '@/common/config/storage';
import type {
  MarketplaceMcpItem,
  MarketplaceSkillItem,
  PluginDetailResult,
  RuntimeEnvironmentReport,
} from '@/common/types/ecosystem';
import type { Assistant } from '@/common/types/agent/assistantTypes';
import MarkdownView from '@/renderer/components/Markdown';
import { openExternalUrl } from '@/renderer/utils/platform';

export interface SelectedMcpPluginTarget {
  kind: 'mcp';
  name: string;
  title: string;
  description: string;
  category?: string;
  author?: string;
  version?: string;
  source?: string;
  repositoryUrl?: string;
  stars?: number;
  downloads?: number;
  catalogItem?: MarketplaceMcpItem;
  installedServer?: IMcpServer;
  hasUpdate?: boolean;
  remoteVersion?: string;
}

export interface SelectedSkillPluginTarget {
  kind: 'skill';
  name: string;
  description: string;
  category?: string;
  author?: string;
  version?: string;
  source?: string;
  repositoryUrl?: string;
  repo?: string;
  skillId?: string;
  rawPath?: string;
  stars?: number;
  installs?: number;
  catalogItem?: MarketplaceSkillItem;
  isInstalled: boolean;
  hasUpdate?: boolean;
}

export type SelectedPluginTarget = SelectedMcpPluginTarget | SelectedSkillPluginTarget;

interface PluginDetailViewProps {
  plugin: SelectedPluginTarget;
  runtimeReport: RuntimeEnvironmentReport | null;
  onBack: () => void;
  onRefresh: () => Promise<void>;
  onInstallRuntimeUv?: () => Promise<void>;
  installingUv?: boolean;
}

interface ExtraEnvPair {
  key: string;
  value: string;
}

function formatCompactCount(num: number): string {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}m`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`;
  return String(num);
}

function deriveInitialFieldValues(
  catalogItem?: MarketplaceMcpItem,
  installedServer?: IMcpServer
): Record<string, string> {
  const result: Record<string, string> = {};
  const fields = catalogItem?.configFields || [];
  const transport = installedServer?.transport ?? catalogItem?.transport;

  for (const field of fields) {
    let resolved = field.defaultValue || '';
    if (transport) {
      if (field.target === 'arg' && transport.type === 'stdio' && typeof field.argIndex === 'number') {
        resolved = transport.args?.[field.argIndex] ?? resolved;
      } else if (field.target === 'header' && transport.type !== 'stdio') {
        const headerName = field.headerName || field.key;
        resolved = transport.headers?.[headerName] ?? resolved;
      } else if (transport.type === 'stdio') {
        resolved = transport.env?.[field.key] ?? resolved;
      }
    }
    result[field.key] = resolved;
  }
  return result;
}

function deriveExtraEnvPairs(
  catalogItem?: MarketplaceMcpItem,
  installedServer?: IMcpServer
): ExtraEnvPair[] {
  const knownKeys = new Set((catalogItem?.configFields || []).map((f) => f.key));
  const transport = installedServer?.transport ?? catalogItem?.transport;
  if (!transport) return [];
  const record = transport.type === 'stdio' ? transport.env || {} : transport.headers || {};
  return Object.entries(record)
    .filter(([k]) => !knownKeys.has(k))
    .map(([key, value]) => ({ key, value: String(value ?? '') }));
}

function buildUpdatedTransport(
  baseTransport: IMcpServerTransport,
  catalogItem: MarketplaceMcpItem | undefined,
  fieldValues: Record<string, string>,
  extraPairs: ExtraEnvPair[],
  remoteUrlInput: string
): IMcpServerTransport {
  const next = structuredClone(baseTransport);
  for (const field of catalogItem?.configFields || []) {
    const val = (fieldValues[field.key] ?? '').trim();
    if (field.target === 'arg' && next.type === 'stdio' && typeof field.argIndex === 'number') {
      const args = [...(next.args || [])];
      if (val) args[field.argIndex] = val;
      next.args = args;
    } else if (field.target === 'header' && next.type !== 'stdio') {
      const hName = field.headerName || field.key;
      const headers = Object.assign({}, next.headers || {});
      if (val) headers[hName] = val;
      else delete headers[hName];
      next.headers = headers;
    } else if (next.type === 'stdio') {
      const env = Object.assign({}, next.env || {});
      if (val) env[field.key] = val;
      else if (field.key in env) env[field.key] = '';
      next.env = env;
    }
  }

  if (next.type === 'stdio') {
    const env = Object.assign({}, next.env || {});
    for (const pair of extraPairs) {
      const k = pair.key.trim();
      if (!k) continue;
      env[k] = pair.value;
    }
    next.env = env;
  } else {
    if (remoteUrlInput.trim()) {
      next.url = remoteUrlInput.trim();
    }
    const headers = Object.assign({}, next.headers || {});
    for (const pair of extraPairs) {
      const k = pair.key.trim();
      if (!k) continue;
      headers[k] = pair.value;
    }
    next.headers = headers;
  }

  return next;
}

const PluginDetailView: React.FC<PluginDetailViewProps> = ({
  plugin,
  runtimeReport,
  onBack,
  onRefresh,
  onInstallRuntimeUv,
  installingUv,
}) => {
  const isMcp = plugin.kind === 'mcp';
  const [details, setDetails] = useState<PluginDetailResult | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);

  const [busyAction, setBusyAction] = useState<'install' | 'save' | 'test' | 'toggle' | 'uninstall' | 'mount' | null>(
    null
  );
  const [testResult, setTestResult] = useState<{
    success: boolean;
    tools: IMcpTool[];
    error?: string;
  } | null>(null);

  const [fieldValues, setFieldValues] = useState<Record<string, string>>(() =>
    isMcp ? deriveInitialFieldValues(plugin.catalogItem, plugin.installedServer) : {}
  );
  const [extraPairs, setExtraPairs] = useState<ExtraEnvPair[]>(() =>
    isMcp ? deriveExtraEnvPairs(plugin.catalogItem, plugin.installedServer) : []
  );
  const [remoteUrlInput, setRemoteUrlInput] = useState<string>(() => {
    if (!isMcp) return '';
    const t = plugin.installedServer?.transport ?? plugin.catalogItem?.transport;
    return t && t.type !== 'stdio' ? t.url : '';
  });

  const [assistants, setAssistants] = useState<Assistant[]>([]);

  useEffect(() => {
    if (!isMcp) return;
    setFieldValues(deriveInitialFieldValues(plugin.catalogItem, plugin.installedServer));
    setExtraPairs(deriveExtraEnvPairs(plugin.catalogItem, plugin.installedServer));
    const t = plugin.installedServer?.transport ?? plugin.catalogItem?.transport;
    setRemoteUrlInput(t && t.type !== 'stdio' ? t.url : '');
    if (plugin.installedServer?.tools && plugin.installedServer.tools.length > 0) {
      setTestResult({
        success: plugin.installedServer.last_test_status !== 'error',
        tools: plugin.installedServer.tools,
      });
    } else {
      setTestResult(null);
    }
  }, [isMcp, plugin]);

  useEffect(() => {
    let cancelled = false;
    setLoadingDetails(true);
    void ipcBridge.ecosystem.getPluginDetails
      .invoke({
        kind: plugin.kind,
        id: isMcp ? plugin.catalogItem?.id || plugin.installedServer?.id || plugin.name : plugin.catalogItem?.id || plugin.name,
        name: plugin.name,
        repo: !isMcp ? plugin.repo || plugin.catalogItem?.repo : undefined,
        skillId: !isMcp ? plugin.skillId || plugin.catalogItem?.skillId : undefined,
        rawPath: !isMcp ? plugin.rawPath || plugin.catalogItem?.rawPath : undefined,
        repositoryUrl: plugin.repositoryUrl,
      })
      .then((res) => {
        if (!cancelled) setDetails(res);
      })
      .catch(() => {
        if (!cancelled) setDetails(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingDetails(false);
      });

    if (!isMcp) {
      void ipcBridge.assistants.list
        .invoke()
        .then((list) => {
          if (!cancelled) setAssistants(list || []);
        })
        .catch(() => {
          if (!cancelled) setAssistants([]);
        });
    }

    return () => {
      cancelled = true;
    };
  }, [plugin, isMcp]);

  const installedServer = isMcp ? plugin.installedServer : undefined;
  const mcpBaseTransport = isMcp ? installedServer?.transport ?? plugin.catalogItem?.transport : undefined;

  const isUvCommand = useMemo(() => {
    if (!mcpBaseTransport || mcpBaseTransport.type !== 'stdio') return false;
    const cmd = (mcpBaseTransport.command || '').toLowerCase();
    return cmd === 'uvx' || cmd === 'uv' || cmd.endsWith('uvx.exe') || cmd.endsWith('uv.exe');
  }, [mcpBaseTransport]);

  const notifySync = useCallback(async () => {
    await Promise.all([
      mutate('/api/mcp/servers'),
      mutate('skills.list'),
      mutate('assistants.list'),
      mutate('agents.boundAssistants.list'),
    ]);
    window.dispatchEvent(new CustomEvent('ethantoken:ecosystem-updated'));
    await onRefresh();
  }, [onRefresh]);

  const handleInstall = async () => {
    setBusyAction('install');
    try {
      if (isMcp) {
        if (!plugin.catalogItem) return;
        for (const f of plugin.catalogItem.configFields || []) {
          if (f.required && !(fieldValues[f.key] || '').trim()) {
            Message.warning(`请先填写必填参数：${f.label}`);
            return;
          }
        }
        const res = await ipcBridge.ecosystem.installMcpFromMarketplace.invoke({
          item: plugin.catalogItem,
          fieldValues,
        });
        if (!res.success) {
          Message.error(res.error || `安装 ${plugin.name} 失败`);
          return;
        }
        Message.success(`已安装并挂载 MCP：${res.name}`);
      } else {
        const repo = plugin.repo || plugin.catalogItem?.repo || '';
        if (!repo) {
          Message.info('该本地技能已存在，无需重复下载');
          return;
        }
        const res = await ipcBridge.ecosystem.installSkillFromMarketplace.invoke({
          repo,
          skillId: plugin.skillId || plugin.catalogItem?.skillId || plugin.name,
          rawPath: plugin.rawPath || plugin.catalogItem?.rawPath,
          customName: plugin.name,
        });
        if (!res.success) {
          Message.error(res.error || `安装 ${plugin.name} 失败`);
          return;
        }
        Message.success(plugin.isInstalled ? `已更新技能：${res.skillName}` : `已安装并挂载技能：${res.skillName}`);
      }
      await notifySync();
    } catch (err) {
      Message.error(err instanceof Error ? err.message : '操作失败');
    } finally {
      setBusyAction(null);
    }
  };

  const handleSaveMcpConfig = async () => {
    if (!isMcp || !installedServer) return;
    setBusyAction('save');
    try {
      const nextTransport = buildUpdatedTransport(
        installedServer.transport,
        plugin.catalogItem,
        fieldValues,
        extraPairs,
        remoteUrlInput
      );
      const originalJson = JSON.stringify(
        {
          mcpServers: {
            [installedServer.name]: nextTransport,
          },
        },
        null,
        2
      );
      await ipcBridge.mcpService.updateServer.invoke({
        id: installedServer.id,
        data: {
          transport: nextTransport,
          original_json: originalJson,
        },
      });
      Message.success('MCP 参数配置已保存');
      await notifySync();
    } catch (err) {
      Message.error(err instanceof Error ? err.message : '保存配置失败');
    } finally {
      setBusyAction(null);
    }
  };

  const handleTestMcp = async () => {
    if (!isMcp || !mcpBaseTransport) return;
    setBusyAction('test');
    try {
      const transportToTest = buildUpdatedTransport(
        mcpBaseTransport,
        plugin.catalogItem,
        fieldValues,
        extraPairs,
        remoteUrlInput
      );
      const now = Date.now();
      const serverPayload: IMcpServer = installedServer
        ? Object.assign({}, installedServer, { transport: transportToTest })
        : {
            id: `preview:${plugin.name}`,
            name: plugin.name,
            description: plugin.description,
            enabled: true,
            transport: transportToTest,
            created_at: now,
            updated_at: now,
            original_json: JSON.stringify({ mcpServers: { [plugin.name]: transportToTest } }, null, 2),
          };
      const res = await ipcBridge.mcpService.testMcpConnection.invoke(serverPayload);
      setTestResult({
        success: res.success,
        tools: res.tools || [],
        error: res.error,
      });
      if (res.success) {
        Message.success(`连接正常，共检测到 ${(res.tools || []).length} 个工具`);
        if (installedServer) await onRefresh();
      } else {
        Message.warning(res.error || 'MCP 连接检测未通过');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '检测失败';
      setTestResult({ success: false, tools: [], error: msg });
      Message.error(msg);
    } finally {
      setBusyAction(null);
    }
  };

  const handleToggleMcp = async () => {
    if (!installedServer) return;
    setBusyAction('toggle');
    try {
      await ipcBridge.mcpService.toggleServer.invoke({ id: installedServer.id });
      await notifySync();
    } catch (err) {
      Message.error(err instanceof Error ? err.message : '切换启用状态失败');
    } finally {
      setBusyAction(null);
    }
  };

  const handleUninstall = () => {
    Modal.confirm({
      title: `卸载 ${isMcp ? plugin.title : plugin.name}`,
      content: '卸载后将从本地移除该插件（不影响对话历史记录），确定继续吗？',
      okText: '确认卸载',
      cancelText: '取消',
      okButtonProps: { status: 'danger' },
      onOk: async () => {
        setBusyAction('uninstall');
        try {
          if (isMcp && installedServer) {
            await ipcBridge.mcpService.deleteServer.invoke({ id: installedServer.id });
          } else if (!isMcp) {
            await ipcBridge.fs.deleteSkill.invoke({ skill_name: plugin.name });
          }
          Message.success(`已卸载 ${plugin.name}`);
          await notifySync();
          onBack();
        } catch (err) {
          Message.error(err instanceof Error ? err.message : '卸载失败');
        } finally {
          setBusyAction(null);
        }
      },
    });
  };

  const handleAttachSkillToAll = async () => {
    setBusyAction('mount');
    try {
      const res = await ipcBridge.ecosystem.attachToAllAssistants.invoke({ skillNames: [plugin.name] });
      Message.success(`已同步挂载到 ${res.updatedAssistants}/${res.totalAssistants} 个助手`);
      const list = await ipcBridge.assistants.list.invoke();
      setAssistants(list || []);
      await notifySync();
    } catch (err) {
      Message.error(err instanceof Error ? err.message : '挂载助手失败');
    } finally {
      setBusyAction(null);
    }
  };

  const copyPrompt = async (prompt: string) => {
    try {
      await navigator.clipboard.writeText(prompt);
      Message.success('已复制示例提示词');
    } catch {
      Message.info(prompt);
    }
  };

  const usageGuide = details?.usageGuide || (isMcp ? plugin.catalogItem?.usageGuide : plugin.catalogItem?.usageGuide);
  const examplePrompts =
    details?.examplePrompts || (isMcp ? plugin.catalogItem?.examplePrompts : plugin.catalogItem?.examplePrompts) || [];

  const titleText = isMcp ? plugin.title || plugin.name : plugin.name;
  const repoUrl = plugin.repositoryUrl;

  const mountedAssistantsCount = useMemo(() => {
    if (isMcp) return 0;
    return assistants.filter(
      (a) => (a.enabled_skills || []).includes(plugin.name) || (a.custom_skill_names || []).includes(plugin.name)
    ).length;
  }, [assistants, isMcp, plugin.name]);

  return (
    <div className='w-full h-full min-h-0 flex flex-col bg-1 overflow-hidden'>
      <div className='shrink-0 px-16px py-14px md:px-36px border-b border-solid border-[var(--color-border-2)] border-x-0 border-t-0 bg-1'>
        <div className='mx-auto w-full max-w-1040px flex items-center justify-between gap-12px'>
          <button
            type='button'
            onClick={onBack}
            className='px-10px py-5px rd-8px bg-transparent hover:bg-fill-2 border-none text-13px font-500 text-t-secondary hover:text-t-primary cursor-pointer flex items-center gap-6px'
          >
            <span>←</span>
            <span>返回插件市场</span>
          </button>

          {repoUrl && (
            <button
              type='button'
              onClick={() => void openExternalUrl(repoUrl)}
              className='px-10px py-5px rd-8px bg-base border border-solid border-[var(--color-border-2)] text-12px text-t-secondary hover:text-t-primary cursor-pointer'
            >
              查看源码仓库 ↗
            </button>
          )}
        </div>
      </div>

      <div className='min-h-0 flex-1 overflow-y-auto overscroll-contain px-16px py-20px md:px-36px'>
        <div className='mx-auto w-full max-w-1040px flex flex-col gap-16px select-text'>
          {/* Header summary card */}
          <div className='p-20px rd-14px bg-base border border-solid border-[var(--color-border-2)] flex flex-col md:flex-row md:items-start justify-between gap-16px'>
            <div className='min-w-0 flex-1'>
              <div className='flex items-center gap-10px flex-wrap'>
                <h2 className='m-0 text-20px font-600 text-t-primary'>{titleText}</h2>
                {plugin.version && <Tag size='small'>v{plugin.version}</Tag>}
                <Tag size='small' color='arcoblue'>
                  {isMcp ? 'MCP 工具' : 'Skill 技能'}
                </Tag>
                {plugin.category && <Tag size='small'>{plugin.category}</Tag>}
                {isMcp && installedServer && (
                  <Tag
                    size='small'
                    color={
                      installedServer.last_test_status === 'connected'
                        ? 'green'
                        : installedServer.last_test_status === 'error'
                          ? 'red'
                          : installedServer.enabled
                            ? 'green'
                            : 'gray'
                    }
                  >
                    {installedServer.last_test_status === 'connected'
                      ? '运行中'
                      : installedServer.last_test_status === 'error'
                        ? '检测异常'
                        : installedServer.enabled
                          ? '已启用'
                          : '已停用'}
                  </Tag>
                )}
              </div>

              <div className='mt-6px flex items-center gap-12px text-12px text-t-tertiary flex-wrap'>
                <span className='font-mono'>{plugin.name}</span>
                {plugin.author && <span>作者：{plugin.author}</span>}
                {typeof plugin.stars === 'number' && <span>★ {formatCompactCount(plugin.stars)}</span>}
                {typeof (isMcp ? plugin.downloads : plugin.installs) === 'number' && (
                  <span>↓ {formatCompactCount((isMcp ? plugin.downloads : plugin.installs) || 0)}</span>
                )}
              </div>

              <p className='m-0 mt-10px text-13.5px text-t-secondary leading-relaxed'>{plugin.description}</p>
            </div>

            <div className='flex items-center gap-10px shrink-0 flex-wrap'>
              {isMcp ? (
                installedServer ? (
                  <>
                    {plugin.hasUpdate && plugin.catalogItem && (
                      <Button
                        type='primary'
                        status='success'
                        loading={busyAction === 'install'}
                        onClick={() => void handleInstall()}
                      >
                        {plugin.remoteVersion ? `更新到 v${plugin.remoteVersion}` : '更新'}
                      </Button>
                    )}
                    <div className='flex items-center gap-6px px-10px py-4px rd-999px bg-fill-1 border border-solid border-[var(--color-border-2)]'>
                      <span className='text-12px text-t-secondary'>{installedServer.enabled ? '已启用' : '已停用'}</span>
                      <Switch
                        size='small'
                        checked={installedServer.enabled}
                        loading={busyAction === 'toggle'}
                        onChange={() => void handleToggleMcp()}
                      />
                    </div>
                    {!installedServer.builtin && (
                      <Button status='danger' loading={busyAction === 'uninstall'} onClick={handleUninstall}>
                        卸载
                      </Button>
                    )}
                  </>
                ) : (
                  <Button type='primary' loading={busyAction === 'install'} onClick={() => void handleInstall()}>
                    一键安装
                  </Button>
                )
              ) : plugin.isInstalled ? (
                <>
                  {plugin.hasUpdate && (
                    <Button
                      type='primary'
                      status='success'
                      loading={busyAction === 'install'}
                      onClick={() => void handleInstall()}
                    >
                      更新到新版
                    </Button>
                  )}
                  <Button loading={busyAction === 'mount'} onClick={() => void handleAttachSkillToAll()}>
                    挂载全助手
                  </Button>
                  <Button status='danger' loading={busyAction === 'uninstall'} onClick={handleUninstall}>
                    卸载
                  </Button>
                </>
              ) : (
                <Button type='primary' loading={busyAction === 'install'} onClick={() => void handleInstall()}>
                  一键安装
                </Button>
              )}
            </div>
          </div>

          {/* Usage guide & prompt chips */}
          {(usageGuide || examplePrompts.length > 0) && (
            <div className='p-18px rd-14px bg-base border border-solid border-[var(--color-border-2)] flex flex-col gap-12px'>
              <div className='text-14px font-600 text-t-primary'>快速上手</div>
              {usageGuide && <p className='m-0 text-13px text-t-secondary leading-relaxed'>{usageGuide}</p>}
              {examplePrompts.length > 0 && (
                <div className='flex flex-col gap-6px'>
                  <div className='text-12px font-500 text-t-tertiary'>推荐示例提问（点击复制）：</div>
                  <div className='flex flex-col gap-6px'>
                    {examplePrompts.map((prompt) => (
                      <button
                        key={prompt}
                        type='button'
                        onClick={() => void copyPrompt(prompt)}
                        className='text-left px-12px py-8px rd-8px bg-fill-1 hover:bg-fill-2 border border-solid border-[var(--color-border-2)] text-12.5px text-t-primary cursor-pointer flex items-center justify-between gap-10px'
                      >
                        <span className='truncate'>{prompt}</span>
                        <span className='text-11px text-t-tertiary shrink-0'>复制</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* MCP configuration + live diagnostics panel */}
          {isMcp && mcpBaseTransport && (
            <div className='p-18px rd-14px bg-base border border-solid border-[var(--color-border-2)] flex flex-col gap-14px'>
              <div className='flex items-center justify-between gap-10px flex-wrap'>
                <div>
                  <div className='text-14px font-600 text-t-primary'>配置与运行诊断</div>
                  <div className='mt-2px text-12px text-t-tertiary font-mono'>
                    {mcpBaseTransport.type === 'stdio'
                      ? `${mcpBaseTransport.command} ${(mcpBaseTransport.args || []).join(' ')}`
                      : `${mcpBaseTransport.type.toUpperCase()} · ${remoteUrlInput || mcpBaseTransport.url}`}
                  </div>
                </div>

                <div className='flex items-center gap-8px'>
                  {installedServer && (
                    <Button type='outline' loading={busyAction === 'save'} onClick={() => void handleSaveMcpConfig()}>
                      保存配置
                    </Button>
                  )}
                  <Button type='primary' loading={busyAction === 'test'} onClick={() => void handleTestMcp()}>
                    检测运行状态
                  </Button>
                </div>
              </div>

              {isUvCommand && runtimeReport && !runtimeReport.uvx.available && (
                <div className='px-12px py-10px rd-10px bg-[#f59e0b]/10 border border-solid border-[#f59e0b]/30 flex items-center justify-between gap-10px flex-wrap'>
                  <span className='text-12.5px text-t-primary'>
                    此 MCP 依赖 Python `uvx` 运行环境，当前本机尚未安装，点击右侧即可全自动静默安装。
                  </span>
                  {onInstallRuntimeUv && (
                    <Button size='small' type='primary' loading={installingUv} onClick={() => void onInstallRuntimeUv()}>
                      一键安装 uv
                    </Button>
                  )}
                </div>
              )}

              {/* Remote URL input */}
              {mcpBaseTransport.type !== 'stdio' && (
                <div>
                  <div className='text-12px font-500 text-t-secondary mb-4px'>服务端点 URL</div>
                  <Input
                    value={remoteUrlInput}
                    onChange={setRemoteUrlInput}
                    placeholder='https://...'
                  />
                </div>
              )}

              {/* Curated configFields */}
              {(plugin.catalogItem?.configFields || []).length > 0 && (
                <div className='grid grid-cols-1 md:grid-cols-2 gap-12px'>
                  {(plugin.catalogItem?.configFields || []).map((field) => (
                    <div key={field.key}>
                      <div className='text-12px font-500 text-t-primary mb-4px'>
                        {field.label}
                        {field.required && <span className='text-[#ef4444] ml-4px'>*</span>}
                      </div>
                      <Input
                        type={field.secret ? 'password' : 'text'}
                        value={fieldValues[field.key] ?? ''}
                        placeholder={field.placeholder}
                        onChange={(val) => setFieldValues((prev) => ({ ...prev, [field.key]: val }))}
                      />
                    </div>
                  ))}
                </div>
              )}

              {/* Generic env/headers pairs for any MCP */}
              <div className='flex flex-col gap-8px'>
                <div className='flex items-center justify-between'>
                  <span className='text-12px font-500 text-t-secondary'>
                    {mcpBaseTransport.type === 'stdio' ? '环境变量（ENV）' : '请求头（Headers）'}
                  </span>
                  <button
                    type='button'
                    onClick={() => setExtraPairs((prev) => [...prev, { key: '', value: '' }])}
                    className='px-8px py-2px rd-6px bg-fill-1 hover:bg-fill-2 border border-solid border-[var(--color-border-2)] text-11.5px text-t-secondary cursor-pointer'
                  >
                    + 添加变量
                  </button>
                </div>
                {extraPairs.length > 0 && (
                  <div className='flex flex-col gap-8px'>
                    {extraPairs.map((pair, idx) => (
                      <div key={idx} className='flex items-center gap-8px'>
                        <Input
                          value={pair.key}
                          placeholder='KEY_NAME'
                          style={{ width: 220 }}
                          onChange={(val) =>
                            setExtraPairs((prev) => prev.map((p, i) => (i === idx ? { ...p, key: val } : p)))
                          }
                        />
                        <Input
                          value={pair.value}
                          placeholder='值'
                          onChange={(val) =>
                            setExtraPairs((prev) => prev.map((p, i) => (i === idx ? { ...p, value: val } : p)))
                          }
                        />
                        <Button
                          size='small'
                          onClick={() => setExtraPairs((prev) => prev.filter((_, i) => i !== idx))}
                        >
                          删除
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Live connection test result + discovered tools */}
              {testResult && (
                <div
                  className={`p-12px rd-10px border border-solid ${
                    testResult.success
                      ? 'bg-[#15803d]/5 border-[#15803d]/30'
                      : 'bg-[#ef4444]/5 border-[#ef4444]/30'
                  }`}
                >
                  <div className='flex items-center justify-between gap-8px'>
                    <span
                      className={`text-12.5px font-600 ${
                        testResult.success ? 'text-[#15803d] dark:text-[#34d399]' : 'text-[#dc2626]'
                      }`}
                    >
                      {testResult.success
                        ? `● 连接健康，共暴露 ${testResult.tools.length} 个 MCP 工具`
                        : `● 连接失败：${testResult.error || '未知错误'}`}
                    </span>
                  </div>
                  {testResult.tools.length > 0 && (
                    <div className='mt-10px grid grid-cols-1 md:grid-cols-2 gap-8px'>
                      {testResult.tools.map((tool) => (
                        <div
                          key={tool.name}
                          className='p-8px rd-8px bg-1 border border-solid border-[var(--color-border-2)]'
                        >
                          <div className='text-12px font-600 font-mono text-t-primary'>{tool.name}</div>
                          {tool.description && (
                            <div className='mt-2px text-11.5px text-t-secondary line-clamp-2'>{tool.description}</div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Skill assistant mounting overview */}
          {!isMcp && plugin.isInstalled && (
            <div className='p-18px rd-14px bg-base border border-solid border-[var(--color-border-2)] flex flex-col gap-10px'>
              <div className='flex items-center justify-between gap-10px'>
                <div className='text-14px font-600 text-t-primary'>
                  助手挂载状态（已挂载 {mountedAssistantsCount} / {assistants.length} 个助手）
                </div>
                <Button size='small' loading={busyAction === 'mount'} onClick={() => void handleAttachSkillToAll()}>
                  全部挂载
                </Button>
              </div>
              {assistants.length > 0 && (
                <div className='flex items-center gap-6px flex-wrap'>
                  {assistants.map((a) => {
                    const active =
                      (a.enabled_skills || []).includes(plugin.name) ||
                      (a.custom_skill_names || []).includes(plugin.name);
                    return (
                      <Tag key={a.id} size='small' color={active ? 'green' : 'gray'}>
                        {active ? '✓ ' : ''}
                        {a.name_i18n?.['zh-CN'] || a.name}
                      </Tag>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Full README / SKILL.md Viewer */}
          <div className='p-18px rd-14px bg-base border border-solid border-[var(--color-border-2)] flex flex-col gap-10px'>
            <div className='flex items-center justify-between'>
              <span className='text-14px font-600 text-t-primary'>
                {isMcp ? '官方说明文档（README）' : '技能说明书（SKILL.md）'}
              </span>
              {details?.resolvedFrom && (
                <span className='text-11px text-t-tertiary'>
                  来源：
                  {details.resolvedFrom === 'local-skill'
                    ? '本地已安装 SKILL.md'
                    : details.resolvedFrom === 'github-skill'
                      ? 'GitHub SKILL.md'
                      : details.resolvedFrom === 'github-readme'
                        ? 'GitHub README.md'
                        : '内置说明'}
                </span>
              )}
            </div>
            {loadingDetails ? (
              <div className='py-32px flex items-center justify-center'>
                <Spin size={22} />
              </div>
            ) : details?.readmeMarkdown ? (
              <div className='text-13px leading-relaxed overflow-x-auto'>
                <MarkdownView>{details.readmeMarkdown}</MarkdownView>
              </div>
            ) : (
              <div className='text-12.5px text-t-tertiary py-12px'>暂无扩展文档内容。</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default PluginDetailView;

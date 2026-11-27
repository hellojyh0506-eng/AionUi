/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Checkbox, Input, Message, Modal, Select, Spin, Switch } from '@arco-design/web-react';
import { mutate } from 'swr';
import { ipcBridge } from '@/common';
import type {
  ClientScanReport,
  EcosystemClientId,
  GlobalMemoryState,
  MigrationImportResult,
} from '@/common/types/ecosystem';

interface MigrationModalProps {
  visible: boolean;
  isOnboarding?: boolean;
  onClose: () => void;
  onImported?: (result: MigrationImportResult) => void;
}

type MigrationTab = 'simple' | 'advanced' | 'memory';
type AdvancedSection = 'mcps' | 'skills' | 'rules';

const MEMORY_EXPORT_PROMPT = `请结合你对我的长期记忆（User Profile / Memory）、User Rules 以及平时交流习惯，输出一份简洁的「个人协作画像（Markdown）」，只需包含：
1）我的说话风格与简短指令习惯（我只说几个字时通常想让你做什么、不要问哪些废话）
2）我常用的技术栈、语言与开发运行环境
3）我明确反感或反复纠正过你的行为
4）当前长期在做的核心项目背景
控制在 600 字以内，直接给正文，不要客套。`;

function toggleSelectionId(setter: React.Dispatch<React.SetStateAction<Set<string>>>, id: string): void {
  setter((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
}

function toggleSelectionGroup(
  setter: React.Dispatch<React.SetStateAction<Set<string>>>,
  visibleIds: string[],
  selectedSet: Set<string>
): void {
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedSet.has(id));
  setter((prev) => {
    const next = new Set(prev);
    if (allSelected) {
      visibleIds.forEach((id) => next.delete(id));
    } else {
      visibleIds.forEach((id) => next.add(id));
    }
    return next;
  });
}

const MigrationModal: React.FC<MigrationModalProps> = ({
  visible,
  isOnboarding = false,
  onClose,
  onImported,
}) => {
  const [activeTab, setActiveTab] = useState<MigrationTab>('simple');
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [report, setReport] = useState<ClientScanReport | null>(null);

  // Simple mode state: select detected clients directly.
  const [selectedClientIds, setSelectedClientIds] = useState<Set<EcosystemClientId>>(new Set());

  // Advanced mode state: search & cherry-pick items.
  const [advSection, setAdvSection] = useState<AdvancedSection>('mcps');
  const [advClient, setAdvClient] = useState<'all' | EcosystemClientId>('all');
  const [advKeyword, setAdvKeyword] = useState('');
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(new Set());
  const [selectedMcpIds, setSelectedMcpIds] = useState<Set<string>>(new Set());
  const [selectedRuleIds, setSelectedRuleIds] = useState<Set<string>>(new Set());

  const [extraMemoryText, setExtraMemoryText] = useState('');
  const [syncAssistant, setSyncAssistant] = useState(true);
  const [memoryState, setMemoryState] = useState<GlobalMemoryState | null>(null);
  const [memoryDraft, setMemoryDraft] = useState('');
  const [savingMemory, setSavingMemory] = useState(false);

  const runScan = useCallback(async () => {
    setScanning(true);
    try {
      const res = await ipcBridge.ecosystem.scanClients.invoke();
      setReport(res);
      const clientsWithData = res.clients.filter(
        (c) => c.detected && (c.skillCount > 0 || c.mcpCount > 0 || c.ruleCount > 0)
      );
      setSelectedClientIds((prev) => {
        if (prev.size > 0) return prev;
        // Pre-select up to top 2 non-generic detected clients on first open for convenience.
        const preferred = clientsWithData
          .filter((c) => c.clientId !== 'other-agents')
          .slice(0, 2)
          .map((c) => c.clientId);
        return new Set(preferred.length > 0 ? preferred : clientsWithData.slice(0, 1).map((c) => c.clientId));
      });

      const pendingSkills = res.skills.filter((s) => !s.installed);
      setSelectedSkillIds(pendingSkills.length <= 30 ? new Set(pendingSkills.map((s) => s.id)) : new Set());
      setSelectedMcpIds(new Set(res.mcps.filter((m) => !m.installed).map((m) => m.id)));
      setSelectedRuleIds(res.rules.length <= 12 ? new Set(res.rules.map((r) => r.id)) : new Set());
    } catch (err) {
      Message.error(err instanceof Error ? err.message : '扫描本机客户端失败');
    } finally {
      setScanning(false);
    }
  }, []);

  const loadMemory = useCallback(async () => {
    try {
      const state = await ipcBridge.ecosystem.getGlobalMemory.invoke();
      setMemoryState(state);
      setMemoryDraft(state.content || '');
    } catch {
      // ignore initial load error
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    void runScan();
    void loadMemory();
  }, [visible, runScan, loadMemory]);

  const detectedClients = useMemo(
    () =>
      (report?.clients || []).filter(
        (c) => c.detected && (c.skillCount > 0 || c.mcpCount > 0 || c.ruleCount > 0)
      ),
    [report]
  );

  const hasTraeSelected = selectedClientIds.has('trae-cn') || selectedClientIds.has('trae');

  const advKw = advKeyword.trim().toLowerCase();

  const filteredAdvMcps = useMemo(() => {
    return (report?.mcps || []).filter((m) => {
      if (advClient !== 'all' && m.clientId !== advClient) return false;
      if (!advKw) return true;
      return (
        m.name.toLowerCase().includes(advKw) ||
        m.clientName.toLowerCase().includes(advKw) ||
        m.preview.toLowerCase().includes(advKw)
      );
    });
  }, [report, advClient, advKw]);

  const filteredAdvSkills = useMemo(() => {
    return (report?.skills || []).filter((s) => {
      if (advClient !== 'all' && s.clientId !== advClient) return false;
      if (!advKw) return true;
      return (
        s.name.toLowerCase().includes(advKw) ||
        s.description.toLowerCase().includes(advKw) ||
        s.clientName.toLowerCase().includes(advKw)
      );
    });
  }, [report, advClient, advKw]);

  const filteredAdvRules = useMemo(() => {
    return (report?.rules || []).filter((r) => {
      if (advClient !== 'all' && r.clientId !== advClient) return false;
      if (!advKw) return true;
      return (
        r.title.toLowerCase().includes(advKw) ||
        r.content.toLowerCase().includes(advKw) ||
        r.clientName.toLowerCase().includes(advKw)
      );
    });
  }, [report, advClient, advKw]);

  const toggleClientCard = (clientId: EcosystemClientId) => {
    setSelectedClientIds((prev) => {
      const next = new Set(prev);
      if (next.has(clientId)) next.delete(clientId);
      else next.add(clientId);
      return next;
    });
  };

  const handleSimpleImport = async () => {
    if (selectedClientIds.size === 0 && !extraMemoryText.trim()) {
      Message.info('请先选择至少一个以前用过的客户端');
      return;
    }
    setImporting(true);
    try {
      const res = await ipcBridge.ecosystem.importScannedItems.invoke({
        clientIds: Array.from(selectedClientIds),
        extraMemoryText: extraMemoryText.trim() || undefined,
        syncAssistant,
      });

      await Promise.all([
        mutate('/api/mcp/servers'),
        mutate('assistants.list'),
        mutate('agents.boundAssistants.list'),
        mutate('skills.list'),
      ]);
      window.dispatchEvent(new CustomEvent('ethantoken:ecosystem-updated'));

      const parts: string[] = [];
      if (res.mcpsImported > 0) parts.push(`工具 ${res.mcpsImported} 个`);
      if (res.skillsImported > 0) parts.push(`技能 ${res.skillsImported} 个`);
      if (res.rulesMerged > 0) parts.push(`记忆与规则 ${res.rulesMerged} 项`);
      const dedupTotal = res.deduplicatedSkills + res.deduplicatedMcps + res.deduplicatedRules;
      const dedupNote = dedupTotal > 0 ? `（已自动合并去重 ${dedupTotal} 项重复配置）` : '';

      if (parts.length > 0) {
        Message.success(`迁移完成：${parts.join(' · ')}${dedupNote}`);
      } else {
        Message.info(`所选配置已全部在当前客户端中${dedupNote}`);
      }

      if (res.skillsFailed.length + res.mcpsFailed.length > 0) {
        const firstErr = res.skillsFailed[0] || res.mcpsFailed[0];
        Message.warning(`部分项未导入成功：${firstErr.name} (${firstErr.reason})`);
      }

      setExtraMemoryText('');
      onImported?.(res);
      await runScan();
      await loadMemory();
      if (isOnboarding) onClose();
    } catch (err) {
      Message.error(err instanceof Error ? err.message : '迁移失败');
    } finally {
      setImporting(false);
    }
  };

  const totalAdvancedSelected =
    selectedMcpIds.size + selectedSkillIds.size + selectedRuleIds.size + (extraMemoryText.trim() ? 1 : 0);

  const handleAdvancedImport = async () => {
    if (totalAdvancedSelected === 0) {
      Message.info('请先勾选需要导入的项目');
      return;
    }
    setImporting(true);
    try {
      const res = await ipcBridge.ecosystem.importScannedItems.invoke({
        skillIds: Array.from(selectedSkillIds),
        mcpIds: Array.from(selectedMcpIds),
        ruleIds: Array.from(selectedRuleIds),
        extraMemoryText: extraMemoryText.trim() || undefined,
        syncAssistant,
      });

      await Promise.all([
        mutate('/api/mcp/servers'),
        mutate('assistants.list'),
        mutate('agents.boundAssistants.list'),
        mutate('skills.list'),
      ]);
      window.dispatchEvent(new CustomEvent('ethantoken:ecosystem-updated'));

      const parts: string[] = [];
      if (res.mcpsImported > 0) parts.push(`MCP ${res.mcpsImported} 个`);
      if (res.skillsImported > 0) parts.push(`技能 ${res.skillsImported} 个`);
      if (res.rulesMerged > 0) parts.push(`规则/记忆 ${res.rulesMerged} 项`);
      Message.success(parts.length > 0 ? `已导入 ${parts.join(' · ')}` : '所选项已存在或无需变更');

      setExtraMemoryText('');
      onImported?.(res);
      await runScan();
      await loadMemory();
    } catch (err) {
      Message.error(err instanceof Error ? err.message : '导入失败');
    } finally {
      setImporting(false);
    }
  };

  const handleSaveGlobalMemory = async () => {
    setSavingMemory(true);
    try {
      const res = await ipcBridge.ecosystem.saveGlobalMemory.invoke({
        content: memoryDraft,
        syncAssistant,
      });
      setMemoryState(res);
      await Promise.all([mutate('assistants.list'), mutate('agents.boundAssistants.list'), mutate('skills.list')]);
      window.dispatchEvent(new CustomEvent('ethantoken:ecosystem-updated'));
      Message.success(res.assistantSynced ? '已保存全局记忆并同步「我的个人习惯」助手' : '已保存全局持久记忆');
    } catch (err) {
      Message.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSavingMemory(false);
    }
  };

  const handleCopyPrompt = () => {
    void navigator.clipboard?.writeText(MEMORY_EXPORT_PROMPT);
    Message.success('已复制记忆提取提示词，发送给 Trae / WorkBuddy / Cursor 后将结果粘回来即可');
  };

  return (
    <Modal
      title={null}
      visible={visible}
      onCancel={onClose}
      footer={null}
      style={{ width: 720, maxWidth: '94vw', borderRadius: 18 }}
    >
      {/* Fixed height container prevents dialog jumping across tabs and filters */}
      <div className='box-border flex flex-col text-t-primary select-none' style={{ height: 550 }}>
        {/* Fixed Header */}
        <div className='shrink-0 pb-12px border-b border-solid border-[var(--color-border-2)] border-x-0 border-t-0 flex items-center justify-between gap-12px flex-wrap'>
          <div>
            <h3 className='m-0 text-17px font-600 text-t-primary'>
              {isOnboarding ? '欢迎使用 · 一键带走旧工具习惯' : '从其他编程客户端迁移'}
            </h3>
            <p className='m-0 mt-3px text-12px text-t-tertiary'>
              自动识别本机已装 AI 工具的记忆偏好、MCP 工具与技能包，仅只读拷贝，不修改原软件。
            </p>
          </div>

          <div className='inline-flex p-2px rd-999px bg-fill-2 border border-solid border-[var(--color-border-2)] shrink-0'>
            <button
              type='button'
              onClick={() => setActiveTab('simple')}
              className={`px-12px py-5px b-none rd-999px text-12px font-500 cursor-pointer transition-colors ${
                activeTab === 'simple'
                  ? 'bg-[var(--color-bg-popup)] text-t-primary shadow-sm'
                  : 'bg-transparent text-t-secondary hover:text-t-primary'
              }`}
            >
              一键迁移
            </button>
            <button
              type='button'
              onClick={() => setActiveTab('advanced')}
              className={`px-12px py-5px b-none rd-999px text-12px font-500 cursor-pointer transition-colors ${
                activeTab === 'advanced'
                  ? 'bg-[var(--color-bg-popup)] text-t-primary shadow-sm'
                  : 'bg-transparent text-t-secondary hover:text-t-primary'
              }`}
            >
              高级自选
            </button>
            <button
              type='button'
              onClick={() => setActiveTab('memory')}
              className={`px-12px py-5px b-none rd-999px text-12px font-500 cursor-pointer transition-colors ${
                activeTab === 'memory'
                  ? 'bg-[var(--color-bg-popup)] text-t-primary shadow-sm'
                  : 'bg-transparent text-t-secondary hover:text-t-primary'
              }`}
            >
              全局记忆
            </button>
          </div>
        </div>

        {/* Fixed-flex Middle Scroll Area */}
        <div className='flex-1 min-h-0 overflow-y-auto py-12px pr-4px box-border'>
          {activeTab === 'simple' ? (
            scanning && !report ? (
              <div className='h-full flex items-center justify-center'>
                <Spin size={24} />
              </div>
            ) : (
              <div className='flex flex-col gap-12px'>
                <div className='flex items-center justify-between gap-8px'>
                  <span className='text-12.5px font-500 text-t-secondary'>
                    勾选你平时在用的客户端（可多选，重复工具与相似规则会自动合并去重）：
                  </span>
                  <button
                    type='button'
                    disabled={scanning}
                    onClick={() => void runScan()}
                    className='h-26px px-10px rd-999px bg-transparent border border-solid border-[var(--color-border-2)] text-11.5px text-t-secondary hover:text-t-primary cursor-pointer shrink-0'
                  >
                    {scanning ? '扫描中...' : '重新检测'}
                  </button>
                </div>

                {detectedClients.length === 0 ? (
                  <div className='py-36px px-16px rd-12px border border-dashed border-[var(--color-border-2)] text-center text-12.5px text-t-tertiary'>
                    暂未检测到其他客户端的本地配置；你可以直接点上方「全局记忆」粘贴个人习惯。
                  </div>
                ) : (
                  <div className='grid grid-cols-1 sm:grid-cols-2 gap-10px'>
                    {detectedClients.map((c) => {
                      const checked = selectedClientIds.has(c.clientId);
                      const summaryParts: string[] = [];
                      if (c.ruleCount > 0) summaryParts.push(`${c.ruleCount} 份记忆/规则`);
                      if (c.mcpCount > 0) summaryParts.push(`${c.mcpCount} 个工具`);
                      if (c.skillCount > 0) summaryParts.push(`${c.skillCount} 个技能`);

                      return (
                        <div
                          key={c.clientId}
                          onClick={() => toggleClientCard(c.clientId)}
                          className={`box-border p-12px rd-12px border border-solid cursor-pointer transition-colors flex items-start justify-between gap-10px ${
                            checked
                              ? 'border-[var(--color-text-1)] bg-fill-2'
                              : 'border-[var(--color-border-2)] bg-fill-1 hover:bg-fill-2'
                          }`}
                        >
                          <div className='min-w-0 flex-1'>
                            <div className='text-13.5px font-600 text-t-primary'>{c.clientName}</div>
                            <div className='mt-4px text-12px text-t-secondary'>
                              {summaryParts.join(' · ') || '已检测到配置目录'}
                            </div>
                          </div>
                          <Checkbox
                            checked={checked}
                            onChange={() => toggleClientCard(c.clientId)}
                            onClick={(e) => e.stopPropagation()}
                          />
                        </div>
                      );
                    })}
                  </div>
                )}

                {hasTraeSelected && (
                  <div className='box-border p-10px rd-10px bg-fill-1 border border-solid border-[var(--color-border-2)] flex items-center justify-between gap-10px flex-wrap'>
                    <span className='text-12px text-t-secondary flex-1 min-w-220px'>
                      提示：最新版 Trae CN 的对话记忆存在云端/加密库中，建议顺手在 Trae 导出一次习惯总结粘到下方。
                    </span>
                    <button
                      type='button'
                      onClick={handleCopyPrompt}
                      className='h-26px px-10px rd-999px bg-[var(--color-bg-popup)] border border-solid border-[var(--color-border-3)] text-11.5px font-500 text-t-primary hover:bg-fill-2 cursor-pointer shrink-0'
                    >
                      复制 Trae 提取口令
                    </button>
                  </div>
                )}

                <div className='box-border p-10px rd-12px bg-fill-1 border border-solid border-[var(--color-border-2)]'>
                  <div className='flex items-center justify-between mb-6px'>
                    <span className='text-12px font-500 text-t-primary'>补充个人习惯/偏好文字（可选）</span>
                    {!hasTraeSelected && (
                      <button
                        type='button'
                        onClick={handleCopyPrompt}
                        className='p-0 b-none bg-transparent text-11.5px text-t-secondary hover:text-t-primary cursor-pointer'
                      >
                        复制记忆提取口令
                      </button>
                    )}
                  </div>
                  <Input.TextArea
                    value={extraMemoryText}
                    onChange={setExtraMemoryText}
                    autoSize={{ minRows: 2, maxRows: 3 }}
                    placeholder='若原工具记忆未写入本地文件，可复制口令让原 AI 生成总结后粘贴到这里，与所选客户端一并导入。'
                  />
                </div>
              </div>
            )
          ) : activeTab === 'advanced' ? (
            <div className='flex flex-col gap-10px h-full'>
              <div className='flex items-center gap-8px flex-wrap shrink-0'>
                <Input
                  allowClear
                  value={advKeyword}
                  onChange={setAdvKeyword}
                  placeholder='搜索技能/工具名称、描述或规则内容...'
                  className='flex-1 min-w-180px'
                />
                <Select
                  value={advClient}
                  onChange={(v) => setAdvClient(v as 'all' | EcosystemClientId)}
                  style={{ width: 165 }}
                  options={[
                    { label: '全部客户端', value: 'all' },
                    ...detectedClients.map((c) => ({ label: c.clientName, value: c.clientId })),
                  ]}
                />
              </div>

              <div className='flex items-center justify-between gap-8px shrink-0'>
                <div className='flex items-center gap-6px'>
                  <button
                    type='button'
                    onClick={() => setAdvSection('mcps')}
                    className={`px-10px py-4px rd-999px text-11.5px font-500 cursor-pointer border border-solid ${
                      advSection === 'mcps'
                        ? 'bg-[#111111] text-[#ffffff] border-[#111111] dark:bg-[#f5f5f7] dark:text-[#111111] dark:border-[#f5f5f7]'
                        : 'bg-transparent text-t-secondary border-[var(--color-border-2)]'
                    }`}
                  >
                    MCP 工具 ({filteredAdvMcps.length})
                  </button>
                  <button
                    type='button'
                    onClick={() => setAdvSection('skills')}
                    className={`px-10px py-4px rd-999px text-11.5px font-500 cursor-pointer border border-solid ${
                      advSection === 'skills'
                        ? 'bg-[#111111] text-[#ffffff] border-[#111111] dark:bg-[#f5f5f7] dark:text-[#111111] dark:border-[#f5f5f7]'
                        : 'bg-transparent text-t-secondary border-[var(--color-border-2)]'
                    }`}
                  >
                    Skills 技能 ({filteredAdvSkills.length})
                  </button>
                  <button
                    type='button'
                    onClick={() => setAdvSection('rules')}
                    className={`px-10px py-4px rd-999px text-11.5px font-500 cursor-pointer border border-solid ${
                      advSection === 'rules'
                        ? 'bg-[#111111] text-[#ffffff] border-[#111111] dark:bg-[#f5f5f7] dark:text-[#111111] dark:border-[#f5f5f7]'
                        : 'bg-transparent text-t-secondary border-[var(--color-border-2)]'
                    }`}
                  >
                    规则与记忆 ({filteredAdvRules.length})
                  </button>
                </div>

                {advSection === 'mcps' && filteredAdvMcps.length > 0 && (
                  <button
                    type='button'
                    onClick={() =>
                      toggleSelectionGroup(
                        setSelectedMcpIds,
                        filteredAdvMcps.map((m) => m.id),
                        selectedMcpIds
                      )
                    }
                    className='p-0 b-none bg-transparent text-11.5px text-t-secondary hover:text-t-primary cursor-pointer'
                  >
                    {filteredAdvMcps.every((m) => selectedMcpIds.has(m.id)) ? '清空当前' : '全选当前'}
                  </button>
                )}
                {advSection === 'skills' && filteredAdvSkills.length > 0 && (
                  <button
                    type='button'
                    onClick={() =>
                      toggleSelectionGroup(
                        setSelectedSkillIds,
                        filteredAdvSkills.map((s) => s.id),
                        selectedSkillIds
                      )
                    }
                    className='p-0 b-none bg-transparent text-11.5px text-t-secondary hover:text-t-primary cursor-pointer'
                  >
                    {filteredAdvSkills.every((s) => selectedSkillIds.has(s.id)) ? '清空当前' : '全选当前'}
                  </button>
                )}
                {advSection === 'rules' && filteredAdvRules.length > 0 && (
                  <button
                    type='button'
                    onClick={() =>
                      toggleSelectionGroup(
                        setSelectedRuleIds,
                        filteredAdvRules.map((r) => r.id),
                        selectedRuleIds
                      )
                    }
                    className='p-0 b-none bg-transparent text-11.5px text-t-secondary hover:text-t-primary cursor-pointer'
                  >
                    {filteredAdvRules.every((r) => selectedRuleIds.has(r.id)) ? '清空当前' : '全选当前'}
                  </button>
                )}
              </div>

              <div className='flex-1 min-h-0 overflow-y-auto flex flex-col gap-6px'>
                {advSection === 'mcps' &&
                  (filteredAdvMcps.length === 0 ? (
                    <div className='py-40px text-center text-12.5px text-t-tertiary'>暂无匹配的 MCP 工具</div>
                  ) : (
                    filteredAdvMcps.map((item) => (
                      <div
                        key={item.id}
                        onClick={() => toggleSelectionId(setSelectedMcpIds, item.id)}
                        className='box-border px-10px py-8px rd-8px bg-fill-1 hover:bg-fill-2 cursor-pointer flex items-start justify-between gap-10px'
                      >
                        <div className='flex items-start gap-8px min-w-0 flex-1'>
                          <Checkbox
                            checked={selectedMcpIds.has(item.id)}
                            onChange={() => toggleSelectionId(setSelectedMcpIds, item.id)}
                            onClick={(e) => e.stopPropagation()}
                          />
                          <div className='min-w-0 flex-1'>
                            <div className='flex items-center gap-6px flex-wrap'>
                              <span className='text-13px font-600 text-t-primary'>{item.name}</span>
                              <span className='px-6px py-1px rd-4px text-10.5px bg-fill-3 text-t-secondary'>
                                {item.clientName}
                              </span>
                            </div>
                            <div className='mt-2px text-11.5px text-t-tertiary truncate' title={item.preview}>
                              {item.preview}
                            </div>
                          </div>
                        </div>
                        {item.installed && <span className='text-11px text-t-tertiary shrink-0'>已存在</span>}
                      </div>
                    ))
                  ))}

                {advSection === 'skills' &&
                  (filteredAdvSkills.length === 0 ? (
                    <div className='py-40px text-center text-12.5px text-t-tertiary'>暂无匹配的 Skills 技能</div>
                  ) : (
                    filteredAdvSkills.map((item) => (
                      <div
                        key={item.id}
                        onClick={() => toggleSelectionId(setSelectedSkillIds, item.id)}
                        className='box-border px-10px py-8px rd-8px bg-fill-1 hover:bg-fill-2 cursor-pointer flex items-start justify-between gap-10px'
                      >
                        <div className='flex items-start gap-8px min-w-0 flex-1'>
                          <Checkbox
                            checked={selectedSkillIds.has(item.id)}
                            onChange={() => toggleSelectionId(setSelectedSkillIds, item.id)}
                            onClick={(e) => e.stopPropagation()}
                          />
                          <div className='min-w-0 flex-1'>
                            <div className='flex items-center gap-6px flex-wrap'>
                              <span className='text-13px font-600 text-t-primary'>{item.name}</span>
                              <span className='px-6px py-1px rd-4px text-10.5px bg-fill-3 text-t-secondary'>
                                {item.clientName}
                              </span>
                            </div>
                            <div className='mt-2px text-11.5px text-t-tertiary line-clamp-1' title={item.description}>
                              {item.description}
                            </div>
                          </div>
                        </div>
                        {item.installed && <span className='text-11px text-t-tertiary shrink-0'>已安装</span>}
                      </div>
                    ))
                  ))}

                {advSection === 'rules' &&
                  (filteredAdvRules.length === 0 ? (
                    <div className='py-40px text-center text-12.5px text-t-tertiary'>暂无匹配的规则与记忆</div>
                  ) : (
                    filteredAdvRules.map((item) => (
                      <div
                        key={item.id}
                        onClick={() => toggleSelectionId(setSelectedRuleIds, item.id)}
                        className='box-border px-10px py-8px rd-8px bg-fill-1 hover:bg-fill-2 cursor-pointer flex items-start justify-between gap-10px'
                      >
                        <div className='flex items-start gap-8px min-w-0 flex-1'>
                          <Checkbox
                            checked={selectedRuleIds.has(item.id)}
                            onChange={() => toggleSelectionId(setSelectedRuleIds, item.id)}
                            onClick={(e) => e.stopPropagation()}
                          />
                          <div className='min-w-0 flex-1'>
                            <div className='flex items-center gap-6px flex-wrap'>
                              <span className='text-13px font-600 text-t-primary'>{item.title}</span>
                              <span className='px-6px py-1px rd-4px text-10.5px bg-fill-3 text-t-secondary'>
                                {item.kind === 'memory' ? '记忆' : '规则'}
                              </span>
                            </div>
                            <div className='mt-2px text-11.5px text-t-tertiary line-clamp-1'>{item.content.slice(0, 120)}</div>
                          </div>
                        </div>
                        <span className='text-11px text-t-tertiary shrink-0'>{item.charCount} 字</span>
                      </div>
                    ))
                  ))}
              </div>
            </div>
          ) : (
            <div className='flex flex-col gap-10px h-full'>
              <div className='box-border rd-10px bg-fill-1 border border-solid border-[var(--color-border-2)] p-10px flex items-center justify-between gap-10px shrink-0'>
                <div className='min-w-0 flex-1'>
                  <div className='text-12.5px font-600 text-t-primary'>全局个人协作习惯（跨工作区生效）</div>
                  <div className='mt-2px text-11.5px text-t-secondary'>
                    保存后无论切到哪个项目目录，AI 都会记住你的沟通习惯与常用环境。
                  </div>
                </div>
                <button
                  type='button'
                  onClick={handleCopyPrompt}
                  className='h-28px px-12px rd-999px bg-[var(--color-bg-popup)] border border-solid border-[var(--color-border-3)] text-11.5px font-500 text-t-primary hover:bg-fill-2 cursor-pointer shrink-0'
                >
                  复制记忆提取口令
                </button>
              </div>

              <div className='flex-1 min-h-0'>
                <Input.TextArea
                  value={memoryDraft}
                  onChange={setMemoryDraft}
                  style={{ height: '100%' }}
                  placeholder={`例如：\n- 我发简短指令时直接按当前工程上下文落地，少反问\n- 常用技术栈：TypeScript / C# / Electron / Python`}
                />
              </div>

              {memoryState?.globalProfilePath && (
                <div className='text-11px text-t-tertiary truncate shrink-0' title={memoryState.globalProfilePath}>
                  存储位置：{memoryState.globalProfilePath}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Fixed Footer */}
        <div className='shrink-0 pt-10px border-t border-solid border-[var(--color-border-2)] border-x-0 border-b-0 flex items-center justify-between gap-12px flex-wrap'>
          <label className='flex items-center gap-8px text-12px text-t-secondary cursor-pointer'>
            <Switch size='small' checked={syncAssistant} onChange={setSyncAssistant} />
            <span>同步到「我的个人习惯」助手</span>
          </label>

          <div className='flex items-center gap-8px'>
            <button
              type='button'
              onClick={onClose}
              className='h-32px px-14px rd-999px bg-transparent border border-solid border-[var(--color-border-3)] text-12.5px font-500 text-t-primary hover:bg-fill-2 cursor-pointer'
            >
              {isOnboarding ? '暂不迁移' : '关闭'}
            </button>
            {activeTab === 'simple' && (
              <button
                type='button'
                disabled={importing || (selectedClientIds.size === 0 && !extraMemoryText.trim())}
                onClick={() => void handleSimpleImport()}
                className='h-32px px-16px b-none rd-999px text-12.5px font-600 cursor-pointer transition-opacity bg-[#111111] hover:opacity-85 text-[#ffffff] dark:bg-[#f5f5f7] dark:text-[#111111] disabled:opacity-40'
              >
                {importing ? '迁移中...' : `一键迁移所选客户端 (${selectedClientIds.size})`}
              </button>
            )}
            {activeTab === 'advanced' && (
              <button
                type='button'
                disabled={importing || totalAdvancedSelected === 0}
                onClick={() => void handleAdvancedImport()}
                className='h-32px px-16px b-none rd-999px text-12.5px font-600 cursor-pointer transition-opacity bg-[#111111] hover:opacity-85 text-[#ffffff] dark:bg-[#f5f5f7] dark:text-[#111111] disabled:opacity-40'
              >
                {importing ? '导入中...' : `导入所选项 (${totalAdvancedSelected})`}
              </button>
            )}
            {activeTab === 'memory' && (
              <button
                type='button'
                disabled={savingMemory}
                onClick={() => void handleSaveGlobalMemory()}
                className='h-32px px-16px b-none rd-999px text-12.5px font-600 cursor-pointer transition-opacity bg-[#111111] hover:opacity-85 text-[#ffffff] dark:bg-[#f5f5f7] dark:text-[#111111] disabled:opacity-40'
              >
                {savingMemory ? '保存中...' : '保存全局记忆'}
              </button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
};

export default MigrationModal;

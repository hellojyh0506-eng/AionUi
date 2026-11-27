/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import classNames from 'classnames';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Dropdown, Input, Menu, Message, Modal, Select, Spin, Switch } from '@arco-design/web-react';
import { mutate } from 'swr';
import { ipcBridge } from '@/common';
import type { IMcpServer } from '@/common/config/storage';
import type {
  MarketplaceMcpItem,
  MarketplaceSkillItem,
  MarketplaceUpdateItem,
  RuntimeEnvironmentReport,
} from '@/common/types/ecosystem';
import { useLayoutContext } from '@/renderer/hooks/context/LayoutContext';
import { openExternalUrl } from '@/renderer/utils/platform';
import SettingsPageHeader from '@/renderer/pages/settings/components/SettingsPageHeader';
import PluginDetailView, { type SelectedPluginTarget } from './PluginDetailView';

type MarketplaceTab = 'discover' | 'mcp' | 'skills' | 'installed' | 'github';
type SortMode = 'default' | 'stars' | 'installs';

interface LocalSkillRow {
  name: string;
  description: string;
  source: 'builtin' | 'custom' | 'cron' | 'extension';
  is_custom: boolean;
}

type UnifiedPluginCard =
  | {
      kind: 'mcp';
      data: MarketplaceMcpItem;
      installedServer?: IMcpServer;
      sortStars: number;
      sortInstalls: number;
    }
  | {
      kind: 'skill';
      data: MarketplaceSkillItem;
      sortStars: number;
      sortInstalls: number;
    };

function formatCompactCount(num: number): string {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}m`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`;
  return String(num);
}

const GitHubMiniIcon = () => (
  <svg width='13' height='13' viewBox='0 0 24 24' fill='currentColor'>
    <path d='M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.38 7.86 10.9.58.11.79-.25.79-.55v-2.14c-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11.02 11.02 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.39-5.25 5.67.41.36.78 1.06.78 2.14v3.18c0 .31.21.67.8.55A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z' />
  </svg>
);

const MarketplacePage: React.FC = () => {
  const layout = useLayoutContext();
  const isMobile = layout?.isMobile ?? false;
  const [searchParams, setSearchParams] = useSearchParams();

  const initialParam = searchParams.get('tab');
  const [activeTab, setActiveTab] = useState<MarketplaceTab>(() => {
    if (initialParam === 'mcp' || initialParam === 'skills' || initialParam === 'installed' || initialParam === 'github') {
      return initialParam;
    }
    return 'discover';
  });
  const [query, setQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('全部');
  const [sortMode, setSortMode] = useState<SortMode>('default');

  const [mcpItems, setMcpItems] = useState<MarketplaceMcpItem[]>([]);
  const [skillItems, setSkillItems] = useState<MarketplaceSkillItem[]>([]);
  const [mcpNextCursor, setMcpNextCursor] = useState<string | undefined>(undefined);
  const [loadingMoreMcp, setLoadingMoreMcp] = useState(false);

  const [installedServers, setInstalledServers] = useState<IMcpServer[]>([]);
  const [localSkills, setLocalSkills] = useState<LocalSkillRow[]>([]);
  const [runtimeReport, setRuntimeReport] = useState<RuntimeEnvironmentReport | null>(null);
  const [installingUv, setInstallingUv] = useState(false);

  const [loading, setLoading] = useState(false);
  const [remoteNotice, setRemoteNotice] = useState(false);

  const [syncing, setSyncing] = useState(false);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updatingAll, setUpdatingAll] = useState(false);
  const [updates, setUpdates] = useState<MarketplaceUpdateItem[]>([]);

  const [installingId, setInstallingId] = useState<string | null>(null);
  const [configModalItem, setConfigModalItem] = useState<MarketplaceMcpItem | null>(null);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [customRepoInput, setCustomRepoInput] = useState('');
  const [selectedPluginKey, setSelectedPluginKey] = useState<{ kind: 'mcp' | 'skill'; name: string; id: string } | null>(
    null
  );

  useEffect(() => {
    const param = searchParams.get('tab');
    if (param === 'mcp' || param === 'skills' || param === 'discover' || param === 'installed' || param === 'github') {
      setActiveTab(param);
      setSelectedCategory('全部');
    }
  }, [searchParams]);

  const loadRuntimeStatus = useCallback(async () => {
    try {
      const report = await ipcBridge.ecosystem.getRuntimeStatus.invoke();
      setRuntimeReport(report);
    } catch {
      // ignore on web fallback if unavailable
    }
  }, []);

  const loadLocalInstalled = useCallback(async () => {
    try {
      const [servers, skills] = await Promise.all([
        ipcBridge.mcpService.listServers.invoke().catch((): IMcpServer[] => []),
        ipcBridge.fs.listAvailableSkills.invoke().catch((): LocalSkillRow[] => []),
      ]);
      setInstalledServers(servers || []);
      setLocalSkills(skills || []);
    } catch {
      // ignore
    }
  }, []);

  const loadCatalogs = useCallback(
    async (searchText: string) => {
      setLoading(true);
      try {
        const [mcpRes, skillRes] = await Promise.all([
          ipcBridge.ecosystem.searchMcpMarketplace.invoke({ query: searchText }),
          ipcBridge.ecosystem.searchSkillsMarketplace.invoke({ query: searchText }),
          loadLocalInstalled(),
        ]);
        setMcpItems(mcpRes.items || []);
        setMcpNextCursor(mcpRes.nextCursor);
        setSkillItems(skillRes.items || []);
        setRemoteNotice(Boolean(mcpRes.remoteUnavailable || skillRes.remoteUnavailable));
      } catch (err) {
        Message.error(err instanceof Error ? err.message : '加载插件市场失败');
      } finally {
        setLoading(false);
      }
    },
    [loadLocalInstalled]
  );

  const runUpdateCheck = useCallback(async (silent = true) => {
    setCheckingUpdates(true);
    try {
      const res = await ipcBridge.ecosystem.checkUpdates.invoke();
      setUpdates(res.updates || []);
      if (!silent) {
        if ((res.updates || []).length > 0) {
          Message.info(`发现 ${res.updates.length} 个插件有新版本`);
        } else {
          Message.success('当前已安装插件均为最新版本');
        }
      }
    } catch {
      if (!silent) Message.warning('检查更新失败，请稍后重试');
    } finally {
      setCheckingUpdates(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadRuntimeStatus();
    void (async () => {
      try {
        await ipcBridge.ecosystem.syncMarketplace.invoke({ force: false });
      } catch {
        // offline fallback
      }
      if (!cancelled) {
        await loadCatalogs('');
        await runUpdateCheck(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadCatalogs, runUpdateCheck, loadRuntimeStatus]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadCatalogs(query);
    }, 240);
    return () => clearTimeout(timer);
  }, [query, loadCatalogs]);

  useEffect(() => {
    const handleEcosystemUpdated = () => {
      void loadCatalogs(query);
      void runUpdateCheck(true);
    };
    window.addEventListener('ethantoken:ecosystem-updated', handleEcosystemUpdated);
    return () => window.removeEventListener('ethantoken:ecosystem-updated', handleEcosystemUpdated);
  }, [loadCatalogs, query, runUpdateCheck]);

  const handleInstallRuntimeUv = async () => {
    setInstallingUv(true);
    try {
      const res = await ipcBridge.ecosystem.installManagedUv.invoke();
      setRuntimeReport(res.report);
      if (res.success) {
        Message.success('uv / uvx 运行环境安装成功，已自动加入客户端运行时路径');
      } else {
        Message.error(res.error || '安装 uv 失败');
      }
    } catch (err) {
      Message.error(err instanceof Error ? err.message : '安装 uv 失败');
    } finally {
      setInstallingUv(false);
    }
  };

  const handleLoadMoreMcp = async () => {
    if (!mcpNextCursor || loadingMoreMcp) return;
    setLoadingMoreMcp(true);
    try {
      const res = await ipcBridge.ecosystem.searchMcpMarketplace.invoke({
        query,
        cursor: mcpNextCursor,
      });
      setMcpItems((prev) => {
        const seen = new Set(prev.map((i) => i.name.toLowerCase()));
        const additions = (res.items || []).filter((i) => !seen.has(i.name.toLowerCase()));
        return [...prev, ...additions];
      });
      setMcpNextCursor(res.nextCursor);
    } catch (err) {
      Message.error(err instanceof Error ? err.message : '加载更多 MCP 失败');
    } finally {
      setLoadingMoreMcp(false);
    }
  };

  const handleSyncCatalog = async () => {
    setSyncing(true);
    try {
      const res = await ipcBridge.ecosystem.syncMarketplace.invoke({ force: true });
      await loadCatalogs(query);
      await runUpdateCheck(true);
      Message.success(
        `已同步目录（更新 ${res.starsUpdated} 个仓库信息${res.updatesAvailable > 0 ? ` · ${res.updatesAvailable} 个可更新` : ''}）`
      );
    } catch (err) {
      Message.error(err instanceof Error ? err.message : '同步目录失败');
    } finally {
      setSyncing(false);
    }
  };

  const handleUpdateAll = async () => {
    setUpdatingAll(true);
    try {
      const res = await ipcBridge.ecosystem.updateAllPlugins.invoke();
      await Promise.all([
        mutate('/api/mcp/servers'),
        mutate('skills.list'),
        mutate('assistants.list'),
        mutate('agents.boundAssistants.list'),
      ]);
      window.dispatchEvent(new CustomEvent('ethantoken:ecosystem-updated'));
      await loadCatalogs(query);
      await runUpdateCheck(true);
      if (res.updatedCount > 0) {
        Message.success(`已更新 ${res.updatedCount} 个插件`);
      } else if (res.failed.length > 0) {
        Message.warning(`部分更新失败：${res.failed[0].name}`);
      } else {
        Message.info('暂无可自动更新的插件');
      }
    } catch (err) {
      Message.error(err instanceof Error ? err.message : '批量更新失败');
    } finally {
      setUpdatingAll(false);
    }
  };

  const updateMap = useMemo(() => new Map(updates.map((u) => [`${u.kind}:${u.name}`, u])), [updates]);
  const installedServerByName = useMemo(
    () => new Map(installedServers.map((s) => [s.name.toLowerCase(), s])),
    [installedServers]
  );

  const allUnifiedCards = useMemo<UnifiedPluginCard[]>(() => {
    const mcps: UnifiedPluginCard[] = mcpItems.map((m) => {
      const srv = installedServerByName.get(m.name.toLowerCase());
      return {
        kind: 'mcp',
        data: srv && !m.installed ? Object.assign({}, m, { installed: true }) : m,
        installedServer: srv,
        sortStars: m.stars || 0,
        sortInstalls: m.downloads || 0,
      };
    });
    const skills: UnifiedPluginCard[] = skillItems.map((s) => ({
      kind: 'skill',
      data: s,
      sortStars: s.stars || 0,
      sortInstalls: s.installs || 0,
    }));
    return [...mcps, ...skills];
  }, [mcpItems, skillItems, installedServerByName]);

  const installedCards = useMemo<UnifiedPluginCard[]>(() => {
    const q = query.trim().toLowerCase();
    const mcpByName = new Map(mcpItems.map((m) => [m.name.toLowerCase(), m]));
    const skillByName = new Map(skillItems.map((s) => [s.name.toLowerCase(), s]));

    const mcpInstalled: UnifiedPluginCard[] = installedServers
      .filter((srv) => !srv.builtin)
      .filter((srv) => !q || srv.name.toLowerCase().includes(q) || (srv.description || '').toLowerCase().includes(q))
      .map((srv) => {
        const catalog = mcpByName.get(srv.name.toLowerCase());
        const item: MarketplaceMcpItem = catalog
          ? Object.assign({}, catalog, { installed: true })
          : {
              id: `local:${srv.id}`,
              name: srv.name,
              title: srv.name,
              description: srv.description || '本地已配置 MCP 服务',
              category: '本地已装',
              source: 'curated',
              transport: srv.transport,
              installed: true,
            };
        return {
          kind: 'mcp',
          data: item,
          installedServer: srv,
          sortStars: item.stars || 0,
          sortInstalls: item.downloads || 0,
        };
      });

    const seenSkills = new Set<string>();
    const skillInstalled: UnifiedPluginCard[] = [];

    for (const row of localSkills) {
      if (row.source !== 'custom' && !row.is_custom) continue;
      if (q && !row.name.toLowerCase().includes(q) && !row.description.toLowerCase().includes(q)) continue;
      seenSkills.add(row.name.toLowerCase());
      const catalog = skillByName.get(row.name.toLowerCase());
      const item: MarketplaceSkillItem = catalog
        ? Object.assign({}, catalog, { installed: true })
        : {
            id: `local-skill:${row.name}`,
            name: row.name,
            description: row.description || '自定义本地技能',
            category: '本地技能',
            source: 'curated',
            repo: '',
            skillId: row.name,
            installed: true,
          };
      skillInstalled.push({
        kind: 'skill',
        data: item,
        sortStars: item.stars || 0,
        sortInstalls: item.installs || 0,
      });
    }

    for (const s of skillItems) {
      if (!s.installed || seenSkills.has(s.name.toLowerCase())) continue;
      seenSkills.add(s.name.toLowerCase());
      skillInstalled.push({
        kind: 'skill',
        data: s,
        sortStars: s.stars || 0,
        sortInstalls: s.installs || 0,
      });
    }

    return [...mcpInstalled, ...skillInstalled];
  }, [installedServers, localSkills, mcpItems, skillItems, query]);

  const installedCount = installedCards.length;

  const featuredSpotlights = useMemo(() => {
    const preferredIds = ['curated:context7', 'curated:playwright', 'curated:sequential-thinking', 'curated:frontend-design'];
    return preferredIds
      .map((id) => allUnifiedCards.find((c) => c.data.id === id))
      .filter((c): c is UnifiedPluginCard => Boolean(c));
  }, [allUnifiedCards]);

  const tabFilteredCards = useMemo(() => {
    let base: UnifiedPluginCard[] = allUnifiedCards;
    if (activeTab === 'mcp') base = allUnifiedCards.filter((c) => c.kind === 'mcp');
    else if (activeTab === 'skills') base = allUnifiedCards.filter((c) => c.kind === 'skill');
    else if (activeTab === 'installed') base = installedCards;

    if (sortMode === 'stars') {
      return base.toSorted((a, b) => b.sortStars - a.sortStars);
    }
    if (sortMode === 'installs') {
      return base.toSorted((a, b) => b.sortInstalls - a.sortInstalls);
    }
    return base;
  }, [allUnifiedCards, installedCards, activeTab, sortMode]);

  const categories = useMemo(() => {
    const cats = new Set(tabFilteredCards.map((c) => c.data.category).filter(Boolean));
    return ['全部', ...Array.from(cats)];
  }, [tabFilteredCards]);

  const visibleCards = useMemo(() => {
    if (selectedCategory === '全部') return tabFilteredCards;
    return tabFilteredCards.filter((c) => c.data.category === selectedCategory);
  }, [tabFilteredCards, selectedCategory]);

  const selectedDetailTarget = useMemo<SelectedPluginTarget | null>(() => {
    if (!selectedPluginKey) return null;
    const pool = [...allUnifiedCards, ...installedCards];
    const match = pool.find(
      (c) =>
        c.kind === selectedPluginKey.kind &&
        (c.data.id === selectedPluginKey.id || c.data.name.toLowerCase() === selectedPluginKey.name.toLowerCase())
    );
    if (!match) return null;
    const upd = updateMap.get(`${match.kind}:${match.data.name}`);
    if (match.kind === 'mcp') {
      return {
        kind: 'mcp',
        name: match.data.name,
        title: match.data.title,
        description: match.data.description,
        category: match.data.category,
        author: match.data.author,
        version: match.data.version,
        source: match.data.source,
        repositoryUrl: match.data.repositoryUrl,
        stars: match.data.stars,
        downloads: match.data.downloads,
        catalogItem: match.data,
        installedServer: match.installedServer ?? installedServerByName.get(match.data.name.toLowerCase()),
        hasUpdate: Boolean(upd),
        remoteVersion: upd?.latestVersion,
      };
    }
    return {
      kind: 'skill',
      name: match.data.name,
      description: match.data.description,
      category: match.data.category,
      author: match.data.author,
      version: match.data.version,
      source: match.data.source,
      repositoryUrl: match.data.repositoryUrl,
      repo: match.data.repo,
      skillId: match.data.skillId,
      rawPath: match.data.rawPath,
      stars: match.data.stars,
      installs: match.data.installs,
      catalogItem: match.data,
      isInstalled: match.data.installed,
      hasUpdate: Boolean(upd),
    };
  }, [selectedPluginKey, allUnifiedCards, installedCards, installedServerByName, updateMap]);

  const doInstallMcp = async (item: MarketplaceMcpItem, values?: Record<string, string>) => {
    setInstallingId(item.id);
    try {
      const res = await ipcBridge.ecosystem.installMcpFromMarketplace.invoke({
        item,
        fieldValues: values,
      });
      if (!res.success) {
        Message.error(res.error || `安装 ${item.name} 失败`);
        return;
      }
      await Promise.all([mutate('/api/mcp/servers'), mutate('assistants.list'), mutate('agents.boundAssistants.list')]);
      window.dispatchEvent(new CustomEvent('ethantoken:ecosystem-updated'));
      Message.success(`已安装并挂载 MCP：${res.name}`);
      setConfigModalItem(null);
      setFieldValues({});
      await loadCatalogs(query);
    } catch (err) {
      Message.error(err instanceof Error ? err.message : '安装 MCP 失败');
    } finally {
      setInstallingId(null);
    }
  };

  const handleInstallCard = async (card: UnifiedPluginCard) => {
    if (card.kind === 'mcp') {
      const item = card.data;
      if (item.configFields && item.configFields.length > 0 && !item.installed) {
        const defaults: Record<string, string> = {};
        for (const f of item.configFields) {
          if (f.defaultValue) defaults[f.key] = f.defaultValue;
        }
        setFieldValues(defaults);
        setConfigModalItem(item);
        return;
      }
      await doInstallMcp(item);
      return;
    }

    const skill = card.data;
    setInstallingId(skill.id);
    try {
      const res = await ipcBridge.ecosystem.installSkillFromMarketplace.invoke({
        repo: skill.repo,
        skillId: skill.skillId,
        rawPath: skill.rawPath,
        customName: skill.name,
      });
      if (!res.success) {
        Message.error(res.error || `安装 ${skill.name} 失败`);
        return;
      }
      await Promise.all([mutate('skills.list'), mutate('assistants.list'), mutate('agents.boundAssistants.list')]);
      window.dispatchEvent(new CustomEvent('ethantoken:ecosystem-updated'));
      Message.success(skill.installed ? `已更新技能：${res.skillName}` : `已安装并挂载技能：${res.skillName}`);
      await loadCatalogs(query);
      await runUpdateCheck(true);
    } catch (err) {
      Message.error(err instanceof Error ? err.message : '安装技能失败');
    } finally {
      setInstallingId(null);
    }
  };

  const handleToggleMcpServer = async (srv: IMcpServer) => {
    try {
      await ipcBridge.mcpService.toggleServer.invoke({ id: srv.id });
      await Promise.all([mutate('/api/mcp/servers'), mutate('assistants.list'), mutate('agents.boundAssistants.list')]);
      await loadLocalInstalled();
    } catch (err) {
      Message.error(err instanceof Error ? err.message : '切换开关失败');
    }
  };

  const handleQuickTestMcp = async (srv: IMcpServer) => {
    try {
      const res = await ipcBridge.mcpService.testMcpConnection.invoke(srv);
      if (res.success) {
        Message.success(`${srv.name} 运行正常（${(res.tools || []).length} 个工具）`);
      } else {
        Message.warning(`${srv.name} 检测异常：${res.error || '连接失败'}`);
      }
      await loadLocalInstalled();
    } catch (err) {
      Message.error(err instanceof Error ? err.message : '检测失败');
    }
  };

  const handleUninstallCard = (card: UnifiedPluginCard) => {
    Modal.confirm({
      title: `卸载 ${card.kind === 'mcp' ? card.data.title : card.data.name}`,
      content: '卸载后将从本地移除该插件，确定继续吗？',
      okText: '确认卸载',
      cancelText: '取消',
      okButtonProps: { status: 'danger' },
      onOk: async () => {
        try {
          if (card.kind === 'mcp' && card.installedServer) {
            await ipcBridge.mcpService.deleteServer.invoke({ id: card.installedServer.id });
          } else if (card.kind === 'skill') {
            await ipcBridge.fs.deleteSkill.invoke({ skill_name: card.data.name });
          }
          Message.success(`已卸载 ${card.data.name}`);
          await Promise.all([mutate('/api/mcp/servers'), mutate('skills.list')]);
          window.dispatchEvent(new CustomEvent('ethantoken:ecosystem-updated'));
          await loadCatalogs(query);
        } catch (err) {
          Message.error(err instanceof Error ? err.message : '卸载失败');
        }
      },
    });
  };

  const handleInstallCustomRepo = async () => {
    const spec = customRepoInput.trim();
    if (!spec) {
      Message.info('请输入 GitHub 仓库或技能地址，如 anthropics/skills@frontend-design');
      return;
    }
    setInstallingId('__custom__');
    try {
      const res = await ipcBridge.ecosystem.installSkillFromMarketplace.invoke({ repo: spec });
      if (!res.success) {
        Message.error(res.error || '从 GitHub 安装技能失败');
        return;
      }
      await Promise.all([mutate('skills.list'), mutate('assistants.list'), mutate('agents.boundAssistants.list')]);
      window.dispatchEvent(new CustomEvent('ethantoken:ecosystem-updated'));
      setCustomRepoInput('');
      Message.success(`已安装并挂载技能：${res.skillName}`);
      await loadCatalogs(query);
    } catch (err) {
      Message.error(err instanceof Error ? err.message : '安装失败');
    } finally {
      setInstallingId(null);
    }
  };

  const handleSubmitMcpConfig = () => {
    if (!configModalItem) return;
    for (const f of configModalItem.configFields || []) {
      if (f.required && !(fieldValues[f.key] || '').trim()) {
        Message.warning(`请填写 ${f.label}`);
        return;
      }
    }
    void doInstallMcp(configModalItem, fieldValues);
  };

  const changeTab = (tab: MarketplaceTab) => {
    setActiveTab(tab);
    setSelectedCategory('全部');
    setSearchParams(tab === 'discover' ? {} : { tab }, { replace: true });
  };

  if (selectedDetailTarget) {
    return (
      <PluginDetailView
        plugin={selectedDetailTarget}
        runtimeReport={runtimeReport}
        installingUv={installingUv}
        onInstallRuntimeUv={handleInstallRuntimeUv}
        onBack={() => setSelectedPluginKey(null)}
        onRefresh={() => loadCatalogs(query)}
      />
    );
  }

  const tabItems: Array<{ key: MarketplaceTab; label: string }> = [
    { key: 'discover', label: `发现 (${allUnifiedCards.length})` },
    { key: 'mcp', label: `MCP 工具 (${mcpItems.length})` },
    { key: 'skills', label: `Skills 技能 (${skillItems.length})` },
    { key: 'installed', label: `已安装 (${installedCount})` },
    { key: 'github', label: 'GitHub 直装' },
  ];

  const openDetail = (card: UnifiedPluginCard) => {
    setSelectedPluginKey({ kind: card.kind, name: card.data.name, id: card.data.id });
  };

  return (
    <div className='w-full h-full min-h-0 box-border bg-1 flex flex-col overflow-hidden select-none'>
      <div
        className={classNames(
          'shrink-0 bg-1 border-b border-solid border-[var(--color-border-2)] border-x-0 border-t-0',
          isMobile ? 'px-16px pt-14px pb-12px' : 'px-16px pt-20px pb-14px md:px-36px md:pt-28px'
        )}
      >
        <div className='mx-auto w-full max-w-1160px box-border flex flex-col gap-14px'>
          <SettingsPageHeader
            sticky={false}
            title='插件市场'
            description='精选高可用工具 + 实时聚合官方 MCP Registry 与 skills.sh 社区技能，内置免配置运行环境。'
            actions={
              <div className='flex items-center gap-8px flex-wrap'>
                <button
                  type='button'
                  disabled={syncing}
                  onClick={() => void handleSyncCatalog()}
                  className='h-30px px-12px rd-999px bg-base border border-solid border-[var(--color-border-2)] text-12px font-500 text-t-primary hover:bg-fill-2 cursor-pointer disabled:opacity-50'
                >
                  {syncing ? '同步中...' : '同步插件市场'}
                </button>
                <button
                  type='button'
                  disabled={checkingUpdates}
                  onClick={() => void runUpdateCheck(false)}
                  className='h-30px px-12px rd-999px bg-base border border-solid border-[var(--color-border-2)] text-12px font-500 text-t-primary hover:bg-fill-2 cursor-pointer disabled:opacity-50'
                >
                  {checkingUpdates ? '检查中...' : '检查更新'}
                </button>
                {updates.length > 0 && (
                  <button
                    type='button'
                    disabled={updatingAll}
                    onClick={() => void handleUpdateAll()}
                    className='h-30px px-14px b-none rd-999px text-12px font-600 cursor-pointer transition-opacity bg-[#111111] hover:opacity-85 text-[#ffffff] dark:bg-[#f5f5f7] dark:text-[#111111] disabled:opacity-50'
                  >
                    {updatingAll ? '更新中...' : `全部更新 (${updates.length})`}
                  </button>
                )}
                <button
                  type='button'
                  onClick={() => window.dispatchEvent(new CustomEvent('ethantoken:open-migration-modal'))}
                  className='h-30px px-12px rd-999px bg-transparent border border-solid border-[var(--color-border-2)] text-12px font-500 text-t-secondary hover:text-t-primary hover:bg-fill-2 cursor-pointer'
                >
                  一键迁移旧工具
                </button>
              </div>
            }
          />

          <div className='flex items-center gap-18px border-b border-solid border-[var(--color-border-2)] border-x-0 border-t-0 overflow-x-auto'>
            {tabItems.map((tab) => {
              const active = activeTab === tab.key;
              return (
                <button
                  key={tab.key}
                  type='button'
                  onClick={() => changeTab(tab.key)}
                  className={`pb-8px pt-2px px-2px b-none bg-transparent text-13.5px cursor-pointer whitespace-nowrap border-b-2 border-solid transition-colors ${
                    active
                      ? 'border-t-0 border-x-0 border-[var(--color-text-1)] font-600 text-t-primary'
                      : 'border-transparent font-500 text-t-secondary hover:text-t-primary'
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          {runtimeReport && (
            <div className='flex items-center justify-between gap-10px px-12px py-7px rd-10px bg-fill-1 border border-solid border-[var(--color-border-2)] text-12px flex-wrap'>
              <div className='flex items-center gap-12px flex-wrap'>
                <span className='text-t-tertiary font-500'>内置运行环境：</span>
                <span
                  className={
                    runtimeReport.npx.available ? 'text-[#15803d] dark:text-[#34d399]' : 'text-[#d97706]'
                  }
                >
                  ● Node / npx{' '}
                  {runtimeReport.npx.available
                    ? runtimeReport.node.source === 'bundled'
                      ? `内置就绪 (${runtimeReport.node.version || 'v24'})`
                      : `已就绪 (${runtimeReport.node.version || '系统'})`
                    : '未检测到'}
                </span>
                <span
                  className={
                    runtimeReport.uvx.available ? 'text-[#15803d] dark:text-[#34d399]' : 'text-[#d97706]'
                  }
                >
                  ● uv / uvx{' '}
                  {runtimeReport.uvx.available
                    ? `${runtimeReport.uvx.source === 'managed' ? '托管就绪' : '系统就绪'} (${runtimeReport.uvx.version || 'ok'})`
                    : '未安装（Python MCP 需此环境）'}
                </span>
              </div>
              {!runtimeReport.uvx.available && (
                <button
                  type='button'
                  disabled={installingUv}
                  onClick={() => void handleInstallRuntimeUv()}
                  className='h-24px px-10px b-none rd-999px text-11.5px font-600 cursor-pointer bg-[#111111] hover:opacity-85 text-[#ffffff] dark:bg-[#f5f5f7] dark:text-[#111111] disabled:opacity-50'
                >
                  {installingUv ? '正在安装 uv...' : '一键安装 uv'}
                </button>
              )}
            </div>
          )}

          {activeTab !== 'github' && (
            <div className='flex flex-col gap-10px'>
              <div className='flex items-center gap-10px flex-wrap'>
                <Input
                  allowClear
                  value={query}
                  onChange={setQuery}
                  placeholder='搜索 MCP 或 Skills（支持实时检索官方 MCP Registry 与 skills.sh，例如 context7、github、frontend）'
                  className='flex-1 min-w-240px'
                />
                <Select
                  value={sortMode}
                  onChange={(v) => setSortMode(v as SortMode)}
                  style={{ width: 140 }}
                  options={[
                    { label: '默认推荐', value: 'default' },
                    { label: '按 Star 数', value: 'stars' },
                    { label: '按安装量', value: 'installs' },
                  ]}
                />
              </div>

              <div className='flex items-center gap-6px flex-wrap'>
                {categories.map((cat) => (
                  <button
                    key={cat}
                    type='button'
                    onClick={() => setSelectedCategory(cat)}
                    className={`px-11px py-4px rd-999px text-11.5px font-500 cursor-pointer border border-solid transition-colors ${
                      selectedCategory === cat
                        ? 'bg-[#111111] text-[#ffffff] border-[#111111] dark:bg-[#f5f5f7] dark:text-[#111111] dark:border-[#f5f5f7]'
                        : 'bg-base text-t-secondary border-[var(--color-border-2)] hover:text-t-primary'
                    }`}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div
        className={classNames(
          'min-h-0 flex-1 overflow-y-auto overscroll-contain',
          isMobile ? 'px-16px py-14px' : 'px-16px py-18px md:px-36px md:py-22px'
        )}
      >
        <div className='mx-auto w-full max-w-1160px box-border'>
          {activeTab === 'github' ? (
            <div className='box-border p-20px rd-14px bg-base border border-solid border-[var(--color-border-2)] max-w-680px'>
              <h3 className='m-0 text-15px font-600 text-t-primary'>从 GitHub 仓库直接安装 Skill</h3>
              <p className='m-0 mt-6px mb-14px text-12.5px text-t-secondary leading-relaxed'>
                支持 `vercel-labs/skills`（skills.sh）及标准 `SKILL.md` 仓库格式，输入 `owner/repo`、`owner/repo@skill` 或完整 GitHub URL 即可自动拉取并安装。
              </p>
              <div className='flex items-center gap-10px'>
                <Input
                  value={customRepoInput}
                  onChange={setCustomRepoInput}
                  placeholder='例如 anthropics/skills@frontend-design 或 obra/superpowers@brainstorming'
                  className='flex-1 min-w-0'
                />
                <button
                  type='button'
                  disabled={installingId === '__custom__'}
                  onClick={() => void handleInstallCustomRepo()}
                  className='h-32px px-16px b-none rd-999px text-12.5px font-600 shrink-0 cursor-pointer transition-opacity bg-[#111111] hover:opacity-85 text-[#ffffff] dark:bg-[#f5f5f7] dark:text-[#111111] disabled:opacity-50'
                >
                  {installingId === '__custom__' ? '拉取安装中...' : '立即安装'}
                </button>
              </div>
            </div>
          ) : (
            <>
              {remoteNotice && (
                <div className='mb-12px px-12px py-8px rd-10px bg-base border border-solid border-[var(--color-border-2)] text-12px text-t-secondary'>
                  部分在线索引源暂时未响应，当前优先展示本地已缓存与精选列表。
                </div>
              )}

              {activeTab === 'discover' && !query.trim() && selectedCategory === '全部' && featuredSpotlights.length > 0 && (
                <div className='mb-16px'>
                  <div className='text-12.5px font-600 text-t-secondary mb-8px'>热门精选推荐（点击卡片可查看使用教程与参数配置）</div>
                  <div className='grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-10px'>
                    {featuredSpotlights.map((card) => {
                      const title = card.kind === 'mcp' ? card.data.title : card.data.name;
                      return (
                        <div
                          key={`spot:${card.data.id}`}
                          onClick={() => openDetail(card)}
                          className='box-border p-12px rd-10px bg-base border border-solid border-[var(--color-border-2)] hover:border-[var(--color-border-3)] cursor-pointer transition-colors flex flex-col justify-between gap-6px'
                        >
                          <div className='flex items-center justify-between gap-6px'>
                            <span className='text-13px font-600 text-t-primary truncate'>{title}</span>
                            <span className='text-10.5px text-t-tertiary shrink-0'>
                              {card.data.installed ? '✓ 已安装' : '详情 →'}
                            </span>
                          </div>
                          <div className='text-11.5px text-t-secondary line-clamp-1'>{card.data.description}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {loading && visibleCards.length === 0 ? (
                <div className='py-64px flex items-center justify-center'>
                  <Spin size={24} />
                </div>
              ) : visibleCards.length === 0 ? (
                <div className='py-48px rd-14px bg-base border border-dashed border-[var(--color-border-2)] text-center text-13px text-t-tertiary'>
                  当前筛选条件下暂无插件卡片
                </div>
              ) : (
                <>
                  <div className='grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-12px'>
                    {visibleCards.map((card) => {
                      const isMcp = card.kind === 'mcp';
                      const title = isMcp ? card.data.title : card.data.name;
                      const subName = card.data.name;
                      const author = card.data.author;
                      const version = card.data.version;
                      const stars = card.data.stars;
                      const installs = isMcp ? card.data.downloads : card.data.installs;
                      const repoUrl = card.data.repositoryUrl;
                      const updateInfo = updateMap.get(`${card.kind}:${subName}`);
                      const hasUpdate = Boolean(updateInfo);
                      const isBusy = installingId === card.data.id;
                      const srv = isMcp ? card.installedServer : undefined;

                      return (
                        <div
                          key={`${card.kind}:${card.data.id}`}
                          onClick={() => openDetail(card)}
                          className='box-border p-14px rd-12px bg-base border border-solid border-[var(--color-border-2)] hover:border-[var(--color-border-3)] transition-colors cursor-pointer flex flex-col justify-between gap-10px min-h-148px'
                        >
                          <div>
                            <div className='flex items-start justify-between gap-8px'>
                              <div className='min-w-0 flex-1'>
                                <div className='flex items-center gap-6px'>
                                  <span className='text-14px font-600 text-t-primary truncate' title={title}>
                                    {title}
                                  </span>
                                  {repoUrl && (
                                    <button
                                      type='button'
                                      title='查看 GitHub 仓库'
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        void openExternalUrl(repoUrl);
                                      }}
                                      className='p-0 b-none bg-transparent text-t-tertiary hover:text-t-primary cursor-pointer flex items-center shrink-0'
                                    >
                                      <GitHubMiniIcon />
                                    </button>
                                  )}
                                </div>
                                <div className='mt-3px flex items-center gap-8px text-11.5px text-t-tertiary flex-wrap'>
                                  {author && <span>{author}</span>}
                                  {version && <span>v{version}</span>}
                                  {typeof stars === 'number' && <span>★ {formatCompactCount(stars)}</span>}
                                  {typeof installs === 'number' && <span>↓ {formatCompactCount(installs)}</span>}
                                </div>
                              </div>

                              <div
                                className='flex items-center gap-6px shrink-0'
                                onClick={(e) => e.stopPropagation()}
                              >
                                {hasUpdate ? (
                                  <button
                                    type='button'
                                    disabled={isBusy}
                                    onClick={() => void handleInstallCard(card)}
                                    className='h-26px px-11px b-none rd-999px text-11.5px font-600 shrink-0 cursor-pointer bg-[#15803d] hover:opacity-90 text-[#ffffff] disabled:opacity-50'
                                  >
                                    {isBusy ? '更新中' : '更新'}
                                  </button>
                                ) : card.data.installed ? (
                                  activeTab === 'installed' && srv ? (
                                    <Switch
                                      size='small'
                                      checked={srv.enabled}
                                      onChange={() => void handleToggleMcpServer(srv)}
                                    />
                                  ) : (
                                    <span className='h-26px px-10px rd-999px text-11.5px font-500 shrink-0 inline-flex items-center bg-[#15803d]/10 text-[#15803d] dark:bg-[#34d399]/15 dark:text-[#34d399]'>
                                      ✓ 已安装
                                    </span>
                                  )
                                ) : (
                                  <button
                                    type='button'
                                    disabled={isBusy}
                                    onClick={() => void handleInstallCard(card)}
                                    className='h-26px px-12px b-none rd-999px text-11.5px font-600 shrink-0 cursor-pointer transition-opacity bg-[#111111] hover:opacity-85 text-[#ffffff] dark:bg-[#f5f5f7] dark:text-[#111111] disabled:opacity-50'
                                  >
                                    {isBusy ? '安装中' : '安装'}
                                  </button>
                                )}

                                {card.data.installed && (
                                  <Dropdown
                                    trigger='click'
                                    droplist={
                                      <Menu
                                        onClickMenuItem={(key) => {
                                          if (key === 'detail') openDetail(card);
                                          else if (key === 'test' && srv) void handleQuickTestMcp(srv);
                                          else if (key === 'uninstall') handleUninstallCard(card);
                                        }}
                                      >
                                        <Menu.Item key='detail'>在详情页查看与配置</Menu.Item>
                                        {srv && <Menu.Item key='test'>检测运行状态</Menu.Item>}
                                        {(!srv || !srv.builtin) && (
                                          <Menu.Item key='uninstall'>
                                            <span className='text-[#ef4444]'>卸载插件</span>
                                          </Menu.Item>
                                        )}
                                      </Menu>
                                    }
                                  >
                                    <button
                                      type='button'
                                      title='更多操作'
                                      className='w-24px h-24px rd-6px b-none bg-transparent hover:bg-fill-2 text-t-tertiary hover:text-t-primary cursor-pointer flex items-center justify-center'
                                    >
                                      ···
                                    </button>
                                  </Dropdown>
                                )}
                              </div>
                            </div>

                            <p className='m-0 mt-8px text-12px text-t-secondary leading-relaxed line-clamp-2' title={card.data.description}>
                              {card.data.description}
                            </p>
                          </div>

                          <div className='flex items-center justify-between gap-6px pt-6px border-t border-solid border-[var(--color-border-1)] border-x-0 border-b-0'>
                            <div className='flex items-center gap-6px flex-wrap'>
                              <span className='px-6px py-1px rd-4px text-10.5px bg-fill-2 text-t-secondary'>
                                {isMcp ? 'MCP 工具' : 'Skill 技能'}
                              </span>
                              <span className='px-6px py-1px rd-4px text-10.5px bg-fill-1 text-t-tertiary border border-solid border-[var(--color-border-2)]'>
                                {card.data.category}
                              </span>
                              {srv && (
                                <span
                                  className={`px-6px py-1px rd-4px text-10.5px ${
                                    srv.last_test_status === 'connected'
                                      ? 'text-[#15803d] bg-[#15803d]/10 dark:text-[#34d399]'
                                      : srv.last_test_status === 'error'
                                        ? 'text-[#dc2626] bg-[#ef4444]/10'
                                        : srv.enabled
                                          ? 'text-[#15803d] bg-[#15803d]/10 dark:text-[#34d399]'
                                          : 'text-t-tertiary bg-fill-1'
                                  }`}
                                >
                                  {srv.last_test_status === 'connected'
                                    ? '● 运行中'
                                    : srv.last_test_status === 'error'
                                      ? '● 检测异常'
                                      : srv.enabled
                                        ? '● 已启用'
                                        : '● 已停用'}
                                </span>
                              )}
                            </div>
                            <span className='text-10.5px text-t-tertiary shrink-0'>
                              {card.data.source === 'curated'
                                ? '官方精选'
                                : card.data.source === 'registry'
                                  ? 'MCP Registry'
                                  : 'skills.sh'}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {(activeTab === 'discover' || activeTab === 'mcp') && mcpNextCursor && (
                    <div className='mt-18px flex justify-center'>
                      <button
                        type='button'
                        disabled={loadingMoreMcp}
                        onClick={() => void handleLoadMoreMcp()}
                        className='h-34px px-20px rd-999px bg-base border border-solid border-[var(--color-border-2)] text-12.5px font-500 text-t-primary hover:bg-fill-2 cursor-pointer disabled:opacity-50'
                      >
                        {loadingMoreMcp ? '加载更多 MCP 中...' : '加载更多官方 Registry MCP'}
                      </button>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>

      <Modal
        title={configModalItem ? `配置 ${configModalItem.title}` : '配置 MCP 参数'}
        visible={Boolean(configModalItem)}
        onCancel={() => setConfigModalItem(null)}
        onOk={handleSubmitMcpConfig}
        confirmLoading={Boolean(configModalItem && installingId === configModalItem.id)}
        okText='确认并安装'
        cancelText='取消'
        style={{ width: 460, maxWidth: '92vw', borderRadius: 16 }}
      >
        <div className='box-border flex flex-col gap-12px'>
          {(configModalItem?.configFields || []).map((field) => (
            <div key={field.key}>
              <div className='text-12.5px font-500 text-t-primary mb-5px'>
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
      </Modal>
    </div>
  );
};

export default MarketplacePage;

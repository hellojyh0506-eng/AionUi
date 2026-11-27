/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import classNames from 'classnames';
import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Dropdown, Input, Menu, Message, Modal, Spin, Switch } from '@arco-design/web-react';
import { ipcBridge } from '@/common';
import type {
  KnowledgeCollection,
  KnowledgeCollectionDetail,
  KnowledgeDocument,
  KnowledgeSearchHit,
} from '@/common/types/knowledge';
import MarkdownView from '@/renderer/components/Markdown';
import { useLayoutContext } from '@/renderer/hooks/context/LayoutContext';
import SettingsPageHeader from '@/renderer/pages/settings/components/SettingsPageHeader';

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatExtLabel(ext: string): string {
  return ext.replace(/^\./u, '').toUpperCase() || 'DOC';
}

function extractLastPathSegment(rawPath: string): string {
  const parts = rawPath.split(/[\\/]/u);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (parts[i]) return parts[i];
  }
  return '我的知识空间';
}

const SparkleIcon = () => (
  <svg width='15' height='15' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round'>
    <path d='M12 3l1.9 5.2L19 10l-5.1 1.8L12 17l-1.9-5.2L5 10l5.1-1.8L12 3z' />
    <path d='M19 16l.9 2.1L22 19l-2.1.9L19 22l-.9-2.1L16 19l2.1-.9L19 16z' />
  </svg>
);

const FolderIcon = () => (
  <svg width='15' height='15' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.75' strokeLinecap='round' strokeLinejoin='round'>
    <path d='M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z' />
  </svg>
);

const SearchIcon = () => (
  <svg width='15' height='15' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round'>
    <circle cx='11' cy='11' r='7' />
    <path d='m20 20-3.5-3.5' />
  </svg>
);

const KnowledgePage: React.FC = () => {
  const layout = useLayoutContext();
  const isMobile = layout?.isMobile ?? false;
  const navigate = useNavigate();

  const [collections, setCollections] = useState<KnowledgeCollection[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<KnowledgeCollectionDetail | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [indexing, setIndexing] = useState(false);

  const [createVisible, setCreateVisible] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');

  const [addSourceVisible, setAddSourceVisible] = useState(false);
  const [includeCode, setIncludeCode] = useState(false);
  const [manualPathInput, setManualPathInput] = useState('');

  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchHits, setSearchHits] = useState<KnowledgeSearchHit[]>([]);
  const [hasSearched, setHasSearched] = useState(false);

  const [previewDoc, setPreviewDoc] = useState<{ title: string; relativePath: string; content: string } | null>(null);

  const loadCollections = useCallback(async (preferredId?: string | null) => {
    setLoadingList(true);
    try {
      const list = await ipcBridge.knowledge.listCollections.invoke();
      setCollections(list || []);
      const targetId =
        preferredId && (list || []).some((c) => c.id === preferredId)
          ? preferredId
          : (list || [])[0]?.id ?? null;
      setSelectedId(targetId);
    } catch (err) {
      Message.error(err instanceof Error ? err.message : '加载知识空间失败');
    } finally {
      setLoadingList(false);
    }
  }, []);

  const loadDetail = useCallback(async (collectionId: string | null) => {
    if (!collectionId) {
      setDetail(null);
      return;
    }
    setLoadingDetail(true);
    try {
      const res = await ipcBridge.knowledge.getCollectionDetail.invoke({ collectionId });
      setDetail(res);
    } catch {
      setDetail(null);
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  useEffect(() => {
    void loadCollections();
  }, [loadCollections]);

  useEffect(() => {
    void loadDetail(selectedId);
    setHasSearched(false);
    setSearchHits([]);
    setSearchQuery('');
  }, [selectedId, loadDetail]);

  const launchButlerCurator = useCallback(async () => {
    let pickedFolder = '';
    try {
      const paths = await ipcBridge.dialog.showOpen.invoke({ properties: ['openDirectory'] });
      pickedFolder = paths?.[0] || '';
    } catch {
      // fall through to manual prompt
    }

    const prompt = pickedFolder
      ? `请帮我把本地文件夹「${pickedFolder}」整理成一个客户端知识空间：\n1. 先调用 knowledge_scan_folder 盘点里面的文件类型；\n2. 默认优先筛选有学习/查阅价值的文档（如 .md/.docx/.xlsx/.txt），排除无关源码与杂项；\n3. 调用 knowledge_create_or_add 帮我建好知识空间，并生成一份清晰的知识梳理大纲。`
      : '我想让你帮我整理电脑里的某个本地文件夹并导入成为客户端知识空间。请先问我要哪个文件夹路径、偏好保留哪些文件后缀（如 .md / .docx / .txt），随后用 knowledge_scan_folder 与 knowledge_create_or_add 自动帮我建库。';

    void navigate('/guid', { state: { prefillPrompt: prompt } });
  }, [navigate]);

  // Shortcut: Ctrl+Shift+K launches AI Butler folder curation flow
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        void launchButlerCurator();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [launchButlerCurator]);

  const addSourcePathsToCollection = async (targetCollectionId: string, sourcePaths: string[], allowCode: boolean) => {
    if (sourcePaths.length === 0) return;
    setIndexing(true);
    try {
      const res = await ipcBridge.knowledge.addSources.invoke({
        collectionId: targetCollectionId,
        sourcePaths,
        includeCode: allowCode,
      });
      Message.success(
        `已收录 ${res.indexedFiles} 篇新资料${res.skippedFiles > 0 ? `（保留 ${res.skippedFiles} 篇未变更资料）` : ''}`
      );
      await Promise.all([loadCollections(targetCollectionId), loadDetail(targetCollectionId)]);
    } catch (err) {
      Message.error(err instanceof Error ? err.message : '导入资料失败');
    } finally {
      setIndexing(false);
    }
  };

  const handleQuickCreateFromFolder = async () => {
    try {
      const paths = await ipcBridge.dialog.showOpen.invoke({
        properties: ['openDirectory', 'multiSelections'],
      });
      if (!paths || paths.length === 0) return;
      const folderBase = extractLastPathSegment(paths[0]);
      setIndexing(true);
      try {
        const created = await ipcBridge.knowledge.createCollection.invoke({
          name: folderBase,
          sourcePaths: paths,
          includeCode: false,
        });
        Message.success(`已创建知识空间「${created.name}」，共收录 ${created.documentCount} 篇精选资料`);
        await loadCollections(created.id);
      } finally {
        setIndexing(false);
      }
    } catch {
      setCreateVisible(true);
    }
  };

  const handleCreateCollection = async () => {
    const name = newName.trim();
    if (!name) {
      Message.warning('请填写知识空间名称');
      return;
    }
    try {
      const created = await ipcBridge.knowledge.createCollection.invoke({
        name,
        description: newDesc.trim() || undefined,
      });
      setCreateVisible(false);
      setNewName('');
      setNewDesc('');
      Message.success(`已新建知识空间「${created.name}」`);
      await loadCollections(created.id);
    } catch (err) {
      Message.error(err instanceof Error ? err.message : '创建失败');
    }
  };

  const handlePickFolders = async () => {
    if (!selectedId) return;
    try {
      const paths = await ipcBridge.dialog.showOpen.invoke({
        properties: ['openDirectory', 'multiSelections'],
      });
      if (paths && paths.length > 0) {
        setAddSourceVisible(false);
        await addSourcePathsToCollection(selectedId, paths, includeCode);
      }
    } catch {
      Message.info('请在下方手动粘贴本地路径');
    }
  };

  const handlePickFiles = async () => {
    if (!selectedId) return;
    try {
      const paths = await ipcBridge.dialog.showOpen.invoke({
        properties: ['openFile', 'multiSelections'],
      });
      if (paths && paths.length > 0) {
        setAddSourceVisible(false);
        await addSourcePathsToCollection(selectedId, paths, includeCode);
      }
    } catch {
      Message.info('请在下方手动粘贴本地路径');
    }
  };

  const handleRefreshCollection = async () => {
    if (!selectedId) return;
    setIndexing(true);
    try {
      const res = await ipcBridge.knowledge.reindexCollection.invoke({
        collectionId: selectedId,
        force: true,
      });
      Message.success(`已刷新知识空间，共 ${res.collection.documentCount} 篇资料`);
      await Promise.all([loadCollections(selectedId), loadDetail(selectedId)]);
    } catch (err) {
      Message.error(err instanceof Error ? err.message : '刷新失败');
    } finally {
      setIndexing(false);
    }
  };

  const handleDeleteCollection = () => {
    if (!detail?.collection) return;
    const target = detail.collection;
    Modal.confirm({
      title: `移除知识空间「${target.name}」`,
      content: '仅清除客户端内的资料目录，不会删除你电脑上的原始文件。确认移除吗？',
      okText: '确认移除',
      cancelText: '取消',
      okButtonProps: { status: 'danger' },
      onOk: async () => {
        await ipcBridge.knowledge.deleteCollection.invoke({ collectionId: target.id });
        Message.success(`已移除「${target.name}」`);
        await loadCollections(null);
      },
    });
  };

  const handleRemoveDoc = async (doc: KnowledgeDocument) => {
    if (!selectedId) return;
    await ipcBridge.knowledge.removeDocument.invoke({ collectionId: selectedId, documentId: doc.id });
    Message.success(`已移除 ${doc.title}`);
    await Promise.all([loadCollections(selectedId), loadDetail(selectedId)]);
  };

  const handlePreviewDoc = async (doc: { collectionId: string; documentId?: string; title: string; relativePath: string }) => {
    try {
      const res = await ipcBridge.knowledge.readDocument.invoke({
        collectionId: doc.collectionId,
        documentId: doc.documentId,
      });
      if (!res.found || !res.content) {
        Message.warning(res.error || '未能读取该文档正文');
        return;
      }
      setPreviewDoc({ title: doc.title, relativePath: doc.relativePath, content: res.content });
    } catch (err) {
      Message.error(err instanceof Error ? err.message : '读取文档失败');
    }
  };

  const handleSearch = async () => {
    const q = searchQuery.trim();
    if (!q || !selectedId) return;
    setSearching(true);
    setHasSearched(true);
    try {
      const res = await ipcBridge.knowledge.search.invoke({
        query: q,
        collectionIds: [selectedId],
        topK: 8,
      });
      setSearchHits(res.hits || []);
    } catch (err) {
      Message.error(err instanceof Error ? err.message : '查找失败');
    } finally {
      setSearching(false);
    }
  };

  const startStudyModePrompt = (mode: 'outline' | 'feynman' | 'quiz' | 'ask', customSnippet?: string) => {
    const col = detail?.collection;
    if (!col) return;
    const refTag = `@知识库:${col.name}`;
    let prompt = '';
    if (mode === 'outline') {
      prompt = `${refTag} 请帮我梳理知识空间「${col.name}」内的核心资料，生成一份结构化的《知识体系导图与学习大纲》，列出最值得优先精读的关键文档与概念关联。`;
    } else if (mode === 'feynman') {
      prompt = `${refTag} 请以 Gemini Study Mode / 费曼互动教学模式，带我系统学习知识空间「${col.name}」的内容：先用 knowledge_list_collections / knowledge_search 概览主题后，每次只讲 1 个核心模块，并用 1 个启发式小问题检验我的理解后再继续下一节。`;
    } else if (mode === 'quiz') {
      prompt = `${refTag} 请结合知识空间「${col.name}」中的重点内容，为我出 5 道由浅入深的自测题（概念辨析 + 工程实战场景），等我作答后逐题点评解析。`;
    } else if (customSnippet) {
      prompt = `${refTag} 请结合资料中的这段内容进一步为我深入讲解：\n> ${customSnippet}`;
    } else {
      prompt = `${refTag} `;
    }
    void navigate('/guid', { state: { prefillPrompt: prompt } });
  };

  return (
    <div className='w-full h-full min-h-0 box-border bg-1 flex flex-col overflow-hidden'>
      <div
        className={classNames(
          'shrink-0 bg-1 border-b border-solid border-[var(--color-border-2)] border-x-0 border-t-0',
          isMobile ? 'px-16px pt-14px pb-12px' : 'px-16px pt-20px pb-16px md:px-36px md:pt-28px'
        )}
      >
        <div className='mx-auto w-full max-w-1180px'>
          <SettingsPageHeader
            sticky={false}
            title='知识空间'
            description='把本地笔记、手册与 Word / Excel 资料收进个人知识空间。支持 AI 梳理框架、费曼互动教学与对话中按需引用。'
            actions={
              <div className='flex items-center gap-8px flex-wrap'>
                <button
                  type='button'
                  onClick={() => void launchButlerCurator()}
                  className='h-32px px-14px rd-999px bg-base border border-solid border-[var(--color-border-2)] text-12.5px font-500 text-t-primary hover:bg-fill-2 cursor-pointer flex items-center gap-6px transition-colors'
                  title='快捷键 Ctrl+Shift+K'
                >
                  <SparkleIcon />
                  <span>AI 管家挑选建库</span>
                </button>
                <button
                  type='button'
                  onClick={() => setCreateVisible(true)}
                  className='h-32px px-16px b-none rd-999px text-12.5px font-600 cursor-pointer transition-opacity bg-[#111111] hover:opacity-85 text-[#ffffff] dark:bg-[#f5f5f7] dark:text-[#111111]'
                >
                  + 新建知识空间
                </button>
              </div>
            }
          />
        </div>
      </div>

      <div className='min-h-0 flex-1 overflow-y-auto px-16px py-20px md:px-36px md:py-24px'>
        <div className='mx-auto w-full max-w-1180px'>
          {loadingList && collections.length === 0 ? (
            <div className='py-64px flex justify-center'>
              <Spin size={24} />
            </div>
          ) : collections.length === 0 ? (
            /* Warm NotebookLM-style Launchpad for first-time users */
            <div className='mx-auto max-w-820px py-24px flex flex-col gap-20px'>
              <div className='text-center flex flex-col gap-8px'>
                <div className='text-22px font-600 text-t-primary tracking-tight'>打造你的专属学习与资料库</div>
                <div className='text-13.5px text-t-secondary max-w-540px mx-auto leading-relaxed'>
                  选一个放着笔记或手册的文件夹即可开始。平时聊天不会乱塞无关文档，仅在你需要学习、梳理或引用 `@知识库` 时精准取用。
                </div>
              </div>

              <div className='grid grid-cols-1 md:grid-cols-2 gap-14px'>
                <button
                  type='button'
                  disabled={indexing}
                  onClick={() => void handleQuickCreateFromFolder()}
                  className='text-left p-22px rd-16px bg-base border border-solid border-[var(--color-border-2)] hover:border-[var(--color-border-3)] cursor-pointer transition-all flex flex-col justify-between gap-14px'
                >
                  <div className='flex flex-col gap-8px'>
                    <div className='size-36px rd-10px bg-fill-2 flex items-center justify-center text-t-primary'>
                      <FolderIcon />
                    </div>
                    <div className='text-15px font-600 text-t-primary'>选一个文件夹，一键建库</div>
                    <div className='text-12.5px text-t-secondary leading-relaxed'>
                      自动收录笔记、Markdown、Word（.docx）、Excel 与 TXT 文档，智能过滤源码与构建缓存，不添乱。
                    </div>
                  </div>
                  <div className='text-12.5px font-600 text-t-primary'>
                    {indexing ? '正在读取资料...' : '选择本地文件夹 →'}
                  </div>
                </button>

                <button
                  type='button'
                  onClick={() => void launchButlerCurator()}
                  className='text-left p-22px rd-16px bg-base border border-solid border-[var(--color-border-2)] hover:border-[var(--color-border-3)] cursor-pointer transition-all flex flex-col justify-between gap-14px'
                >
                  <div className='flex flex-col gap-8px'>
                    <div className='size-36px rd-10px bg-fill-2 flex items-center justify-center text-t-primary'>
                      <SparkleIcon />
                    </div>
                    <div className='text-15px font-600 text-t-primary'>让 AI 管家按类型挑资料建库</div>
                    <div className='text-12.5px text-t-secondary leading-relaxed'>
                      目录文件太杂？交给 AI 管家先盘点文件夹里的后缀分布，你一句话定规则，自动建库并附带学习导图。
                    </div>
                  </div>
                  <div className='text-12.5px font-600 text-t-primary'>
                    唤醒管家整理（Ctrl+Shift+K）→
                  </div>
                </button>
              </div>
            </div>
          ) : (
            <div className='grid grid-cols-1 lg:grid-cols-[248px_1fr] gap-18px items-start'>
              {/* Left Space Rail */}
              <div className='flex flex-col gap-8px'>
                <div className='px-4px text-11.5px font-500 text-t-tertiary flex items-center justify-between'>
                  <span>我的知识空间 ({collections.length})</span>
                </div>
                {collections.map((col) => {
                  const active = col.id === selectedId;
                  return (
                    <button
                      key={col.id}
                      type='button'
                      onClick={() => setSelectedId(col.id)}
                      className={`w-full text-left px-14px py-12px rd-14px border border-solid cursor-pointer transition-all ${
                        active
                          ? 'bg-base border-[var(--color-text-3)] shadow-sm'
                          : 'bg-transparent border-transparent hover:bg-base/70 hover:border-[var(--color-border-2)]'
                      }`}
                    >
                      <div className='flex items-center justify-between gap-8px'>
                        <span className='text-13.5px font-600 text-t-primary truncate'>{col.name}</span>
                        <span className='text-11.5px text-t-tertiary shrink-0'>{col.documentCount} 篇</span>
                      </div>
                      <div className='mt-4px text-11.5px text-t-tertiary flex items-center justify-between'>
                        <span className='truncate'>{col.description || '本地资料空间'}</span>
                        <span className='shrink-0 ml-6px'>{formatBytes(col.totalBytes)}</span>
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Main Studio Pane */}
              <div className='min-w-0 flex flex-col gap-16px'>
                {!selectedId || !detail ? (
                  <div className='p-40px rd-16px bg-base border border-solid border-[var(--color-border-2)] flex justify-center'>
                    {loadingDetail ? <Spin size={22} /> : <span className='text-13px text-t-tertiary'>请选择一个知识空间</span>}
                  </div>
                ) : (
                  <>
                    {/* Studio Header */}
                    <div className='p-20px rd-16px bg-base border border-solid border-[var(--color-border-2)] flex flex-col gap-14px'>
                      <div className='flex items-start justify-between gap-12px flex-wrap'>
                        <div className='min-w-0 flex-1'>
                          <div className='flex items-center gap-10px flex-wrap'>
                            <h2 className='m-0 text-19px font-600 text-t-primary tracking-tight'>
                              {detail.collection.name}
                            </h2>
                            <span className='px-8px py-2px rd-999px bg-fill-2 text-11.5px text-t-secondary'>
                              {detail.collection.documentCount} 篇资料 · {formatBytes(detail.collection.totalBytes)}
                            </span>
                          </div>
                          {detail.collection.description && (
                            <p className='m-0 mt-5px text-13px text-t-secondary'>{detail.collection.description}</p>
                          )}
                          <div className='mt-6px text-12px text-t-tertiary'>
                            对话输入 <span className='font-mono text-t-secondary'>@知识库:{detail.collection.name}</span> 或点输入框左下角小书图标即可精准引用
                          </div>
                        </div>

                        <div className='flex items-center gap-8px shrink-0'>
                          <button
                            type='button'
                            disabled={indexing}
                            onClick={() => setAddSourceVisible(true)}
                            className='h-32px px-14px b-none rd-999px text-12.5px font-600 cursor-pointer transition-opacity bg-[#111111] hover:opacity-85 text-[#ffffff] dark:bg-[#f5f5f7] dark:text-[#111111] disabled:opacity-50'
                          >
                            {indexing ? '正在整理...' : '+ 添加资料'}
                          </button>

                          <Dropdown
                            trigger='click'
                            droplist={
                              <Menu
                                onClickMenuItem={(key) => {
                                  if (key === 'refresh') void handleRefreshCollection();
                                  else if (key === 'butler') void launchButlerCurator();
                                  else if (key === 'delete') handleDeleteCollection();
                                }}
                              >
                                <Menu.Item key='refresh'>同步最新文件夹变更</Menu.Item>
                                <Menu.Item key='butler'>让 AI 管家扩充资料</Menu.Item>
                                <Menu.Item key='delete'>
                                  <span className='text-[#ef4444]'>移除知识空间</span>
                                </Menu.Item>
                              </Menu>
                            }
                          >
                            <button
                              type='button'
                              className='w-32px h-32px rd-999px bg-fill-1 hover:bg-fill-2 border border-solid border-[var(--color-border-2)] text-14px text-t-secondary cursor-pointer flex items-center justify-center'
                              title='更多操作'
                            >
                              ···
                            </button>
                          </Dropdown>
                        </div>
                      </div>
                    </div>

                    {/* Study Mode & AI Curation Quick Cards */}
                    <div className='flex flex-col gap-10px'>
                      <div className='text-12.5px font-600 text-t-secondary px-2px'>AI 助学与内容梳理</div>
                      <div className='grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-10px'>
                        <button
                          type='button'
                          onClick={() => startStudyModePrompt('outline')}
                          className='text-left p-14px rd-14px bg-base border border-solid border-[var(--color-border-2)] hover:border-[var(--color-border-3)] hover:bg-fill-1/60 cursor-pointer transition-all flex flex-col gap-5px'
                        >
                          <div className='text-13.5px font-600 text-t-primary'>梳理知识导图</div>
                          <div className='text-12px text-t-tertiary leading-snug'>提炼体系大纲与核心概念脉络</div>
                        </button>

                        <button
                          type='button'
                          onClick={() => startStudyModePrompt('feynman')}
                          className='text-left p-14px rd-14px bg-base border border-solid border-[var(--color-border-2)] hover:border-[var(--color-border-3)] hover:bg-fill-1/60 cursor-pointer transition-all flex flex-col gap-5px'
                        >
                          <div className='text-13.5px font-600 text-t-primary'>费曼互动教学</div>
                          <div className='text-12px text-t-tertiary leading-snug'>Study Mode 循序讲解+提问验收</div>
                        </button>

                        <button
                          type='button'
                          onClick={() => startStudyModePrompt('quiz')}
                          className='text-left p-14px rd-14px bg-base border border-solid border-[var(--color-border-2)] hover:border-[var(--color-border-3)] hover:bg-fill-1/60 cursor-pointer transition-all flex flex-col gap-5px'
                        >
                          <div className='text-13.5px font-600 text-t-primary'>出题自测演练</div>
                          <div className='text-12px text-t-tertiary leading-snug'>围绕难点生成 5 题并逐题讲解</div>
                        </button>

                        <button
                          type='button'
                          onClick={() => startStudyModePrompt('ask')}
                          className='text-left p-14px rd-14px bg-base border border-solid border-[var(--color-border-2)] hover:border-[var(--color-border-3)] hover:bg-fill-1/60 cursor-pointer transition-all flex flex-col gap-5px'
                        >
                          <div className='text-13.5px font-600 text-t-primary'>带入新对话提问</div>
                          <div className='text-12px text-t-tertiary leading-snug'>自动挂载空间并开始自由讨论</div>
                        </button>
                      </div>
                    </div>

                    {/* Search & Editorial Document Feed */}
                    <div className='p-20px rd-16px bg-base border border-solid border-[var(--color-border-2)] flex flex-col gap-16px'>
                      <div className='flex items-center gap-8px'>
                        <div className='flex-1 min-w-0'>
                          <Input
                            prefix={<SearchIcon />}
                            value={searchQuery}
                            onChange={setSearchQuery}
                            onPressEnter={() => void handleSearch()}
                            placeholder='在当前知识空间内查找知识点、概念或关键词...'
                            allowClear
                          />
                        </div>
                        <button
                          type='button'
                          disabled={searching || !searchQuery.trim()}
                          onClick={() => void handleSearch()}
                          className='h-32px px-14px rd-999px bg-fill-2 hover:bg-fill-3 border border-solid border-[var(--color-border-2)] text-12.5px font-500 text-t-primary cursor-pointer shrink-0 disabled:opacity-45'
                        >
                          {searching ? '查找中...' : '查找'}
                        </button>
                      </div>

                      {hasSearched && (
                        <div className='flex flex-col gap-8px pb-12px border-b border-solid border-[var(--color-border-2)] border-x-0 border-t-0'>
                          <div className='text-12px font-500 text-t-tertiary'>
                            {searchHits.length > 0 ? `找到 ${searchHits.length} 篇相关资料` : '未找到直接匹配的段落，试试换个核心词'}
                          </div>
                          {searchHits.map((hit) => (
                            <div
                              key={hit.chunkId}
                              className='p-12px rd-12px bg-fill-1 border border-solid border-[var(--color-border-2)] flex flex-col gap-6px'
                            >
                              <div className='flex items-center justify-between gap-10px'>
                                <span className='text-13px font-600 text-t-primary truncate'>{hit.title}</span>
                                <div className='flex items-center gap-6px shrink-0'>
                                  <button
                                    type='button'
                                    onClick={() =>
                                      void handlePreviewDoc({
                                        collectionId: hit.collectionId,
                                        documentId: hit.documentId,
                                        title: hit.title,
                                        relativePath: hit.relativePath,
                                      })
                                    }
                                    className='px-8px py-3px rd-6px bg-base border border-solid border-[var(--color-border-2)] text-11.5px text-t-primary hover:bg-fill-2 cursor-pointer'
                                  >
                                    阅读全文
                                  </button>
                                  <button
                                    type='button'
                                    onClick={() => startStudyModePrompt('ask', hit.snippet)}
                                    className='px-8px py-3px rd-6px bg-base border border-solid border-[var(--color-border-2)] text-11.5px text-t-secondary hover:text-t-primary hover:bg-fill-2 cursor-pointer'
                                  >
                                    就这段提问
                                  </button>
                                </div>
                              </div>
                              <div className='text-12px text-t-secondary leading-relaxed'>{hit.snippet}</div>
                            </div>
                          ))}
                        </div>
                      )}

                      <div className='flex items-center justify-between'>
                        <span className='text-13.5px font-600 text-t-primary'>已收录资料</span>
                        <span className='text-12px text-t-tertiary'>{detail.documents.length} 篇</span>
                      </div>

                      {detail.documents.length === 0 ? (
                        <div className='py-28px text-center text-13px text-t-tertiary'>
                          还没有资料，点击右上角「+ 添加资料」导入文件夹或文档即可开始。
                        </div>
                      ) : (
                        <div className='flex flex-col divide-y divide-[var(--color-border-1)]'>
                          {detail.documents.map((doc) => (
                            <div
                              key={doc.id}
                              className='py-10px px-6px flex items-center justify-between gap-12px hover:bg-fill-1/60 rd-8px transition-colors'
                            >
                              <div className='min-w-0 flex-1 flex items-center gap-10px'>
                                <span className='px-6px py-2px rd-6px bg-fill-2 text-10.5px font-600 font-mono text-t-secondary shrink-0'>
                                  {formatExtLabel(doc.ext)}
                                </span>
                                <div className='min-w-0 flex-1'>
                                  <div className='text-13px font-500 text-t-primary truncate' title={doc.title}>
                                    {doc.title}
                                  </div>
                                  <div className='text-11.5px text-t-tertiary truncate' title={doc.filePath}>
                                    {doc.relativePath} · {formatBytes(doc.sizeBytes)}
                                  </div>
                                </div>
                              </div>

                              <div className='flex items-center gap-6px shrink-0'>
                                <button
                                  type='button'
                                  onClick={() =>
                                    void handlePreviewDoc({
                                      collectionId: doc.collectionId,
                                      documentId: doc.id,
                                      title: doc.title,
                                      relativePath: doc.relativePath,
                                    })
                                  }
                                  className='px-10px py-4px rd-999px bg-fill-1 hover:bg-fill-2 border border-solid border-[var(--color-border-2)] text-12px text-t-primary cursor-pointer'
                                >
                                  阅读
                                </button>
                                <button
                                  type='button'
                                  onClick={() => void handleRemoveDoc(doc)}
                                  className='px-8px py-4px rd-999px bg-transparent hover:bg-[#ef4444]/10 border-none text-12px text-t-tertiary hover:text-[#dc2626] cursor-pointer'
                                >
                                  移除
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Create Space Modal */}
      <Modal
        title='新建知识空间'
        visible={createVisible}
        onCancel={() => setCreateVisible(false)}
        onOk={() => void handleCreateCollection()}
        okText='创建空间'
        cancelText='取消'
        style={{ width: 440, maxWidth: '92vw', borderRadius: 16 }}
      >
        <div className='flex flex-col gap-12px'>
          <div>
            <div className='text-12.5px font-500 text-t-primary mb-4px'>空间名称</div>
            <Input value={newName} onChange={setNewName} placeholder='例如：机器视觉学习笔记、产品需求方案' />
          </div>
          <div>
            <div className='text-12.5px font-500 text-t-primary mb-4px'>简单说明（可选）</div>
            <Input value={newDesc} onChange={setNewDesc} placeholder='写一句方便区分里面放了什么资料' />
          </div>
        </div>
      </Modal>

      {/* Add Sources Modal */}
      <Modal
        title='添加资料到当前知识空间'
        visible={addSourceVisible}
        onCancel={() => setAddSourceVisible(false)}
        footer={null}
        style={{ width: 480, maxWidth: '92vw', borderRadius: 16 }}
      >
        <div className='flex flex-col gap-14px'>
          <div className='grid grid-cols-2 gap-10px'>
            <button
              type='button'
              onClick={() => void handlePickFolders()}
              className='p-14px rd-12px bg-fill-1 hover:bg-fill-2 border border-solid border-[var(--color-border-2)] text-left cursor-pointer'
            >
              <div className='text-13.5px font-600 text-t-primary'>选择文件夹</div>
              <div className='mt-2px text-11.5px text-t-tertiary'>自动扫描笔记与文档</div>
            </button>
            <button
              type='button'
              onClick={() => void handlePickFiles()}
              className='p-14px rd-12px bg-fill-1 hover:bg-fill-2 border border-solid border-[var(--color-border-2)] text-left cursor-pointer'
            >
              <div className='text-13.5px font-600 text-t-primary'>挑选单个文件</div>
              <div className='mt-2px text-11.5px text-t-tertiary'>支持 md / docx / xlsx / txt</div>
            </button>
          </div>

          <div className='flex items-center justify-between px-12px py-10px rd-10px bg-fill-1 border border-solid border-[var(--color-border-2)]'>
            <div>
              <div className='text-12.5px font-500 text-t-primary'>同时收录文件夹内的源码</div>
              <div className='text-11.5px text-t-tertiary'>默认关闭，仅导入笔记与文档以保持检索精准</div>
            </div>
            <Switch size='small' checked={includeCode} onChange={setIncludeCode} />
          </div>

          <div className='flex flex-col gap-6px'>
            <div className='text-12px font-500 text-t-secondary'>或者直接粘贴文件/文件夹路径（每行一个）：</div>
            <Input.TextArea
              rows={3}
              value={manualPathInput}
              onChange={setManualPathInput}
              placeholder='例如：D:\machine-visual\docs'
            />
            <div className='flex justify-end'>
              <button
                type='button'
                disabled={!manualPathInput.trim() || indexing}
                onClick={() => {
                  if (!selectedId) return;
                  const paths = manualPathInput
                    .split(/\r?\n/u)
                    .map((s) => s.trim())
                    .filter(Boolean);
                  setAddSourceVisible(false);
                  setManualPathInput('');
                  void addSourcePathsToCollection(selectedId, paths, includeCode);
                }}
                className='h-30px px-14px b-none rd-999px text-12px font-600 cursor-pointer bg-[#111111] text-[#ffffff] dark:bg-[#f5f5f7] dark:text-[#111111] disabled:opacity-45'
              >
                导入这些路径
              </button>
            </div>
          </div>
        </div>
      </Modal>

      {/* Clean Markdown Document Reader Modal */}
      <Modal
        title={
          previewDoc
            ? !previewDoc.relativePath || previewDoc.relativePath === previewDoc.title
              ? previewDoc.title
              : `${previewDoc.title} · ${previewDoc.relativePath}`
            : '阅读资料'
        }
        visible={Boolean(previewDoc)}
        onCancel={() => setPreviewDoc(null)}
        footer={null}
        style={{ width: 820, maxWidth: '94vw', borderRadius: 16 }}
      >
        <div className='max-h-72vh overflow-y-auto px-10px py-4px text-13.5px leading-relaxed select-text'>
          {previewDoc && <MarkdownView>{previewDoc.content}</MarkdownView>}
        </div>
      </Modal>
    </div>
  );
};

export default KnowledgePage;

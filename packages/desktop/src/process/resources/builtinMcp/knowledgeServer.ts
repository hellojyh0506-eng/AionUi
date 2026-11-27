/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Built-in MCP server for local Knowledge Base search & document reading,
 * also serving an interactive `@modelcontextprotocol/ext-apps` UI widget (`ui://`).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { MCP_APPS_MIME_TYPE } from '@/common/types/mcpApps';
import {
  addSourcesToKnowledgeCollection,
  createKnowledgeCollection,
} from '@/process/services/knowledge/knowledgeIndexer';
import {
  listKnowledgeCollections,
  readKnowledgeDocument,
  resolveFallbackKnowledgeDir,
  searchKnowledgeBase,
} from '@/process/services/knowledge/knowledgeStore';
import { scanFolderSummary } from '@/process/services/knowledge/textExtractor';
import { BUILTIN_KNOWLEDGE_MCP_NAME } from './constants';

const KNOWLEDGE_WIDGET_URI = 'ui://aionui-knowledge/search-results';

function buildKnowledgeSearchWidgetHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>本地知识库检索面板</title>
<style>
  :root {
    --bg: #ffffff;
    --surface: #f7f8fa;
    --border: #e5e6eb;
    --text: #1d2129;
    --muted: #6b7280;
    --accent: #111827;
    --accent-fg: #ffffff;
    --tag-bg: #eef2ff;
    --tag-fg: #3730a3;
  }
  [data-theme="dark"] {
    --bg: #16181d;
    --surface: #1e2128;
    --border: #2e333e;
    --text: #f3f4f6;
    --muted: #9ca3af;
    --accent: #f3f4f6;
    --accent-fg: #111827;
    --tag-bg: #1e293b;
    --tag-fg: #93c5fd;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 12px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
    background: var(--bg);
    color: var(--text);
    font-size: 13px;
    line-height: 1.5;
  }
  .toolbar {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-bottom: 10px;
  }
  .search-input {
    flex: 1;
    height: 32px;
    padding: 0 10px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    font-size: 13px;
    outline: none;
  }
  .btn {
    height: 32px;
    padding: 0 12px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--accent);
    color: var(--accent-fg);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
  }
  .btn-ghost {
    height: 26px;
    padding: 0 8px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--muted);
    font-size: 11px;
    cursor: pointer;
  }
  .btn-ghost:hover { color: var(--text); background: var(--surface); }
  .meta { font-size: 11.5px; color: var(--muted); margin-bottom: 10px; display: flex; justify-content: space-between; }
  .hits { display: flex; flex-direction: column; gap: 8px; }
  .card {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 10px 12px;
    background: var(--surface);
  }
  .card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
  .card-title { font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge {
    font-size: 11px;
    padding: 1px 6px;
    border-radius: 999px;
    background: var(--tag-bg);
    color: var(--tag-fg);
    flex-shrink: 0;
  }
  .path { font-size: 11px; color: var(--muted); margin-bottom: 6px; word-break: break-all; }
  .snippet { font-size: 12.5px; white-space: pre-wrap; word-break: break-word; }
  .card-actions { display: flex; gap: 6px; margin-top: 8px; }
  .doc-viewer {
    margin-top: 8px;
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--bg);
    max-height: 220px;
    overflow: auto;
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 11.5px;
    white-space: pre-wrap;
  }
  .empty { text-align: center; padding: 24px 12px; color: var(--muted); }
</style>
</head>
<body>
  <div class="toolbar">
    <input id="q" class="search-input" placeholder="输入关键词继续在本地知识库中检索..." />
    <button id="searchBtn" class="btn">检索</button>
  </div>
  <div class="meta">
    <span id="summaryText">等待接收检索结果...</span>
    <span id="countText"></span>
  </div>
  <div id="hits" class="hits"></div>

<script>
(function () {
  var nextId = 1;
  var pending = new Map();
  var state = { query: '', hits: [], totalIndexedChunks: 0 };
  var docContents = new Map();
  var expandedDocs = new Set();

  function postRpc(method, params, isNotif) {
    var payload = { jsonrpc: '2.0', method: method, params: params || {} };
    if (isNotif) {
      window.parent.postMessage(payload, '*');
      return Promise.resolve();
    }
    var id = nextId++;
    payload.id = id;
    return new Promise(function (resolve, reject) {
      pending.set(id, { resolve: resolve, reject: reject });
      window.parent.postMessage(payload, '*');
    });
  }

  function notifyHeight() {
    var h = Math.max(180, Math.min(640, document.documentElement.scrollHeight + 4));
    postRpc('ui/notifications/size-changed', { height: h }, true);
  }

  function esc(str) {
    return String(str || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function render() {
    var qEl = document.getElementById('q');
    if (document.activeElement !== qEl) qEl.value = state.query || '';
    document.getElementById('summaryText').textContent = state.query
      ? '关键词：“' + state.query + '” · 已检索 ' + (state.totalIndexedChunks || 0) + ' 个切片'
      : '本地知识库交互检索面板';
    document.getElementById('countText').textContent = '命中 ' + (state.hits || []).length + ' 条';

    var container = document.getElementById('hits');
    if (!state.hits || state.hits.length === 0) {
      container.innerHTML = '<div class="empty">暂无匹配片段，可尝试更换关键词或先在“知识库”页面导入文件夹。</div>';
      requestAnimationFrame(notifyHeight);
      return;
    }

    container.innerHTML = state.hits.map(function (hit, idx) {
      var key = hit.collectionId + ':' + hit.documentId;
      var isOpen = expandedDocs.has(key);
      var docBody = docContents.get(key);
      return '<div class="card">' +
        '<div class="card-head">' +
          '<span class="card-title">' + esc(hit.title) + '</span>' +
          '<span class="badge">' + esc(hit.collectionName) + ' · 相关度 ' + esc(hit.score) + '</span>' +
        '</div>' +
        '<div class="path">' + esc(hit.relativePath) + '</div>' +
        '<div class="snippet">' + esc(hit.snippet || hit.content) + '</div>' +
        '<div class="card-actions">' +
          '<button class="btn-ghost" data-read="' + idx + '">' + (isOpen ? '收起原文' : '查看全文') + '</button>' +
          '<button class="btn-ghost" data-cite="' + idx + '">插入追问</button>' +
        '</div>' +
        (isOpen ? '<div class="doc-viewer">' + esc(docBody || '加载原文中...') + '</div>' : '') +
      '</div>';
    }).join('');

    Array.from(container.querySelectorAll('[data-read]')).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var hit = state.hits[Number(btn.getAttribute('data-read'))];
        if (!hit) return;
        var key = hit.collectionId + ':' + hit.documentId;
        if (expandedDocs.has(key)) {
          expandedDocs.delete(key);
          render();
          return;
        }
        expandedDocs.add(key);
        render();
        if (!docContents.has(key)) {
          postRpc('tools/call', {
            name: 'knowledge_read_document',
            arguments: { collectionId: hit.collectionId, documentId: hit.documentId }
          }).then(function (res) {
            var text = (res && res.content && res.content[0] && res.content[0].text) || '未能读取文档正文';
            docContents.set(key, text);
            render();
          }).catch(function () {
            docContents.set(key, '读取失败');
            render();
          });
        }
      });
    });

    Array.from(container.querySelectorAll('[data-cite]')).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var hit = state.hits[Number(btn.getAttribute('data-cite'))];
        if (!hit) return;
        postRpc('ui/message', {
          content: [{ type: 'text', text: '请结合知识库文件「' + hit.relativePath + '」进一步解释这部分内容。' }]
        });
      });
    });

    requestAnimationFrame(notifyHeight);
  }

  function applyResult(result) {
    var sc = (result && result.structuredContent) || {};
    if (Array.isArray(sc.hits)) {
      state = {
        query: sc.query || state.query || '',
        hits: sc.hits,
        totalIndexedChunks: sc.totalIndexedChunks || 0
      };
      render();
    }
  }

  function runSearch() {
    var q = document.getElementById('q').value.trim();
    if (!q) return;
    state.query = q;
    postRpc('tools/call', {
      name: 'knowledge_search',
      arguments: { query: q, topK: 8 }
    }).then(applyResult).catch(function () {});
  }

  document.getElementById('searchBtn').addEventListener('click', runSearch);
  document.getElementById('q').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') runSearch();
  });

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.jsonrpc !== '2.0') return;
    if (data.id !== undefined && pending.has(data.id)) {
      var h = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) h.reject(data.error);
      else h.resolve(data.result);
      return;
    }
    if (data.method === 'ui/notifications/tool-input' && data.params && data.params.arguments) {
      if (data.params.arguments.query) {
        state.query = data.params.arguments.query;
        render();
      }
    } else if (data.method === 'ui/notifications/tool-result') {
      applyResult(data.params);
    } else if (data.method === 'ui/notifications/host-context-changed' && data.params && data.params.theme) {
      document.documentElement.setAttribute('data-theme', data.params.theme);
    }
  });

  postRpc('ui/initialize', {
    appInfo: { name: 'aionui-knowledge-widget', version: '1.0.0' },
    appCapabilities: {},
    protocolVersion: '2026-01-26'
  }).then(function (initRes) {
    if (initRes && initRes.hostContext && initRes.hostContext.theme) {
      document.documentElement.setAttribute('data-theme', initRes.hostContext.theme);
    }
    postRpc('ui/notifications/initialized', {}, true);
    render();
  }).catch(function () {
    render();
  });
})();
</script>
</body>
</html>`;
}

async function main() {
  const knowledgeDir = resolveFallbackKnowledgeDir();

  const server = new McpServer({
    name: BUILTIN_KNOWLEDGE_MCP_NAME,
    version: '1.0.0',
  });

  server.registerResource(
    'knowledge-search-results',
    KNOWLEDGE_WIDGET_URI,
    {
      title: '本地知识库交互检索组件',
      description: '在聊天消息内交互式浏览检索命中的本地知识库段落与查看原文。',
      mimeType: MCP_APPS_MIME_TYPE,
    },
    async () => ({
      contents: [
        {
          uri: KNOWLEDGE_WIDGET_URI,
          mimeType: MCP_APPS_MIME_TYPE,
          text: buildKnowledgeSearchWidgetHtml(),
          _meta: {
            ui: {
              prefersBorder: true,
            },
          },
        },
      ],
    })
  );

  server.registerTool(
    'knowledge_list_collections',
    {
      title: '列出本地知识库',
      description: '列出用户已导入并建立索引的全部本地知识库集合及文档数量。',
      inputSchema: {},
    },
    async () => {
      const collections = listKnowledgeCollections(knowledgeDir);
      const summary =
        collections.length === 0
          ? '当前尚未创建任何本地知识库。请先在客户端左侧“知识库”页面新建并导入文档。'
          : collections
              .map(
                (c) =>
                  `- **${c.name}** (ID: \`${c.id}\`) · ${c.documentCount} 篇文档 · ${c.chunkCount} 个索引切片`
              )
              .join('\n');
      return {
        content: [{ type: 'text' as const, text: summary }],
        structuredContent: { collections },
      };
    }
  );

  server.registerTool(
    'knowledge_search',
    {
      title: '检索本地知识库',
      description: '在用户本地知识库中进行中英文 BM25 全文检索，返回最相关的文档段落与引用来源。',
      inputSchema: {
        query: z.string().describe('搜索关键词或问题核心词'),
        collectionIds: z.array(z.string()).optional().describe('可选，限定只在指定知识库 ID 列表中检索'),
        topK: z.number().int().min(1).max(20).optional().describe('返回前 K 条最相关片段，默认 6'),
      },
      _meta: {
        ui: {
          resourceUri: KNOWLEDGE_WIDGET_URI,
          visibility: ['model', 'app'],
        },
      },
    },
    async ({ query, collectionIds, topK }) => {
      const result = searchKnowledgeBase(knowledgeDir, {
        query,
        collectionIds,
        topK: topK ?? 6,
      });

      const formatted =
        result.hits.length === 0
          ? `未在本地知识库中找到与「${result.query}」相关的内容（共扫描 ${result.totalIndexedChunks} 个切片）。`
          : result.hits
              .map(
                (hit, idx) =>
                  `### [${idx + 1}] ${hit.title}（${hit.collectionName} · 相关度 ${hit.score}）\n路径：\`${hit.relativePath}\`\n\n${hit.content}`
              )
              .join('\n\n---\n\n');

      return {
        content: [{ type: 'text' as const, text: formatted }],
        structuredContent: {
          query: result.query,
          totalIndexedChunks: result.totalIndexedChunks,
          hits: result.hits,
        },
        _meta: {
          ui: {
            resourceUri: KNOWLEDGE_WIDGET_URI,
          },
        },
      };
    }
  );

  server.registerTool(
    'knowledge_read_document',
    {
      title: '读取知识库文档全文',
      description: '读取本地知识库中某篇已索引文档的完整内容。',
      inputSchema: {
        collectionId: z.string().describe('知识库集合 ID'),
        documentId: z.string().optional().describe('文档 ID（优先使用）'),
        filePath: z.string().optional().describe('文档路径或相对路径'),
      },
      _meta: {
        ui: {
          visibility: ['model', 'app'],
        },
      },
    },
    async ({ collectionId, documentId, filePath }) => {
      const res = readKnowledgeDocument(knowledgeDir, {
        collectionId,
        documentId,
        filePath,
      });
      if (!res.found || !res.content) {
        return {
          content: [{ type: 'text' as const, text: res.error || '未找到对应文档' }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: res.content }],
      };
    }
  );

  server.registerTool(
    'knowledge_scan_folder',
    {
      title: '扫描目录文件分布',
      description:
        '扫描指定本地目录内的文件后缀分布和样例文件列表，便于 AI 管家帮助用户挑选适合导入知识库的笔记/文档后缀，避开源码和无关数据文件。',
      inputSchema: {
        folderPath: z.string().describe('待检查的本地文件夹绝对路径'),
      },
    },
    async ({ folderPath }) => {
      const summary = scanFolderSummary(folderPath);
      const lines =
        summary.byExtension.length === 0
          ? `目录 \`${summary.rootPath}\` 下未发现支持索引的文本/文档文件。`
          : summary.byExtension
              .map((g) => `- **${g.ext}** (${g.count} 个文件)：例如 ${g.samples.map((s) => `\`${s}\``).join('、')}`)
              .join('\n');
      return {
        content: [
          {
            type: 'text' as const,
            text: `目录 \`${summary.rootPath}\` 共发现 ${summary.totalFiles} 个候选文件：\n${lines}`,
          },
        ],
        structuredContent: summary as unknown as Record<string, unknown>,
      };
    }
  );

  server.registerTool(
    'knowledge_create_or_add',
    {
      title: '创建或导入本地知识空间',
      description:
        '创建新的本地知识空间（或向已有知识空间追加资料），支持通过 allowedExtensions 仅挑选特定后缀（如 .md/.docx/.txt）导入并自动建立本地索引。',
      inputSchema: {
        name: z.string().describe('知识空间名称（若同名知识空间已存在则向其追加资料）'),
        description: z.string().optional().describe('可选简介，说明这套资料的用途'),
        collectionId: z.string().optional().describe('可选已有知识空间 ID'),
        sourcePaths: z.array(z.string()).min(1).describe('要导入的一个或多个本地目录/文件绝对路径'),
        allowedExtensions: z
          .array(z.string())
          .optional()
          .describe('可选白名单后缀（如 [".md", ".docx", ".txt"]），指定后仅收录这些类型的文件'),
        includeCode: z.boolean().optional().describe('是否同时收录源代码文件（默认 false，仅收录笔记与文档）'),
      },
    },
    async ({ name, description, collectionId, sourcePaths, allowedExtensions, includeCode }) => {
      const existingList = listKnowledgeCollections(knowledgeDir);
      const matched =
        (collectionId ? existingList.find((c) => c.id === collectionId) : undefined) ||
        existingList.find((c) => c.name.trim().toLowerCase() === name.trim().toLowerCase());

      if (matched) {
        const res = await addSourcesToKnowledgeCollection(knowledgeDir, {
          collectionId: matched.id,
          sourcePaths,
          allowedExtensions,
          includeCode,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: `已向知识空间「${res.collection.name}」(ID: \`${res.collection.id}\`) 追加并完成索引：新增/更新 ${res.indexedFiles} 篇，跳过未变更 ${res.skippedFiles} 篇，当前共 ${res.collection.documentCount} 篇文档。`,
            },
          ],
          structuredContent: { collection: res.collection, indexedFiles: res.indexedFiles },
        };
      }

      const created = await createKnowledgeCollection(knowledgeDir, {
        name,
        description,
        sourcePaths,
        allowedExtensions,
        includeCode,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: `已成功新建本地知识空间「${created.name}」(ID: \`${created.id}\`)，共收录 ${created.documentCount} 篇精选资料。用户现在可在对话中用 @知识库:${created.name} 或左下角知识库按钮随时引用它。`,
          },
        ],
        structuredContent: { collection: created },
      };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('[KnowledgeMCP] Fatal error:', error);
  process.exit(1);
});

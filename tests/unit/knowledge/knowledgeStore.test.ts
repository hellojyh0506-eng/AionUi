/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addSourcesToKnowledgeCollection,
  createKnowledgeCollection,
  reindexKnowledgeCollection,
} from '@/process/services/knowledge/knowledgeIndexer';
import {
  chunkDocumentText,
  deleteKnowledgeCollection,
  getKnowledgeCollectionDetail,
  listKnowledgeCollections,
  readKnowledgeDocument,
  removeDocumentFromCollection,
  searchKnowledgeBase,
  tokenizeText,
} from '@/process/services/knowledge/knowledgeStore';
import { scanFolderSummary } from '@/process/services/knowledge/textExtractor';

describe('local knowledge base engine', () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    while (tmpRoots.length > 0) {
      fs.rmSync(tmpRoots.pop()!, { recursive: true, force: true });
    }
  });

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpRoots.push(dir);
    return dir;
  }

  it('tokenizes mixed Chinese bigrams and English identifiers while filtering stopwords', () => {
    const tokens = tokenizeText('帮我看下Halcon视觉检测 ocr_engine 的报错怎么处理');
    expect(tokens).toContain('halcon');
    expect(tokens).toContain('ocr_engine');
    expect(tokens).toContain('视觉');
    expect(tokens).toContain('觉检');
    expect(tokens).toContain('报错');
    // Single filler chars should not pollute BM25 matches across unrelated files.
    expect(tokens).not.toContain('的');
    expect(tokens).not.toContain('我');
  });

  it('splits long Markdown cleanly by sections with bounded chunks', () => {
    const body = ['# 第一章 架构', 'A'.repeat(450), '## 第二章 部署流程', 'B'.repeat(450)].join('\n\n');
    const chunks = chunkDocumentText(body, 500, 50);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.every((c) => c.length <= 500)).toBe(true);
  });

  it('filters code by default on directory scan, supports Butler folder summary, deduplicates per doc, and rejects noise hits', async () => {
    const dataDir = makeTempDir('aionui-kb-data-');
    const docsDir = makeTempDir('aionui-kb-docs-');

    fs.writeFileSync(
      path.join(docsDir, 'halcon-ocr-guide.md'),
      '# Halcon OCR 字符训练与识别\n\n当出现**笔画粘连**时，建议开启 `erosion_circle` 拆分并校验 trf 样本均衡度。\n\n## 第二节 阈值调优\n\n配合 Halcon OCR 动态阈值分割与连通域筛选，进一步减少笔画粘连。\n',
      'utf-8'
    );
    fs.mkdirSync(path.join(docsDir, 'nested'), { recursive: true });
    fs.writeFileSync(
      path.join(docsDir, 'nested', 'deploy-notes.txt'),
      'Windows 打包前需运行 tsc --noEmit 与 electron-vite build。\n',
      'utf-8'
    );
    // Code/data files in folder must be skipped unless includeCode or allowedExtensions is passed.
    fs.writeFileSync(path.join(docsDir, 'Form1.cs'), 'public class Form1 { /* 图片浏览器 */ }', 'utf-8');
    fs.writeFileSync(path.join(docsDir, 'slides_data.js'), 'export const slides = [{ x: 1 }];', 'utf-8');
    fs.mkdirSync(path.join(docsDir, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(docsDir, 'node_modules', 'ignored.md'), 'should never be indexed', 'utf-8');

    const scan = scanFolderSummary(docsDir);
    expect(scan.totalFiles).toBe(4);
    expect(scan.byExtension.map((e) => e.ext)).toContain('.cs');

    const collection = await createKnowledgeCollection(dataDir, {
      name: '工业视觉手册',
      description: '内部经验库',
      sourcePaths: [docsDir],
    });
    expect(collection.documentCount).toBe(2);
    expect(collection.chunkCount).toBeGreaterThanOrEqual(2);
    expect(listKnowledgeCollections(dataDir)).toHaveLength(1);

    // Incremental add skips unchanged files.
    const secondRun = await addSourcesToKnowledgeCollection(dataDir, {
      collectionId: collection.id,
      sourcePaths: [docsDir],
    });
    expect(secondRun.indexedFiles).toBe(0);
    expect(secondRun.skippedFiles).toBe(2);

    // Force reindex re-processes everything.
    const forced = await reindexKnowledgeCollection(dataDir, { collectionId: collection.id, force: true });
    expect(forced.indexedFiles).toBe(2);

    // Chinese BM25 query hits Halcon guide once per document and strips Markdown markup from snippet.
    const cnHits = searchKnowledgeBase(dataDir, { query: 'Halcon 笔画粘连怎么处理', topK: 5 });
    expect(cnHits.hits.length).toBe(1);
    expect(cnHits.hits[0].title).toBe('halcon-ocr-guide.md');
    expect(cnHits.hits[0].snippet).not.toContain('**');

    // Unrelated query with filler words must return 0 hits instead of junk matches.
    const unrelatedHits = searchKnowledgeBase(dataDir, { query: '你帮我看一下UU远程能发消息吗', topK: 5 });
    expect(unrelatedHits.hits).toHaveLength(0);

    // Explicit allowedExtensions allows Butler to opt in specific file suffixes.
    const codeCol = await createKnowledgeCollection(dataDir, {
      name: '源码库',
      sourcePaths: [docsDir],
      allowedExtensions: ['.cs'],
    });
    expect(codeCol.documentCount).toBe(1);

    // Read full document content by documentId.
    const docRead = readKnowledgeDocument(dataDir, {
      collectionId: collection.id,
      documentId: cnHits.hits[0].documentId,
    });
    expect(docRead.found).toBe(true);
    expect(docRead.content).toContain('erosion_circle');

    // Document removal & collection deletion update cleanly.
    const detailBefore = getKnowledgeCollectionDetail(dataDir, collection.id);
    expect(detailBefore?.documents).toHaveLength(2);
    const afterRemove = removeDocumentFromCollection(dataDir, collection.id, cnHits.hits[0].documentId);
    expect(afterRemove?.documentCount).toBe(1);

    expect(deleteKnowledgeCollection(dataDir, collection.id)).toBe(true);
    expect(deleteKnowledgeCollection(dataDir, codeCol.id)).toBe(true);
    expect(listKnowledgeCollections(dataDir)).toHaveLength(0);
  });

  it('preserves multi-row Markdown tables without chunk breaks or duplicate rows when reading', async () => {
    const dataDir = makeTempDir('aionui-kb-table-data-');
    const docsDir = makeTempDir('aionui-kb-table-docs-');
    const tableRows = Array.from(
      { length: 28 },
      (_, i) => `| 选型项目 ${i + 1} | \`Task.Run(...)\` | \`new Thread(...)\` | 原因：复用线程池，避免第 ${i + 1} 次分配 1MB 栈内存与上下文字段撕裂 |`
    );
    const mdContent = [
      '# 01_WinForms多线程与UI跨线程刷新_卡片.md',
      '',
      '## 2. 方案优缺点与选型决策对比',
      '',
      '| 选型对比项 | 推荐方案 (X) | 淘汰方案 (Y) | 为什么选 X 不选 Y |',
      '| :--- | :--- | :--- | :--- |',
      ...tableRows,
      '',
    ].join('\n');

    const mdFile = path.join(docsDir, '01_WinForms_Card.md');
    fs.writeFileSync(mdFile, mdContent, 'utf-8');

    const col = await createKnowledgeCollection(dataDir, {
      name: '卡片表格测试',
      sourcePaths: [mdFile],
    });
    const detail = getKnowledgeCollectionDetail(dataDir, col.id)!;
    expect(detail.documents).toHaveLength(1);

    // Direct disk read keeps the entire Markdown table completely intact.
    const docRead = readKnowledgeDocument(dataDir, {
      collectionId: col.id,
      documentId: detail.documents[0].id,
    });
    expect(docRead.found).toBe(true);
    expect(docRead.content).toBe(mdContent);
    expect(docRead.content?.match(/\| :--- \| :--- \|/gu)).toHaveLength(1);
    expect(docRead.content?.match(/选型项目 14 \|/gu)).toHaveLength(1);

    // Even if the original file is later removed, overlap-dedup chunk join still avoids duplicating lines.
    fs.unlinkSync(mdFile);
    const fallbackRead = readKnowledgeDocument(dataDir, {
      collectionId: col.id,
      documentId: detail.documents[0].id,
    });
    expect(fallbackRead.found).toBe(true);
    expect(fallbackRead.content).toContain('| 选型对比项 | 推荐方案 (X) | 淘汰方案 (Y) | 为什么选 X 不选 Y |');
    expect(fallbackRead.content?.match(/选型项目 28 \|/gu)).toHaveLength(1);
  });
});

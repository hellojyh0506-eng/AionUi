/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  CreateKnowledgeCollectionRequest,
  KnowledgeCollection,
  KnowledgeCollectionDetail,
  KnowledgeDocument,
  KnowledgeSearchHit,
  ReadKnowledgeDocumentRequest,
  ReadKnowledgeDocumentResult,
  SearchKnowledgeRequest,
  SearchKnowledgeResult,
} from '@/common/types/knowledge';

export interface StoredKnowledgeChunk {
  id: string;
  documentId: string;
  chunkIndex: number;
  content: string;
  tokenFreqs: Record<string, number>;
  tokenLength: number;
}

export interface StoredKnowledgeCollectionIndex {
  collectionId: string;
  documents: KnowledgeDocument[];
  chunks: StoredKnowledgeChunk[];
  avgChunkLength: number;
  docFreqs: Record<string, number>;
}

interface CollectionsCatalogFile {
  version: 1;
  collections: KnowledgeCollection[];
}

const CJK_CHAR_RE = /[\u4e00-\u9fff]/u;
const WORD_OR_CJK_RUN_RE = /[a-z0-9_+#.-]{2,}|[\u4e00-\u9fff]+/gu;
const MAX_SNIPPET_CHARS = 240;

const CJK_STOPWORDS = new Set<string>([
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '这', '那', '吗', '呢', '啊', '吧',
  '有', '和', '与', '就', '都', '很', '把', '被', '给', '让', '到', '去', '来', '说', '要',
  '会', '能', '个', '一', '不', '也', '还', '看', '下', '上', '里', '中', '请', '帮', '问',
  '啥', '什', '么', '怎', '样', '为',
]);

const ENGLISH_STOPWORDS = new Set<string>([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'are', 'was', 'you', 'can', 'how',
  'what', 'when', 'where', 'which', 'have', 'has', 'had', 'not', 'but', 'all', 'use', 'using',
]);

export function resolveFallbackKnowledgeDir(overrideDir?: string): string {
  if (overrideDir) return overrideDir;
  if (process.env.AIONUI_KNOWLEDGE_DIR?.trim()) return process.env.AIONUI_KNOWLEDGE_DIR.trim();
  return path.join(os.homedir(), '.aionui', 'knowledge');
}

function getCatalogPath(baseDir: string): string {
  return path.join(baseDir, 'collections.json');
}

function getCollectionIndexPath(baseDir: string, collectionId: string): string {
  const safeId = collectionId.replace(/[^A-Za-z0-9_-]/gu, '_');
  return path.join(baseDir, `index-${safeId}.json`);
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function readCatalog(baseDir: string): CollectionsCatalogFile {
  const catalogPath = getCatalogPath(baseDir);
  try {
    if (fs.existsSync(catalogPath)) {
      const parsed = JSON.parse(fs.readFileSync(catalogPath, 'utf-8')) as Partial<CollectionsCatalogFile>;
      if (Array.isArray(parsed.collections)) {
        return { version: 1, collections: parsed.collections };
      }
    }
  } catch {
    // ignore corrupt catalog and recover empty
  }
  return { version: 1, collections: [] };
}

function writeCatalog(baseDir: string, catalog: CollectionsCatalogFile): void {
  writeJsonAtomic(getCatalogPath(baseDir), catalog);
}

export function readCollectionIndex(baseDir: string, collectionId: string): StoredKnowledgeCollectionIndex {
  const indexPath = getCollectionIndexPath(baseDir, collectionId);
  try {
    if (fs.existsSync(indexPath)) {
      const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as Partial<StoredKnowledgeCollectionIndex>;
      if (Array.isArray(parsed.documents) && Array.isArray(parsed.chunks)) {
        return {
          collectionId,
          documents: parsed.documents,
          chunks: parsed.chunks,
          avgChunkLength: typeof parsed.avgChunkLength === 'number' ? parsed.avgChunkLength : 0,
          docFreqs: parsed.docFreqs && typeof parsed.docFreqs === 'object' ? parsed.docFreqs : {},
        };
      }
    }
  } catch {
    // fallback empty
  }
  return {
    collectionId,
    documents: [],
    chunks: [],
    avgChunkLength: 0,
    docFreqs: {},
  };
}

function writeCollectionIndex(baseDir: string, index: StoredKnowledgeCollectionIndex): void {
  writeJsonAtomic(getCollectionIndexPath(baseDir, index.collectionId), index);
}

/**
 * Mixed CJK (non-stopword bigrams) + lowercase alphanumeric tokenizer.
 * Avoids flooding Chinese queries with single-character noise while preserving code identifiers.
 */
export function tokenizeText(text: string): string[] {
  const lower = text.toLowerCase();
  const matches = lower.match(WORD_OR_CJK_RUN_RE);
  if (!matches) return [];

  const tokens: string[] = [];
  for (const run of matches) {
    if (CJK_CHAR_RE.test(run)) {
      const chars = Array.from(run);
      if (chars.length === 1) {
        if (!CJK_STOPWORDS.has(chars[0])) {
          tokens.push(chars[0]);
        }
        continue;
      }
      for (let i = 0; i < chars.length - 1; i += 1) {
        const a = chars[i];
        const b = chars[i + 1];
        if (CJK_STOPWORDS.has(a) && CJK_STOPWORDS.has(b)) continue;
        tokens.push(`${a}${b}`);
      }
    } else if (!ENGLISH_STOPWORDS.has(run)) {
      tokens.push(run);
    }
  }
  return tokens;
}

function countTokenFrequencies(tokens: string[]): Record<string, number> {
  const freqs: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const token of tokens) {
    freqs[token] = (freqs[token] || 0) + 1;
  }
  return freqs;
}

/**
 * Split document text along heading / blank-line boundaries with bounded overlap.
 */
export function chunkDocumentText(text: string, maxChars = 700, overlapChars = 100): string[] {
  const normalized = text.replace(/\r\n/gu, '\n').trim();
  if (!normalized) return [];
  if (normalized.length <= maxChars) return [normalized];

  const blocks = normalized
    .split(/\n{2,}|(?=^#{1,6}\s)/mu)
    .map((b) => b.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let buffer = '';

  const pushWindowed = (longText: string) => {
    let start = 0;
    const step = Math.max(120, maxChars - overlapChars);
    while (start < longText.length) {
      const slice = longText.slice(start, start + maxChars).trim();
      if (slice) chunks.push(slice);
      if (start + maxChars >= longText.length) break;
      start += step;
    }
  };

  for (const block of blocks) {
    if (block.length > maxChars) {
      if (buffer) {
        chunks.push(buffer);
        buffer = '';
      }
      pushWindowed(block);
      continue;
    }

    const candidate = buffer ? `${buffer}\n\n${block}` : block;
    if (candidate.length <= maxChars) {
      buffer = candidate;
    } else {
      if (buffer) chunks.push(buffer);
      const tail = overlapChars > 0 && buffer.length > overlapChars ? buffer.slice(-overlapChars).trim() : '';
      buffer = tail && tail.length + block.length + 2 <= maxChars ? `${tail}\n\n${block}` : block;
    }
  }

  if (buffer) chunks.push(buffer);
  return chunks;
}

function rebuildIndexStats(
  collectionId: string,
  documents: KnowledgeDocument[],
  chunks: StoredKnowledgeChunk[]
): StoredKnowledgeCollectionIndex {
  const docFreqs: Record<string, number> = Object.create(null) as Record<string, number>;
  let totalLen = 0;
  for (const chunk of chunks) {
    totalLen += chunk.tokenLength;
    for (const term of Object.keys(chunk.tokenFreqs)) {
      docFreqs[term] = (docFreqs[term] || 0) + 1;
    }
  }
  const avgChunkLength = chunks.length > 0 ? totalLen / chunks.length : 0;
  return {
    collectionId,
    documents,
    chunks,
    avgChunkLength,
    docFreqs,
  };
}

export function computeDocumentId(filePath: string): string {
  const key = process.platform === 'win32' ? filePath.toLowerCase() : filePath;
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
}

export function buildDocumentChunks(
  collectionId: string,
  documentId: string,
  text: string
): StoredKnowledgeChunk[] {
  const segments = chunkDocumentText(text);
  return segments.map((content, chunkIndex) => {
    const tokens = tokenizeText(content);
    return {
      id: `${documentId}:${chunkIndex}`,
      documentId,
      chunkIndex,
      content,
      tokenFreqs: countTokenFrequencies(tokens),
      tokenLength: tokens.length,
    };
  });
}

export function listKnowledgeCollections(baseDir: string): KnowledgeCollection[] {
  return readCatalog(baseDir).collections.toSorted((a, b) => b.updatedAt - a.updatedAt);
}

export function getKnowledgeCollectionDetail(baseDir: string, collectionId: string): KnowledgeCollectionDetail | null {
  const collection = readCatalog(baseDir).collections.find((c) => c.id === collectionId);
  if (!collection) return null;
  const idx = readCollectionIndex(baseDir, collectionId);
  return {
    collection,
    documents: idx.documents.toSorted((a, b) => a.relativePath.localeCompare(b.relativePath)),
  };
}

export function createKnowledgeCollectionRecord(
  baseDir: string,
  req: CreateKnowledgeCollectionRequest
): KnowledgeCollection {
  const catalog = readCatalog(baseDir);
  const now = Date.now();
  const id = `kb_${crypto.randomUUID().replace(/-/gu, '').slice(0, 12)}`;
  const collection: KnowledgeCollection = {
    id,
    name: req.name.trim() || '未命名知识库',
    ...(req.description?.trim() ? { description: req.description.trim() } : {}),
    sourceDirs: Array.from(new Set((req.sourcePaths || []).map((p) => path.resolve(p.trim())).filter(Boolean))),
    documentCount: 0,
    chunkCount: 0,
    totalBytes: 0,
    createdAt: now,
    updatedAt: now,
    status: 'idle',
  };
  catalog.collections.push(collection);
  writeCatalog(baseDir, catalog);
  writeCollectionIndex(baseDir, rebuildIndexStats(id, [], []));
  return collection;
}

export function deleteKnowledgeCollection(baseDir: string, collectionId: string): boolean {
  const catalog = readCatalog(baseDir);
  const next = catalog.collections.filter((c) => c.id !== collectionId);
  if (next.length === catalog.collections.length) return false;
  catalog.collections = next;
  writeCatalog(baseDir, catalog);
  try {
    fs.rmSync(getCollectionIndexPath(baseDir, collectionId), { force: true });
  } catch {
    // ignore missing file
  }
  return true;
}

export function saveCollectionSnapshot(
  baseDir: string,
  collectionId: string,
  sourceDirs: string[],
  documents: KnowledgeDocument[],
  chunks: StoredKnowledgeChunk[],
  errorMessage?: string
): KnowledgeCollection | null {
  const catalog = readCatalog(baseDir);
  const existing = catalog.collections.find((c) => c.id === collectionId);
  if (!existing) return null;

  const index = rebuildIndexStats(collectionId, documents, chunks);
  writeCollectionIndex(baseDir, index);

  const totalBytes = documents.reduce((acc, d) => acc + d.sizeBytes, 0);
  const updated: KnowledgeCollection = {
    ...existing,
    sourceDirs,
    documentCount: documents.length,
    chunkCount: chunks.length,
    totalBytes,
    updatedAt: Date.now(),
    status: errorMessage ? 'error' : 'idle',
    ...(errorMessage ? { lastError: errorMessage } : {}),
  };
  if (!errorMessage) {
    delete updated.lastError;
  }

  catalog.collections = catalog.collections.map((c) => (c.id === collectionId ? updated : c));
  writeCatalog(baseDir, catalog);
  return updated;
}

export function removeDocumentFromCollection(
  baseDir: string,
  collectionId: string,
  documentId: string
): KnowledgeCollection | null {
  const catalog = readCatalog(baseDir);
  const existing = catalog.collections.find((c) => c.id === collectionId);
  if (!existing) return null;

  const idx = readCollectionIndex(baseDir, collectionId);
  const nextDocs = idx.documents.filter((d) => d.id !== documentId);
  const nextChunks = idx.chunks.filter((c) => c.documentId !== documentId);
  return saveCollectionSnapshot(baseDir, collectionId, existing.sourceDirs, nextDocs, nextChunks);
}

function cleanSnippetNoise(content: string): string {
  return content
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/^#{1,6}\s+/gmu, '')
    .replace(/```[\s\S]*?```/gu, (block) => block.replace(/```[a-zA-Z0-9_-]*\n?/gu, '').replace(/```/gu, ''))
    .replace(/[*_`~>-]{1,3}/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function buildSnippet(content: string, queryText: string): string {
  const clean = cleanSnippetNoise(content);
  if (clean.length <= MAX_SNIPPET_CHARS) return clean;
  const qLower = queryText.trim().toLowerCase();
  const hitPos = qLower ? clean.toLowerCase().indexOf(qLower) : -1;
  if (hitPos >= 0) {
    const start = Math.max(0, hitPos - 60);
    const slice = clean.slice(start, start + MAX_SNIPPET_CHARS);
    return `${start > 0 ? '...' : ''}${slice}${start + MAX_SNIPPET_CHARS < clean.length ? '...' : ''}`;
  }
  return `${clean.slice(0, MAX_SNIPPET_CHARS)}...`;
}

/**
 * Search indexed local knowledge collections using CJK+Latin BM25 plus phrase/title boosts,
 * filtering out weak noise hits and keeping at most 1 best chunk per document.
 */
export function searchKnowledgeBase(baseDir: string, req: SearchKnowledgeRequest): SearchKnowledgeResult {
  const queryText = (req.query || '').trim();
  const topK = Math.max(1, Math.min(req.topK ?? 8, 30));
  const catalog = readCatalog(baseDir);

  const filterIds = req.collectionIds && req.collectionIds.length > 0 ? new Set(req.collectionIds) : null;
  const targetCollections = filterIds
    ? catalog.collections.filter((c) => filterIds.has(c.id))
    : catalog.collections;

  if (!queryText || targetCollections.length === 0) {
    return {
      query: queryText,
      hits: [],
      totalIndexedChunks: targetCollections.reduce((sum, c) => sum + c.chunkCount, 0),
    };
  }

  const queryTokens = Array.from(new Set(tokenizeText(queryText)));
  const qLower = queryText.toLowerCase();
  const minMatchedTerms = queryTokens.length >= 2 ? 2 : 1;
  const scoredHits: KnowledgeSearchHit[] = [];
  let totalIndexedChunks = 0;

  const k1 = 1.5;
  const bm25B = 0.75;

  for (const collection of targetCollections) {
    const idx = readCollectionIndex(baseDir, collection.id);
    const docById = new Map(idx.documents.map((d) => [d.id, d]));
    const N = idx.chunks.length;
    totalIndexedChunks += N;
    if (N === 0) continue;

    const avgdl = idx.avgChunkLength || 1;

    for (const chunk of idx.chunks) {
      const doc = docById.get(chunk.documentId);
      if (!doc) continue;

      let score = 0;
      let matchedTerms = 0;
      for (const term of queryTokens) {
        const tf = chunk.tokenFreqs[term] || 0;
        if (tf === 0) continue;
        matchedTerms += 1;
        const df = idx.docFreqs[term] || 0;
        const idf = Math.log(1.35 + (N - df + 0.5) / (df + 0.5));
        const norm = tf + k1 * (1 - bm25B + (bm25B * chunk.tokenLength) / avgdl);
        score += idf * ((tf * (k1 + 1)) / norm);
      }

      const contentMatch = chunk.content.toLowerCase().includes(qLower);
      const titleMatch = doc.title.toLowerCase().includes(qLower);
      const hasExactPhrase = contentMatch || titleMatch;

      if (!hasExactPhrase && matchedTerms < minMatchedTerms) {
        continue;
      }

      if (contentMatch) {
        score = Math.max(score, 0.8) * 1.35;
      }
      if (titleMatch) {
        score = Math.max(score, 0.8) * 1.6;
      }

      if (score <= 0) {
        continue;
      }

      scoredHits.push({
        chunkId: chunk.id,
        documentId: doc.id,
        collectionId: collection.id,
        collectionName: collection.name,
        title: doc.title,
        filePath: doc.filePath,
        relativePath: doc.relativePath,
        snippet: buildSnippet(chunk.content, queryText),
        content: chunk.content,
        score: Number(score.toFixed(4)),
        chunkIndex: chunk.chunkIndex,
      });
    }
  }

  // Keep only the top-scoring chunk per document so one file never floods results.
  const bestPerDoc = new Map<string, KnowledgeSearchHit>();
  for (const hit of scoredHits.toSorted((a, b) => b.score - a.score)) {
    const docKey = `${hit.collectionId}:${hit.documentId}`;
    if (!bestPerDoc.has(docKey)) {
      bestPerDoc.set(docKey, hit);
    }
  }

  const hits = Array.from(bestPerDoc.values()).slice(0, topK);
  return {
    query: queryText,
    hits,
    totalIndexedChunks,
  };
}

const MAX_READ_DOCUMENT_CHARS = 120_000;
const DIRECT_TEXT_READ_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.csv',
  '.json',
  '.yaml',
  '.yml',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.py',
  '.cs',
  '.cpp',
  '.c',
  '.h',
  '.hpp',
  '.java',
  '.go',
  '.rs',
  '.sql',
  '.html',
  '.css',
  '.xml',
  '.log',
  '.ini',
  '.toml',
  '.sh',
  '.ps1',
  '.bat',
]);

/**
 * Deduplicate overlap lines at chunk boundaries when reconstructing text from persisted chunks.
 */
function joinChunksCleanly(segments: string[]): string {
  if (segments.length <= 1) return segments[0] ?? '';
  let acc = segments[0];
  for (let i = 1; i < segments.length; i += 1) {
    const next = segments[i];
    const maxOverlap = Math.min(240, acc.length, next.length);
    let overlapLen = 0;
    for (let len = maxOverlap; len >= 16; len -= 1) {
      if (acc.endsWith(next.slice(0, len))) {
        overlapLen = len;
        break;
      }
    }
    if (overlapLen > 0) {
      acc += next.slice(overlapLen);
    } else {
      acc += `\n\n${next}`;
    }
  }
  return acc;
}

/**
 * Reconstruct indexed document text cleanly: prefer reading UTF-8 text/Markdown originals
 * directly from disk so tables, code fences, and headings remain intact without chunk breaks.
 */
export function readKnowledgeDocument(baseDir: string, req: ReadKnowledgeDocumentRequest): ReadKnowledgeDocumentResult {
  const catalog = readCatalog(baseDir);
  const candidateCollections = req.collectionId
    ? catalog.collections.filter((c) => c.id === req.collectionId)
    : catalog.collections;

  for (const collection of candidateCollections) {
    const idx = readCollectionIndex(baseDir, collection.id);
    const doc = idx.documents.find((d) => {
      if (req.documentId && d.id === req.documentId) return true;
      if (req.filePath) {
        return d.filePath === req.filePath || d.relativePath === req.filePath;
      }
      return false;
    });
    if (!doc) continue;

    const ext = path.extname(doc.filePath || doc.title || '').toLowerCase();
    if (doc.filePath && DIRECT_TEXT_READ_EXTENSIONS.has(ext) && fs.existsSync(doc.filePath)) {
      try {
        const raw = fs.readFileSync(doc.filePath, 'utf8').replace(/\r\n/gu, '\n');
        const content =
          raw.length > MAX_READ_DOCUMENT_CHARS
            ? `${raw.slice(0, MAX_READ_DOCUMENT_CHARS)}\n\n---\n*(文档较长，已截断前 ${MAX_READ_DOCUMENT_CHARS} 字以保障阅读性能)*`
            : raw;
        return {
          found: true,
          document: doc,
          content,
        };
      } catch {
        // Fall back to chunk reconstruction if the original file became unreadable.
      }
    }

    const docChunks = idx.chunks
      .filter((c) => c.documentId === doc.id)
      .toSorted((a, b) => a.chunkIndex - b.chunkIndex)
      .map((c) => c.content);

    return {
      found: true,
      document: doc,
      content: joinChunksCleanly(docChunks),
    };
  }

  return {
    found: false,
    error: '未在指定知识库中找到该文档。',
  };
}

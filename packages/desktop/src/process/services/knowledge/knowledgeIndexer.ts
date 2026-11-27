/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import type {
  AddKnowledgeSourcesRequest,
  AddKnowledgeSourcesResult,
  CreateKnowledgeCollectionRequest,
  KnowledgeCollection,
  KnowledgeDocument,
  ReindexKnowledgeCollectionRequest,
} from '@/common/types/knowledge';
import {
  buildDocumentChunks,
  computeDocumentId,
  createKnowledgeCollectionRecord,
  listKnowledgeCollections,
  readCollectionIndex,
  saveCollectionSnapshot,
  type StoredKnowledgeChunk,
} from './knowledgeStore';
import { collectIndexableFiles, extractTextFromFile, type DiscoveredKnowledgeFile } from './textExtractor';

interface IndexedFileOutcome {
  doc?: KnowledgeDocument;
  chunks?: StoredKnowledgeChunk[];
  skipped?: boolean;
  failed?: { path: string; reason: string };
}

async function processDiscoveredFiles(
  collectionId: string,
  files: DiscoveredKnowledgeFile[],
  existingDocById: Map<string, KnowledgeDocument>,
  existingChunksByDocId: Map<string, StoredKnowledgeChunk[]>,
  forceReindex: boolean
): Promise<IndexedFileOutcome[]> {
  return await Promise.all(
    files.map(async (file): Promise<IndexedFileOutcome> => {
      const docId = computeDocumentId(file.filePath);
      const prevDoc = existingDocById.get(docId);

      if (
        !forceReindex &&
        prevDoc &&
        prevDoc.mtimeMs === file.mtimeMs &&
        prevDoc.sizeBytes === file.sizeBytes
      ) {
        return {
          doc: prevDoc,
          chunks: existingChunksByDocId.get(docId) || [],
          skipped: true,
        };
      }

      try {
        const extracted = await extractTextFromFile(file.filePath);
        if (!extracted || !extracted.text.trim()) {
          return { skipped: true };
        }
        const chunks = buildDocumentChunks(collectionId, docId, extracted.text);
        if (chunks.length === 0) {
          return { skipped: true };
        }
        const doc: KnowledgeDocument = {
          id: docId,
          collectionId,
          title: path.basename(file.filePath),
          filePath: file.filePath,
          relativePath: file.relativePath,
          ext: extracted.ext,
          sizeBytes: file.sizeBytes,
          mtimeMs: file.mtimeMs,
          chunkCount: chunks.length,
          indexedAt: Date.now(),
        };
        return { doc, chunks };
      } catch (err) {
        return {
          failed: {
            path: file.filePath,
            reason: err instanceof Error ? err.message : String(err),
          },
        };
      }
    })
  );
}

/**
 * Index newly added files or folders into an existing collection incrementally.
 */
export async function addSourcesToKnowledgeCollection(
  baseDir: string,
  req: AddKnowledgeSourcesRequest
): Promise<AddKnowledgeSourcesResult> {
  const collection = listKnowledgeCollections(baseDir).find((c) => c.id === req.collectionId);
  if (!collection) {
    throw new Error(`未找到知识库 (${req.collectionId})`);
  }

  const normalizedNewSources = req.sourcePaths.map((p) => path.resolve(p.trim())).filter(Boolean);
  const mergedSources = Array.from(new Set([...collection.sourceDirs, ...normalizedNewSources]));
  const discovered = collectIndexableFiles(mergedSources, {
    includeCode: req.includeCode,
    allowedExtensions: req.allowedExtensions,
  });

  const prevIndex = readCollectionIndex(baseDir, collection.id);
  const existingDocById = new Map(prevIndex.documents.map((d) => [d.id, d]));
  const existingChunksByDocId = new Map<string, StoredKnowledgeChunk[]>();
  for (const chunk of prevIndex.chunks) {
    const arr = existingChunksByDocId.get(chunk.documentId) || [];
    arr.push(chunk);
    existingChunksByDocId.set(chunk.documentId, arr);
  }

  const outcomes = await processDiscoveredFiles(
    collection.id,
    discovered,
    existingDocById,
    existingChunksByDocId,
    false
  );

  const nextDocs: KnowledgeDocument[] = [];
  const nextChunks: StoredKnowledgeChunk[] = [];
  const failedFiles: Array<{ path: string; reason: string }> = [];
  let indexedFiles = 0;
  let skippedFiles = 0;

  for (const item of outcomes) {
    if (item.failed) {
      failedFiles.push(item.failed);
      continue;
    }
    if (item.doc && item.chunks) {
      nextDocs.push(item.doc);
      nextChunks.push(...item.chunks);
      if (item.skipped) skippedFiles += 1;
      else indexedFiles += 1;
    } else if (item.skipped) {
      skippedFiles += 1;
    }
  }

  const updated =
    saveCollectionSnapshot(baseDir, collection.id, mergedSources, nextDocs, nextChunks) ?? collection;

  return {
    collection: updated,
    indexedFiles,
    skippedFiles,
    failedFiles,
  };
}

/**
 * Create a new knowledge collection and immediately index any initial source paths.
 */
export async function createKnowledgeCollection(
  baseDir: string,
  req: CreateKnowledgeCollectionRequest
): Promise<KnowledgeCollection> {
  const created = createKnowledgeCollectionRecord(baseDir, req);
  if (req.sourcePaths && req.sourcePaths.length > 0) {
    const res = await addSourcesToKnowledgeCollection(baseDir, {
      collectionId: created.id,
      sourcePaths: req.sourcePaths,
      includeCode: req.includeCode,
      allowedExtensions: req.allowedExtensions,
    });
    return res.collection;
  }
  return created;
}

/**
 * Re-scan all configured source directories/files for a collection and rebuild its index.
 */
export async function reindexKnowledgeCollection(
  baseDir: string,
  req: ReindexKnowledgeCollectionRequest
): Promise<AddKnowledgeSourcesResult> {
  const collection = listKnowledgeCollections(baseDir).find((c) => c.id === req.collectionId);
  if (!collection) {
    throw new Error(`未找到知识库 (${req.collectionId})`);
  }

  const discovered = collectIndexableFiles(collection.sourceDirs);
  const prevIndex = readCollectionIndex(baseDir, collection.id);
  const existingDocById = new Map(prevIndex.documents.map((d) => [d.id, d]));
  const existingChunksByDocId = new Map<string, StoredKnowledgeChunk[]>();
  for (const chunk of prevIndex.chunks) {
    const arr = existingChunksByDocId.get(chunk.documentId) || [];
    arr.push(chunk);
    existingChunksByDocId.set(chunk.documentId, arr);
  }

  const outcomes = await processDiscoveredFiles(
    collection.id,
    discovered,
    existingDocById,
    existingChunksByDocId,
    Boolean(req.force)
  );

  const nextDocs: KnowledgeDocument[] = [];
  const nextChunks: StoredKnowledgeChunk[] = [];
  const failedFiles: Array<{ path: string; reason: string }> = [];
  let indexedFiles = 0;
  let skippedFiles = 0;

  for (const item of outcomes) {
    if (item.failed) {
      failedFiles.push(item.failed);
      continue;
    }
    if (item.doc && item.chunks) {
      nextDocs.push(item.doc);
      nextChunks.push(...item.chunks);
      if (item.skipped) skippedFiles += 1;
      else indexedFiles += 1;
    } else if (item.skipped) {
      skippedFiles += 1;
    }
  }

  const updated =
    saveCollectionSnapshot(baseDir, collection.id, collection.sourceDirs, nextDocs, nextChunks) ?? collection;

  return {
    collection: updated,
    indexedFiles,
    skippedFiles,
    failedFiles,
  };
}

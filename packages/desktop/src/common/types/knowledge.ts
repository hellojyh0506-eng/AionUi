/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

export type KnowledgeCollectionStatus = 'idle' | 'indexing' | 'error';

export interface KnowledgeCollection {
  id: string;
  name: string;
  description?: string;
  sourceDirs: string[];
  documentCount: number;
  chunkCount: number;
  totalBytes: number;
  createdAt: number;
  updatedAt: number;
  status: KnowledgeCollectionStatus;
  lastError?: string;
}

export interface KnowledgeDocument {
  id: string;
  collectionId: string;
  title: string;
  filePath: string;
  relativePath: string;
  ext: string;
  sizeBytes: number;
  mtimeMs: number;
  chunkCount: number;
  indexedAt: number;
}

export interface KnowledgeSearchHit {
  chunkId: string;
  documentId: string;
  collectionId: string;
  collectionName: string;
  title: string;
  filePath: string;
  relativePath: string;
  snippet: string;
  content: string;
  score: number;
  chunkIndex: number;
}

export interface KnowledgeCollectionDetail {
  collection: KnowledgeCollection;
  documents: KnowledgeDocument[];
}

export interface CreateKnowledgeCollectionRequest {
  name: string;
  description?: string;
  sourcePaths?: string[];
  includeCode?: boolean;
  allowedExtensions?: string[];
}

export interface AddKnowledgeSourcesRequest {
  collectionId: string;
  sourcePaths: string[];
  includeCode?: boolean;
  allowedExtensions?: string[];
}

export interface ScanKnowledgeFolderResult {
  rootPath: string;
  totalFiles: number;
  byExtension: Array<{
    ext: string;
    count: number;
    samples: string[];
  }>;
}

export interface AddKnowledgeSourcesResult {
  collection: KnowledgeCollection;
  indexedFiles: number;
  skippedFiles: number;
  failedFiles: Array<{ path: string; reason: string }>;
}

export interface ReindexKnowledgeCollectionRequest {
  collectionId: string;
  force?: boolean;
}

export interface RemoveKnowledgeDocumentRequest {
  collectionId: string;
  documentId: string;
}

export interface SearchKnowledgeRequest {
  query: string;
  collectionIds?: string[];
  topK?: number;
}

export interface SearchKnowledgeResult {
  query: string;
  hits: KnowledgeSearchHit[];
  totalIndexedChunks: number;
}

export interface ReadKnowledgeDocumentRequest {
  collectionId: string;
  documentId?: string;
  filePath?: string;
}

export interface ReadKnowledgeDocumentResult {
  found: boolean;
  document?: KnowledgeDocument;
  content?: string;
  error?: string;
}

/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { ipcBridge } from '@/common';
import {
  addSourcesToKnowledgeCollection,
  createKnowledgeCollection,
  reindexKnowledgeCollection,
} from '../services/knowledge/knowledgeIndexer';
import {
  deleteKnowledgeCollection,
  getKnowledgeCollectionDetail,
  listKnowledgeCollections,
  readKnowledgeDocument,
  removeDocumentFromCollection,
  searchKnowledgeBase,
} from '../services/knowledge/knowledgeStore';
import { getDataPath } from '../utils/utils';

function getKnowledgeDir(): string {
  return path.join(getDataPath(), 'knowledge');
}

export function initKnowledgeBridge(): void {
  ipcBridge.knowledge.listCollections.provider(async () => {
    return listKnowledgeCollections(getKnowledgeDir());
  });

  ipcBridge.knowledge.getCollectionDetail.provider(async (req) => {
    return getKnowledgeCollectionDetail(getKnowledgeDir(), req.collectionId);
  });

  ipcBridge.knowledge.createCollection.provider(async (req) => {
    return await createKnowledgeCollection(getKnowledgeDir(), req);
  });

  ipcBridge.knowledge.deleteCollection.provider(async (req) => {
    return deleteKnowledgeCollection(getKnowledgeDir(), req.collectionId);
  });

  ipcBridge.knowledge.addSources.provider(async (req) => {
    return await addSourcesToKnowledgeCollection(getKnowledgeDir(), req);
  });

  ipcBridge.knowledge.removeDocument.provider(async (req) => {
    return removeDocumentFromCollection(getKnowledgeDir(), req.collectionId, req.documentId);
  });

  ipcBridge.knowledge.reindexCollection.provider(async (req) => {
    return await reindexKnowledgeCollection(getKnowledgeDir(), req);
  });

  ipcBridge.knowledge.search.provider(async (req) => {
    return searchKnowledgeBase(getKnowledgeDir(), req);
  });

  ipcBridge.knowledge.readDocument.provider(async (req) => {
    return readKnowledgeDocument(getKnowledgeDir(), req);
  });
}

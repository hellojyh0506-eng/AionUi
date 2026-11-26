/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { localFileRef } from '@/common/types/chatFile';
import {
  isBareWorkspaceFilename,
  joinWorkspacePath,
  resolveWorkspaceRelativeCandidate,
  stripLocalFileLocationSuffix,
} from './markdownUtils';
import type { LocalFileLinkReference } from './markdownUtils';

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

const EXISTS_TRUE_TTL_MS = 30_000;
const EXISTS_FALSE_TTL_MS = 2_000;
const WORKSPACE_FILES_TTL_MS = 3_000;
const MAX_EXISTS_CACHE_ENTRIES = 300;

const existsCache = new Map<string, CacheEntry<boolean>>();
const existsInflight = new Map<string, Promise<boolean>>();

const workspaceFilesCache = new Map<string, CacheEntry<string[]>>();
const workspaceFilesInflight = new Map<string, Promise<string[]>>();

const IGNORED_PATH_SEGMENT_RE = /(?:^|[\\/])(?:\.git|node_modules|dist|out)(?:[\\/]|$)/i;

const pruneExistsCache = () => {
  if (existsCache.size <= MAX_EXISTS_CACHE_ENTRIES) return;
  const oldestKey = existsCache.keys().next().value;
  if (oldestKey !== undefined) {
    existsCache.delete(oldestKey);
  }
};

/**
 * Check whether a local path exists and points to a file (not a directory),
 * with short-lived caching and in-flight deduplication so chat scrolling and
 * streaming re-renders do not spam backend IPC.
 */
export const checkLocalFileExists = async (filePath: string, workspace?: string): Promise<boolean> => {
  const getMeta = ipcBridge?.fs?.getFileMetadata?.invoke;
  const getContentMeta = ipcBridge?.fs?.getContentMetadata?.invoke;
  if ((!getMeta && !getContentMeta) || !filePath) return false;

  const key = `${workspace || ''}\0${filePath}`;
  const now = Date.now();
  const cached = existsCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const inflight = existsInflight.get(key);
  if (inflight) {
    return inflight;
  }

  const isAbsolute = /^[A-Za-z]:[\\/]/.test(filePath) || filePath.startsWith('\\\\') || filePath.startsWith('/');
  const probe = async (): Promise<boolean> => {
    if (getMeta) {
      try {
        const meta = await getMeta({ path: filePath, workspace });
        if (meta && !meta.isDirectory) return true;
      } catch {
        // External absolute paths are blocked by the workspace sandbox on /api/fs/metadata;
        // fall back to /api/fs/content/metadata via Local ChatFileRef below.
      }
    }
    if (isAbsolute && getContentMeta) {
      try {
        const meta = await getContentMeta({ file: localFileRef(filePath) });
        return Boolean(meta && !meta.isDirectory);
      } catch {
        return false;
      }
    }
    return false;
  };

  const promise = probe().then((exists) => {
    existsInflight.delete(key);
    pruneExistsCache();
    existsCache.set(key, {
      value: exists,
      expiresAt: Date.now() + (exists ? EXISTS_TRUE_TTL_MS : EXISTS_FALSE_TTL_MS),
    });
    return exists;
  });

  existsInflight.set(key, promise);
  return promise;
};

const listWorkspaceRelativePaths = async (workspace: string): Promise<string[]> => {
  const listFn = ipcBridge?.fs?.listWorkspaceFiles?.invoke;
  if (!listFn || !workspace) return [];

  const now = Date.now();
  const cached = workspaceFilesCache.get(workspace);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const inflight = workspaceFilesInflight.get(workspace);
  if (inflight) {
    return inflight;
  }

  const promise = listFn({ root: workspace })
    .then((items) =>
      Array.isArray(items)
        ? items
            .map((item) => item?.relativePath)
            .filter((rel): rel is string => typeof rel === 'string' && rel.length > 0 && !IGNORED_PATH_SEGMENT_RE.test(rel))
        : []
    )
    .catch(() => [] as string[])
    .then((paths) => {
      workspaceFilesInflight.delete(workspace);
      workspaceFilesCache.set(workspace, {
        value: paths,
        expiresAt: Date.now() + WORKSPACE_FILES_TTL_MS,
      });
      return paths;
    });

  workspaceFilesInflight.set(workspace, promise);
  return promise;
};

/**
 * Resolve a workspace-relative path or bare filename (e.g. `index.html`) only if
 * the target file actually exists inside `workspace`. Bare filenames fall back to a
 * unique-basename match in `listWorkspaceFiles` (e.g. `pelican-motors/index.html`).
 */
export const resolveWorkspaceFileByCandidate = async (
  rawText: string,
  workspace?: string
): Promise<LocalFileLinkReference | null> => {
  if (!workspace) return null;

  const direct = resolveWorkspaceRelativeCandidate(rawText, workspace);
  if (!direct) return null;

  if (await checkLocalFileExists(direct.filePath, workspace)) {
    return direct;
  }

  const { cleanPath, suffix } = stripLocalFileLocationSuffix(rawText.trim());
  if (!isBareWorkspaceFilename(cleanPath)) {
    return null;
  }

  const targetLower = cleanPath.toLowerCase();
  const workspaceFiles = await listWorkspaceRelativePaths(workspace);
  const matches = workspaceFiles.filter((rel) => {
    const base = rel.split(/[\\/]/).pop() || '';
    return base.toLowerCase() === targetLower;
  });

  if (matches.length !== 1) {
    return null;
  }

  const matchedFullPath = joinWorkspacePath(workspace, matches[0]);
  return {
    ...direct,
    filePath: matchedFullPath,
    rawReference: `${matchedFullPath}${suffix}`,
  };
};

/** Test-only helper to clear module caches between unit tests. */
export const resetLocalFileLookupCacheForTest = () => {
  existsCache.clear();
  existsInflight.clear();
  workspaceFilesCache.clear();
  workspaceFilesInflight.clear();
};

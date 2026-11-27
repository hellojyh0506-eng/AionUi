/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx-republish';
import type { ScanKnowledgeFolderResult } from '@/common/types/knowledge';

export const MAX_KNOWLEDGE_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_COLLECTION_FILES = 1000;
const MAX_WALK_DEPTH = 12;
const MAX_SPREADSHEET_ROWS_PER_SHEET = 500;

/**
 * Clean human-readable document/study note formats indexed by default when scanning a directory.
 */
export const DOCUMENT_KNOWLEDGE_EXTENSIONS = new Set<string>([
  '.md',
  '.mdx',
  '.markdown',
  '.txt',
  '.text',
  '.docx',
  '.xlsx',
  '.xls',
  '.csv',
  '.tsv',
]);

/**
 * Source code & configuration formats opted in via `includeCode: true`, explicit extensions, or direct file selection.
 */
export const CODE_KNOWLEDGE_EXTENSIONS = new Set<string>([
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rs',
  '.go',
  '.cs',
  '.java',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.sql',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.xml',
  '.ini',
  '.conf',
  '.log',
  '.sh',
  '.ps1',
]);

export const SUPPORTED_KNOWLEDGE_EXTENSIONS = new Set<string>([
  ...DOCUMENT_KNOWLEDGE_EXTENSIONS,
  ...CODE_KNOWLEDGE_EXTENSIONS,
]);

const IGNORED_DIR_NAMES = new Set<string>([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'out',
  'build',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  'bin',
  'obj',
  '.next',
  '.cache',
  '.turbo',
]);

export interface DiscoveredKnowledgeFile {
  filePath: string;
  relativePath: string;
  ext: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface CollectKnowledgeFilesOptions {
  includeCode?: boolean;
  allowedExtensions?: string[];
}

function resolveDirectoryExtensionAllowlist(options?: CollectKnowledgeFilesOptions): Set<string> {
  if (options?.allowedExtensions && options.allowedExtensions.length > 0) {
    const custom = new Set<string>();
    for (const raw of options.allowedExtensions) {
      const normalized = raw.trim().toLowerCase();
      if (!normalized) continue;
      const withDot = normalized.startsWith('.') ? normalized : `.${normalized}`;
      if (SUPPORTED_KNOWLEDGE_EXTENSIONS.has(withDot)) {
        custom.add(withDot);
      }
    }
    if (custom.size > 0) return custom;
  }
  return options?.includeCode ? SUPPORTED_KNOWLEDGE_EXTENSIONS : DOCUMENT_KNOWLEDGE_EXTENSIONS;
}

function walkDirectoryRecursive(
  dirPath: string,
  rootBasePath: string,
  depth: number,
  allowedExtensions: Set<string>,
  collected: DiscoveredKnowledgeFile[],
  seenPaths: Set<string>
): void {
  if (depth > MAX_WALK_DEPTH || collected.length >= MAX_COLLECTION_FILES) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (collected.length >= MAX_COLLECTION_FILES) break;
    if (entry.name.startsWith('.') && entry.name !== '.github') continue;
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      if (IGNORED_DIR_NAMES.has(entry.name)) continue;
      walkDirectoryRecursive(fullPath, rootBasePath, depth + 1, allowedExtensions, collected, seenPaths);
      continue;
    }

    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!allowedExtensions.has(ext)) continue;

    try {
      const stat = fs.statSync(fullPath);
      if (stat.size === 0 || stat.size > MAX_KNOWLEDGE_FILE_BYTES) continue;
      const normKey = process.platform === 'win32' ? fullPath.toLowerCase() : fullPath;
      if (seenPaths.has(normKey)) continue;
      seenPaths.add(normKey);
      collected.push({
        filePath: fullPath,
        relativePath: path.relative(rootBasePath, fullPath).replace(/\\/gu, '/'),
        ext,
        sizeBytes: stat.size,
        mtimeMs: Math.trunc(stat.mtimeMs),
      });
    } catch {
      // skip unreadable files
    }
  }
}

/**
 * Scan a directory and summarize indexable files grouped by extension (for AI Butler curation).
 */
export function scanFolderSummary(folderPath: string): ScanKnowledgeFolderResult {
  const resolved = path.resolve(folderPath.trim());
  const files = collectIndexableFiles([resolved], { includeCode: true });
  const grouped = new Map<string, { count: number; samples: string[] }>();

  for (const file of files) {
    const bucket = grouped.get(file.ext) || { count: 0, samples: [] };
    bucket.count += 1;
    if (bucket.samples.length < 5) {
      bucket.samples.push(file.relativePath);
    }
    grouped.set(file.ext, bucket);
  }

  const byExtension = Array.from(grouped.entries())
    .map(([ext, info]) => ({ ext, count: info.count, samples: info.samples }))
    .toSorted((a, b) => b.count - a.count);

  return {
    rootPath: resolved,
    totalFiles: files.length,
    byExtension,
  };
}

/**
 * Discover indexable documents across selected files and directories.
 * Directories default to study/document extensions unless `includeCode` or `allowedExtensions` overrides it;
 * explicitly selected individual files allow any supported extension.
 */
export function collectIndexableFiles(
  sourcePaths: string[],
  options?: CollectKnowledgeFilesOptions
): DiscoveredKnowledgeFile[] {
  const dirAllowlist = resolveDirectoryExtensionAllowlist(options);
  const collected: DiscoveredKnowledgeFile[] = [];
  const seenPaths = new Set<string>();

  for (const rawSource of sourcePaths) {
    if (collected.length >= MAX_COLLECTION_FILES) break;
    const trimmed = rawSource.trim();
    if (!trimmed) continue;
    const resolved = path.resolve(trimmed);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      walkDirectoryRecursive(resolved, resolved, 0, dirAllowlist, collected, seenPaths);
    } else if (stat.isFile()) {
      const ext = path.extname(resolved).toLowerCase();
      const allowed = options?.allowedExtensions?.length ? dirAllowlist.has(ext) : SUPPORTED_KNOWLEDGE_EXTENSIONS.has(ext);
      if (!allowed) continue;
      if (stat.size === 0 || stat.size > MAX_KNOWLEDGE_FILE_BYTES) continue;
      const normKey = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
      if (seenPaths.has(normKey)) continue;
      seenPaths.add(normKey);
      collected.push({
        filePath: resolved,
        relativePath: path.basename(resolved),
        ext,
        sizeBytes: stat.size,
        mtimeMs: Math.trunc(stat.mtimeMs),
      });
    }
  }

  return collected;
}

function extractWorkbookText(filePath: string): string {
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const parts: string[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false });
    const limitedRows = rows.slice(0, MAX_SPREADSHEET_ROWS_PER_SHEET);
    const lines = limitedRows
      .map((row) =>
        (Array.isArray(row) ? row : [])
          .map((cell) => String(cell ?? '').replace(/\s+/gu, ' ').trim())
          .filter(Boolean)
          .join(' | ')
      )
      .filter(Boolean);
    if (lines.length > 0) {
      parts.push(`## ${sheetName}\n${lines.join('\n')}`);
    }
  }
  return parts.join('\n\n');
}

/**
 * Extract plain readable text from a local file (`.docx`, `.xlsx`/`.xls`, or UTF-8 text/Markdown/code).
 */
export async function extractTextFromFile(filePath: string): Promise<{ text: string; ext: string } | null> {
  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_KNOWLEDGE_EXTENSIONS.has(ext)) return null;

  if (ext === '.docx') {
    const result = await mammoth.extractRawText({ path: filePath });
    const text = (result.value || '').trim();
    return text ? { text, ext } : null;
  }

  if (ext === '.xlsx' || ext === '.xls') {
    const text = extractWorkbookText(filePath).trim();
    return text ? { text, ext } : null;
  }

  const buffer = fs.readFileSync(filePath);
  if (buffer.includes(0)) {
    return null;
  }
  const text = buffer.toString('utf-8').replace(/^\uFEFF/u, '').trim();
  return text ? { text, ext } : null;
}

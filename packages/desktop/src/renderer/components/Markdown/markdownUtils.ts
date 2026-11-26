/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';

import { diffColors } from '@/renderer/styles/colors';

/**
 * Format raw code string, attempting JSON pretty-print.
 * Falls back to stripped trailing newline if parsing fails.
 */
export const formatCode = (code: string): string => {
  const content = String(code).replace(/\n$/, '');
  try {
    return JSON.stringify(
      JSON.parse(content),
      (_key, value) => {
        return value;
      },
      2
    );
  } catch (_error) {
    return content;
  }
};

/**
 * Conditional render helper — returns trueComponent when condition is true,
 * falseComponent otherwise.
 */
export const logicRender = <T, F>(condition: boolean, trueComponent: T, falseComponent?: F): T | F => {
  return condition ? trueComponent : (falseComponent as F);
};

const safeDecodeURIComponent = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export type LocalFileLinkReference = {
  filePath: string;
  rawReference: string;
  line?: number;
  column?: number;
  endLine?: number;
};

type LocalFileLocation = {
  line?: number;
  column?: number;
  endLine?: number;
  source?: 'hash' | 'colon';
};

type LocalFilePathCandidate = {
  filePath: string;
  hashLocation?: LocalFileLocation;
  hasInvalidHash?: boolean;
};

const parseHashLocation = (hash: string): LocalFileLocation | null => {
  const match = /^#L(\d+)(?:-L(\d+))?$/.exec(hash);
  if (!match) return null;

  const [, lineText, endLineText] = match;
  return {
    line: Number(lineText),
    endLine: endLineText == null ? undefined : Number(endLineText),
    source: 'hash',
  };
};

const splitHashLocation = (href: string): LocalFilePathCandidate => {
  const hashIndex = href.lastIndexOf('#');
  if (hashIndex < 0) return { filePath: href };

  const lastSep = Math.max(href.lastIndexOf('/'), href.lastIndexOf('\\'));
  if (hashIndex < lastSep) {
    return { filePath: href };
  }

  const fragment = href.slice(hashIndex);
  const hashLocation = parseHashLocation(fragment);
  if (hashLocation) {
    return {
      filePath: href.slice(0, hashIndex),
      hashLocation,
    };
  }

  // Only treat trailing `#L...` style fragments (e.g. `#l10`, `#L10-l20`) as
  // malformed line anchors; keep literal `#` in filenames like `C# notes.html`.
  if (/^#l(?:\d|$|-)/i.test(fragment)) {
    return {
      filePath: href.slice(0, hashIndex),
      hasInvalidHash: true,
    };
  }

  return { filePath: href };
};

const normalizeFilePath = (path: string): string => {
  return /^\/[A-Za-z]:[\\/]/.test(path) ? path.slice(1) : path;
};

const normalizeLocalFileHrefToPath = (href: string): LocalFilePathCandidate | null => {
  if (/^https?:\/\//i.test(href)) return null;

  if (/^file:/i.test(href)) {
    try {
      const url = new URL(href);
      const path = normalizeFilePath(safeDecodeURIComponent(url.pathname));
      const rawHash = safeDecodeURIComponent(url.hash);
      if (!rawHash) return { filePath: path };

      const hashLocation = parseHashLocation(rawHash);
      return hashLocation ? { filePath: path, hashLocation } : { filePath: path, hasInvalidHash: true };
    } catch {
      const stripped = href.replace(/^file:(?:\/\/)?/i, '');
      const candidate = splitHashLocation(stripped);
      return {
        ...candidate,
        filePath: normalizeFilePath(candidate.filePath),
      };
    }
  }

  const candidate = splitHashLocation(href);
  const path = candidate.filePath;

  if (/^[A-Za-z]:[\\/]/.test(path)) {
    return {
      ...candidate,
      filePath: path,
    };
  }

  if (/^\/[A-Za-z]:[\\/]/.test(path)) {
    return {
      ...candidate,
      filePath: path.slice(1),
    };
  }

  if (/^\/(Users|home|tmp|private|var|mnt|Volumes)\//.test(path)) return candidate;
  if (/^\/[^/?#]+\/.+\.[^/?#/.]+$/.test(path)) return candidate;

  return null;
};

const splitLocationSuffix = (filePath: string): Omit<LocalFileLinkReference, 'rawReference'> & LocalFileLocation => {
  const lineColumnMatch = /^(.*):(\d+):(\d+)$/.exec(filePath);
  if (lineColumnMatch) {
    const [, pathWithoutLocation, lineText, columnText] = lineColumnMatch;
    if (normalizeLocalFileHrefToPath(pathWithoutLocation)) {
      return {
        filePath: pathWithoutLocation,
        line: Number(lineText),
        column: Number(columnText),
        source: 'colon',
      };
    }
  }

  const lineMatch = /^(.*):(\d+)$/.exec(filePath);
  if (!lineMatch) return { filePath };

  const [, pathWithoutLocation, lineText] = lineMatch;
  if (!normalizeLocalFileHrefToPath(pathWithoutLocation)) return { filePath };

  return {
    filePath: pathWithoutLocation,
    line: Number(lineText),
    source: 'colon',
  };
};

const formatRawReference = (
  reference: Omit<LocalFileLinkReference, 'rawReference'>,
  source?: 'hash' | 'colon'
): string => {
  if (reference.line == null) return reference.filePath;

  if (source === 'hash') {
    return `${reference.filePath}#L${reference.line}${reference.endLine == null ? '' : `-L${reference.endLine}`}`;
  }

  return `${reference.filePath}:${reference.line}${reference.column == null ? '' : `:${reference.column}`}`;
};

export const resolveLocalFileLinkReference = (
  rawHref: string,
  resolvedHref?: string
): LocalFileLinkReference | null => {
  const href = safeDecodeURIComponent((rawHref || resolvedHref || '').trim());
  if (!href) return null;

  const candidate = normalizeLocalFileHrefToPath(href);
  if (!candidate || candidate.hasInvalidHash) return null;

  const colonReference = splitLocationSuffix(candidate.filePath);
  const reference =
    candidate.hashLocation?.line == null
      ? colonReference
      : {
          ...candidate.hashLocation,
          filePath: colonReference.filePath,
        };

  if (!normalizeLocalFileHrefToPath(reference.filePath)) return null;

  const source = candidate.hashLocation?.line == null ? colonReference.source : 'hash';
  const { source: _source, ...publicReference } = reference;
  return {
    ...publicReference,
    rawReference: formatRawReference(publicReference, source),
  };
};

export const resolveLocalFileLinkPath = (rawHref: string, resolvedHref?: string): string | null => {
  return resolveLocalFileLinkReference(rawHref, resolvedHref)?.filePath ?? null;
};

export const toLocalFileHref = (filePath: string): string => {
  const normalized = filePath.replace(/\\/g, '/');
  const withScheme = /^[A-Za-z]:\//.test(normalized) ? `file:///${normalized}` : `file://${normalized}`;
  return encodeURI(withScheme);
};

const INLINE_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg']);
const HTML_FILE_EXTENSIONS = new Set(['.html', '.htm']);
const URL_WITH_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const SHELL_OPERATOR_RE = /[\r\n\t`|;><]|&&|\|\|/;
const SHELL_FLAG_OR_QUOTE_RE = /(?:^|\s)--?[A-Za-z0-9]|["']/;

const getPathExtensionLower = (filePath: string): string => {
  const clean = stripLocalFileLocationSuffix(filePath).cleanPath;
  const base = clean.split(/[\\/]/).pop() || '';
  const dotIndex = base.lastIndexOf('.');
  return dotIndex > 0 ? base.slice(dotIndex).toLowerCase() : '';
};

export const isImageFilePath = (filePath: string): boolean => INLINE_IMAGE_EXTENSIONS.has(getPathExtensionLower(filePath));

export const isHtmlFilePath = (filePath: string): boolean => HTML_FILE_EXTENSIONS.has(getPathExtensionLower(filePath));

export const isShellCommandText = (text: string): boolean => {
  if (SHELL_OPERATOR_RE.test(text)) return true;
  if (/\s/.test(text) && SHELL_FLAG_OR_QUOTE_RE.test(text)) return true;
  return false;
};

export const stripLocalFileLocationSuffix = (
  rawText: string
): { cleanPath: string; suffix: string; line?: number; column?: number; endLine?: number } => {
  const hashSplit = splitHashLocation(rawText);
  if (hashSplit.hashLocation?.line != null) {
    const suffix = `#L${hashSplit.hashLocation.line}${hashSplit.hashLocation.endLine == null ? '' : `-L${hashSplit.hashLocation.endLine}`}`;
    return {
      cleanPath: hashSplit.filePath,
      suffix,
      ...hashSplit.hashLocation,
    };
  }

  const lineColMatch = /^(.*):(\d+):(\d+)$/.exec(rawText);
  if (lineColMatch) {
    return {
      cleanPath: lineColMatch[1],
      suffix: `:${lineColMatch[2]}:${lineColMatch[3]}`,
      line: Number(lineColMatch[2]),
      column: Number(lineColMatch[3]),
    };
  }

  const lineMatch = /^(.*):(\d+)$/.exec(rawText);
  if (lineMatch && !/^[A-Za-z]:$/.test(lineMatch[1])) {
    return {
      cleanPath: lineMatch[1],
      suffix: `:${lineMatch[2]}`,
      line: Number(lineMatch[2]),
    };
  }

  return { cleanPath: rawText, suffix: '' };
};

export const joinWorkspacePath = (workspace: string, relativePath: string): string => {
  const useBackslash = workspace.includes('\\') || /^[A-Za-z]:/.test(workspace);
  const sep = useBackslash ? '\\' : '/';
  const base = workspace.replace(/[\\/]+$/, '');
  const rel = relativePath.replace(/^[./\\]+/, '').replace(/[\\/]+/g, sep);
  return rel ? `${base}${sep}${rel}` : base;
};

export const isBareWorkspaceFilename = (cleanRelativePath: string): boolean => {
  const stripped = cleanRelativePath.replace(/^\.[\\/]/, '');
  return !stripped.includes('/') && !stripped.includes('\\');
};

/**
 * Parse an unambiguous absolute local file reference from inline code text,
 * rejecting shell commands and multi-line snippets.
 */
export const resolveInlineAbsoluteFileReference = (rawText: string): LocalFileLinkReference | null => {
  let trimmed = rawText.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  if (!trimmed || trimmed.length > 512 || isShellCommandText(trimmed)) {
    return null;
  }
  if (URL_WITH_SCHEME_RE.test(trimmed) && !/^file:\/\//i.test(trimmed)) {
    return null;
  }
  return resolveLocalFileLinkReference(trimmed);
};

/**
 * Build a candidate local file reference for a workspace-relative path or
 * filename (e.g. `index.html`, `pelican-motors/index.html:12`). Callers must
 * confirm existence before converting it into an interactive chip.
 */
export const resolveWorkspaceRelativeCandidate = (
  rawText: string,
  workspace?: string
): LocalFileLinkReference | null => {
  if (!workspace) return null;
  const trimmed = rawText.trim();
  if (!trimmed || trimmed.length > 512 || isShellCommandText(trimmed)) {
    return null;
  }
  if (URL_WITH_SCHEME_RE.test(trimmed) || /^file:/i.test(trimmed)) {
    return null;
  }
  if (resolveLocalFileLinkReference(trimmed)) {
    return null;
  }

  const { cleanPath, suffix, line, column, endLine } = stripLocalFileLocationSuffix(trimmed);
  if (!cleanPath || /^[\\/~-]/.test(cleanPath) || /^[A-Za-z]:/.test(cleanPath)) {
    return null;
  }

  const normalized = cleanPath.replace(/\\/g, '/').replace(/^\.\//, '');
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0 || segments.some((seg) => seg === '..' || seg === '.')) {
    return null;
  }

  const baseName = segments[segments.length - 1];
  if (!/^[^/]+\.[A-Za-z0-9]{1,12}$/.test(baseName)) {
    return null;
  }

  const filePath = joinWorkspacePath(workspace, normalized);
  return {
    filePath,
    rawReference: `${filePath}${suffix}`,
    ...(line != null ? { line } : {}),
    ...(column != null ? { column } : {}),
    ...(endLine != null ? { endLine } : {}),
  };
};

/**
 * Get line background style for diff rendering.
 * Highlights additions (green), deletions (red), and hunk headers (blue).
 */
export const getDiffLineStyle = (line: string, isDark: boolean): React.CSSProperties => {
  if (line.startsWith('+') && !line.startsWith('+++')) {
    return { backgroundColor: isDark ? diffColors.additionBgDark : diffColors.additionBgLight };
  }
  if (line.startsWith('-') && !line.startsWith('---')) {
    return { backgroundColor: isDark ? diffColors.deletionBgDark : diffColors.deletionBgLight };
  }
  if (line.startsWith('@@')) {
    return { backgroundColor: isDark ? diffColors.hunkBgDark : diffColors.hunkBgLight };
  }
  return {};
};

export type DiagramSize = { width: number; height: number };

/**
 * Cap an inline SVG diagram at min(container, natural width): narrow diagrams
 * (e.g. top-down layouts) render 1:1 at their natural size instead of being
 * stretched across the message column; wide diagrams still fit the column.
 * Shared by MermaidBlock and WavedromBlock.
 */
export const withResponsiveSvg = (svg: string): string => {
  const intrinsicWidth = getSvgIntrinsicSize(svg)?.width;
  const maxWidth = intrinsicWidth ? `min(100%, ${intrinsicWidth}px)` : '100%';
  return svg.replace(/<svg\b([^>]*)>/i, (_match, attrs: string) => {
    if (/style\s*=/.test(attrs)) {
      return `<svg${attrs.replace(
        /style\s*=\s*(["'])(.*?)\1/i,
        (_styleMatch, quote: string, styleValue: string) =>
          ` style=${quote}${styleValue};max-width: ${maxWidth}; height: auto; display: block;${quote}`
      )}>`;
    }
    return `<svg${attrs} style="max-width: ${maxWidth}; height: auto; display: block;">`;
  });
};

/**
 * Extract a diagram SVG's natural size from its markup so callers can size it by
 * its own aspect ratio instead of by the container. Mermaid always emits a
 * viewBox; numeric width/height attributes are a fallback for hand-written SVGs.
 */
export const getSvgIntrinsicSize = (svg: string): DiagramSize | null => {
  const svgTag = /<svg\b[^>]*>/i.exec(svg)?.[0];
  if (!svgTag) return null;

  const viewBox = /viewBox\s*=\s*["']\s*[\d.eE+-]+\s+[\d.eE+-]+\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s*["']/i.exec(svgTag);
  if (viewBox) {
    const width = parseFloat(viewBox[1]);
    const height = parseFloat(viewBox[2]);
    if (width > 0 && height > 0) return { width, height };
  }

  const widthAttr = /width\s*=\s*["']([\d.]+)\s*(?:px)?["']/i.exec(svgTag);
  const heightAttr = /height\s*=\s*["']([\d.]+)\s*(?:px)?["']/i.exec(svgTag);
  if (widthAttr && heightAttr) {
    const width = parseFloat(widthAttr[1]);
    const height = parseFloat(heightAttr[1]);
    if (width > 0 && height > 0) return { width, height };
  }
  return null;
};

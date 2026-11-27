/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ActiveAtKnowledgeQuery {
  start: number;
  end: number;
  query: string;
  rawQuery: string;
  token: string;
}

const BOUNDARY_CHARS = String.raw`\s,;!?()[\]{}`;
const BOUNDARY_RE = new RegExp(`[${BOUNDARY_CHARS}]`);
const KB_PREFIX_RE = /^(?:kb|知识库|知识)(?::(.*))?$/iu;
const KB_EXPLICIT_TAG_RE = /@(?:kb|知识库):([^\s,;!?()[\]{}]+)/giu;

function isBoundary(ch: string): boolean {
  return BOUNDARY_RE.test(ch);
}

/**
 * Detect whether the caret is currently inside an active `@kb`, `@知识`, or `@知识库` mention token.
 */
export function getActiveAtKnowledgeQuery(value: string, caretPosition: number): ActiveAtKnowledgeQuery | null {
  if (!value) return null;
  const safeCaret = Math.max(0, Math.min(caretPosition, value.length));

  let atIndex = -1;
  for (let i = safeCaret - 1; i >= 0; i -= 1) {
    const ch = value[i];
    if (ch === '@') {
      const prev = i > 0 ? value[i - 1] : '';
      // Ignore `@@` session mentions.
      if (value[i + 1] === '@' || prev === '@') {
        return null;
      }
      if (!prev || isBoundary(prev)) {
        atIndex = i;
        break;
      }
      return null;
    }
    if (isBoundary(ch)) {
      return null;
    }
  }

  if (atIndex === -1) return null;

  let tokenEnd = value.length;
  for (let i = atIndex + 1; i < value.length; i += 1) {
    if (isBoundary(value[i])) {
      tokenEnd = i;
      break;
    }
  }

  if (safeCaret < atIndex || safeCaret > tokenEnd) return null;
  const rawAfterAt = value.slice(atIndex + 1, tokenEnd);
  const match = KB_PREFIX_RE.exec(rawAfterAt);
  if (!match) return null;

  const filterText = (match[1] ?? '').trim();
  return {
    start: atIndex,
    end: tokenEnd,
    query: filterText,
    rawQuery: rawAfterAt,
    token: value.slice(atIndex, tokenEnd),
  };
}

/**
 * Extract explicit `@kb:<Name>` / `@知识库:<Name>` references embedded in a message.
 */
export function extractKnowledgeMentions(value: string): string[] {
  if (!value) return [];
  const names = new Set<string>();
  KB_EXPLICIT_TAG_RE.lastIndex = 0;
  let m = KB_EXPLICIT_TAG_RE.exec(value);
  while (m) {
    const name = (m[1] || '').trim();
    if (name) names.add(name);
    m = KB_EXPLICIT_TAG_RE.exec(value);
  }
  return Array.from(names);
}

/**
 * Build inserted token text for a chosen knowledge collection (or `'全部'` for all collections).
 */
export function buildAtKnowledgeInsertion(collectionName: string): string {
  return `@知识库:${collectionName}`;
}

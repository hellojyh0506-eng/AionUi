/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { isShellCommandText } from './markdownUtils';

type AstNode = {
  type: string;
  tagName?: string;
  value?: string;
  url?: string;
  title?: string | null;
  properties?: Record<string, unknown>;
  children?: AstNode[];
};

const BARE_WIN_FILE_PATH_RE =
  /(?:^|(?<=[\s：:（([【'=|、]))(?:"([A-Za-z]:[\\/][^"\r\n<>|]+)"|([A-Za-z]:[\\/][^\r\n`"'<>[\]【】，。；;!！?？|、:：]+?\.[A-Za-z0-9]{1,12}(?:#L\d+(?:-L\d+)?|:\d+(?::\d+)?)?)(?=$|[\s，。；;：:)\]】"'!！?？|、）])|([A-Za-z]:[\\/][^\s`"'<>()（）[\]【】，。；;!！?？|、:：]+[\\/][^\s`"'<>()（）[\]【】，。；;!！?？|、:：\\/]+)(?=$|[\s，。；;：:)）\]】"'!！?？|、]))/g;

const SKIP_BARE_PARENT_TYPES = new Set(['link', 'linkReference', 'heading', 'inlineCode', 'code', 'html']);

const splitBarePathTextNode = (node: AstNode): AstNode[] | null => {
  const value = node.value;
  if (!value || !value.includes(':')) return null;

  BARE_WIN_FILE_PATH_RE.lastIndex = 0;
  const parts: AstNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = BARE_WIN_FILE_PATH_RE.exec(value)) !== null) {
    const candidate = match[1] ?? match[2] ?? match[3];
    if (!candidate) continue;
    const fullMatchLen = match[0].length;
    const start = match.index;
    if (isShellCommandText(candidate)) {
      continue;
    }
    if (start > lastIndex) {
      parts.push({ type: 'text', value: value.slice(lastIndex, start) });
    }
    parts.push({ type: 'inlineCode', value: candidate });
    lastIndex = start + fullMatchLen;
  }

  if (parts.length === 0) return null;
  if (lastIndex < value.length) {
    parts.push({ type: 'text', value: value.slice(lastIndex) });
  }
  return parts;
};

/**
 * Remark plugin that promotes unambiguous bare Windows local file paths in
 * prose (outside links, headings, and existing code) to inlineCode nodes so
 * they share the chat local-file chip and standalone-image pipeline.
 */
export const remarkBareLocalFilePaths = () => {
  const walk = (node: AstNode) => {
    if (!Array.isArray(node.children) || SKIP_BARE_PARENT_TYPES.has(node.type)) {
      return;
    }

    const nextChildren: AstNode[] = [];
    let mutated = false;
    for (const child of node.children) {
      if (child.type === 'text') {
        const replacement = splitBarePathTextNode(child);
        if (replacement) {
          nextChildren.push(...replacement);
          mutated = true;
          continue;
        }
      } else {
        walk(child);
      }
      nextChildren.push(child);
    }
    if (mutated) {
      node.children = nextChildren;
    }
  };

  return (tree: AstNode) => {
    walk(tree);
  };
};

const unwrapSingleCodeElement = (node: AstNode): AstNode | null => {
  if (node.type !== 'element') return null;
  if (node.tagName === 'code') return node;
  if ((node.tagName === 'strong' || node.tagName === 'em') && Array.isArray(node.children)) {
    const significant = node.children.filter((c) => !(c.type === 'text' && !c.value?.trim()));
    if (significant.length === 1) {
      return unwrapSingleCodeElement(significant[0]);
    }
  }
  return null;
};

const markSegmentIfStandaloneCode = (segment: AstNode[]) => {
  const significant = segment.filter((c) => !(c.type === 'text' && !c.value?.trim()));
  if (significant.length !== 1) return;
  const codeNode = unwrapSingleCodeElement(significant[0]);
  if (!codeNode) return;
  codeNode.properties = codeNode.properties || {};
  codeNode.properties.dataStandalone = 'true';
};

const AUTOLINK_PREFIX_RE = /^(?:https?:\/\/|www\.)/i;
const AUTOLINK_VALID_HOST_RE = /^(?:https?:\/\/|www\.)[^/\s]+/i;
const AUTOLINK_FULLWIDTH_PUNCT_RE = /[（），。；：、！？【】《》「」『』]/;
const AUTOLINK_TRAILING_NOISE_RE = /[*~.,;:!?'"）】]$/;

const countChar = (text: string, ch: string): number => {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === ch) count += 1;
  }
  return count;
};

const findEarliestUnmatchedBracket = (text: string): number => {
  const openParens: number[] = [];
  const openBrackets: number[] = [];

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(') {
      openParens.push(i);
    } else if (ch === ')') {
      if (openParens.length > 0) openParens.pop();
    } else if (ch === '[') {
      openBrackets.push(i);
    } else if (ch === ']') {
      if (openBrackets.length > 0) openBrackets.pop();
    }
  }

  let earliest = -1;
  if (openParens.length > 0) earliest = openParens[0];
  if (openBrackets.length > 0 && (earliest === -1 || openBrackets[0] < earliest)) {
    earliest = openBrackets[0];
  }
  return earliest;
};

/**
 * Splits trailing Markdown emphasis markers, CJK punctuation, or unmatched
 * opening brackets that `remark-gfm` greedily absorbed into an autolink literal.
 */
export const splitAutolinkTrailingJunk = (rawText: string): { clean: string; trailing: string } | null => {
  if (!AUTOLINK_PREFIX_RE.test(rawText)) return null;

  let cutIndex = rawText.length;

  for (const marker of ['**', '__', '~~']) {
    const idx = rawText.indexOf(marker);
    if (idx !== -1 && idx < cutIndex) {
      cutIndex = idx;
    }
  }

  const cjkMatch = AUTOLINK_FULLWIDTH_PUNCT_RE.exec(rawText);
  if (cjkMatch && cjkMatch.index < cutIndex) {
    cutIndex = cjkMatch.index;
  }

  const unmatchedIdx = findEarliestUnmatchedBracket(rawText.slice(0, cutIndex));
  if (unmatchedIdx !== -1 && unmatchedIdx < cutIndex) {
    cutIndex = unmatchedIdx;
  }

  let clean = rawText.slice(0, cutIndex);

  while (clean.length > 0) {
    if (AUTOLINK_TRAILING_NOISE_RE.test(clean)) {
      clean = clean.slice(0, -1);
      continue;
    }
    const lastCh = clean[clean.length - 1];
    if (lastCh === ')' && countChar(clean, ')') > countChar(clean, '(')) {
      clean = clean.slice(0, -1);
      continue;
    }
    if (lastCh === ']' && countChar(clean, ']') > countChar(clean, '[')) {
      clean = clean.slice(0, -1);
      continue;
    }
    break;
  }

  if (clean.length >= rawText.length || !AUTOLINK_VALID_HOST_RE.test(clean)) {
    return null;
  }

  return {
    clean,
    trailing: rawText.slice(clean.length),
  };
};

const SKIP_AUTOLINK_WALK_TYPES = new Set(['code', 'inlineCode', 'html', 'link']);

/**
 * Remark plugin (running after `remarkGfm`) that trims trailing emphasis markers,
 * CJK punctuation, and unmatched opening brackets off GFM autolink literals and
 * restores paired `**` / `~~` wrappers around the cleaned link when needed.
 */
export const remarkSanitizeAutolinkTrailing = () => {
  const walk = (node: AstNode) => {
    if (!Array.isArray(node.children) || SKIP_AUTOLINK_WALK_TYPES.has(node.type)) {
      return;
    }

    const nextChildren: AstNode[] = [];
    let mutated = false;

    for (const child of node.children) {
      if (
        child.type === 'link' &&
        child.title == null &&
        Array.isArray(child.children) &&
        child.children.length === 1 &&
        child.children[0].type === 'text' &&
        typeof child.children[0].value === 'string'
      ) {
        const rawText = child.children[0].value;
        const isExact = child.url === rawText;
        const isWww = child.url === `http://${rawText}`;

        if (isExact || isWww) {
          const split = splitAutolinkTrailingJunk(rawText);
          if (split) {
            mutated = true;
            const { clean } = split;
            let { trailing } = split;
            child.url = isWww ? `http://${clean}` : clean;
            child.children = [{ type: 'text', value: clean }];

            const prev = nextChildren[nextChildren.length - 1];
            let wrappedNode: AstNode = child;
            if (prev?.type === 'text' && typeof prev.value === 'string') {
              const pair =
                prev.value.endsWith('**') && trailing.startsWith('**')
                  ? { marker: '**', wrapperType: 'strong' }
                  : prev.value.endsWith('~~') && trailing.startsWith('~~')
                    ? { marker: '~~', wrapperType: 'delete' }
                    : null;

              if (pair) {
                prev.value = prev.value.slice(0, -pair.marker.length);
                if (prev.value.length === 0) {
                  nextChildren.pop();
                }
                trailing = trailing.slice(pair.marker.length);
                wrappedNode = { type: pair.wrapperType, children: [child] };
              }
            }

            nextChildren.push(wrappedNode);
            if (trailing.length > 0) {
              nextChildren.push({ type: 'text', value: trailing });
            }
            continue;
          }
        }
      }

      walk(child);
      nextChildren.push(child);
    }

    if (mutated) {
      node.children = nextChildren;
    }
  };

  return (tree: AstNode) => {
    walk(tree);
  };
};

/**
 * Rehype plugin (running after rehypeSanitize) that marks an inline `<code>`
 * element as standalone when it is the sole content on its visual line inside
 * a `<p>` or `<li>` (accounting for `remark-breaks` `<br>` elements and
 * bold/italic wrappers).
 */
export const rehypeMarkStandaloneInlineCode = () => {
  const walk = (node: AstNode) => {
    if (node.type === 'element' && (node.tagName === 'p' || node.tagName === 'li') && Array.isArray(node.children)) {
      let segment: AstNode[] = [];
      for (const child of node.children) {
        if (child.type === 'element' && child.tagName === 'br') {
          markSegmentIfStandaloneCode(segment);
          segment = [];
        } else {
          segment.push(child);
        }
      }
      markSegmentIfStandaloneCode(segment);
      return;
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        walk(child);
      }
    }
  };

  return (tree: AstNode) => {
    walk(tree);
  };
};

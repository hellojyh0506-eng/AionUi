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
  properties?: Record<string, unknown>;
  children?: AstNode[];
};

const BARE_WIN_FILE_PATH_RE =
  /(?:^|(?<=[\s：:（([【"'=|、]))([A-Za-z]:[\\/][^\s`"'<>()（）[\]【】，。；;!！?？|、]+?(?:\.[A-Za-z0-9]{1,12}|[\\/][^\s`"'<>()（）[\]【】，。；;!！?？|、\\/]+)(?:#L\d+(?:-L\d+)?|:\d+(?::\d+)?)?)(?=$|[\s，。；;：:)）\]】"'!！?？|、])/g;

const SKIP_BARE_PARENT_TYPES = new Set(['link', 'linkReference', 'heading', 'inlineCode', 'code', 'html']);

const splitBarePathTextNode = (node: AstNode): AstNode[] | null => {
  const value = node.value;
  if (!value || !value.includes(':')) return null;

  BARE_WIN_FILE_PATH_RE.lastIndex = 0;
  const parts: AstNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = BARE_WIN_FILE_PATH_RE.exec(value)) !== null) {
    const candidate = match[1];
    const start = match.index;
    if (isShellCommandText(candidate)) {
      continue;
    }
    if (start > lastIndex) {
      parts.push({ type: 'text', value: value.slice(lastIndex, start) });
    }
    parts.push({ type: 'inlineCode', value: candidate });
    lastIndex = start + candidate.length;
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

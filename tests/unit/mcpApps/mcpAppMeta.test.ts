/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  expandMcpToolNameAliases,
  extractEmbeddedMcpAppDescriptor,
  isToolVisibleToApp,
  readMcpAppToolUiMetadata,
} from '@/common/types/mcpApps';
import { getActiveAtFileQuery } from '@/renderer/utils/chat/atFileQuery';
import {
  buildAtKnowledgeInsertion,
  extractKnowledgeMentions,
  getActiveAtKnowledgeQuery,
} from '@/renderer/utils/chat/atKnowledgeQuery';

describe('MCP Apps metadata & Knowledge mention parsing', () => {
  it('parses standard _meta.ui and legacy ui/resourceUri descriptors accurately', () => {
    expect(
      readMcpAppToolUiMetadata({
        ui: {
          resourceUri: 'ui://aionui-knowledge/search-results',
          visibility: ['model', 'app'],
        },
      })
    ).toEqual({
      resourceUri: 'ui://aionui-knowledge/search-results',
      visibility: ['model', 'app'],
    });

    expect(
      readMcpAppToolUiMetadata({
        'ui/resourceUri': 'ui://chart-server/bar',
      })
    ).toEqual({
      resourceUri: 'ui://chart-server/bar',
    });

    expect(readMcpAppToolUiMetadata(undefined)).toBeUndefined();
    expect(readMcpAppToolUiMetadata({ other: true })).toBeUndefined();
  });

  it('enforces ext-apps visibility constraints on model-only tools', () => {
    expect(isToolVisibleToApp(undefined)).toBe(true);
    expect(isToolVisibleToApp({ ui: { visibility: ['model', 'app'] } })).toBe(true);
    expect(isToolVisibleToApp({ ui: { visibility: ['app'] } })).toBe(true);
    expect(isToolVisibleToApp({ ui: { visibility: ['model'] } })).toBe(false);
  });

  it('expands namespaced MCP tool aliases and parses embedded UI JSON payloads', () => {
    const aliases = expandMcpToolNameAliases('mcp__aionui-knowledge-base__knowledge_search');
    expect(aliases).toContain('knowledge_search');
    expect(aliases).toContain('aionui-knowledge-base:knowledge_search');

    const embedded = extractEmbeddedMcpAppDescriptor(
      JSON.stringify({
        structuredContent: { query: 'test', hits: [] },
        _meta: { ui: { resourceUri: 'ui://demo/widget' } },
      })
    );
    expect(embedded).toEqual({
      resourceUri: 'ui://demo/widget',
      structuredContent: { query: 'test', hits: [] },
    });
  });

  it('parses @kb / @知识 mentions without colliding with @ file queries', () => {
    const q1 = getActiveAtKnowledgeQuery('帮我查下 @kb:产品文档', '帮我查下 @kb:产品文档'.length);
    expect(q1).toEqual({
      start: 5,
      end: 13,
      query: '产品文档',
      rawQuery: 'kb:产品文档',
      token: '@kb:产品文档',
    });

    const q2 = getActiveAtKnowledgeQuery('@知识', 3);
    expect(q2?.query).toBe('');
    expect(q2?.token).toBe('@知识');

    // `@` file matcher must short-circuit when `@kb` / `@知识` is active.
    expect(getActiveAtFileQuery('请看 @kb:文档', 10)).toBeNull();
    expect(getActiveAtFileQuery('请看 @知识', 6)).toBeNull();
    // Double-at session mention should not trigger KB mention.
    expect(getActiveAtKnowledgeQuery('@@kb', 4)).toBeNull();

    expect(buildAtKnowledgeInsertion('产品文档')).toBe('@知识库:产品文档');
    expect(extractKnowledgeMentions('请结合 @知识库:产品文档 和 @kb:API 说明回答')).toEqual([
      '产品文档',
      'API',
    ]);
  });
});

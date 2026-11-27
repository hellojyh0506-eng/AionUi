/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback } from 'react';
import useSWR from 'swr';
import { ipcBridge } from '@/common';
import type { IMcpServer } from '@/common/config/storage';
import {
  expandMcpToolNameAliases,
  extractEmbeddedMcpAppDescriptor,
  readMcpAppToolUiMetadata,
} from '@/common/types/mcpApps';

export interface ResolvedMcpAppTarget {
  serverId?: string;
  serverName?: string;
  toolName: string;
  resourceUri: string;
  embeddedStructuredContent?: Record<string, unknown>;
}

/**
 * Subscribe to the shared `/api/mcp/servers` SWR catalog and resolve whether a completed
 * chat tool call carries an `@modelcontextprotocol/ext-apps` interactive UI widget (`ui://...`).
 */
export function useMcpAppRegistry() {
  const { data: servers } = useSWR<IMcpServer[]>('/api/mcp/servers', () => ipcBridge.mcpService.listServers.invoke(), {
    revalidateOnFocus: false,
    dedupingInterval: 10000,
  });

  const resolveMcpAppForTool = useCallback(
    (toolName: string, rawOutput?: string): ResolvedMcpAppTarget | null => {
      const embedded = extractEmbeddedMcpAppDescriptor(rawOutput);
      const candidateNames = new Set(expandMcpToolNameAliases(toolName).map((a) => a.toLowerCase()));

      let matchedServer: IMcpServer | undefined;
      let matchedToolName = toolName;
      let matchedResourceUri = embedded?.resourceUri;

      for (const srv of servers || []) {
        if (embedded?.serverName && srv.name.toLowerCase() === embedded.serverName.toLowerCase()) {
          matchedServer = srv;
          break;
        }
        for (const tool of srv.tools || []) {
          const toolAliases = expandMcpToolNameAliases(tool.name).map((a) => a.toLowerCase());
          const hits = toolAliases.some((a) => candidateNames.has(a));
          if (!hits) continue;

          const uiMeta = readMcpAppToolUiMetadata(tool._meta);
          if (uiMeta?.resourceUri || embedded?.resourceUri) {
            matchedServer = srv;
            matchedToolName = tool.name;
            matchedResourceUri = matchedResourceUri || uiMeta?.resourceUri;
            break;
          }
        }
        if (matchedServer) break;
      }

      if (!matchedResourceUri && !matchedServer && (rawOutput || '').includes('ui://aionui-knowledge/search-results')) {
        const kbServer = (servers || []).find((s) => s.name === 'aionui-knowledge-base');
        if (kbServer) {
          matchedServer = kbServer;
          matchedResourceUri = 'ui://aionui-knowledge/search-results';
        }
      }

      if (!matchedResourceUri) return null;

      return {
        serverId: matchedServer?.id,
        serverName: matchedServer?.name || embedded?.serverName,
        toolName: embedded?.toolName || matchedToolName,
        resourceUri: matchedResourceUri,
        embeddedStructuredContent: embedded?.structuredContent,
      };
    },
    [servers]
  );

  return { resolveMcpAppForTool };
}

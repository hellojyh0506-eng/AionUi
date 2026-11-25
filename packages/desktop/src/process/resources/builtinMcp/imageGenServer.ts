/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Built-in MCP server for image generation.
 * Runs as a standalone stdio process spawned by the MCP client.
 * Reads provider config from environment variables.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BUILTIN_IMAGE_GEN_ID, BUILTIN_IMAGE_GEN_NAME } from './constants';
import { executeImageGeneration } from '@/common/chat/imageGenCore';
import type { TProviderWithModel } from '@/common/config/storage';

// Read provider config from environment variables
function getProviderFromEnv(): TProviderWithModel | null {
  const platform = process.env.AIONUI_IMG_PLATFORM;
  const base_url = process.env.AIONUI_IMG_BASE_URL;
  const api_key = process.env.AIONUI_IMG_API_KEY;
  const model = process.env.AIONUI_IMG_MODEL;

  if (!platform || !model) {
    return null;
  }

  return {
    id: BUILTIN_IMAGE_GEN_ID,
    name: BUILTIN_IMAGE_GEN_NAME,
    platform,
    base_url: base_url || '',
    api_key: api_key || '',
    use_model: model,
  };
}

async function main() {
  const defaultModel = process.env.AIONUI_IMG_MODEL?.trim() || '未配置';
  const defaultBaseUrl = process.env.AIONUI_IMG_BASE_URL?.trim() || '未配置';

  const server = new McpServer({
    name: BUILTIN_IMAGE_GEN_NAME,
    version: '1.1.0',
  });

  server.tool(
    'aionui_image_generation',
    `REQUIRED tool for generating or editing images (text-to-image AND reference-image / image-to-image edits via /v1/images/generations & /v1/images/edits).

Configured Runtime Defaults:
- Default model: ${defaultModel}
- API gateway: ${defaultBaseUrl}
- Supports optional overrides: model, size, quality, n, and image_uris (triggers multipart /v1/images/edits on OpenAI-compatible image models like gpt-image-2.6).

CRITICAL: You MUST call this tool directly BEFORE falling back to scripts or searching config files:
- Text-to-image: pass prompt (and optional model / size / quality / n)
- Reference image / image-to-image editing: pass prompt AND image_uris (e.g. ["ref.jpg"]) + optional size (e.g. "1024x1536")

Output:
- Saves generated/edited image directly into the conversation workspace and returns its relative path for inline Markdown rendering.`,
    {
      prompt: z
        .string()
        .describe(
          'Text prompt describing the image to generate or edit (English recommended for best visual fidelity).'
        ),
      image_uris: z
        .array(z.string())
        .optional()
        .describe(
          'Optional: Local workspace file paths or HTTP/HTTPS URLs for reference-image / image-to-image editing (automatically routes to /v1/images/edits for models like gpt-image-2.6).'
        ),
      model: z
        .string()
        .optional()
        .describe(
          `Optional model override (defaults to "${defaultModel}"). Examples: "gpt-image-2.6", "gpt-image-2.5", "grok-imagine-image-2.0", "gemini-2.5-flash-image".`
        ),
      size: z
        .string()
        .optional()
        .describe(
          'Optional output dimensions, e.g. "1024x1024", "1024x1536", "1536x1024", "auto".'
        ),
      quality: z
        .string()
        .optional()
        .describe('Optional rendering quality, e.g. "low", "medium", "high", "auto".'),
      n: z
        .number()
        .int()
        .min(1)
        .max(4)
        .optional()
        .describe('Optional number of images to generate (1-4, defaults to 1).'),
    },
    async ({ prompt, image_uris, model, size, quality, n }) => {
      const provider = getProviderFromEnv();
      if (!provider) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Error: Image generation model not configured. Please select an image generation model in Settings > Tools.',
            },
          ],
          isError: true,
        };
      }

      const proxy = process.env.AIONUI_IMG_PROXY || undefined;
      // Prefer AIONUI_WORKSPACE injected by the agent runtime (since the spawned
      // MCP process cwd often inherits app userData instead of conversation workspace).
      const workspaceDir =
        process.env.AIONUI_WORKSPACE?.trim() || process.env.WORKSPACE_DIR?.trim() || process.cwd();

      const result = await executeImageGeneration(
        { prompt, image_uris, model, size, quality, n },
        provider,
        workspaceDir,
        proxy
      );

      if (!result.success) {
        return {
          content: [{ type: 'text' as const, text: result.text }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: result.text }],
      };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('[ImageGenMCP] Fatal error:', error);
  process.exit(1);
});

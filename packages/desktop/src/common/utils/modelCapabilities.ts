/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  IProvider,
  ModelImageInputCapability,
  ModelOpenAiApiMode,
  ModelSettings,
  ModelType,
} from '@/common/config/storage';

/**
 * Capability matching regex patterns
 */
export const CAPABILITY_PATTERNS: Record<ModelType, RegExp> = {
  text: /gpt|claude|gemini|qwen|llama|mistral|deepseek/i,
  vision: /4o|gpt-4\.1|gpt-5|gpt-6|o[134](?:-|$)|claude-(?:3|4|5|sonnet|opus|haiku)|gemini|grok|deepseek-v4\.1-flash|qwen.*vl|glm-4v|llava|vision/i,
  function_calling: /gpt-4|claude-3|gemini|qwen|deepseek/i,
  image_generation: /flux|diffusion|stabilityai|sd-|dall|cogview|janus|midjourney|mj-|imagen|gpt-image|nano-banana|grok-imagine-image|-image(?:$|-)/i,
  web_search: /search|perplexity/i,
  reasoning: /o1-|reasoning|think/i,
  embedding: /(?:^text-|embed|bge-|e5-|LLM2Vec|retrieval|uae-|gte-|jina-clip|jina-embeddings|voyage-)/i,
  rerank: /(?:rerank|re-rank|re-ranker|re-ranking|retrieval|retriever)/i,
  // Media/utility models must never appear in the primary chat model picker —
  // they belong in Settings > Tools (image generation) or the media skills only.
  // `banana` catches gemini-nano-banana-*; `imagine` catches grok-imagine-*;
  // `image` catches gpt-image-*, *-image, flash-image, etc.
  excludeFromPrimary: /dall-e|flux|stable-diffusion|midjourney|flash-image|image|video|embed|rerank|banana|imagine|imagen|cogview|janus|mj-|diffusion|tts|whisper/i,
};

/**
 * Explicit exclusion lists (blacklist) for capabilities
 */
export const CAPABILITY_EXCLUSIONS: Record<ModelType, RegExp[]> = {
  text: [],
  vision: [/embed|rerank|dall-e|flux|stable-diffusion|midjourney|imagen|gpt-image|nano-banana|-image(?:$|-)|video|tts|whisper|audio/i],
  function_calling: [
    /aqa(?:-[\w-]+)?/i,
    /imagen(?:-[\w-]+)?/i,
    /o1-mini/i,
    /o1-preview/i,
    /gemini-1(?:\\.[\w-]+)?/i,
    /dall-e/i,
    /embed/i,
    /rerank/i,
  ],
  image_generation: [/video/i],
  web_search: [],
  reasoning: [],
  embedding: [],
  rerank: [],
  excludeFromPrimary: [],
};

/**
 * Get the lowercase, normalized base model name for matching.
 */
export const getBaseModelName = (modelName: string): string => {
  return modelName
    .toLowerCase()
    .replace(/[^a-z0-9./-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
};

export type ModelOpenAiApiModeChoice = ModelOpenAiApiMode | 'auto';
export type ModelImageInputChoice = ModelImageInputCapability | 'auto';

/** Whether a provider/model protocol can select an OpenAI wire API. */
export const supportsOpenAiApiMode = (platform: string, modelProtocol = 'openai'): boolean => {
  if (platform === 'new-api') return modelProtocol === 'openai';
  return !['anthropic', 'bedrock', 'gemini', 'gemini-vertex-ai'].includes(platform);
};

/** Apply explicit settings to models while keeping automatic values absent on the wire. */
export const updateModelSettings = (
  current: Record<string, ModelSettings> | undefined,
  modelIds: string[],
  imageInput: ModelImageInputChoice,
  openAiApiMode: ModelOpenAiApiModeChoice
): Record<string, ModelSettings> => {
  const next = { ...current };

  for (const modelId of modelIds) {
    if (imageInput === 'auto' && openAiApiMode === 'auto') {
      delete next[modelId];
      continue;
    }

    const settings: ModelSettings = {};
    if (imageInput !== 'auto') settings.image_input = imageInput;
    if (openAiApiMode !== 'auto') settings.openai_api_mode = openAiApiMode;
    next[modelId] = settings;
  }

  return next;
};

/**
 * Check whether a specific model within a provider has a given capability.
 * Returns true (supported), false (excluded), or undefined (unknown).
 */
export const hasSpecificModelCapability = (
  _platformModel: IProvider,
  modelName: string,
  type: ModelType
): boolean | undefined => {
  const baseModelName = getBaseModelName(modelName);
  const exclusions = CAPABILITY_EXCLUSIONS[type];
  const pattern = CAPABILITY_PATTERNS[type];

  const isExcluded = exclusions.some((excludePattern) => excludePattern.test(baseModelName));
  if (isExcluded) return false;

  return pattern.test(baseModelName) ? true : undefined;
};

/**
 * Determine whether a chat model name should default to multimodal image input (`supported`).
 */
export const isLikelyVisionChatModel = (modelName: string): boolean => {
  const baseModelName = getBaseModelName(modelName);
  if (!baseModelName) return false;
  if (CAPABILITY_EXCLUSIONS.vision.some((excludePattern) => excludePattern.test(baseModelName))) {
    return false;
  }
  return CAPABILITY_PATTERNS.vision.test(baseModelName);
};

/**
 * When adding new models with imageInput set to 'auto', pre-populate `{ image_input: 'supported' }`
 * for models recognized by `isLikelyVisionChatModel` so renamed custom aliases work out of the box.
 */
export const withAutoVisionModelSettings = (
  settings: Record<string, ModelSettings>,
  modelIds: string[],
  imageInputChoice: ModelImageInputChoice
): Record<string, ModelSettings> => {
  if (imageInputChoice !== 'auto') return settings;
  const next = { ...settings };
  for (const modelId of modelIds) {
    if (isLikelyVisionChatModel(modelId) && !next[modelId]?.image_input) {
      next[modelId] = { ...next[modelId], image_input: 'supported' };
    }
  }
  return next;
};

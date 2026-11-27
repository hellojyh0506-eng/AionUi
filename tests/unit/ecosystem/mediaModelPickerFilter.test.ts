/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { IProvider } from '@/common/config/storage';
import { hasSpecificModelCapability } from '@/common/utils/modelCapabilities';
import { isImageGenSupported } from '@/common/utils/imageModelAllowlist';
import { getAvailableModels } from '@/renderer/pages/guid/utils/modelUtils';

const ethanProvider = {
  id: 'ethan-test',
  platform: 'new-api',
  name: 'EthanToken',
  base_url: 'https://ethantoken.top/v1',
  api_key: 'sk-test',
  models: [
    'deepseek-v4.1-flash',
    'gpt-6.2-sol',
    'claude-sonnet-5-5',
    'grok-4.7',
    'gemini-nano-banana-2.1',
    'gemini-3-pro-image',
    'gemini-3.1-flash-image',
    'gemini-2.5-flash-image',
    'gpt-image-2.6',
    'gpt-image-2.6-flare',
    'grok-imagine-image-2.0',
    'grok-imagine-image-quality',
    'grok-imagine-video',
    'grok-imagine-video-1.5',
    'muse-video',
  ],
} as unknown as IProvider;

describe('media models never appear in the primary chat picker', () => {
  it('flags nano-banana / imagine / image / video models as excludeFromPrimary', () => {
    for (const media of [
      'gemini-nano-banana-2.1',
      'gemini-3-pro-image',
      'gemini-3.1-flash-image',
      'gpt-image-2.6',
      'grok-imagine-image-2.0',
      'grok-imagine-video',
      'muse-video',
    ]) {
      expect(hasSpecificModelCapability(ethanProvider, media, 'excludeFromPrimary')).toBe(true);
    }
    for (const chat of ['deepseek-v4.1-flash', 'gpt-6.2-sol', 'claude-sonnet-5-5', 'grok-4.7']) {
      expect(hasSpecificModelCapability(ethanProvider, chat, 'excludeFromPrimary')).not.toBe(true);
    }
  });

  it('getAvailableModels keeps only chat models', () => {
    expect(getAvailableModels(ethanProvider)).toEqual([
      'deepseek-v4.1-flash',
      'gpt-6.2-sol',
      'claude-sonnet-5-5',
      'grok-4.7',
    ]);
  });

  it('image-gen allowlist still offers nano-banana in Settings > Tools', () => {
    expect(isImageGenSupported(ethanProvider, 'gemini-nano-banana-2.1')).toBe(true);
    expect(isImageGenSupported(ethanProvider, 'gpt-image-2.6')).toBe(true);
    expect(isImageGenSupported(ethanProvider, 'grok-imagine-image-2.0')).toBe(true);
    expect(isImageGenSupported(ethanProvider, 'grok-imagine-video')).toBe(false);
    expect(isImageGenSupported(ethanProvider, 'deepseek-v4.1-flash')).toBe(false);
  });
});

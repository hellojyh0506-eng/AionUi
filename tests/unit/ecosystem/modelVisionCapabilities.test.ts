/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { isLikelyVisionChatModel, withAutoVisionModelSettings } from '@/common/utils/modelCapabilities';

describe('isLikelyVisionChatModel', () => {
  it('detects EthanToken and custom multimodal flagship model aliases as vision-capable', () => {
    expect(isLikelyVisionChatModel('claude-sonnet-5-5')).toBe(true);
    expect(isLikelyVisionChatModel('gpt-6.2-sol-fast')).toBe(true);
    expect(isLikelyVisionChatModel('gpt-6.2-sol')).toBe(true);
    expect(isLikelyVisionChatModel('gpt-6.2-sol-pro')).toBe(true);
    expect(isLikelyVisionChatModel('gpt-6.2-astra')).toBe(true);
    expect(isLikelyVisionChatModel('gemini-3.8-flash')).toBe(true);
    expect(isLikelyVisionChatModel('gemini-3.8-flash-high')).toBe(true);
    expect(isLikelyVisionChatModel('grok-4.7')).toBe(true);
    expect(isLikelyVisionChatModel('deepseek-v4.1-flash')).toBe(true);
    expect(isLikelyVisionChatModel('workbuddy/deepseek-v4.1-flash')).toBe(true);
    expect(isLikelyVisionChatModel('deepseek-v4.1-flash-official')).toBe(true);
    expect(isLikelyVisionChatModel('gpt-4o')).toBe(true);
  });

  it('auto-populates image_input supported when adding new vision models with auto choice', () => {
    const res = withAutoVisionModelSettings(
      {},
      ['workbuddy/deepseek-v4.1-flash', 'deepseek-v4-pro'],
      'auto'
    );
    expect(res).toEqual({
      'workbuddy/deepseek-v4.1-flash': { image_input: 'supported' },
    });
  });

  it('excludes text-only, image-generation, video, and embedding models', () => {
    expect(isLikelyVisionChatModel('deepseek-v4-pro')).toBe(false);
    expect(isLikelyVisionChatModel('gpt-image-2.6')).toBe(false);
    expect(isLikelyVisionChatModel('gemini-2.5-flash-image')).toBe(false);
    expect(isLikelyVisionChatModel('grok-imagine-video')).toBe(false);
    expect(isLikelyVisionChatModel('text-embedding-3-large')).toBe(false);
  });
});

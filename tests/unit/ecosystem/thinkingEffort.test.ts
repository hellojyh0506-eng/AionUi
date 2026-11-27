/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  CODEX_STARFIELD_PARTICLES,
  energyFor,
  fillBackgroundFor,
  getModelThinkingLevel,
  getThinkingSliderPreferences,
  MOTION_FAST,
  MOTION_SMOOTH,
  motionSettled,
  motionStep,
  normalizeThinkingOptions,
  resolveModelThinkingSpec,
  setModelThinkingLevel,
  setThinkingSliderAnimationMode,
  setThinkingSliderEnabled,
  setThinkingSliderReachedTickStyle,
  setThinkingSliderStyle,
  valueColorFor,
} from '@/renderer/utils/thinkingEffort';

describe('thinkingEffort real model specs and dsh-codex-effort-slider physics', () => {
  it('resolves exact per-model capabilities and hides non-thinking/media models', () => {
    const dsFlash = resolveModelThinkingSpec('workbuddy/deepseek-v4.1-flash');
    expect(dsFlash?.options.map((o) => o.value)).toEqual(['off', 'low', 'high', 'max']);
    expect(dsFlash?.defaultValue).toBe('high');

    const gpt6 = resolveModelThinkingSpec('gpt-6.2-sol');
    expect(gpt6?.options.map((o) => o.value)).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(gpt6?.defaultValue).toBe('medium');

    const gemini4 = resolveModelThinkingSpec('gemini-4-neon');
    expect(gemini4?.options.map((o) => o.value)).toEqual(['low', 'medium', 'high', 'xhigh']);

    const gemini38 = resolveModelThinkingSpec('gemini-3.8-flash');
    expect(gemini38?.options.map((o) => o.value)).toEqual(['low', 'medium', 'high', 'xhigh']);

    const claude5 = resolveModelThinkingSpec('claude-sonnet-5-5');
    expect(claude5?.options.map((o) => o.value)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);

    expect(resolveModelThinkingSpec('gpt-image-2.6')).toBeNull();
    expect(resolveModelThinkingSpec('gemini-3.1-flash-image')).toBeNull();
    expect(resolveModelThinkingSpec('gpt-4o')).toBeNull();
    expect(resolveModelThinkingSpec(null)).toBeNull();
  });

  it('persists per-model effort levels and slider preferences cleanly', () => {
    setThinkingSliderEnabled(true);
    setThinkingSliderStyle('native-list');
    setThinkingSliderAnimationMode('smooth');
    setThinkingSliderReachedTickStyle('same');

    const spec = resolveModelThinkingSpec('gpt-6.2-sol')!;
    expect(getModelThinkingLevel(getThinkingSliderPreferences(), 'gpt-6.2-sol', spec)).toBe('medium');

    setModelThinkingLevel('gpt-6.2-sol', 'xhigh');
    expect(getModelThinkingLevel(getThinkingSliderPreferences(), 'gpt-6.2-sol', spec)).toBe('xhigh');
    // Invalid stored value falls back cleanly to model default
    setModelThinkingLevel('gpt-6.2-sol', 'max');
    expect(getModelThinkingLevel(getThinkingSliderPreferences(), 'gpt-6.2-sol', spec)).toBe('medium');

    setThinkingSliderStyle('codex-slider');
    setThinkingSliderAnimationMode('smooth');
    setThinkingSliderReachedTickStyle('highlight');
    expect(getThinkingSliderPreferences()).toMatchObject({
      enabled: true,
      style: 'codex-slider',
      animationMode: 'smooth',
      reachedTickStyle: 'highlight',
    });
  });

  it('computes codex energy curve, Off gray text color, and 22 spaced starfield particles', () => {
    expect(energyFor(0.2)).toBe(0);
    expect(energyFor(1)).toBe(1);
    expect(valueColorFor(0, { value: 'off', label: 'Off' })).toBe('');
    expect(valueColorFor(1, { value: 'max', label: 'Max' })).toContain('rgb(');
    expect(fillBackgroundFor(0, true)).toBe('transparent');
    expect(fillBackgroundFor(0.67, false)).toContain('linear-gradient');

    expect(CODEX_STARFIELD_PARTICLES).toHaveLength(22);
    for (const star of CODEX_STARFIELD_PARTICLES) {
      expect(star.yPercent).toBeGreaterThanOrEqual(8);
      expect(star.yPercent).toBeLessThanOrEqual(92);
      expect(star.delaySec).toBeLessThanOrEqual(0);
    }

    expect(normalizeThinkingOptions([{ value: 'xhigh', label: 'xhigh' }])[0].label).toBe('Extra High');
  });

  it('converges without overshoot in both fast and smooth motion solvers', () => {
    const fast = { x: 0, v: 0, a: 0, target: 1 };
    for (let i = 0; i < 60 && !motionSettled(fast, MOTION_FAST); i += 1) {
      motionStep(fast, 1 / 60, MOTION_FAST);
      expect(fast.x).toBeLessThanOrEqual(1);
      expect(fast.x).toBeGreaterThanOrEqual(0);
    }
    expect(fast.x).toBe(1);

    const smooth = { x: 1, v: 0, a: 0, target: 0.3333 };
    for (let i = 0; i < 90 && !motionSettled(smooth, MOTION_SMOOTH); i += 1) {
      motionStep(smooth, 1 / 60, MOTION_SMOOTH);
      expect(smooth.x).toBeGreaterThanOrEqual(0.3333);
    }
    expect(smooth.x).toBeCloseTo(0.3333, 3);
  });
});

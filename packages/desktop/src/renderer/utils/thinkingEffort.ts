/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { useSyncExternalStore } from 'react';

export type ThinkingSliderStyle = 'codex-slider' | 'native-list';
export type ThinkingSliderAnimationMode = 'fast' | 'smooth';
export type ThinkingReachedTickStyle = 'highlight' | 'same' | 'hidden';

export type ThinkingOptionItem = {
  value: string;
  label: string;
  description?: string | null;
};

export interface ModelThinkingSpec {
  options: ThinkingOptionItem[];
  defaultValue: string;
}

export interface ThinkingSliderPreferences {
  enabled: boolean;
  style: ThinkingSliderStyle;
  animationMode: ThinkingSliderAnimationMode;
  reachedTickStyle: ThinkingReachedTickStyle;
  modelLevels: Record<string, string>;
}

export interface ThinkingSliderStyleMeta {
  id: ThinkingSliderStyle;
  name: string;
  badge: string;
  description: string;
}

export const THINKING_SLIDER_STYLES: ThinkingSliderStyleMeta[] = [
  {
    id: 'codex-slider',
    name: 'Codex 滑条',
    badge: '默认',
    description: '渐变滑块',
  },
  {
    id: 'native-list',
    name: '极简列表',
    badge: '原生',
    description: '下拉勾选',
  },
];

const STORAGE_KEY = 'ethantoken.thinkingSlider.v4';
const LEGACY_STORAGE_KEY_V3 = 'ethantoken.thinkingSlider.v3';

const DEFAULT_PREFERENCES: ThinkingSliderPreferences = {
  enabled: true,
  style: 'codex-slider',
  animationMode: 'smooth',
  reachedTickStyle: 'highlight',
  modelLevels: {},
};

const VALID_STYLES = new Set<ThinkingSliderStyle>(['codex-slider', 'native-list']);
const VALID_ANIM_MODES = new Set<ThinkingSliderAnimationMode>(['fast', 'smooth']);
const VALID_TICK_STYLES = new Set<ThinkingReachedTickStyle>(['highlight', 'same', 'hidden']);

function normalizePreferences(raw: unknown): ThinkingSliderPreferences {
  if (!raw || typeof raw !== 'object') {
    return DEFAULT_PREFERENCES;
  }
  const obj = raw as Record<string, unknown>;
  const rawLevels = obj.modelLevels;
  const modelLevels: Record<string, string> = {};
  if (rawLevels && typeof rawLevels === 'object' && !Array.isArray(rawLevels)) {
    for (const [k, v] of Object.entries(rawLevels as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim()) {
        modelLevels[k] = v;
      }
    }
  }
  return {
    enabled: typeof obj.enabled === 'boolean' ? obj.enabled : DEFAULT_PREFERENCES.enabled,
    style:
      typeof obj.style === 'string' && VALID_STYLES.has(obj.style as ThinkingSliderStyle)
        ? (obj.style as ThinkingSliderStyle)
        : DEFAULT_PREFERENCES.style,
    animationMode:
      typeof obj.animationMode === 'string' && VALID_ANIM_MODES.has(obj.animationMode as ThinkingSliderAnimationMode)
        ? (obj.animationMode as ThinkingSliderAnimationMode)
        : DEFAULT_PREFERENCES.animationMode,
    reachedTickStyle:
      typeof obj.reachedTickStyle === 'string' &&
      VALID_TICK_STYLES.has(obj.reachedTickStyle as ThinkingReachedTickStyle)
        ? (obj.reachedTickStyle as ThinkingReachedTickStyle)
        : DEFAULT_PREFERENCES.reachedTickStyle,
    modelLevels,
  };
}

function readPreferencesFromStorage(): ThinkingSliderPreferences {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return DEFAULT_PREFERENCES;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return normalizePreferences(JSON.parse(raw));
    }
    const legacyV3 = window.localStorage.getItem(LEGACY_STORAGE_KEY_V3);
    if (legacyV3) {
      const migratedV3 = normalizePreferences(JSON.parse(legacyV3));
      return {
        ...DEFAULT_PREFERENCES,
        modelLevels: migratedV3.modelLevels,
      };
    }
    return DEFAULT_PREFERENCES;
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

let cachedPreferences: ThinkingSliderPreferences = readPreferencesFromStorage();
const listeners = new Set<() => void>();

function emitChange(): void {
  listeners.forEach((listener) => listener());
}

export function getThinkingSliderPreferences(): ThinkingSliderPreferences {
  return cachedPreferences;
}

function syncPreferencesToGateway(prefs: ThinkingSliderPreferences): void {
  try {
    const invoke = ipcBridge?.thinkingEffort?.syncPreferences?.invoke;
    if (typeof invoke === 'function') {
      void invoke({ enabled: prefs.enabled, modelLevels: prefs.modelLevels }).catch((): undefined => undefined);
    }
  } catch {
    // ignore in SSR / test environments without ipcBridge
  }
}

function syncModelEffortToGateway(modelKey: string, value: string): void {
  try {
    const invoke = ipcBridge?.thinkingEffort?.setModelEffort?.invoke;
    if (typeof invoke === 'function') {
      void invoke({ model: modelKey, effort: value }).catch((): undefined => undefined);
    }
  } catch {
    // ignore in SSR / test environments without ipcBridge
  }
}

let gatewayHydrated = false;

/**
 * Pushes cached localStorage preferences to the main-process loopback thinking gateway
 * once per renderer lifecycle so persisted levels take effect on initial launch.
 */
export function hydrateThinkingEffortGateway(): void {
  if (gatewayHydrated) return;
  gatewayHydrated = true;
  syncPreferencesToGateway(cachedPreferences);
}

export function updateThinkingSliderPreferences(
  patch: Partial<ThinkingSliderPreferences>
): ThinkingSliderPreferences {
  cachedPreferences = normalizePreferences({ ...cachedPreferences, ...patch });
  if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cachedPreferences));
    } catch {
      // ignore quota / storage failures
    }
  }
  syncPreferencesToGateway(cachedPreferences);
  emitChange();
  return cachedPreferences;
}

export function setThinkingSliderEnabled(enabled: boolean): void {
  updateThinkingSliderPreferences({ enabled });
}

export function setThinkingSliderStyle(style: ThinkingSliderStyle): void {
  updateThinkingSliderPreferences({ style });
}

export function setThinkingSliderAnimationMode(animationMode: ThinkingSliderAnimationMode): void {
  updateThinkingSliderPreferences({ animationMode });
}

export function setThinkingSliderReachedTickStyle(reachedTickStyle: ThinkingReachedTickStyle): void {
  updateThinkingSliderPreferences({ reachedTickStyle });
}

export function normalizeModelCapabilityKey(modelName?: string | null): string {
  if (!modelName) return '';
  const trimmed = modelName.trim();
  const slashIdx = trimmed.lastIndexOf('/');
  const bare = slashIdx >= 0 ? trimmed.slice(slashIdx + 1) : trimmed;
  return bare.toLowerCase();
}

export function setModelThinkingLevel(modelName: string, value: string): void {
  const key = normalizeModelCapabilityKey(modelName);
  if (!key) return;
  updateThinkingSliderPreferences({
    modelLevels: {
      ...cachedPreferences.modelLevels,
      [key]: value,
    },
  });
  syncModelEffortToGateway(key, value);
}

export function getModelThinkingLevel(
  prefs: ThinkingSliderPreferences,
  modelName?: string | null,
  spec?: ModelThinkingSpec | null
): string {
  if (!spec || spec.options.length === 0) return '';
  const key = normalizeModelCapabilityKey(modelName);
  const stored = key ? prefs.modelLevels[key] : undefined;
  if (stored && spec.options.some((o) => o.value === stored)) {
    return stored;
  }
  return spec.defaultValue;
}

export function subscribeThinkingSliderPreferences(listener: () => void): () => void {
  listeners.add(listener);
  if (typeof window !== 'undefined') {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) {
        cachedPreferences = readPreferencesFromStorage();
        emitChange();
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => {
      listeners.delete(listener);
      window.removeEventListener('storage', handleStorage);
    };
  }
  return () => {
    listeners.delete(listener);
  };
}

export function useThinkingSliderPreferences(): ThinkingSliderPreferences {
  return useSyncExternalStore(
    subscribeThinkingSliderPreferences,
    getThinkingSliderPreferences,
    () => DEFAULT_PREFERENCES
  );
}

// =============================================================================
// Authentic per-model thinking effort capabilities
// =============================================================================

const TIER_LABELS: Record<string, string> = {
  none: 'Off',
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  med: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
};

function makeOptions(values: string[]): ThinkingOptionItem[] {
  return values.map((v) => ({
    value: v,
    label: TIER_LABELS[v.toLowerCase()] || v,
  }));
}

/**
 * Resolves the real thinking effort tiers supported by a model.
 * Returns null for image/video/audio/non-thinking models so the slider hides automatically.
 */
export function resolveModelThinkingSpec(modelName?: string | null): ModelThinkingSpec | null {
  const m = normalizeModelCapabilityKey(modelName);
  if (!m) return null;

  // Exclude image/video/audio/embedding/non-thinking models strictly.
  if (
    /(?:^|-)(?:image|video|tts|whisper|embedding|dall-e|sora|muse-video|nano-banana)(?:$|-)|gpt-image|grok-imagine/i.test(
      m
    )
  ) {
    return null;
  }
  if (/^(?:gpt-4o|gpt-4\.1|gpt-4-turbo|claude-3-5|claude-3-haiku|deepseek-v3|deepseek-chat)/.test(m)) {
    return null;
  }

  // DeepSeek V4.1 Flash: official 4-notch Off / Low / High / Max (default High)
  if (/deepseek-v4\.1-flash/.test(m)) {
    return { options: makeOptions(['off', 'low', 'high', 'max']), defaultValue: 'high' };
  }

  // DeepSeek V4 Pro / R1 / Reasoner: Low / Medium / High
  if (/deepseek-v4-pro|deepseek-r1|deepseek-reasoner/.test(m)) {
    return { options: makeOptions(['low', 'medium', 'high']), defaultValue: 'medium' };
  }

  // GPT-6 / GPT-5.2 / 5.3 / 5.4 / Codex: OpenAI 4-notch Low / Medium / High / Extra High (no Max!)
  if (/^(?:gpt-6|gpt-5\.[2-9]|.*codex)/.test(m)) {
    return { options: makeOptions(['low', 'medium', 'high', 'xhigh']), defaultValue: 'medium' };
  }

  // GPT-5 / o1 / o3 / o4-mini: Low / Medium / High
  if (/^(?:gpt-5|o1|o3|o4-mini)/.test(m)) {
    return { options: makeOptions(['low', 'medium', 'high']), defaultValue: 'medium' };
  }

  // Gemini 4 / 3.8 / 3: Low / Medium / High / Extra High (matches user reference!)
  if (/^gemini-(?:4|3\.8|3)/.test(m)) {
    return { options: makeOptions(['low', 'medium', 'high', 'xhigh']), defaultValue: 'medium' };
  }

  // Gemini 2.5 thinking models: Off / Low / Medium / High
  if (m.startsWith('gemini-2.5')) {
    return { options: makeOptions(['off', 'low', 'medium', 'high']), defaultValue: 'medium' };
  }

  // Claude Opus 4.7/4.8, Sonnet 5, Fable 5: Low / Medium / High / Extra High / Max
  if (/claude-(?:opus-4-[78]|sonnet-5|fable-5)/.test(m)) {
    return { options: makeOptions(['low', 'medium', 'high', 'xhigh', 'max']), defaultValue: 'medium' };
  }

  // Claude 3.7 / 4.x Sonnet & Opus (up to 4.6): Off / Low / Medium / High
  if (/claude-(?:3-7-sonnet|sonnet-4|opus-4)/.test(m)) {
    return { options: makeOptions(['off', 'low', 'medium', 'high']), defaultValue: 'medium' };
  }

  // Grok 4 / Grok 3 Mini: Low / High
  if (/^grok-(?:4|3-mini)/.test(m)) {
    return { options: makeOptions(['low', 'high']), defaultValue: 'low' };
  }

  return null;
}

export function normalizeThinkingOptions(options: ThinkingOptionItem[]): ThinkingOptionItem[] {
  return options.map((item) => {
    const key = item.value.trim().toLowerCase();
    return {
      value: item.value,
      label: TIER_LABELS[key] || item.label || item.value,
      description: item.description,
    };
  });
}

// =============================================================================
// Direct port of Microqian2th/dsh-codex-effort-slider color math & physics
// =============================================================================

const ENERGY_START = 1 / 3;
const ENERGY_END = 2 / 3;
const COLOR_BLUE: readonly [number, number, number] = [77, 147, 248]; // #4d93f8
const COLOR_VIOLET: readonly [number, number, number] = [147, 51, 234]; // #9333ea
const COLOR_DEEP: readonly [number, number, number] = [76, 29, 149]; // #4c1d95
const COLOR_TEXT_VIOLET: readonly [number, number, number] = [139, 92, 246]; // #8b5cf6 (AA contrast light & dark)

function clamp01(v: number): number {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}

function mixColor(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number
): [number, number, number] {
  const k = clamp01(t);
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ];
}

function rgbOf(c: readonly [number, number, number]): string {
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export function isOffOption(option?: Pick<ThinkingOptionItem, 'value' | 'label'> | null): boolean {
  if (!option) return false;
  for (const cand of [option.value, option.label]) {
    if (typeof cand !== 'string') continue;
    const flat = cand.replace(/\s+/gu, '').toLowerCase();
    if (flat === 'off' || flat === 'none' || flat === '关闭' || flat === '无') {
      return true;
    }
  }
  return false;
}

export function energyFor(pct: number): number {
  return clamp01((clamp01(pct) - ENERGY_START) / (1 - ENERGY_START));
}

export function fillColorFor(pct: number): string {
  const t = clamp01(pct);
  if (t <= ENERGY_START) return rgbOf(COLOR_BLUE);
  if (t <= ENERGY_END) return rgbOf(mixColor(COLOR_BLUE, COLOR_VIOLET, (t - ENERGY_START) / (ENERGY_END - ENERGY_START)));
  return rgbOf(mixColor(COLOR_VIOLET, COLOR_DEEP, (t - ENERGY_END) / (1 - ENERGY_END)));
}

export function fillBackgroundFor(pct: number, isOff = false): string {
  if (isOff) return 'transparent';
  return `linear-gradient(90deg, ${rgbOf(COLOR_BLUE)}, ${fillColorFor(pct)})`;
}

export function valueColorFor(pct: number, option?: Pick<ThinkingOptionItem, 'value' | 'label'> | null): string {
  if (isOffOption(option)) return '';
  return rgbOf(mixColor(COLOR_BLUE, COLOR_TEXT_VIOLET, energyFor(pct)));
}

export function particleCountFor(pct: number, total = 22): number {
  return Math.round(energyFor(pct) * total);
}

// =============================================================================
// 60fps 2nd-order non-overshooting motion solver (MIT dsh-codex-effort-slider)
// =============================================================================

export interface MotionState {
  x: number;
  v: number;
  a: number;
  target: number;
}

export interface MotionParams {
  K: number;
  A: number;
  k: number;
  amax: number;
  vmax: number;
  epsX: number;
  epsV: number;
}

export const MOTION_FAST: MotionParams = { K: 60, A: 500, k: 60, amax: 300, vmax: 10, epsX: 0.002, epsV: 0.02 };
export const MOTION_SMOOTH: MotionParams = { K: 20, A: 120, k: 40, amax: 240, vmax: 6, epsX: 0.002, epsV: 0.02 };

function clampAbs(value: number, limit: number): number {
  if (value > limit) return limit;
  return value < -limit ? -limit : value;
}

export function motionSettled(m: MotionState, p: MotionParams): boolean {
  return Math.abs(m.target - m.x) < p.epsX && Math.abs(m.v) < p.epsV;
}

export function motionStep(m: MotionState, dt: number, p: MotionParams): MotionState {
  const e = m.target - m.x;
  let vAbs = p.K * Math.abs(e);
  const brake = Math.sqrt(2 * p.A * Math.abs(e));
  if (brake < vAbs) vAbs = brake;
  if (vAbs > p.vmax) vAbs = p.vmax;
  const vDesired = e > 0 ? vAbs : e < 0 ? -vAbs : 0;
  m.a = clampAbs(p.k * (vDesired - m.v), p.amax);
  m.v = clampAbs(m.v + m.a * dt, p.vmax);
  if (e !== 0 && Math.abs(m.v * dt) >= Math.abs(e)) {
    m.x = m.target;
    m.v = 0;
    m.a = 0;
    return m;
  }
  const xRaw = m.x + m.v * dt;
  const xClamped = xRaw < 0 ? 0 : xRaw > 1 ? 1 : xRaw;
  if (xClamped !== xRaw && ((xClamped === 0 && m.v < 0) || (xClamped === 1 && m.v > 0))) {
    m.v = 0;
    m.a = 0;
  }
  m.x = xClamped;
  if (motionSettled(m, p)) {
    m.x = m.target;
    m.v = 0;
    m.a = 0;
  }
  return m;
}

// =============================================================================
// Golden-ratio 22-starfield layout (zero oxlint Array#sort warnings)
// =============================================================================

export interface CodexStarParticle {
  id: number;
  yPercent: number;
  phase: number;
  durationSec: number;
  delaySec: number;
  brightness: number;
}

const GOLDEN_RATIO = 0.6180339887498949;
const MIN_HEIGHT_SLOTS = 4;
const STARFIELD_DURATION_MEAN = 1.5;
const STARFIELD_DURATION_SPREAD = 0.08;

function starHash01(i: number, salt: number): number {
  const x = Math.sin((i + 1) * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function buildCodexStarfieldParticles(): CodexStarParticle[] {
  const count = 22;
  const raw = Array.from({ length: count }, (_, i) => ({
    y: 0,
    phase: ((i + 1) * GOLDEN_RATIO) % 1,
  }));

  const byPhase = Array.from({ length: count }, (_, i) => i).toSorted((a, b) => raw[a].phase - raw[b].phase);

  let slots: number[] | null = null;
  for (let salt = 71; salt < 4000 && slots === null; salt += 1) {
    const candidate = Array.from({ length: count }, (_, i) => i).toSorted((a, b) => {
      const ha = starHash01(a, salt);
      const hb = starHash01(b, salt);
      return ha === hb ? a - b : ha - hb;
    });
    let ok = true;
    for (let k = 1; k < count && ok; k += 1) {
      if (Math.abs(candidate[k] - candidate[k - 1]) < MIN_HEIGHT_SLOTS) ok = false;
    }
    if (ok) slots = candidate;
  }

  if (slots === null) {
    slots = Array.from({ length: count }, (_, i) => (i * 5) % count);
  }

  for (let rank = 0; rank < count; rank += 1) {
    raw[byPhase[rank]].y = 8 + (slots[rank] / (count - 1)) * 84;
  }

  return raw.map((item, idx) => {
    const jitter = (starHash01(idx, 911) - 0.5) * 2 * STARFIELD_DURATION_SPREAD;
    const durationSec = Number((STARFIELD_DURATION_MEAN + jitter).toFixed(3));
    const delaySec = Number((-item.phase * durationSec).toFixed(3));
    const brightness = Number((0.5 + 0.5 * starHash01(idx, 313)).toFixed(2));
    return {
      id: idx,
      yPercent: Number(item.y.toFixed(1)),
      phase: item.phase,
      durationSec,
      delaySec,
      brightness,
    };
  });
}

export const CODEX_STARFIELD_PARTICLES: CodexStarParticle[] = buildCodexStarfieldParticles();

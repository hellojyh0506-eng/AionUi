/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CODEX_STARFIELD_PARTICLES,
  energyFor,
  fillBackgroundFor,
  getModelThinkingLevel,
  hydrateThinkingEffortGateway,
  isOffOption,
  MOTION_FAST,
  MOTION_SMOOTH,
  motionSettled,
  motionStep,
  type MotionState,
  normalizeThinkingOptions,
  particleCountFor,
  resolveModelThinkingSpec,
  setModelThinkingLevel,
  type ThinkingOptionItem,
  type ThinkingSliderStyle,
  useThinkingSliderPreferences,
  valueColorFor,
} from '@/renderer/utils/thinkingEffort';
import { Button, Popover } from '@arco-design/web-react';
import { Brain, Down } from '@icon-park/react';
import classNames from 'classnames';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './ThinkingEffortSlider.css';

export interface ThinkingEffortSliderProps {
  options: ThinkingOptionItem[];
  value: string;
  onChange: (value: string) => void;
  styleVariant?: ThinkingSliderStyle;
  disabled?: boolean;
  showHeader?: boolean;
  fullWidth?: boolean;
}

function knobOffsetOf(pct: number): string {
  const t = Math.round(Math.max(0, Math.min(1, pct)) * 10000) / 10000;
  return `calc(var(--ces-knob-r, 12px) + ${t} * (100% - var(--ces-knob-r, 12px) * 2))`;
}

function indexToPct(index: number, count: number): number {
  if (count <= 1) return 1;
  return Math.max(0, Math.min(1, index / (count - 1)));
}

function snapWithHysteresis(pos: number, current: number, count: number): number {
  const th = 1 / 3;
  const lo = Math.max(0, Math.min(count - 1, current));
  const p = Math.max(0, Math.min(count - 1, pos));
  if (p >= lo + th) return Math.min(count - 1, Math.max(lo + 1, Math.round(p)));
  if (p <= lo - (1 - th)) return Math.max(0, Math.min(lo - 1, Math.round(p)));
  return lo;
}

export const ThinkingEffortSlider: React.FC<ThinkingEffortSliderProps> = ({
  options,
  value,
  onChange,
  styleVariant,
  disabled = false,
  showHeader = true,
  fullWidth = false,
}) => {
  const prefs = useThinkingSliderPreferences();
  const activeStyle = styleVariant ?? prefs.style;
  const normalizedOptions = useMemo(() => normalizeThinkingOptions(options), [options]);
  const levelCount = normalizedOptions.length;

  const committedIndex = useMemo(() => {
    const idx = normalizedOptions.findIndex((o) => o.value === value);
    return idx >= 0 ? idx : 0;
  }, [normalizedOptions, value]);

  const [previewIndex, setPreviewIndex] = useState<number>(committedIndex);
  const initialPct = indexToPct(committedIndex, levelCount);
  const [renderPct, setRenderPct] = useState<number>(initialPct);

  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const detentIndexRef = useRef(committedIndex);
  const motionRef = useRef<MotionState>({ x: initialPct, v: 0, a: 0, target: initialPct });
  const rafRef = useRef<number | null>(null);
  const lastFrameTsRef = useRef<number | null>(null);
  const animModeRef = useRef(prefs.animationMode);
  animModeRef.current = prefs.animationMode;

  const stopFrames = useCallback(() => {
    if (rafRef.current !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(rafRef.current);
    }
    rafRef.current = null;
    lastFrameTsRef.current = null;
  }, []);

  const startFrames = useCallback(() => {
    if (rafRef.current !== null) return;
    if (typeof requestAnimationFrame !== 'function') {
      motionRef.current.x = motionRef.current.target;
      motionRef.current.v = 0;
      motionRef.current.a = 0;
      setRenderPct(motionRef.current.x);
      return;
    }
    const tick = (ts: number) => {
      const prevTs = lastFrameTsRef.current ?? ts;
      lastFrameTsRef.current = ts;
      const dt = Math.min(0.05, Math.max(0.001, (ts - prevTs) / 1000));
      const params = animModeRef.current === 'fast' ? MOTION_FAST : MOTION_SMOOTH;
      motionStep(motionRef.current, dt, params);
      setRenderPct(motionRef.current.x);
      if (motionSettled(motionRef.current, params) && !draggingRef.current) {
        motionRef.current.x = motionRef.current.target;
        motionRef.current.v = 0;
        motionRef.current.a = 0;
        setRenderPct(motionRef.current.x);
        rafRef.current = null;
        lastFrameTsRef.current = null;
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  useEffect(() => stopFrames, [stopFrames]);
  useEffect(() => {
    hydrateThinkingEffortGateway();
  }, []);

  useEffect(() => {
    if (draggingRef.current) return;
    setPreviewIndex(committedIndex);
    detentIndexRef.current = committedIndex;
    const nextPct = indexToPct(committedIndex, levelCount);
    motionRef.current.target = nextPct;
    startFrames();
  }, [committedIndex, levelCount, startFrames]);

  const pctAtClientX = useCallback((clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    const knobRadius = rect.height > 0 ? Math.max(10, Math.min(18, rect.height / 2)) : 12;
    const usable = Math.max(1, rect.width - knobRadius * 2);
    return Math.max(0, Math.min(1, (clientX - rect.left - knobRadius) / usable));
  }, []);

  const commitIdx = useCallback(
    (idx: number) => {
      const clamped = Math.max(0, Math.min(levelCount - 1, idx));
      const targetOption = normalizedOptions[clamped];
      setPreviewIndex(clamped);
      detentIndexRef.current = clamped;
      motionRef.current.target = indexToPct(clamped, levelCount);
      startFrames();
      if (targetOption && targetOption.value !== value) {
        onChange(targetOption.value);
      }
    },
    [levelCount, normalizedOptions, onChange, startFrames, value]
  );

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || levelCount === 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // ignore synthetic test events
      }
    }
    draggingRef.current = true;
    const p = pctAtClientX(event.clientX);
    const idx = Math.round(p * Math.max(0, levelCount - 1));
    detentIndexRef.current = idx;
    setPreviewIndex(idx);
    motionRef.current.target = prefs.animationMode === 'fast' ? indexToPct(idx, levelCount) : p;
    startFrames();
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current || disabled || levelCount <= 1) return;
    const p = pctAtClientX(event.clientX);
    if (prefs.animationMode === 'fast') {
      const pos = p * (levelCount - 1);
      const nextIdx = snapWithHysteresis(pos, detentIndexRef.current, levelCount);
      if (nextIdx !== detentIndexRef.current) {
        detentIndexRef.current = nextIdx;
        setPreviewIndex(nextIdx);
        motionRef.current.target = indexToPct(nextIdx, levelCount);
        startFrames();
      }
    } else {
      const nextIdx = Math.round(p * (levelCount - 1));
      setPreviewIndex(nextIdx);
      motionRef.current.target = p;
      startFrames();
    }
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    if (
      typeof event.currentTarget.hasPointerCapture === 'function' &&
      event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // ignore
      }
    }
    const p = pctAtClientX(event.clientX);
    const finalIdx =
      prefs.animationMode === 'fast'
        ? snapWithHysteresis(p * Math.max(0, levelCount - 1), detentIndexRef.current, levelCount)
        : Math.round(p * Math.max(0, levelCount - 1));
    commitIdx(finalIdx);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled || levelCount === 0) return;
    let delta = 0;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') delta = 1;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') delta = -1;
    if (delta === 0) return;
    event.preventDefault();
    commitIdx(previewIndex + delta);
  };

  if (activeStyle === 'native-list') {
    return (
      <div className='effort-native-list' role='listbox' aria-label='Thinking effort'>
        {showHeader && <div className='effort-native-list__header'>Thinking effort</div>}
        {normalizedOptions.map((item) => {
          const selected = item.value === value;
          return (
            <button
              key={item.value}
              type='button'
              role='option'
              aria-selected={selected}
              disabled={disabled}
              className='effort-native-list__item'
              onClick={() => !disabled && onChange(item.value)}
            >
              <span>{item.label}</span>
              <span className='w-14px text-right text-12px'>{selected ? '✓' : ''}</span>
            </button>
          );
        })}
      </div>
    );
  }

  const shownOption = normalizedOptions[previewIndex] ?? normalizedOptions[0];
  const offState = isOffOption(shownOption);
  const energy = offState ? 0 : energyFor(renderPct);
  const energyOn = energy > 0;
  const visibleStars = particleCountFor(renderPct, CODEX_STARFIELD_PARTICLES.length);
  const knobOffset = knobOffsetOf(renderPct);
  const fillBg = fillBackgroundFor(renderPct, offState);
  const labelColor = valueColorFor(renderPct, shownOption);

  return (
    <div
      className={classNames('ces-card', fullWidth && 'ces-card--full')}
      data-energy={energyOn ? '1' : '0'}
      style={{ ['--ces-energy' as string]: energy.toFixed(3) }}
    >
      {showHeader && (
        <div className='ces-header'>
          <span className='ces-header__title'>推理等级</span>
          <span className='ces-header__value' style={labelColor ? { color: labelColor } : undefined}>
            {shownOption?.label}
          </span>
        </div>
      )}

      <div
        ref={trackRef}
        role='slider'
        tabIndex={disabled ? -1 : 0}
        aria-label='推理等级'
        aria-valuemin={0}
        aria-valuemax={Math.max(0, levelCount - 1)}
        aria-valuenow={previewIndex}
        aria-valuetext={shownOption?.label || ''}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => {
          draggingRef.current = false;
          commitIdx(detentIndexRef.current);
        }}
        onKeyDown={handleKeyDown}
        className={classNames('ces-track', disabled && 'ces-track--disabled')}
      >
        {!offState && <div className='ces-fill' style={{ width: knobOffset, background: fillBg }} />}
        <div className='ces-energy' style={{ width: knobOffset }}>
          <div className='ces-energy__sweep' />
        </div>
        <div className='ces-stars' style={{ width: knobOffset, opacity: energyOn ? 1 : 0 }} aria-hidden='true'>
          {CODEX_STARFIELD_PARTICLES.slice(0, visibleStars).map((star) => (
            <div
              key={star.id}
              className='ces-star'
              style={{
                top: `${star.yPercent}%`,
                animationDuration: `${star.durationSec}s`,
                animationDelay: `${star.delaySec}s`,
              }}
            >
              <span className='ces-star__dot' style={{ ['--ces-b' as string]: star.brightness }} />
            </div>
          ))}
        </div>

        {normalizedOptions.map((opt, idx) => {
          const tickPct = indexToPct(idx, levelCount);
          const reached = !offState && idx <= previewIndex;
          return (
            <span
              key={opt.value}
              className='ces-tick'
              data-on={reached ? '1' : '0'}
              data-tick-style={prefs.reachedTickStyle}
              style={{ left: knobOffsetOf(tickPct) }}
            />
          );
        })}

        <div className='ces-knob' style={{ left: knobOffset }} />
      </div>
    </div>
  );
};

export interface ThinkingEffortTriggerProps {
  /** Native ACP/runtime thought_level option when exposed by the active agent */
  runtimeOption?: {
    id: string;
    currentValue: string | null;
    options: ThinkingOptionItem[];
  } | null;
  onSetRuntimeOption?: (optionId: string, value: string) => Promise<unknown>;
  /** Active model identifier (e.g. `workbuddy/deepseek-v4.1-flash`, `gpt-6.2-sol`) */
  modelName?: string | null;
  disabled?: boolean;
}

export const ThinkingEffortTrigger: React.FC<ThinkingEffortTriggerProps> = ({
  runtimeOption,
  onSetRuntimeOption,
  modelName,
  disabled = false,
}) => {
  const prefs = useThinkingSliderPreferences();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const isNativeRuntime = Boolean(runtimeOption && runtimeOption.options.length > 0);
  const modelSpec = useMemo(() => (isNativeRuntime ? null : resolveModelThinkingSpec(modelName)), [isNativeRuntime, modelName]);

  useEffect(() => {
    hydrateThinkingEffortGateway();
  }, []);

  if (!prefs.enabled) {
    return null;
  }

  const activeOptions = isNativeRuntime
    ? normalizeThinkingOptions(runtimeOption!.options)
    : modelSpec
      ? modelSpec.options
      : null;

  // Hide completely when the current model/agent has no thinking capability!
  if (!activeOptions || activeOptions.length === 0) {
    return null;
  }

  const activeValue = isNativeRuntime
    ? runtimeOption!.currentValue || activeOptions[0].value
    : getModelThinkingLevel(prefs, modelName, modelSpec);

  const activeIdx = Math.max(
    0,
    activeOptions.findIndex((o) => o.value === activeValue)
  );
  const activeOption = activeOptions[activeIdx] ?? activeOptions[0];
  const pct = indexToPct(activeIdx, activeOptions.length);
  const seatColor = valueColorFor(pct, activeOption);

  const handleChange = (nextValue: string) => {
    if (isNativeRuntime && runtimeOption && onSetRuntimeOption) {
      setSaving(true);
      void onSetRuntimeOption(runtimeOption.id, nextValue).finally(() => {
        setSaving(false);
      });
    } else if (modelName) {
      setModelThinkingLevel(modelName, nextValue);
    }
  };

  return (
    <Popover
      trigger='click'
      position='top'
      popupVisible={open}
      onVisibleChange={setOpen}
      content={
        <ThinkingEffortSlider
          options={activeOptions}
          value={activeValue}
          onChange={handleChange}
          disabled={disabled || saving}
        />
      }
    >
      <Button
        size='small'
        shape='round'
        type='secondary'
        disabled={disabled}
        data-testid='thinking-effort-trigger'
        className='sendbox-model-btn !h-28px !px-10px text-12px'
      >
        <span className='flex items-center gap-5px'>
          <Brain theme='outline' size='13' />
          <span style={seatColor ? { color: seatColor, fontWeight: 500 } : undefined}>{activeOption.label}</span>
          <Down theme='outline' size={11} />
        </span>
      </Button>
    </Popover>
  );
};

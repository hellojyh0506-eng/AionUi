/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TitlebarUpdateCapsule, {
  UPDATE_BADGE_SYNC_EVENT,
} from '@/renderer/components/layout/Titlebar/TitlebarUpdateCapsule';

const statusListenerRef = vi.hoisted(() => ({ current: null as ((evt: unknown) => void) | null }));
const restoreDownloadedMock = vi.hoisted(() => vi.fn().mockResolvedValue({ success: false }));

vi.mock('@/common', () => ({
  ipcBridge: {
    autoUpdate: {
      restoreDownloaded: { invoke: restoreDownloadedMock },
      status: {
        on: (cb: (evt: unknown) => void) => {
          statusListenerRef.current = cb;
          return () => {
            statusListenerRef.current = null;
          };
        },
      },
    },
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  }),
}));

describe('TitlebarUpdateCapsule', () => {
  beforeEach(() => {
    restoreDownloadedMock.mockClear();
  });

  it('stays hidden when idle and shows persistent top-right capsule across update states', () => {
    render(<TitlebarUpdateCapsule />);
    expect(screen.queryByTestId('titlebar-update-capsule')).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(
        new CustomEvent(UPDATE_BADGE_SYNC_EVENT, {
          detail: { status: 'available', version: '2.2.5' },
        })
      );
    });
    const availBtn = screen.getByTestId('titlebar-update-capsule');
    expect(availBtn).toHaveTextContent('v2.2.5');

    const openListener = vi.fn();
    window.addEventListener('aionui-open-update-modal', openListener);
    fireEvent.click(availBtn);
    expect(openListener).toHaveBeenCalledTimes(1);
    window.removeEventListener('aionui-open-update-modal', openListener);

    act(() => {
      window.dispatchEvent(
        new CustomEvent(UPDATE_BADGE_SYNC_EVENT, {
          detail: { status: 'downloaded', version: '2.2.5' },
        })
      );
    });
    expect(screen.getByTestId('titlebar-update-capsule')).toHaveTextContent('Restart Now');
    expect(screen.getByTestId('titlebar-update-capsule')).toHaveClass('is-ready');
  });
});

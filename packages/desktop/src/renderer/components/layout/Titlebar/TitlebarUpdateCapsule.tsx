/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { AutoUpdateStatus } from '@/process/services/autoUpdaterService';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

export const UPDATE_BADGE_SYNC_EVENT = 'aionui-update-badge-sync';

export type UpdateBadgeSyncDetail = {
  status: string;
  version?: string;
  percent?: number;
};

type CapsuleState = {
  status: 'hidden' | 'available' | 'downloading' | 'downloaded' | 'preparing-install';
  version?: string;
  percent: number;
};

/**
 * Persistent top-right update capsule in the titlebar toolbar (similar to
 * Antigravity / Magpie): stays visible whenever a new version is available,
 * downloading, or downloaded and ready to restart, even if the bottom-right
 * notification card was minimized or dismissed with "Later".
 */
const TitlebarUpdateCapsule: React.FC = () => {
  const { t } = useTranslation();
  const [capsule, setCapsule] = useState<CapsuleState>({ status: 'hidden', percent: 0 });

  useEffect(() => {
    let cancelled = false;

    const restoreDownloaded = ipcBridge?.autoUpdate?.restoreDownloaded?.invoke;
    if (restoreDownloaded) {
      void restoreDownloaded()
        .then((res) => {
          if (cancelled || !res?.success || !res.data?.ready || !res.data.version) return;
          setCapsule({ status: 'downloaded', version: res.data.version, percent: 100 });
        })
        .catch(() => {});
    }

    const onAutoStatus = ipcBridge?.autoUpdate?.status?.on;
    const removeAutoListener = onAutoStatus
      ? onAutoStatus((evt: AutoUpdateStatus) => {
          if (!evt) return;
          if (evt.status === 'available') {
            setCapsule({ status: 'available', version: evt.version, percent: 0 });
          } else if (evt.status === 'downloading') {
            setCapsule((prev) => ({
              ...prev,
              status: 'downloading',
              percent: Math.round(evt.progress?.percent ?? prev.percent ?? 0),
            }));
          } else if (evt.status === 'downloaded') {
            setCapsule((prev) => ({ ...prev, status: 'downloaded', percent: 100 }));
          } else if (evt.status === 'preparing-install') {
            setCapsule((prev) => ({ ...prev, status: 'preparing-install', percent: 100 }));
          } else if (evt.status === 'not-available') {
            setCapsule({ status: 'hidden', percent: 0 });
          }
        })
      : undefined;

    const handleSync = (evt: Event) => {
      const detail = (evt as CustomEvent<UpdateBadgeSyncDetail>).detail;
      if (!detail) return;
      if (detail.status === 'available' || detail.status === 'success') {
        setCapsule({ status: 'available', version: detail.version, percent: 0 });
      } else if (detail.status === 'downloading') {
        setCapsule((prev) => ({
          ...prev,
          status: 'downloading',
          version: detail.version ?? prev.version,
          percent: Math.round(detail.percent ?? prev.percent ?? 0),
        }));
      } else if (detail.status === 'downloaded') {
        setCapsule((prev) => ({ ...prev, status: 'downloaded', version: detail.version ?? prev.version, percent: 100 }));
      } else if (detail.status === 'preparing-install') {
        setCapsule((prev) => ({
          ...prev,
          status: 'preparing-install',
          version: detail.version ?? prev.version,
          percent: 100,
        }));
      } else if (detail.status === 'upToDate') {
        setCapsule({ status: 'hidden', percent: 0 });
      }
    };

    window.addEventListener(UPDATE_BADGE_SYNC_EVENT, handleSync);
    return () => {
      cancelled = true;
      removeAutoListener?.();
      window.removeEventListener(UPDATE_BADGE_SYNC_EVENT, handleSync);
    };
  }, []);

  if (capsule.status === 'hidden') return null;

  const versionTag = capsule.version ? ` v${capsule.version.replace(/^v/i, '')}` : '';
  const label =
    capsule.status === 'preparing-install'
      ? t('update.preparingInstall', { defaultValue: 'Preparing...' })
      : capsule.status === 'downloaded'
        ? t('update.restartNow', { defaultValue: 'Restart Now' })
        : capsule.status === 'downloading'
          ? `${capsule.percent}%`
          : `${t('update.availableTitle', { defaultValue: 'Update' })}${versionTag}`;

  const handleClick = () => {
    window.dispatchEvent(new CustomEvent('aionui-open-update-modal', { detail: { source: 'menu' } }));
  };

  return (
    <button
      type='button'
      data-testid='titlebar-update-capsule'
      className={`app-titlebar__update-capsule ${capsule.status === 'downloaded' ? 'is-ready' : ''}`}
      onClick={handleClick}
      aria-label={label}
      title={label}
    >
      <span aria-hidden='true'>↑</span>
      <span>{label}</span>
    </button>
  );
};

export default TitlebarUpdateCapsule;

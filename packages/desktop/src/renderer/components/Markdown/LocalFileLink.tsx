/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback } from 'react';
import { Button, Message, Tooltip } from '@arco-design/web-react';
import { Copy, Earth, FolderOpen } from '@icon-park/react';
import { ipcBridge } from '@/common';
import { iconColors } from '@/renderer/styles/colors';
import { copyText } from '@/renderer/utils/ui/clipboard';
import { useTranslation } from 'react-i18next';
import { isHtmlFilePath } from './markdownUtils';
import type { LocalFileLinkReference } from './markdownUtils';

type LocalFileLinkProps = {
  reference: LocalFileLinkReference;
  children?: React.ReactNode;
  onOpen?: (path: string, reference?: LocalFileLinkReference) => void | Promise<void>;
};

const LocalFileLink: React.FC<LocalFileLinkProps> = ({ reference, children, onOpen }) => {
  const { t } = useTranslation();
  const { filePath, line, rawReference } = reference;
  const fallbackLabel = filePath.split(/[\\/]/).pop() || filePath;
  const label = children || fallbackLabel;
  const textLabel =
    React.Children.toArray(children)
      .map((child) => (typeof child === 'string' || typeof child === 'number' ? String(child) : ''))
      .join('') || fallbackLabel;
  const locationLabel =
    line == null
      ? null
      : `L${line}${reference.endLine == null ? (reference.column == null ? '' : `:${reference.column}`) : `-L${reference.endLine}`}`;
  const canOpen = Boolean(onOpen);
  const isDesktop = typeof window !== 'undefined' && Boolean((window as { electronAPI?: unknown }).electronAPI);
  const canRevealInFolder = canOpen && isDesktop && Boolean(ipcBridge?.shell?.showItemInFolder?.invoke);
  const canOpenInBrowser = canOpen && isDesktop && isHtmlFilePath(filePath) && Boolean(ipcBridge?.shell?.openFile?.invoke);

  const handleOpen = useCallback(
    (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      if (onOpen) {
        void onOpen(filePath, reference);
      }
    },
    [filePath, onOpen, reference]
  );

  const handleRevealInFolder = useCallback(
    (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      ipcBridge?.shell?.showItemInFolder?.invoke(filePath)?.catch(() => {
        Message.error(t('preview.openLocationFailed', { defaultValue: 'Failed to open containing folder' }));
      });
    },
    [filePath, t]
  );

  const handleOpenInBrowser = useCallback(
    (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      ipcBridge?.shell?.openFile?.invoke(filePath)?.catch(() => {
        Message.error(t('messages.openLinkFailed', { defaultValue: 'Failed to open link' }));
      });
    },
    [filePath, t]
  );

  const handleCopy = useCallback(
    (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      copyText(rawReference).catch(() => {
        Message.error(t('common.copyFailed'));
      });
    },
    [rawReference, t]
  );

  const content = (
    <span className='inline-flex items-center gap-4px max-w-full'>
      <span className='truncate'>{label}</span>
      {locationLabel && (
        <span className='flex-shrink-0 rd-4px bg-fill-2 px-4px text-11px font-mono text-t-secondary'>
          {locationLabel}
        </span>
      )}
    </span>
  );

  return (
    <span
      className='inline-flex items-center gap-2px max-w-full align-baseline'
      data-local-file-path={filePath}
      data-local-file-line={line}
      title={rawReference}
    >
      {canOpen ? (
        <Button
          type='text'
          size='mini'
          aria-label={locationLabel ? `${textLabel} ${locationLabel}` : textLabel}
          className='markdown-local-file-link !px-6px !py-2px !h-auto !leading-normal !align-baseline max-w-full !rd-6px'
          onClick={handleOpen}
        >
          {content}
        </Button>
      ) : (
        <span className='markdown-local-file-link inline-flex items-center gap-4px max-w-full'>{content}</span>
      )}
      {canRevealInFolder && (
        <Tooltip content={t('preview.openLocation', { defaultValue: 'Show in folder' })}>
          <Button
            aria-label={t('preview.openLocation', { defaultValue: 'Show in folder' })}
            type='text'
            size='mini'
            className='markdown-local-file-copy !p-1px !w-20px !h-20px flex-shrink-0'
            icon={<FolderOpen theme='outline' size='14' fill={iconColors.secondary} />}
            onClick={handleRevealInFolder}
          />
        </Tooltip>
      )}
      {canOpenInBrowser && (
        <Tooltip content={t('common.openInSystemBrowser', { defaultValue: 'Open in system browser' })}>
          <Button
            aria-label={t('common.openInSystemBrowser', { defaultValue: 'Open in system browser' })}
            type='text'
            size='mini'
            className='markdown-local-file-copy !p-1px !w-20px !h-20px flex-shrink-0'
            icon={<Earth theme='outline' size='14' fill={iconColors.secondary} />}
            onClick={handleOpenInBrowser}
          />
        </Tooltip>
      )}
      <Tooltip content={t('common.copy', { defaultValue: 'Copy' })}>
        <Button
          aria-label={t('common.copy', { defaultValue: 'Copy' })}
          type='text'
          size='mini'
          className='markdown-local-file-copy !p-1px !w-20px !h-20px flex-shrink-0'
          icon={<Copy theme='outline' size='14' fill={iconColors.secondary} />}
          onClick={handleCopy}
        />
      </Tooltip>
    </span>
  );
};

export default LocalFileLink;

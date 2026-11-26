/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationProvider } from '@/renderer/hooks/context/ConversationContext';
import LocalImageView from '@/renderer/components/media/LocalImageView';

const getImageBase64Mock = vi.hoisted(() => vi.fn());
const readContentMock = vi.hoisted(() => vi.fn());

vi.mock('@/common', () => ({
  ipcBridge: {
    fs: {
      getImageBase64: { invoke: getImageBase64Mock },
      readContent: { invoke: readContentMock },
    },
  },
}));

vi.mock('@icon-park/react', () => ({
  LoadingTwo: () => <span data-testid='loading-icon' />,
}));

describe('LocalImageView', () => {
  beforeEach(() => {
    getImageBase64Mock.mockReset();
    readContentMock.mockReset();
  });

  it('normalizes file:///C:/ stripped paths (/C:/...) without prepending workspace root', async () => {
    getImageBase64Mock.mockResolvedValue('data:image/jpeg;base64,OK');

    render(
      <ConversationProvider
        value={{ conversation_id: 'c1', workspace: 'C:\\Users\\Admin\\aionrs-temp-1', type: 'aionrs' }}
      >
        <LocalImageView src='/C:/Windows/Web/Screen/img102.jpg' alt='图片' />
      </ConversationProvider>
    );

    await waitFor(() => {
      const img = screen.getByRole('img', { name: '图片' });
      expect(img).toHaveAttribute('src', 'data:image/jpeg;base64,OK');
    });
    expect(getImageBase64Mock).toHaveBeenCalledWith({
      path: 'C:/Windows/Web/Screen/img102.jpg',
      workspace: 'C:\\Users\\Admin\\aionrs-temp-1',
    });
  });

  it('falls back to fs.readContent when getImageBase64 rejects with PATH_OUTSIDE_SANDBOX', async () => {
    getImageBase64Mock.mockRejectedValue(new Error('PATH_OUTSIDE_SANDBOX'));
    readContentMock.mockResolvedValue('data:image/jpeg;base64,FALLBACK_OK');

    render(
      <ConversationProvider
        value={{ conversation_id: 'c1', workspace: 'C:\\Users\\Admin\\aionrs-temp-1', type: 'aionrs' }}
      >
        <LocalImageView src={'C:\\Windows\\Web\\Screen\\img102.jpg'} alt='壁纸' />
      </ConversationProvider>
    );

    await waitFor(() => {
      const img = screen.getByRole('img', { name: '壁纸' });
      expect(img).toHaveAttribute('src', 'data:image/jpeg;base64,FALLBACK_OK');
    });
    expect(readContentMock).toHaveBeenCalledWith({
      file: { kind: 'local', path: 'C:\\Windows\\Web\\Screen\\img102.jpg' },
      encoding: 'dataurl',
    });
  });

  it('skips backend calls when src is empty instead of reading the workspace directory', async () => {
    render(
      <ConversationProvider
        value={{ conversation_id: 'c1', workspace: 'C:\\Users\\Admin\\aionrs-temp-1', type: 'aionrs' }}
      >
        <LocalImageView src='' alt='空图' />
      </ConversationProvider>
    );

    await waitFor(() => {
      expect(screen.getByRole('img', { name: '空图' })).toBeInTheDocument();
    });
    expect(getImageBase64Mock).not.toHaveBeenCalled();
    expect(readContentMock).not.toHaveBeenCalled();
  });
});

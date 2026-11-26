/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationProvider } from '@/renderer/hooks/context/ConversationContext';
import MarkdownView from '@/renderer/components/Markdown';
import { resetLocalFileLookupCacheForTest } from '@/renderer/components/Markdown/localFileLookup';

const copyTextMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const getFileMetadataMock = vi.hoisted(() => vi.fn());
const listWorkspaceFilesMock = vi.hoisted(() => vi.fn());
const showItemInFolderMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const openFileMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('@/common', () => ({
  ipcBridge: {
    fs: {
      getFileMetadata: { invoke: getFileMetadataMock },
      getContentMetadata: { invoke: getFileMetadataMock },
      listWorkspaceFiles: { invoke: listWorkspaceFilesMock },
      getImageBase64: { invoke: vi.fn().mockResolvedValue('data:image/png;base64,AAA') },
      readContent: { invoke: vi.fn().mockResolvedValue('data:image/png;base64,AAA') },
    },
    shell: {
      showItemInFolder: { invoke: showItemInFolderMock },
      openFile: { invoke: openFileMock },
    },
  },
}));

vi.mock('@/renderer/components/Markdown/ShadowView', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/renderer/components/media/LocalImageView', () => ({
  __esModule: true,
  default: ({ src, alt }: { src: string; alt: string }) => <img data-testid='local-image-view' src={src} alt={alt} />,
}));

vi.mock('@/renderer/utils/chat/latexDelimiters', () => ({
  convertLatexDelimiters: (text: string) => text,
}));

vi.mock('@/renderer/utils/platform', () => ({
  openExternalUrl: vi.fn(),
}));

vi.mock('@/renderer/utils/ui/clipboard', () => ({
  copyText: copyTextMock,
}));

vi.mock('@arco-design/web-react', () => ({
  Button: ({
    children,
    icon,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: React.ReactNode }) => (
    <button type='button' {...props}>
      {icon}
      {children}
    </button>
  ),
  Message: {
    error: vi.fn(),
  },
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@icon-park/react', () => ({
  Copy: () => <span data-testid='copy-icon' />,
  FolderOpen: () => <span data-testid='folder-open-icon' />,
  Earth: () => <span data-testid='earth-icon' />,
  Down: () => <span />,
  Up: () => <span />,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

describe('MarkdownView inline local file and standalone image rendering', () => {
  beforeEach(() => {
    resetLocalFileLookupCacheForTest();
    copyTextMock.mockClear();
    getFileMetadataMock.mockReset();
    listWorkspaceFilesMock.mockReset();
    showItemInFolderMock.mockClear();
    openFileMock.mockClear();
    (window as unknown as { electronAPI?: unknown }).electronAPI = { platform: 'win32' };
  });

  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('renders backticked and bare Windows html paths as chips with preview, reveal-in-folder, and open-in-browser actions', () => {
    const onLocalFileLink = vi.fn();
    const htmlPath = 'D:\\AllWorkspace\\Ethan_Workspace\\pelican-motors\\index.html';

    render(
      <MarkdownView onLocalFileLink={onLocalFileLink}>
        {`交付文件：\`${htmlPath}\`（也可看 ${htmlPath}）`}
      </MarkdownView>
    );

    const openButtons = screen.getAllByRole('button', { name: 'index.html' });
    expect(openButtons).toHaveLength(2);

    fireEvent.click(openButtons[0]);
    expect(onLocalFileLink).toHaveBeenCalledWith(
      htmlPath,
      expect.objectContaining({ filePath: htmlPath, rawReference: htmlPath })
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Show in folder' })[0]);
    expect(showItemInFolderMock).toHaveBeenCalledWith(htmlPath);

    fireEvent.click(screen.getAllByRole('button', { name: 'Open in system browser' })[0]);
    expect(openFileMock).toHaveBeenCalledWith(htmlPath);
  });

  it('resolves unique workspace bare filename in inline code and leaves missing filenames as plain code', async () => {
    const onLocalFileLink = vi.fn();
    getFileMetadataMock.mockRejectedValue(new Error('ENOENT'));
    listWorkspaceFilesMock.mockResolvedValue([
      {
        name: 'index.html',
        relativePath: 'pelican-motors/index.html',
        fullPath: 'D:\\AllWorkspace\\Ethan_Workspace\\pelican-motors\\index.html',
      },
    ]);

    render(
      <ConversationProvider
        value={{ conversation_id: 'conv-1', workspace: 'D:\\AllWorkspace\\Ethan_Workspace', type: 'acp' }}
      >
        <MarkdownView onLocalFileLink={onLocalFileLink}>
          {'直接双击 `index.html`，或者查看不存在的 `missing.txt`。'}
        </MarkdownView>
      </ConversationProvider>
    );

    const openButton = await screen.findByRole('button', { name: 'index.html' });
    fireEvent.click(openButton);
    expect(onLocalFileLink).toHaveBeenCalledWith(
      'D:\\AllWorkspace\\Ethan_Workspace\\pelican-motors\\index.html',
      expect.objectContaining({
        filePath: 'D:\\AllWorkspace\\Ethan_Workspace\\pelican-motors\\index.html',
      })
    );

    expect(screen.queryByRole('button', { name: 'missing.txt' })).not.toBeInTheDocument();
    expect(screen.getByText('missing.txt').tagName).toBe('CODE');
  });

  it('keeps shell commands in inline code as plain code', () => {
    const onLocalFileLink = vi.fn();

    render(
      <MarkdownView onLocalFileLink={onLocalFileLink}>
        {'运行 `C:\\Python312\\python.exe script.py --port 8080` 验证。'}
      </MarkdownView>
    );

    expect(screen.queryByTestId('folder-open-icon')).not.toBeInTheDocument();
    expect(screen.getByText('C:\\Python312\\python.exe script.py --port 8080').tagName).toBe('CODE');
  });

  it('renders standalone existing image path as inline image plus chip while keeping sentence-inline image as chip only', async () => {
    const onLocalFileLink = vi.fn();
    const standaloneImg = 'D:\\AllWorkspace\\Ethan_Workspace\\poster.png';
    const inlineImg = 'D:\\AllWorkspace\\Ethan_Workspace\\icon.jpg';

    getFileMetadataMock.mockResolvedValue({
      name: 'poster.png',
      path: standaloneImg,
      size: 1024,
      type: 'file',
      lastModified: 1_717_000_000,
      isDirectory: false,
    });

    render(
      <MarkdownView onLocalFileLink={onLocalFileLink}>
        {`海报已生成：\n\`${standaloneImg}\`\n\n此外还参考了 \`${inlineImg}\` 的风格。`}
      </MarkdownView>
    );

    await waitFor(() => {
      const renderedImages = screen.getAllByTestId('local-image-view');
      expect(renderedImages).toHaveLength(1);
      expect(renderedImages[0]).toHaveAttribute('src', standaloneImg);
    });

    expect(screen.getByRole('button', { name: 'icon.jpg' })).toBeInTheDocument();
  });

  it('preserves Windows drive-letter markdown image src through sanitize and promotes extensionless bare hosts path', () => {
    const onLocalFileLink = vi.fn();
    const winImg = 'C:\\Windows\\Web\\Screen\\img102.jpg';
    const hostsPath = 'C:\\Windows\\System32\\drivers\\etc\\hosts';

    render(
      <MarkdownView onLocalFileLink={onLocalFileLink}>
        {`![图片](${winImg})\n\n绝对路径：${hostsPath}`}
      </MarkdownView>
    );

    const renderedImage = screen.getByTestId('local-image-view');
    expect(renderedImage).toHaveAttribute('src', winImg);

    const hostsButton = screen.getByRole('button', { name: 'hosts' });
    fireEvent.click(hostsButton);
    expect(onLocalFileLink).toHaveBeenCalledWith(
      hostsPath,
      expect.objectContaining({ filePath: hostsPath, rawReference: hostsPath })
    );
  });

  it('keeps full Windows filenames with spaces, # (C#), and Chinese parentheses intact without truncating', () => {
    const onLocalFileLink = vi.fn();
    const spacePath = 'C:\\Users\\86137\\Desktop\\2025 春招 C# 基础笔试题（原答案 + 新手易懂版答案）.html';

    render(
      <MarkdownView onLocalFileLink={onLocalFileLink}>
        {`${spacePath}\n\n"${spacePath}"`}
      </MarkdownView>
    );

    const expectedFileName = '2025 春招 C# 基础笔试题（原答案 + 新手易懂版答案）.html';
    const buttons = screen.getAllByRole('button', { name: expectedFileName });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]);
    expect(onLocalFileLink).toHaveBeenCalledWith(
      spacePath,
      expect.objectContaining({ filePath: spacePath, rawReference: spacePath })
    );
    expect(screen.getAllByRole('button', { name: 'Open in system browser' })).toHaveLength(2);
  });
});

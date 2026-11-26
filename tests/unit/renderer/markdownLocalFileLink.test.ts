/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  isHtmlFilePath,
  isImageFilePath,
  resolveInlineAbsoluteFileReference,
  resolveLocalFileLinkPath,
  resolveLocalFileLinkReference,
  resolveWorkspaceRelativeCandidate,
  toLocalFileHref,
} from '@/renderer/components/Markdown/markdownUtils';

describe('resolveLocalFileLinkPath', () => {
  it('recognizes Windows absolute paths emitted as root-relative markdown links', () => {
    expect(resolveLocalFileLinkPath('/C:/Users/Administrator/AppData/Roaming/AionUi/report.xlsx')).toBe(
      'C:/Users/Administrator/AppData/Roaming/AionUi/report.xlsx'
    );
  });

  it('recognizes encoded file URLs', () => {
    expect(resolveLocalFileLinkPath('file:///C:/Users/Administrator/%E7%9C%8B%E6%9D%BF.xlsx')).toBe(
      'C:/Users/Administrator/看板.xlsx'
    );
  });

  it('recognizes common POSIX absolute paths', () => {
    expect(resolveLocalFileLinkPath('/Users/demo/outputs/report.xlsx')).toBe('/Users/demo/outputs/report.xlsx');
  });

  it('recognizes file-like POSIX absolute paths outside common home and temp roots', () => {
    expect(resolveLocalFileLinkPath('/opt/aionui/outputs/report.xlsx')).toBe('/opt/aionui/outputs/report.xlsx');
  });

  it('recognizes line suffixes without confusing Windows drive letters', () => {
    const reference = resolveLocalFileLinkReference('C:/Users/Administrator/AppData/Roaming/AionUi/logs/app.log:1421');

    expect(reference).toEqual({
      filePath: 'C:/Users/Administrator/AppData/Roaming/AionUi/logs/app.log',
      rawReference: 'C:/Users/Administrator/AppData/Roaming/AionUi/logs/app.log:1421',
      line: 1421,
    });
    expect(resolveLocalFileLinkPath('C:/Users/Administrator/AppData/Roaming/AionUi/logs/app.log:1421')).toBe(
      'C:/Users/Administrator/AppData/Roaming/AionUi/logs/app.log'
    );
  });

  it('recognizes line and column suffixes without including the line in the file path', () => {
    const reference = resolveLocalFileLinkReference(
      'C:/Users/Administrator/AppData/Roaming/AionUi/logs/app.log:1421:7'
    );

    expect(reference).toEqual({
      filePath: 'C:/Users/Administrator/AppData/Roaming/AionUi/logs/app.log',
      rawReference: 'C:/Users/Administrator/AppData/Roaming/AionUi/logs/app.log:1421:7',
      line: 1421,
      column: 7,
    });
    expect(resolveLocalFileLinkPath('C:/Users/Administrator/AppData/Roaming/AionUi/logs/app.log:1421:7')).toBe(
      'C:/Users/Administrator/AppData/Roaming/AionUi/logs/app.log'
    );
  });

  it('recognizes POSIX hash line references', () => {
    expect(resolveLocalFileLinkReference('/Users/demo/file.ts#L10')).toEqual({
      filePath: '/Users/demo/file.ts',
      rawReference: '/Users/demo/file.ts#L10',
      line: 10,
    });

    expect(resolveLocalFileLinkReference('/Users/demo/file.ts#L10-L20')).toEqual({
      filePath: '/Users/demo/file.ts',
      rawReference: '/Users/demo/file.ts#L10-L20',
      line: 10,
      endLine: 20,
    });
  });

  it('recognizes file URL hash line references and normalizes raw references', () => {
    expect(resolveLocalFileLinkReference('file:///Users/demo/file.ts#L10')).toEqual({
      filePath: '/Users/demo/file.ts',
      rawReference: '/Users/demo/file.ts#L10',
      line: 10,
    });

    expect(resolveLocalFileLinkReference('file:///Users/demo/file.ts#L10-L20')).toEqual({
      filePath: '/Users/demo/file.ts',
      rawReference: '/Users/demo/file.ts#L10-L20',
      line: 10,
      endLine: 20,
    });

    expect(resolveLocalFileLinkReference('file:///Users/demo/My%20File.ts#L10')).toEqual({
      filePath: '/Users/demo/My File.ts',
      rawReference: '/Users/demo/My File.ts#L10',
      line: 10,
    });

    expect(resolveLocalFileLinkReference('file:///Users/demo/%E6%96%87%E4%BB%B6.ts#L10')).toEqual({
      filePath: '/Users/demo/文件.ts',
      rawReference: '/Users/demo/文件.ts#L10',
      line: 10,
    });
  });

  it('recognizes Windows file URL hash lines and ranges', () => {
    expect(resolveLocalFileLinkReference('file:///C:/Users/demo/file.ts#L10')).toEqual({
      filePath: 'C:/Users/demo/file.ts',
      rawReference: 'C:/Users/demo/file.ts#L10',
      line: 10,
    });

    expect(resolveLocalFileLinkReference('file:///C:/Users/demo/file.ts#L10-L20')).toEqual({
      filePath: 'C:/Users/demo/file.ts',
      rawReference: 'C:/Users/demo/file.ts#L10-L20',
      line: 10,
      endLine: 20,
    });
  });

  it('prioritizes hash line references over colon suffixes', () => {
    expect(resolveLocalFileLinkReference('/Users/demo/file.ts:10#L20')).toEqual({
      filePath: '/Users/demo/file.ts',
      rawReference: '/Users/demo/file.ts#L20',
      line: 20,
    });
  });

  it('rejects unsupported hash line formats and remote hash links', () => {
    expect(resolveLocalFileLinkReference('user.ts')).toBeNull();
    expect(resolveLocalFileLinkReference('./user.ts')).toBeNull();
    expect(resolveLocalFileLinkReference('../user.ts')).toBeNull();
    expect(resolveLocalFileLinkReference('/settings')).toBeNull();
    expect(resolveLocalFileLinkReference('https://aionui.com/docs#L10')).toBeNull();
    expect(resolveLocalFileLinkReference('https://github.com/org/repo/blob/main/file.ts#L10')).toBeNull();
    expect(resolveLocalFileLinkReference('/Users/demo/file.ts#l10')).toBeNull();
    expect(resolveLocalFileLinkReference('/Users/demo/file.ts#L10-l20')).toBeNull();
  });

  it('does not treat normal web links or app routes as local files', () => {
    expect(resolveLocalFileLinkPath('https://aionui.com/docs')).toBeNull();
    expect(resolveLocalFileLinkPath('/settings')).toBeNull();
  });

  it('formats local file paths as file URLs for browser link copying', () => {
    expect(toLocalFileHref('C:/Users/Administrator/AppData/Roaming/AionUi/report.xlsx')).toBe(
      'file:///C:/Users/Administrator/AppData/Roaming/AionUi/report.xlsx'
    );
    expect(toLocalFileHref('/var/folders/demo/report.xlsx')).toBe('file:///var/folders/demo/report.xlsx');
  });

  it('recognizes absolute inline code paths including spaces while rejecting shell commands', () => {
    expect(resolveInlineAbsoluteFileReference('D:\\AllWorkspace\\Ethan_Workspace\\pelican-motors\\index.html')).toEqual({
      filePath: 'D:\\AllWorkspace\\Ethan_Workspace\\pelican-motors\\index.html',
      rawReference: 'D:\\AllWorkspace\\Ethan_Workspace\\pelican-motors\\index.html',
    });
    expect(resolveInlineAbsoluteFileReference('C:\\Users\\Demo User\\My Report 2026.pdf#L10')).toEqual({
      filePath: 'C:\\Users\\Demo User\\My Report 2026.pdf',
      rawReference: 'C:\\Users\\Demo User\\My Report 2026.pdf#L10',
      line: 10,
    });
    expect(resolveInlineAbsoluteFileReference('C:\\Python312\\python.exe script.py --port 8080')).toBeNull();
    expect(resolveInlineAbsoluteFileReference('D:\\work\\run.bat && echo ok')).toBeNull();
    expect(resolveInlineAbsoluteFileReference('npm install')).toBeNull();
    expect(
      resolveInlineAbsoluteFileReference(
        '"C:\\Users\\86137\\Desktop\\2025 春招 C# 基础笔试题（原答案 + 新手易懂版答案）.html"'
      )
    ).toEqual({
      filePath: 'C:\\Users\\86137\\Desktop\\2025 春招 C# 基础笔试题（原答案 + 新手易懂版答案）.html',
      rawReference: 'C:\\Users\\86137\\Desktop\\2025 春招 C# 基础笔试题（原答案 + 新手易懂版答案）.html',
    });
  });

  it('builds workspace-relative candidates safely and identifies image/html extensions', () => {
    expect(resolveWorkspaceRelativeCandidate('index.html', 'D:\\AllWorkspace\\Ethan_Workspace')).toEqual({
      filePath: 'D:\\AllWorkspace\\Ethan_Workspace\\index.html',
      rawReference: 'D:\\AllWorkspace\\Ethan_Workspace\\index.html',
    });
    expect(resolveWorkspaceRelativeCandidate('pelican-motors/index.html:12', 'D:\\AllWorkspace\\Ethan_Workspace')).toEqual({
      filePath: 'D:\\AllWorkspace\\Ethan_Workspace\\pelican-motors\\index.html',
      rawReference: 'D:\\AllWorkspace\\Ethan_Workspace\\pelican-motors\\index.html:12',
      line: 12,
    });
    expect(resolveWorkspaceRelativeCandidate('../escape.html', 'D:\\AllWorkspace\\Ethan_Workspace')).toBeNull();
    expect(resolveWorkspaceRelativeCandidate('npm', 'D:\\AllWorkspace\\Ethan_Workspace')).toBeNull();
    expect(isImageFilePath('D:\\out\\poster.PNG')).toBe(true);
    expect(isImageFilePath('D:\\out\\index.html')).toBe(false);
    expect(isHtmlFilePath('D:\\AllWorkspace\\pelican-motors\\index.html')).toBe(true);
    expect(isHtmlFilePath('D:\\AllWorkspace\\pelican-motors\\app.ts:10')).toBe(false);
  });
});

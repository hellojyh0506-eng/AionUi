/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeTransportForBackend } from '@/process/services/ecosystem/assistantMount';
import {
  bootstrapRuntimePathEnv,
  extractFilesFromZipBuffer,
  getManagedRuntimeBinDir,
  inspectRuntimeEnvironment,
  resolveBundledNodeDir,
  resolveCommandWithManagedRuntime,
} from '@/process/services/ecosystem/runtimeEnvironment';

describe('runtimeEnvironment', () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    while (tmpRoots.length > 0) {
      fs.rmSync(tmpRoots.pop()!, { recursive: true, force: true });
    }
  });

  function createFakeRuntimeRoot(): { dataDir: string; resourcesDir: string; bundledNodeDir: string; managedBinDir: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-runtime-test-'));
    tmpRoots.push(root);
    const dataDir = path.join(root, 'data');
    const resourcesDir = path.join(root, 'resources');
    const bundledNodeDir = path.join(
      resourcesDir,
      'bundled-aioncore',
      'win32-x64',
      'managed-resources',
      'node',
      'node-v24.11.0-win-x64'
    );
    fs.mkdirSync(bundledNodeDir, { recursive: true });
    fs.writeFileSync(path.join(bundledNodeDir, 'node.exe'), '', 'utf-8');
    fs.writeFileSync(path.join(bundledNodeDir, 'npx.cmd'), '', 'utf-8');
    fs.writeFileSync(path.join(bundledNodeDir, 'npm.cmd'), '', 'utf-8');

    const managedBinDir = getManagedRuntimeBinDir(dataDir);
    fs.mkdirSync(managedBinDir, { recursive: true });
    fs.writeFileSync(path.join(managedBinDir, 'uv.exe'), '', 'utf-8');
    fs.writeFileSync(path.join(managedBinDir, 'uvx.exe'), '', 'utf-8');

    return { dataDir, resourcesDir, bundledNodeDir, managedBinDir };
  }

  it('locates bundled Node.js directory in workspace and synthetic resource roots', () => {
    const { resourcesDir, bundledNodeDir } = createFakeRuntimeRoot();
    const found = resolveBundledNodeDir({
      resourcesPath: resourcesDir,
      platform: 'win32',
      arch: 'x64',
    });
    expect(found).toBe(bundledNodeDir);

    if (process.platform === 'win32' && process.arch === 'x64') {
      const workspaceFound = resolveBundledNodeDir({ extraRoots: [process.cwd()] });
      expect(workspaceFound).toBeTruthy();
      expect(fs.existsSync(path.join(workspaceFound!, 'npx.cmd'))).toBe(true);
    }
  });

  it('resolves bare node/npx/uv/uvx commands to bundled or managed executables', () => {
    const { dataDir, resourcesDir, bundledNodeDir, managedBinDir } = createFakeRuntimeRoot();
    const opts = { dataPath: dataDir, resourcesPath: resourcesDir, platform: 'win32' as const, arch: 'x64' };

    expect(resolveCommandWithManagedRuntime('npx', opts)).toBe(path.join(bundledNodeDir, 'npx.cmd'));
    expect(resolveCommandWithManagedRuntime('node', opts)).toBe(path.join(bundledNodeDir, 'node.exe'));
    expect(resolveCommandWithManagedRuntime('uvx', opts)).toBe(path.join(managedBinDir, 'uvx.exe'));
    expect(resolveCommandWithManagedRuntime('uv', opts)).toBe(path.join(managedBinDir, 'uv.exe'));

    // Explicit paths and non-managed binaries are preserved verbatim.
    expect(resolveCommandWithManagedRuntime('C:\\custom\\python.exe', opts)).toBe('C:\\custom\\python.exe');
    expect(resolveCommandWithManagedRuntime('docker', opts)).toBe('docker');
  });

  it('idempotently prepends managed bin and bundled node directories to PATH', () => {
    const { dataDir, resourcesDir, bundledNodeDir, managedBinDir } = createFakeRuntimeRoot();
    const env: NodeJS.ProcessEnv = { PATH: 'C:\\Windows\\System32' };
    const opts = { dataPath: dataDir, resourcesPath: resourcesDir, platform: 'win32' as const, arch: 'x64', env };

    const firstPath = bootstrapRuntimePathEnv(dataDir, opts);
    const secondPath = bootstrapRuntimePathEnv(dataDir, opts);
    expect(firstPath).toBe(secondPath);
    expect(firstPath.split(';')).toEqual([managedBinDir, bundledNodeDir, 'C:\\Windows\\System32']);
  });

  it('reports real bundled Node readiness cleanly and rewrites MCP stdio commands', async () => {
    if (process.platform === 'win32' && process.arch === 'x64') {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-runtime-real-'));
      tmpRoots.push(dataDir);
      const report = await inspectRuntimeEnvironment({ dataPath: dataDir, extraRoots: [process.cwd()] });
      expect(report.node.available).toBe(true);
      expect(report.node.source).toBe('bundled');
      expect(report.npx.available).toBe(true);

      const normalized = normalizeTransportForBackend({
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp'],
      });
      expect(normalized.type).toBe('stdio');
      if (normalized.type === 'stdio') {
        expect(normalized.command.toLowerCase()).toContain('npx');
      }
    }
  });

  it('extracts uv.exe and uvx.exe cleanly from deflated ZIP buffers without external dependencies', () => {
    const createMinimalZip = (entries: Array<{ name: string; content: Buffer }>): Buffer => {
      const localChunks: Buffer[] = [];
      const cdChunks: Buffer[] = [];
      let offset = 0;

      for (const entry of entries) {
        const nameBuf = Buffer.from(entry.name, 'utf8');
        const compressed = zlib.deflateRawSync(entry.content);
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0);
        lh.writeUInt16LE(20, 4);
        lh.writeUInt16LE(8, 8);
        lh.writeUInt32LE(compressed.length, 18);
        lh.writeUInt32LE(entry.content.length, 22);
        lh.writeUInt16LE(nameBuf.length, 26);

        const cd = Buffer.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0);
        cd.writeUInt16LE(20, 4);
        cd.writeUInt16LE(20, 6);
        cd.writeUInt16LE(8, 10);
        cd.writeUInt32LE(compressed.length, 20);
        cd.writeUInt32LE(entry.content.length, 24);
        cd.writeUInt16LE(nameBuf.length, 28);
        cd.writeUInt32LE(offset, 42);

        localChunks.push(lh, nameBuf, compressed);
        cdChunks.push(cd, nameBuf);
        offset += lh.length + nameBuf.length + compressed.length;
      }

      const cdBuf = Buffer.concat(cdChunks);
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0);
      eocd.writeUInt16LE(entries.length, 8);
      eocd.writeUInt16LE(entries.length, 10);
      eocd.writeUInt32LE(cdBuf.length, 12);
      eocd.writeUInt32LE(offset, 16);

      return Buffer.concat([...localChunks, cdBuf, eocd]);
    };

    const zipBuf = createMinimalZip([
      { name: 'uv-x86_64-pc-windows-msvc/uv.exe', content: Buffer.from('UV-BIN') },
      { name: 'uv-x86_64-pc-windows-msvc/uvx.exe', content: Buffer.from('UVX-BIN') },
      { name: 'uv-x86_64-pc-windows-msvc/README.md', content: Buffer.from('ignored') },
    ]);

    const extracted = extractFilesFromZipBuffer(zipBuf, ['uv.exe', 'uvx.exe']);
    expect(extracted.get('uv.exe')?.toString('utf8')).toBe('UV-BIN');
    expect(extracted.get('uvx.exe')?.toString('utf8')).toBe('UVX-BIN');
    expect(extracted.has('readme.md')).toBe(false);
  });
});

/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import type {
  InstallRuntimeResult,
  RuntimeEnvironmentReport,
  RuntimeToolSource,
  RuntimeToolStatus,
} from '@/common/types/ecosystem';
import { getDataPath } from '@/process/utils/utils';

type ManagedToolName = 'node' | 'npm' | 'npx' | 'uv' | 'uvx';

export interface RuntimePathOptions {
  dataPath?: string;
  resourcesPath?: string;
  extraRoots?: string[];
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
}

const versionCache = new Map<string, string>();
let activeUvInstallPromise: Promise<InstallRuntimeResult> | null = null;

function isWindowsPlatform(platform: NodeJS.Platform): boolean {
  return platform === 'win32';
}

function getPlatformArchKey(platform: NodeJS.Platform, arch: string): string {
  return `${platform}-${arch}`;
}

function getBundledToolFileName(tool: ManagedToolName, platform: NodeJS.Platform): string {
  if (isWindowsPlatform(platform)) {
    if (tool === 'node') return 'node.exe';
    if (tool === 'npm') return 'npm.cmd';
    return 'npx.cmd';
  }
  return tool;
}

function getManagedToolFileName(tool: 'uv' | 'uvx', platform: NodeJS.Platform): string {
  return isWindowsPlatform(platform) ? `${tool}.exe` : tool;
}

function splitPathEntries(pathValue: string | undefined, platform: NodeJS.Platform): string[] {
  if (!pathValue) return [];
  const sep = isWindowsPlatform(platform) ? ';' : ':';
  return pathValue
    .split(sep)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizePathCompare(target: string, platform: NodeJS.Platform): string {
  const normalized = path.normalize(target);
  return isWindowsPlatform(platform) ? normalized.toLowerCase() : normalized;
}

function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function dirExists(dirPath: string): boolean {
  try {
    return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function collectBundledNodeCandidates(opts?: RuntimePathOptions): string[] {
  const platform = opts?.platform ?? process.platform;
  const arch = opts?.arch ?? process.arch;
  const platformKey = getPlatformArchKey(platform, arch);
  const roots: string[] = [];

  if (opts?.resourcesPath) {
    roots.push(path.join(opts.resourcesPath, 'bundled-aioncore'));
  }
  const procResources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (procResources) {
    roots.push(path.join(procResources, 'bundled-aioncore'));
  }
  for (const extra of opts?.extraRoots || []) {
    roots.push(path.join(extra, 'resources', 'bundled-aioncore'));
    roots.push(path.join(extra, 'bundled-aioncore'));
  }
  roots.push(path.join(process.cwd(), 'resources', 'bundled-aioncore'));
  roots.push(path.resolve(__dirname, '../../../..', 'resources', 'bundled-aioncore'));
  roots.push(path.resolve(__dirname, '../../../../..', 'resources', 'bundled-aioncore'));

  const candidates: string[] = [];
  for (const root of roots) {
    const nodeBaseDir = path.join(root, platformKey, 'managed-resources', 'node');
    if (!dirExists(nodeBaseDir)) continue;
    try {
      const entries = fs
        .readdirSync(nodeBaseDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.startsWith('node-'))
        .map((d) => d.name)
        .toSorted()
        .toReversed();
      for (const entry of entries) {
        const sub = path.join(nodeBaseDir, entry);
        candidates.push(sub);
        candidates.push(path.join(sub, 'bin'));
      }
    } catch {
      // Ignore unreadable directories and continue scanning fallbacks.
    }
    candidates.push(nodeBaseDir);
  }
  return candidates;
}

/**
 * Locate the bundled Node.js directory shipped inside `resources/bundled-aioncore`.
 * Returns `undefined` if no bundled Node runtime is present.
 */
export function resolveBundledNodeDir(opts?: RuntimePathOptions): string | undefined {
  const platform = opts?.platform ?? process.platform;
  const nodeExe = getBundledToolFileName('node', platform);
  const candidates = collectBundledNodeCandidates(opts);
  for (const dir of candidates) {
    if (fileExists(path.join(dir, nodeExe))) {
      return dir;
    }
  }
  return undefined;
}

/**
 * Return the per-user managed binary directory (`<dataPath>/runtime/bin`) where
 * client-downloaded tools such as `uv` and `uvx` live cleanly without modifying system PATH.
 */
export function getManagedRuntimeBinDir(dataPath?: string): string {
  const baseDir = dataPath || process.env.AIONUI_RUNTIME_DIR || getDataPath();
  return path.join(baseDir, 'runtime', 'bin');
}

/**
 * Prepend the managed runtime bin dir and bundled Node.js directory to `env.PATH`
 * (idempotently) so child processes spawned by Electron or `aioncore` find `node`, `npx`, `uv`, `uvx` immediately.
 */
export function bootstrapRuntimePathEnv(dataPath?: string, opts?: RuntimePathOptions): string {
  const platform = opts?.platform ?? process.platform;
  const env = opts?.env ?? process.env;
  const managedBinDir = getManagedRuntimeBinDir(dataPath);
  fs.mkdirSync(managedBinDir, { recursive: true });

  const bundledNodeDir = resolveBundledNodeDir(opts);
  const desiredDirs = [managedBinDir, bundledNodeDir].filter((d): d is string => Boolean(d));
  const currentEntries = splitPathEntries(env.PATH || env.Path, platform);
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const dir of [...desiredDirs, ...currentEntries]) {
    const key = normalizePathCompare(dir, platform);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(dir);
  }

  const sep = isWindowsPlatform(platform) ? ';' : ':';
  const nextPath = merged.join(sep);
  env.PATH = nextPath;
  if (isWindowsPlatform(platform) && 'Path' in env) {
    env.Path = nextPath;
  }
  return nextPath;
}

function findExecutableInPath(name: string, opts?: RuntimePathOptions): string | undefined {
  const platform = opts?.platform ?? process.platform;
  const env = opts?.env ?? process.env;
  const entries = splitPathEntries(env.PATH || env.Path, platform);
  const candidates = isWindowsPlatform(platform) ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name] : [name];

  for (const dir of entries) {
    for (const candidate of candidates) {
      const fullPath = path.join(dir, candidate);
      if (fileExists(fullPath)) {
        return fullPath;
      }
    }
  }
  return undefined;
}

/**
 * Resolve bare commands (`node`, `npm`, `npx`, `uv`, `uvx`) to bundled/managed executables when present,
 * leaving absolute paths and non-managed commands unchanged.
 */
export function resolveCommandWithManagedRuntime(command: string, opts?: RuntimePathOptions): string {
  const trimmed = command.trim();
  if (!trimmed) return command;
  if (trimmed.includes('/') || trimmed.includes('\\') || path.isAbsolute(trimmed)) {
    return command;
  }

  const platform = opts?.platform ?? process.platform;
  const baseLower = trimmed.toLowerCase().replace(/\.(exe|cmd|bat)$/u, '');

  if (baseLower === 'node' || baseLower === 'npm' || baseLower === 'npx') {
    const bundledDir = resolveBundledNodeDir(opts);
    if (bundledDir) {
      const target = path.join(bundledDir, getBundledToolFileName(baseLower, platform));
      if (fileExists(target)) return target;
    }
    return command;
  }

  if (baseLower === 'uv' || baseLower === 'uvx') {
    const managedBinDir = getManagedRuntimeBinDir(opts?.dataPath);
    const target = path.join(managedBinDir, getManagedToolFileName(baseLower, platform));
    if (fileExists(target)) return target;
    return command;
  }

  return command;
}

function probeVersion(executablePath: string, platform: NodeJS.Platform): Promise<string | undefined> {
  const cached = versionCache.get(executablePath);
  if (cached) return Promise.resolve(cached);

  return new Promise<string | undefined>((resolve) => {
    const isWinCmd = isWindowsPlatform(platform) && /\.(cmd|bat)$/iu.test(executablePath);
    const cmd = isWinCmd ? process.env.ComSpec || 'cmd.exe' : executablePath;
    const args = isWinCmd ? ['/d', '/s', '/c', `"${executablePath}" --version`] : ['--version'];
    execFile(cmd, args, { timeout: 2500, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        resolve(undefined);
        return;
      }
      const line = `${stdout || ''}\n${stderr || ''}`
        .split(/\r?\n/u)
        .map((s) => s.trim())
        .find(Boolean);
      if (line) {
        versionCache.set(executablePath, line);
      }
      resolve(line);
    });
  });
}

async function resolveToolStatus(
  tool: ManagedToolName,
  bundledNodeDir: string | undefined,
  managedBinDir: string,
  opts?: RuntimePathOptions
): Promise<RuntimeToolStatus> {
  const platform = opts?.platform ?? process.platform;

  if (tool === 'node' || tool === 'npm' || tool === 'npx') {
    const bundledFile = bundledNodeDir ? path.join(bundledNodeDir, getBundledToolFileName(tool, platform)) : undefined;
    if (bundledFile && fileExists(bundledFile)) {
      const version = await probeVersion(bundledFile, platform);
      return { available: true, source: 'bundled', path: bundledFile, version };
    }
  } else {
    const managedFile = path.join(managedBinDir, getManagedToolFileName(tool, platform));
    if (fileExists(managedFile)) {
      const version = await probeVersion(managedFile, platform);
      return { available: true, source: 'managed', path: managedFile, version };
    }
  }

  const systemPath = findExecutableInPath(tool, opts);
  if (systemPath) {
    const source: RuntimeToolSource =
      bundledNodeDir && normalizePathCompare(path.dirname(systemPath), platform) === normalizePathCompare(bundledNodeDir, platform)
        ? 'bundled'
        : normalizePathCompare(path.dirname(systemPath), platform) === normalizePathCompare(managedBinDir, platform)
          ? 'managed'
          : 'system';
    const version = await probeVersion(systemPath, platform);
    return { available: true, source, path: systemPath, version };
  }

  return { available: false, source: 'missing' };
}

/**
 * Inspect availability, origin (`bundled` / `managed` / `system` / `missing`), and version
 * of Node.js, npx, uv, and uvx without shelling out unnecessarily.
 */
export async function inspectRuntimeEnvironment(opts?: RuntimePathOptions): Promise<RuntimeEnvironmentReport> {
  const platform = opts?.platform ?? process.platform;
  const managedBinDir = getManagedRuntimeBinDir(opts?.dataPath);
  const bundledNodeDir = resolveBundledNodeDir(opts);

  const [node, npx, uv, uvx] = await Promise.all([
    resolveToolStatus('node', bundledNodeDir, managedBinDir, opts),
    resolveToolStatus('npx', bundledNodeDir, managedBinDir, opts),
    resolveToolStatus('uv', bundledNodeDir, managedBinDir, opts),
    resolveToolStatus('uvx', bundledNodeDir, managedBinDir, opts),
  ]);

  return {
    platform,
    node,
    npx,
    uv,
    uvx,
    bundledNodeDir,
    managedBinDir,
  };
}

function getUvReleaseZipUrls(platform: NodeJS.Platform, arch: string): string[] {
  if (platform !== 'win32') return [];
  const archiveName = arch === 'arm64' ? 'uv-aarch64-pc-windows-msvc.zip' : 'uv-x86_64-pc-windows-msvc.zip';
  const officialUrl = `https://github.com/astral-sh/uv/releases/latest/download/${archiveName}`;
  return [officialUrl, `https://gh-proxy.com/${officialUrl}`];
}

/**
 * Extract specific filenames (by case-insensitive basename) from a ZIP buffer using Node built-in zlib,
 * avoiding any external runtime zip dependency in packaged Electron/Vitest bundles.
 */
export function extractFilesFromZipBuffer(archiveBuffer: Buffer, wantedLowerNames: string[]): Map<string, Buffer> {
  const wantedSet = new Set(wantedLowerNames.map((n) => n.toLowerCase()));
  const result = new Map<string, Buffer>();

  const minOffset = Math.max(0, archiveBuffer.length - 65557);
  let eocdOffset = -1;
  for (let pos = archiveBuffer.length - 22; pos >= minOffset; pos -= 1) {
    if (archiveBuffer.readUInt32LE(pos) === 0x06054b50) {
      eocdOffset = pos;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error('无效的 ZIP 压缩包：未找到目录结束标记');
  }

  const totalEntries = archiveBuffer.readUInt16LE(eocdOffset + 10);
  let cdOffset = archiveBuffer.readUInt32LE(eocdOffset + 16);

  for (let i = 0; i < totalEntries; i += 1) {
    if (cdOffset + 46 > archiveBuffer.length || archiveBuffer.readUInt32LE(cdOffset) !== 0x02014b50) {
      throw new Error('无效的 ZIP 中央目录头');
    }
    const compressionMethod = archiveBuffer.readUInt16LE(cdOffset + 10);
    const compressedSize = archiveBuffer.readUInt32LE(cdOffset + 20);
    const nameLen = archiveBuffer.readUInt16LE(cdOffset + 28);
    const extraLen = archiveBuffer.readUInt16LE(cdOffset + 30);
    const commentLen = archiveBuffer.readUInt16LE(cdOffset + 32);
    const localHeaderOffset = archiveBuffer.readUInt32LE(cdOffset + 42);
    const entryName = archiveBuffer.subarray(cdOffset + 46, cdOffset + 46 + nameLen).toString('utf8');
    cdOffset += 46 + nameLen + extraLen + commentLen;

    const baseLower = path.posix.basename(entryName.replace(/\\/gu, '/')).toLowerCase();
    if (!wantedSet.has(baseLower) || entryName.endsWith('/')) continue;

    if (
      localHeaderOffset + 30 > archiveBuffer.length ||
      archiveBuffer.readUInt32LE(localHeaderOffset) !== 0x04034b50
    ) {
      throw new Error(`无效的 ZIP 本地文件头：${entryName}`);
    }
    const lhNameLen = archiveBuffer.readUInt16LE(localHeaderOffset + 26);
    const lhExtraLen = archiveBuffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + lhNameLen + lhExtraLen;
    const compressedSlice = archiveBuffer.subarray(dataStart, dataStart + compressedSize);

    if (compressionMethod === 0) {
      result.set(baseLower, Buffer.from(compressedSlice));
    } else if (compressionMethod === 8) {
      result.set(baseLower, zlib.inflateRawSync(compressedSlice));
    } else {
      throw new Error(`不支持的 ZIP 压缩方式 (${compressionMethod})：${entryName}`);
    }
  }

  return result;
}

async function downloadBufferWithTimeout(url: string, timeoutMs = 45000): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'EthanToken-Client/2.x (+https://github.com/hellojyh0506-eng/AionUi)',
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  } finally {
    clearTimeout(timer);
  }
}

async function performInstallManagedUv(opts?: RuntimePathOptions): Promise<InstallRuntimeResult> {
  const platform = opts?.platform ?? process.platform;
  const arch = opts?.arch ?? process.arch;
  const managedBinDir = getManagedRuntimeBinDir(opts?.dataPath);
  fs.mkdirSync(managedBinDir, { recursive: true });

  const urls = getUvReleaseZipUrls(platform, arch);
  if (urls.length === 0) {
    const report = await inspectRuntimeEnvironment(opts);
    return {
      success: false,
      report,
      error: `当前系统 (${platform}/${arch}) 暂不支持一键安装 uv，请参考官方文档手动安装。`,
    };
  }

  let archiveBuffer: Buffer | null = null;
  let lastError = '下载失败';
  for (const url of urls) {
    try {
      // eslint-disable-next-line no-await-in-loop -- fallback mirrors are tried sequentially on failure
      archiveBuffer = await downloadBufferWithTimeout(url);
      break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  if (!archiveBuffer) {
    const report = await inspectRuntimeEnvironment(opts);
    return {
      success: false,
      report,
      error: `无法下载 uv 安装包（${lastError}），请检查网络或代理后重试。`,
    };
  }

  try {
    const wantedFiles = ['uv.exe', 'uvx.exe'];
    const filesMap = extractFilesFromZipBuffer(archiveBuffer, wantedFiles);
    const extracted: string[] = [];

    for (const wanted of wantedFiles) {
      const content = filesMap.get(wanted);
      if (!content) continue;
      const targetPath = path.join(managedBinDir, wanted);
      const tempPath = `${targetPath}.tmp`;
      fs.writeFileSync(tempPath, content);
      fs.renameSync(tempPath, targetPath);
      versionCache.delete(targetPath);
      extracted.push(wanted);
    }

    if (!extracted.includes('uv.exe') || !extracted.includes('uvx.exe')) {
      const report = await inspectRuntimeEnvironment(opts);
      return {
        success: false,
        report,
        error: '下载压缩包内缺少 uv.exe / uvx.exe，解压失败。',
      };
    }

    bootstrapRuntimePathEnv(opts?.dataPath, opts);
    const report = await inspectRuntimeEnvironment(opts);
    if (!report.uv.available || !report.uvx.available) {
      return {
        success: false,
        report,
        error: 'uv/uvx 已解压但运行自检未通过，请检查杀毒软件是否拦截。',
      };
    }

    return { success: true, report };
  } catch (err) {
    const report = await inspectRuntimeEnvironment(opts);
    return {
      success: false,
      report,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Download and install Astral `uv` and `uvx` into `<dataPath>/runtime/bin` with deduplicated concurrency.
 */
export async function installManagedUv(opts?: RuntimePathOptions): Promise<InstallRuntimeResult> {
  if (activeUvInstallPromise) {
    return activeUvInstallPromise;
  }
  activeUvInstallPromise = performInstallManagedUv(opts).finally(() => {
    activeUvInstallPromise = null;
  });
  return activeUvInstallPromise;
}

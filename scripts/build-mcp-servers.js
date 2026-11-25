#!/usr/bin/env node
/**
 * Build builtin MCP server scripts as fully self-contained CJS bundles.
 *
 * electron-vite's externalizeDepsPlugin leaves all npm packages as require()
 * calls, which works for Electron's main process (ASAR virtual FS patches
 * require()) but fails when an external `node` process runs the script from
 * app.asar.unpacked — there is no ASAR support there.
 *
 * This script uses esbuild's programmatic API (instead of CLI flags) to avoid
 * shell-quoting issues with special characters in --define values.
 */

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const SHARED_OPTIONS = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  tsconfig: path.join(ROOT, 'tsconfig.json'),
  loader: { '.wasm': 'empty' },
};

function copyBundledChromeDevtoolsMcp() {
  const pkgRoot = path.dirname(require.resolve('chrome-devtools-mcp/package.json', { paths: [ROOT] }));
  const targetDir = path.join(ROOT, 'out/main/chrome-devtools-mcp');
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
  fs.cpSync(path.join(pkgRoot, 'build'), path.join(targetDir, 'build'), { recursive: true });
  fs.copyFileSync(path.join(pkgRoot, 'package.json'), path.join(targetDir, 'package.json'));
}

async function main() {
  await Promise.all([
    esbuild.build({
      ...SHARED_OPTIONS,
      entryPoints: [path.join(ROOT, 'packages/desktop/src/process/resources/builtinMcp/imageGenServer.ts')],
      outfile: path.join(ROOT, 'out/main/builtin-mcp-image-gen.js'),
    }),
    esbuild.build({
      ...SHARED_OPTIONS,
      entryPoints: [path.join(ROOT, 'packages/desktop/src/process/resources/builtinMcp/browserServer.ts')],
      outfile: path.join(ROOT, 'out/main/builtin-mcp-browser.js'),
    }),
  ]);
  copyBundledChromeDevtoolsMcp();
}

main().catch((err) => {
  console.error('MCP server build failed:', err);
  process.exit(1);
});

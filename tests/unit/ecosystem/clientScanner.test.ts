/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanInstalledClients } from '@/process/services/ecosystem/clientScanner';
import { parseCodexTomlMcpServers } from '@/process/services/ecosystem/tomlMcpParser';

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

describe('parseCodexTomlMcpServers', () => {
  it('parses stdio, remote headers, inline arrays, and skips disabled entries', () => {
    const toml = `
model = "gpt-5"

[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp@latest"]

[mcp_servers.context7.env]
API_TOKEN = "secret-123"

[mcp_servers."remote_docs"]
url = "https://example.com/mcp"

[mcp_servers."remote_docs".http_headers]
Authorization = "Bearer abc"

[mcp_servers.disabled_srv]
enabled = false
command = "node"
args = ["dead.js"]

malformed_line_without_equals
`;
    const entries = parseCodexTomlMcpServers(toml);
    expect(entries).toHaveLength(2);
    const ctx = entries.find((e) => e.name === 'context7');
    expect(ctx?.transport).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp@latest'],
      env: { API_TOKEN: 'secret-123' },
    });
    const remote = entries.find((e) => e.name === 'remote_docs');
    expect(remote?.transport).toEqual({
      type: 'streamable_http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer abc' },
    });
  });
});

describe('scanInstalledClients', () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    while (tmpRoots.length > 0) {
      const dir = tmpRoots.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scans Trae CN, WorkBuddy, CodeBuddy, Qoder CN, Claude, Codex, Cursor, Windsurf, Gemini and redacts secrets', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ethantoken-scan-'));
    tmpRoots.push(root);
    const home = path.join(root, 'home');
    const appData = path.join(root, 'appdata');

    // Trae CN: regular skill + .trae-plugin skill/mcp + AppData mcp + user_rules
    writeFile(
      path.join(home, '.trae-cn', 'skills', 'trae-skill', 'SKILL.md'),
      '---\nname: trae-skill\ndescription: Trae local skill\n---\n# Body'
    );
    writeFile(
      path.join(home, '.trae-cn', 'plugins', 'demo', '.trae-plugin', 'plugin.json'),
      JSON.stringify({ name: 'demo', version: '1.0.0' })
    );
    writeFile(
      path.join(home, '.trae-cn', 'plugins', 'demo', 'skills', 'plugin-skill', 'SKILL.md'),
      '---\nname: plugin-skill\ndescription: From plugin\n---\n'
    );
    writeFile(
      path.join(home, '.trae-cn', 'plugins', 'demo', '.mcp.json'),
      JSON.stringify({ mcpServers: { pluginMcp: { command: 'npx', args: ['-y', 'demo-mcp'] } } })
    );
    writeFile(path.join(home, '.trae-cn', 'user_rules.md'), 'Always respond concisely in Chinese.');

    // WorkBuddy: skills + connectors/skills + mcp + memory
    writeFile(
      path.join(home, '.workbuddy', 'skills', 'wb-skill', 'SKILL.md'),
      '---\nname: wb-skill\ndescription: WB skill\n---\n'
    );
    writeFile(
      path.join(home, '.workbuddy', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          tavily: {
            command: 'npx',
            args: ['-y', 'tavily-mcp'],
            env: { TAVILY_API_KEY: 'tvly-super-secret' },
          },
        },
      })
    );
    writeFile(path.join(home, '.workbuddy', 'memory', 'acc_memory.md'), 'Prefer TypeScript strict types.');

    // CodeBuddy + Qoder CN + Claude + Codex + Cursor + Windsurf + Gemini + Kiro
    writeFile(
      path.join(home, '.codebuddy', '.mcp.json'),
      JSON.stringify({ mcpServers: { cbTool: { url: 'https://cb.example.com/sse' } } })
    );
    writeFile(
      path.join(home, '.qoder-cn', 'settings.json'),
      JSON.stringify({ mcpServers: { qoderMcp: { command: 'uvx', args: ['mcp-fetch'] } } })
    );
    writeFile(path.join(home, '.claude', 'CLAUDE.md'), 'Never mutate unrelated files.');
    writeFile(
      path.join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { claudeMcp: { command: 'node', args: ['srv.js'] } } })
    );
    writeFile(
      path.join(home, '.codex', 'skills', '.system', 'internal-hidden', 'SKILL.md'),
      '---\nname: internal-hidden\n---\n'
    );
    writeFile(
      path.join(home, '.codex', 'skills', 'codex-skill', 'SKILL.md'),
      '---\nname: codex-skill\ndescription: Codex public skill\n---\n'
    );
    writeFile(
      path.join(home, '.codex', 'config.toml'),
      '[mcp_servers.codexTool]\ncommand = "npx"\nargs = ["-y", "codex-mcp"]\n'
    );
    writeFile(path.join(home, '.cursor', 'rules', 'style.mdc'), 'Use descriptive naming in all components.');
    writeFile(
      path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
      JSON.stringify({ mcpServers: { broken: { invalid: true } }, brokenJson: true })
    );
    writeFile(path.join(home, '.gemini', 'GEMINI.md'), 'Always verify builds after edits.');
    writeFile(
      path.join(home, '.kiro', 'skills', 'kiro-skill', 'SKILL.md'),
      '---\nname: kiro-skill\ndescription: Kiro skill\n---\n'
    );
    // Corrupt JSON should be safely ignored without throwing.
    writeFile(path.join(appData, 'Trae CN', 'User', 'mcp.json'), '{not-valid-json');

    const outcome = scanInstalledClients({
      homeDir: home,
      appDataDir: appData,
      existingSkillNames: new Set(['trae-skill']),
      existingMcpNames: new Set(['claudeMcp']),
    });

    const skillNames = outcome.report.skills.map((s) => s.name);
    expect(skillNames).toContain('trae-skill');
    expect(skillNames).toContain('plugin-skill');
    expect(skillNames).toContain('wb-skill');
    expect(skillNames).toContain('codex-skill');
    expect(skillNames).toContain('kiro-skill');
    expect(skillNames).not.toContain('internal-hidden');

    const installedTraeSkill = outcome.report.skills.find((s) => s.name === 'trae-skill');
    expect(installedTraeSkill?.installed).toBe(true);

    const tavilyUi = outcome.report.mcps.find((m) => m.name === 'tavily');
    expect(tavilyUi?.hasSecrets).toBe(true);
    expect(tavilyUi?.preview).toContain('TAVILY_API_KEY=***');
    expect(tavilyUi?.preview).not.toContain('tvly-super-secret');

    // Internal record retains raw env for backend import while UI stays redacted.
    const tavilyInternal = outcome.internalMcpsById.get(tavilyUi!.id);
    expect(tavilyInternal?.transport).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'tavily-mcp'],
      env: { TAVILY_API_KEY: 'tvly-super-secret' },
    });

    const claudeMcpUi = outcome.report.mcps.find((m) => m.name === 'claudeMcp');
    expect(claudeMcpUi?.installed).toBe(true);
    expect(outcome.report.mcps.some((m) => m.name === 'codexTool')).toBe(true);
    expect(outcome.report.mcps.some((m) => m.name === 'qoderMcp')).toBe(true);
    expect(outcome.report.mcps.some((m) => m.name === 'cbTool' && m.transportType === 'sse')).toBe(true);

    expect(outcome.report.rules.length).toBeGreaterThanOrEqual(5);
  });

  it('parses YAML multiline block scalars (| and >) and falls back to markdown body', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ethantoken-yaml-'));
    tmpRoots.push(root);
    const home = path.join(root, 'home');
    const appData = path.join(root, 'appdata');

    writeFile(
      path.join(home, '.agents', 'skills', 'firecrawl', 'SKILL.md'),
      [
        '---',
        'name: firecrawl',
        'description: |',
        '  Scrape and search any website cleanly.',
        '  Handles JS-rendered pages and pagination.',
        '---',
        '# Firecrawl CLI',
      ].join('\n')
    );

    writeFile(
      path.join(home, '.agents', 'skills', 'folded-doc', 'SKILL.md'),
      [
        '---',
        'name: folded-doc',
        'description: >-',
        '  Folded description line one',
        '  and line two.',
        '---',
        '# Body',
      ].join('\n')
    );

    writeFile(
      path.join(home, '.agents', 'skills', 'body-fallback', 'SKILL.md'),
      '---\nname: body-fallback\n---\n\n# Heading\n\nFallback summary extracted from body text.\n'
    );

    const outcome = scanInstalledClients({ homeDir: home, appDataDir: appData });
    const fc = outcome.report.skills.find((s) => s.name === 'firecrawl');
    expect(fc?.description).toBe('Scrape and search any website cleanly. Handles JS-rendered pages and pagination.');
    expect(fc?.description).not.toBe('|');
    expect(typeof fc?.mtimeMs).toBe('number');
    expect((fc?.mtimeMs ?? 0) > 0).toBe(true);

    const folded = outcome.report.skills.find((s) => s.name === 'folded-doc');
    expect(folded?.description).toBe('Folded description line one and line two.');

    const bodyFallback = outcome.report.skills.find((s) => s.name === 'body-fallback');
    expect(bodyFallback?.description).toBe('Fallback summary extracted from body text.');
  });
});

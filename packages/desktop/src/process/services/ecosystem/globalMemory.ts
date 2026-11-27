/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { httpRequest } from '@/common/adapter/httpBridge';
import type { Assistant, CreateAssistantRequest } from '@/common/types/agent/assistantTypes';
import { isAionrsAssistant } from '@/common/types/agent/assistantTypes';
import { getSystemDir } from '@process/utils/initStorage';
import { getDataPath } from '@process/utils/utils';
import type { GlobalMemoryState, SaveGlobalMemoryRequest } from './types';

const MAX_SANITIZED_LENGTH = 200;
const CUSTOM_MEMORY_SKILL_NAME = 'ethantoken-user-memory';
const USER_HABITS_ASSISTANT_ID = 'ethantoken-user-habits';
const USER_HABITS_ASSISTANT_NAME = '我的个人习惯';

/**
 * Mirrors `aionrs/crates/aion-memory/src/paths.rs#sanitize_path` for typical workspace paths.
 */
export function sanitizeAionrsProjectPath(projectRoot: string): string {
  const sanitized = Array.from(projectRoot)
    .map((ch) => (/^[A-Za-z0-9]$/.test(ch) ? ch : '-'))
    .join('');
  if (sanitized.length <= MAX_SANITIZED_LENGTH) {
    return sanitized;
  }
  return sanitized.slice(0, MAX_SANITIZED_LENGTH);
}

export function resolveMemoryBaseDir(overrideBaseDir?: string): string {
  const raw = overrideBaseDir?.trim() || process.env.AIONRS_MEMORY_DIR?.trim() || path.join(getDataPath(), 'memory');
  return raw;
}

export function resolveProjectMemoryDir(memoryBaseDir: string, projectRoot: string): string {
  return path.join(memoryBaseDir, 'projects', sanitizeAionrsProjectPath(projectRoot), 'memory');
}

export function resolveGlobalProfilePath(memoryBaseDir: string): string {
  return path.join(memoryBaseDir, 'global', 'user_profile.md');
}

export function upsertMemoryIndexEntry(indexFilePath: string, filename: string, summaryLine: string): void {
  const entry = `- [${filename}](${filename}) - ${summaryLine}`;
  let existing = '';
  try {
    if (fs.existsSync(indexFilePath)) {
      existing = fs.readFileSync(indexFilePath, 'utf-8');
    }
  } catch {
    existing = '';
  }

  const lines = existing ? existing.split(/\r?\n/) : ['# Memory Index', ''];
  const marker = `(${filename})`;
  let replaced = false;
  const nextLines = lines.map((line) => {
    if (line.includes(marker)) {
      replaced = true;
      return entry;
    }
    return line;
  });

  if (!replaced) {
    if (nextLines.length > 0 && nextLines[nextLines.length - 1].trim() !== '') {
      nextLines.push('');
    }
    nextLines.push(entry);
  }

  fs.mkdirSync(path.dirname(indexFilePath), { recursive: true });
  fs.writeFileSync(indexFilePath, `${nextLines.join('\n').replace(/\n+$/, '')}\n`, 'utf-8');
}

export function writeAionMemorySnapshot(
  memoryBaseDir: string,
  projectRoot: string,
  content: string
): { globalProfilePath: string; projectMemoryPath: string; updatedAt: number } {
  const cleanBody = content.replace(/\r\n/g, '\n').trim();
  const globalProfilePath = resolveGlobalProfilePath(memoryBaseDir);
  const projectMemDir = resolveProjectMemoryDir(memoryBaseDir, projectRoot);
  const projectMemoryPath = path.join(projectMemDir, 'user_profile.md');
  const indexPath = path.join(projectMemDir, 'MEMORY.md');

  fs.mkdirSync(path.dirname(globalProfilePath), { recursive: true });
  fs.writeFileSync(globalProfilePath, cleanBody ? `${cleanBody}\n` : '', 'utf-8');

  fs.mkdirSync(projectMemDir, { recursive: true });
  const frontmatterDoc = cleanBody
    ? [
        '---',
        'name: user-profile',
        'description: Global collaboration style, prompt habits, and technical preferences',
        'type: user',
        '---',
        '',
        cleanBody,
        '',
      ].join('\n')
    : [
        '---',
        'name: user-profile',
        'description: Global collaboration style, prompt habits, and technical preferences',
        'type: user',
        '---',
        '',
      ].join('\n');
  fs.writeFileSync(projectMemoryPath, frontmatterDoc, 'utf-8');

  if (cleanBody) {
    upsertMemoryIndexEntry(indexPath, 'user_profile.md', '个人协作习惯、短句偏好与常用技术环境');
  }

  return {
    globalProfilePath,
    projectMemoryPath,
    updatedAt: Date.now(),
  };
}

function normalizeRuleFingerprint(line: string): string {
  return line
    .trim()
    .replace(/^[-*•\d.)]+\s*/, '')
    .replace(/[.,。，!！;；:：]+$/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export function mergeRuleSegmentsIntoProfile(
  existingProfile: string,
  segments: Array<{ title: string; content: string }>
): string {
  return mergeRuleSegmentsWithStats(existingProfile, segments).merged;
}

export function mergeRuleSegmentsWithStats(
  existingProfile: string,
  segments: Array<{ title: string; content: string }>
): { merged: string; addedSegments: number; deduplicatedCount: number } {
  const blocks: string[] = [];
  const seenLines = new Set<string>();
  const trimmedExisting = existingProfile.replace(/\r\n/g, '\n').trim();
  if (trimmedExisting) {
    blocks.push(trimmedExisting);
    for (const line of trimmedExisting.split('\n')) {
      const fp = normalizeRuleFingerprint(line);
      if (fp.length >= 8 && !line.trim().startsWith('#')) {
        seenLines.add(fp);
      }
    }
  }

  let addedSegments = 0;
  let deduplicatedCount = 0;

  for (const seg of segments) {
    const rawBody = seg.content.replace(/\r\n/g, '\n').trim();
    if (!rawBody) continue;
    const combinedCurrent = blocks.join('\n\n');
    if (combinedCurrent.includes(rawBody)) {
      deduplicatedCount += 1;
      continue;
    }

    const filteredLines: string[] = [];
    for (const line of rawBody.split('\n')) {
      const fp = normalizeRuleFingerprint(line);
      if (fp.length >= 8 && !line.trim().startsWith('#') && seenLines.has(fp)) {
        continue;
      }
      if (fp.length >= 8 && !line.trim().startsWith('#')) {
        seenLines.add(fp);
      }
      filteredLines.push(line);
    }

    const dedupedBody = filteredLines.join('\n').trim();
    if (!dedupedBody) {
      deduplicatedCount += 1;
      continue;
    }
    blocks.push(`## ${seg.title}\n\n${dedupedBody}`);
    addedSegments += 1;
  }

  return {
    merged: blocks.join('\n\n').trim(),
    addedSegments,
    deduplicatedCount,
  };
}

function buildUserMemorySkillMarkdown(content: string): string {
  return [
    '---',
    `name: ${CUSTOM_MEMORY_SKILL_NAME}`,
    'description: User personal collaboration habits, concise communication style, and workspace preferences migrated across clients.',
    '---',
    '',
    '# 个人协作习惯与偏好',
    '',
    content.trim(),
    '',
  ].join('\n');
}

async function ensureUserMemorySkillAndAssistant(content: string, syncAssistant: boolean): Promise<boolean> {
  const clean = content.trim();
  if (!clean) return false;

  try {
    const paths = await httpRequest<{ user_skills_dir?: string }>('GET', '/api/skills/paths');
    if (paths?.user_skills_dir) {
      const skillDir = path.join(paths.user_skills_dir, CUSTOM_MEMORY_SKILL_NAME);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), buildUserMemorySkillMarkdown(clean), 'utf-8');
    }
  } catch (err) {
    console.warn('[Ecosystem] Failed to write global user-memory skill:', err);
  }

  if (!syncAssistant) return false;

  try {
    const assistants = await httpRequest<Assistant[]>('GET', '/api/assistants');
    const existing = assistants.find(
      (a) => a.id === USER_HABITS_ASSISTANT_ID || a.name === USER_HABITS_ASSISTANT_NAME
    );

    const aionrsAgentId = assistants.find((a) => isAionrsAssistant(a) && a.agent_id)?.agent_id;
    let targetId = existing?.id;

    if (!targetId) {
      const createBody: CreateAssistantRequest = {
        id: USER_HABITS_ASSISTANT_ID,
        name: USER_HABITS_ASSISTANT_NAME,
        description: '已同步个人协作习惯与常用规则，适合日常简短指令协作。',
        ...(aionrsAgentId ? { agent_id: aionrsAgentId } : {}),
        enabled_skills: [CUSTOM_MEMORY_SKILL_NAME],
      };
      const created = await httpRequest<Assistant>('POST', '/api/assistants', createBody);
      targetId = created?.id || USER_HABITS_ASSISTANT_ID;
    } else {
      const nextSkills = Array.from(new Set([...(existing?.enabled_skills || []), CUSTOM_MEMORY_SKILL_NAME]));
      await httpRequest<Assistant>('PUT', `/api/assistants/${encodeURIComponent(targetId)}`, {
        id: targetId,
        enabled_skills: nextSkills,
      }).catch((): undefined => undefined);
    }

    const ruleBody = [
      '# 个人协作偏好与沟通规则',
      '',
      '以下内容来自用户长期沉淀的个人记忆与规则，请优先遵循；无需在每次回复前复述这些规则：',
      '',
      clean,
      '',
    ].join('\n');

    await Promise.all([
      httpRequest<boolean>('POST', '/api/skills/assistant-rule/write', {
        assistant_id: targetId,
        content: ruleBody,
        locale: 'zh-CN',
      }),
      httpRequest<boolean>('POST', '/api/skills/assistant-rule/write', {
        assistant_id: targetId,
        content: ruleBody,
        locale: 'en-US',
      }).catch(() => false),
    ]);
    return true;
  } catch (err) {
    console.warn('[Ecosystem] Failed to sync user-habits assistant:', err);
    return false;
  }
}

export async function getGlobalMemoryState(): Promise<GlobalMemoryState> {
  const memoryBaseDir = resolveMemoryBaseDir();
  const workDir = getSystemDir().workDir || getDataPath();
  const globalProfilePath = resolveGlobalProfilePath(memoryBaseDir);
  const projectMemoryPath = path.join(resolveProjectMemoryDir(memoryBaseDir, workDir), 'user_profile.md');

  let content = '';
  let updatedAt = 0;
  try {
    if (fs.existsSync(globalProfilePath)) {
      content = fs.readFileSync(globalProfilePath, 'utf-8');
      updatedAt = fs.statSync(globalProfilePath).mtimeMs;
    } else if (fs.existsSync(projectMemoryPath)) {
      const raw = fs.readFileSync(projectMemoryPath, 'utf-8');
      content = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, '').trim();
      updatedAt = fs.statSync(projectMemoryPath).mtimeMs;
    }
  } catch {
    content = '';
  }

  let assistantExists = false;
  try {
    const assistants = await httpRequest<Assistant[]>('GET', '/api/assistants');
    assistantExists = assistants.some(
      (a) => a.id === USER_HABITS_ASSISTANT_ID || a.name === USER_HABITS_ASSISTANT_NAME
    );
  } catch {
    assistantExists = false;
  }

  return {
    memoryBaseDir,
    globalProfilePath,
    projectMemoryPath,
    content,
    assistantExists,
    updatedAt,
  };
}

export async function saveGlobalMemoryState(
  req: SaveGlobalMemoryRequest
): Promise<GlobalMemoryState & { assistantSynced: boolean }> {
  const memoryBaseDir = resolveMemoryBaseDir();
  const workDir = getSystemDir().workDir || getDataPath();
  const snap = writeAionMemorySnapshot(memoryBaseDir, workDir, req.content);
  const assistantSynced = await ensureUserMemorySkillAndAssistant(req.content, req.syncAssistant !== false);
  const latest = await getGlobalMemoryState();
  return {
    ...latest,
    updatedAt: snap.updatedAt,
    assistantSynced,
  };
}

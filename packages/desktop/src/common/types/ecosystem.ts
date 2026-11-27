/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IMcpServerTransport } from '@/common/config/storage';

export type EcosystemClientId =
  | 'trae-cn'
  | 'trae'
  | 'workbuddy'
  | 'codebuddy'
  | 'qoder-cn'
  | 'qoder'
  | 'claude'
  | 'codex'
  | 'cursor'
  | 'windsurf'
  | 'gemini'
  | 'other-agents';

export interface ScannedSkillItem {
  id: string;
  clientId: EcosystemClientId;
  clientName: string;
  name: string;
  description: string;
  sourcePath: string;
  installed: boolean;
  mtimeMs?: number;
}

export interface ScannedMcpItem {
  id: string;
  clientId: EcosystemClientId;
  clientName: string;
  name: string;
  description: string;
  sourcePath: string;
  transportType: IMcpServerTransport['type'];
  preview: string;
  hasSecrets: boolean;
  installed: boolean;
}

export interface ScannedRuleItem {
  id: string;
  clientId: EcosystemClientId;
  clientName: string;
  title: string;
  sourcePath: string;
  kind: 'rule' | 'memory';
  content: string;
  charCount: number;
}

export interface ScannedClientSummary {
  clientId: EcosystemClientId;
  clientName: string;
  detected: boolean;
  rootPaths: string[];
  skillCount: number;
  mcpCount: number;
  ruleCount: number;
}

export interface ClientScanReport {
  scannedAt: number;
  clients: ScannedClientSummary[];
  skills: ScannedSkillItem[];
  mcps: ScannedMcpItem[];
  rules: ScannedRuleItem[];
}

export interface MigrationImportRequest {
  /** Simple one-click mode: import & deduplicate all items belonging to these clients. */
  clientIds?: EcosystemClientId[];
  /** Advanced custom mode: import explicitly selected item IDs. */
  skillIds?: string[];
  mcpIds?: string[];
  ruleIds?: string[];
  extraMemoryText?: string;
  syncAssistant?: boolean;
}

export interface MigrationImportResult {
  skillsImported: number;
  skillsFailed: Array<{ name: string; reason: string }>;
  mcpsImported: number;
  mcpsFailed: Array<{ name: string; reason: string }>;
  rulesMerged: number;
  deduplicatedSkills: number;
  deduplicatedMcps: number;
  deduplicatedRules: number;
  assistantSynced: boolean;
  globalMemoryPath: string;
}

export interface GlobalMemoryState {
  memoryBaseDir: string;
  globalProfilePath: string;
  projectMemoryPath: string;
  content: string;
  assistantExists: boolean;
  updatedAt: number;
}

export interface SaveGlobalMemoryRequest {
  content: string;
  syncAssistant?: boolean;
}

export interface MarketplaceEnvField {
  key: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  secret?: boolean;
  target?: 'env' | 'header' | 'arg';
  headerName?: string;
  argIndex?: number;
  defaultValue?: string;
}

export interface MarketplaceMcpItem {
  id: string;
  name: string;
  title: string;
  description: string;
  category: string;
  source: 'curated' | 'registry';
  transport: IMcpServerTransport;
  configFields?: MarketplaceEnvField[];
  repositoryUrl?: string;
  author?: string;
  version?: string;
  stars?: number;
  downloads?: number;
  hasUpdate?: boolean;
  installedVersion?: string;
  remoteVersion?: string;
  installed: boolean;
}

export interface MarketplaceSearchMcpResult {
  items: MarketplaceMcpItem[];
  remoteUnavailable?: boolean;
}

export interface InstallMcpRequest {
  item: MarketplaceMcpItem;
  fieldValues?: Record<string, string>;
}

export interface InstallMcpResult {
  success: boolean;
  name: string;
  error?: string;
}

export interface MarketplaceSkillItem {
  id: string;
  name: string;
  description: string;
  category: string;
  source: 'curated' | 'skills.sh';
  repo: string;
  skillId: string;
  rawPath?: string;
  author?: string;
  repositoryUrl?: string;
  version?: string;
  stars?: number;
  installs?: number;
  hasUpdate?: boolean;
  installed: boolean;
}

export interface MarketplaceSearchSkillsResult {
  items: MarketplaceSkillItem[];
  remoteUnavailable?: boolean;
}

export interface InstallSkillRequest {
  repo: string;
  skillId?: string;
  rawPath?: string;
  customName?: string;
}

export interface InstallSkillResult {
  success: boolean;
  skillName: string;
  error?: string;
}

export interface MarketplaceSyncResult {
  syncedAt: number;
  mcpCount: number;
  skillCount: number;
  starsUpdated: number;
  updatesAvailable: number;
}

export interface MarketplaceUpdateItem {
  kind: 'mcp' | 'skill';
  id: string;
  name: string;
  currentVersion?: string;
  latestVersion?: string;
  repo?: string;
  skillId?: string;
  rawPath?: string;
}

export interface MarketplaceUpdateCheckResult {
  checkedAt: number;
  updates: MarketplaceUpdateItem[];
}

export interface MarketplaceUpdateAllResult {
  updatedCount: number;
  failed: Array<{ name: string; reason: string }>;
}

export interface AttachResourcesRequest {
  skillNames?: string[];
  mcpServerIds?: string[];
  mcpServerNames?: string[];
}

export interface AttachResourcesResult {
  updatedAssistants: number;
  totalAssistants: number;
  enabledMcpIds: string[];
}

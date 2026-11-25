/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { IProvider } from '@/common/config/storage';
import { assistantRuntimeKey, type AssistantDetail } from '@/common/types/agent/assistantTypes';

const PREFERRED_AIONRS_MODELS = [
  'deepseek-v4.1-flash',
  'gpt-6.2-sol-fast',
  'claude-sonnet-5-5',
  'gemini-3.8-flash',
  'gpt-6.2-sol',
];

function getEnabledModelsForProvider(provider: IProvider): string[] {
  const models = Array.isArray(provider.models) ? provider.models : [];
  return models.filter((modelName) => Boolean(modelName) && provider.model_enabled?.[modelName] !== false);
}

/**
 * Pick the best enabled provider+model pair for an aionrs team slot.
 * Filters out disabled providers, disabled models, and Google Auth providers
 * (which aioncore/aionrs does not support).
 */
export function pickDefaultAionrsProviderModel(
  providers: IProvider[]
): { provider: IProvider; model: string } | undefined {
  const eligibleProviders = providers.filter(
    (p) => p.enabled !== false && !p.platform?.toLowerCase().includes('gemini-with-google-auth')
  );

  for (const preferred of PREFERRED_AIONRS_MODELS) {
    for (const provider of eligibleProviders) {
      if (getEnabledModelsForProvider(provider).includes(preferred)) {
        return { provider, model: preferred };
      }
    }
  }

  for (const provider of eligibleProviders) {
    const firstModel = getEnabledModelsForProvider(provider)[0];
    if (firstModel) {
      return { provider, model: firstModel };
    }
  }

  return undefined;
}

/**
 * Resolve the `model` value a team agent should send to `POST /api/teams`.
 *
 * Backend `service.rs` consumes `input.model` verbatim with no default, so an
 * empty or backend-name-only value (e.g. "gemini") ends up persisted as
 * `use_model: null`. Downstream, GeminiSendBox / AionrsSendBox gate the
 * textarea on `current_model?.useModel` and render disabled. See mnemo #297.
 *
 * This resolver reads assistant-owned defaults first and then falls back to
 * backend-safe defaults when the selected assistant has no explicit model.
 *
 * For ACP backends (claude, codex, acp) the model is resolved from the
 * agent's handshake data or cached model info so the backend receives a
 * valid model ID (e.g. "claude-sonnet-4-5-20250514") instead of the bare
 * backend name.
 */
export async function resolveDefaultTeamAgentModel(params: {
  assistant_id?: string;
  assistant_backend?: string;
}): Promise<string> {
  const { assistant_id, assistant_backend } = params;

  const assistantDetail = await resolveAssistantDetail(assistant_id);
  if (assistantDetail) {
    const assistantModel = resolveAssistantModel(assistantDetail);
    if (assistantModel) {
      return assistantModel;
    }

    return resolveBackendDefaultModel(assistantRuntimeKey({ agent: assistantDetail.engine.agent }));
  }

  return resolveBackendDefaultModel(assistant_backend);
}

async function resolveAssistantDetail(assistant_id?: string): Promise<AssistantDetail | undefined> {
  if (!assistant_id) return undefined;

  try {
    const detail = (await ipcBridge.assistants.get.invoke({ id: assistant_id })) as AssistantDetail | null;
    return detail ?? undefined;
  } catch {
    return undefined;
  }
}

function resolveAssistantModel(detail: AssistantDetail): string | undefined {
  if (detail.defaults.model.mode === 'fixed' && detail.defaults.model.value) {
    return detail.defaults.model.value;
  }

  if (detail.defaults.model.mode === 'auto' && detail.preferences.last_model_id) {
    return detail.preferences.last_model_id;
  }

  return undefined;
}

function resolveBackendDefaultModel(assistant_backend?: string): Promise<string> {
  if (assistant_backend === 'gemini') {
    return resolveGeminiDefaultModel();
  }

  if (assistant_backend === 'aionrs') {
    return resolveAionrsDefaultModel();
  }

  if (assistant_backend === 'antigravity') {
    return resolveAntigravityDefaultModel();
  }

  return resolveAcpDefaultModel(assistant_backend ?? 'acp');
}

async function resolveAcpDefaultModel(_assistant_backend: string): Promise<string> {
  return 'default';
}

async function resolveAntigravityDefaultModel(): Promise<string> {
  // An empty model means "no --model flag": team provisioning persists it
  // verbatim, the session layer filters empty ids to None, and agy runs on
  // its own default model — the exact path direct chat already uses. The
  // 'default' placeholder is not a real agy model id and fails every team
  // turn with UserLlmProviderModelNotFound while agy's discovery is empty.
  return '';
}

async function resolveGeminiDefaultModel(): Promise<string> {
  // The legacy 'gemini.defaultModel' config key has been removed after the
  // Gemini → ACP consolidation. Always fall back to the 'auto' alias.
  return 'auto';
}

async function resolveAionrsDefaultModel(): Promise<string> {
  try {
    const providers = (await ipcBridge.mode.listProviders.invoke()) ?? [];
    const picked = pickDefaultAionrsProviderModel(providers);
    if (picked) {
      return picked.model;
    }
  } catch {
    // Fall back when provider list is unavailable during initial setup or tests.
  }
  return 'default';
}

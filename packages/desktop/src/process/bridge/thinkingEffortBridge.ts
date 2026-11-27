/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { thinkingEffortGateway } from '../services/thinkingEffortGateway';

export function initThinkingEffortBridge(): void {
  ipcBridge.thinkingEffort.setModelEffort.provider(async ({ model, effort }) => {
    await thinkingEffortGateway.setModelEffort(model, effort);
    return { ok: true };
  });

  ipcBridge.thinkingEffort.syncPreferences.provider(async ({ enabled, modelLevels }) => {
    await thinkingEffortGateway.syncPreferences({ enabled, modelLevels });
    return { ok: true };
  });

  ipcBridge.thinkingEffort.wrapUrl.provider(async ({ url }) => {
    return { url: thinkingEffortGateway.wrapUrlIfActive(url) };
  });

  ipcBridge.thinkingEffort.reconcileProviders.provider(async () => {
    const wrappedCount = await thinkingEffortGateway.reconcileProvidersWithBackend();
    return { wrappedCount };
  });

  ipcBridge.thinkingEffort.getStatus.provider(async () => {
    return thinkingEffortGateway.getStatus();
  });
}

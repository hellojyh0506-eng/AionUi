/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { initApplicationBridge } from './applicationBridge';
import { initDialogBridge } from './dialogBridge';
import { initUpdateBridge } from './updateBridge';
import { initSystemSettingsBridge } from './systemSettingsBridge';
import { initWindowControlsBridge } from './windowControlsBridge';
import { initNotificationBridge } from './notificationBridge';
import { initWebuiBridge } from './webuiBridge';
import { initThemeBridge } from './themeBridge';
import { initEthanTokenBridge } from './ethantokenBridge';
import { initEcosystemBridge } from './ecosystemBridge';
import { initKnowledgeBridge } from './knowledgeBridge';
import { initMcpAppsBridge } from './mcpAppsBridge';
import { initThinkingEffortBridge } from './thinkingEffortBridge';

export type BridgeDependencies = Record<string, never>;

export function initAllBridges(_deps: BridgeDependencies = {}): void {
  initDialogBridge();
  initApplicationBridge();
  initWindowControlsBridge();
  initUpdateBridge();
  initSystemSettingsBridge();
  initNotificationBridge();
  initWebuiBridge();
  initThemeBridge();
  initEthanTokenBridge();
  initEcosystemBridge();
  initKnowledgeBridge();
  initMcpAppsBridge();
  initThinkingEffortBridge();
}

export {
  initApplicationBridge,
  initDialogBridge,
  initEcosystemBridge,
  initEthanTokenBridge,
  initKnowledgeBridge,
  initMcpAppsBridge,
  initNotificationBridge,
  initSystemSettingsBridge,
  initThemeBridge,
  initThinkingEffortBridge,
  initUpdateBridge,
  initWindowControlsBridge,
  initWebuiBridge,
};
export { registerWindowMaximizeListeners } from './windowControlsBridge';
export const disposeAllTeamSessions = (): Promise<void> => Promise.resolve();

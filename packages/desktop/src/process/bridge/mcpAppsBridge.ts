/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { callMcpAppTool, readMcpAppUiResource } from '../services/mcpApps/mcpAppHostService';

export function initMcpAppsBridge(): void {
  ipcBridge.mcpApps.readUiResource.provider(async (req) => {
    return await readMcpAppUiResource(req);
  });

  ipcBridge.mcpApps.callTool.provider(async (req) => {
    return await callMcpAppTool(req);
  });
}

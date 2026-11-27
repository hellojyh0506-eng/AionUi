/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

export type DesktopBridgeHandler = (params: unknown) => Promise<unknown>;

const handlers = new Map<string, DesktopBridgeHandler>();

export function registerDesktopWebuiHandler(channel: string, handler: DesktopBridgeHandler): void {
  handlers.set(channel, handler);
}

export function getDesktopWebuiHandler(channel: string): DesktopBridgeHandler | undefined {
  return handlers.get(channel);
}

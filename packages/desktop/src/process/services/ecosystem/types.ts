/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IMcpServerTransport } from '@/common/config/storage';

export * from '@/common/types/ecosystem';

export interface InternalScannedMcpRecord {
  id: string;
  name: string;
  description: string;
  transport: IMcpServerTransport;
  originalConfig: Record<string, unknown>;
}

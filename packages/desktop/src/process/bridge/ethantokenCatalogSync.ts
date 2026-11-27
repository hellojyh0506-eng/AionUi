/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

export type CatalogParseFailureReason =
  | 'auth_invalid'
  | 'http_error'
  | 'network_error'
  | 'malformed_body'
  | 'api_error'
  | 'malformed_data'
  | 'malformed_entry';

export type CatalogParseResult =
  | { ok: true; models: string[] }
  | {
      ok: false;
      reason: CatalogParseFailureReason;
      authInvalid: boolean;
      status?: number;
      message?: string;
    };

export type CatalogSyncStatus = 'synced' | 'stale' | 'auth_invalid' | 'unconfirmed' | 'discarded';

export interface CatalogSyncIdentity {
  baseUrl: string;
  userId: number;
  apiKey: string;
}

export interface CatalogSyncResult {
  status: CatalogSyncStatus;
  models: string[];
  providerId?: string;
  providerWritten: boolean;
  discarded?: boolean;
  catalogSyncedAt?: number;
  error?: string;
  reason?: CatalogParseFailureReason;
}

/**
 * Strictly validate an OpenAI-compatible `/v1/models` response.
 * - Accepts a valid empty array `data: []` as an authoritative empty catalog.
 * - Rejects HTTP errors, `success: false`, non-array `data`, or ANY malformed entry
 *   so partial corruption never causes accidental model deletion.
 * - Preserves exact model IDs without mutating or collapsing aliases.
 */
export function parseRemoteModelCatalogResponse(
  status: number,
  body: unknown,
  preferredOrder: readonly string[] = []
): CatalogParseResult {
  if (status === 401 || status === 403) {
    return { ok: false, reason: 'auth_invalid', authInvalid: true, status };
  }
  if (status < 200 || status >= 300) {
    return { ok: false, reason: 'http_error', authInvalid: false, status };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'malformed_body', authInvalid: false, status };
  }

  const record = body as Record<string, unknown>;
  if ('success' in record && record.success !== true) {
    return {
      ok: false,
      reason: 'api_error',
      authInvalid: false,
      status,
      message: typeof record.message === 'string' ? record.message : undefined,
    };
  }

  if (!Array.isArray(record.data)) {
    return { ok: false, reason: 'malformed_data', authInvalid: false, status };
  }

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const item of record.data) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, reason: 'malformed_entry', authInvalid: false, status };
    }
    const rawId = (item as Record<string, unknown>).id;
    if (typeof rawId !== 'string' || rawId.trim().length === 0) {
      return { ok: false, reason: 'malformed_entry', authInvalid: false, status };
    }
    const id = rawId.trim();
    if (!seen.has(id)) {
      seen.add(id);
      deduped.push(id);
    }
  }

  return { ok: true, models: sortCatalogModels(deduped, preferredOrder) };
}

/**
 * Reorder existing model IDs by preferred display priority only.
 * Never injects fallback defaults, never drops valid IDs, never rewrites IDs.
 */
export function sortCatalogModels(models: readonly string[], preferredOrder: readonly string[]): string[] {
  if (models.length <= 1) return [...models];
  const rank = new Map(preferredOrder.map((m, i) => [m, i] as const));
  return [...models].toSorted((a, b) => {
    const ra = rank.get(a) ?? Number.MAX_SAFE_INTEGER;
    const rb = rank.get(b) ?? Number.MAX_SAFE_INTEGER;
    return ra - rb;
  });
}

export function haveSameModelSet(a?: readonly string[], b?: readonly string[]): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const sa = [...a].toSorted();
  const sb = [...b].toSorted();
  return sa.every((v, i) => v === sb[i]);
}

export function buildCatalogIdentityKey(identity: CatalogSyncIdentity): string {
  return `${identity.baseUrl.replace(/\/+$/, '')}|${identity.userId}|${identity.apiKey}`;
}

export interface CatalogSyncDeps {
  fetchCatalog: (identity: CatalogSyncIdentity) => Promise<CatalogParseResult>;
  readCurrentProviderModels: (identity: CatalogSyncIdentity) => Promise<{
    providerId?: string;
    models?: string[];
    needsRepair: boolean;
  }>;
  writeProviderModels: (identity: CatalogSyncIdentity, models: string[]) => Promise<string>;
}

/**
 * Coordinates EthanToken model catalog synchronization:
 * - Isolates state by (baseUrl, userId, apiKey) identity.
 * - Coalesces concurrent fetches for the same identity.
 * - Serializes AionCore provider writes and guards them with an epoch counter so
 *   late responses from a previous account or pre-logout request never pollute state.
 */
export class EthanTokenCatalogCoordinator {
  private epoch = 0;
  private activeIdentityKey: string | null = null;
  private inFlight = new Map<string, Promise<CatalogSyncResult>>();
  private writeChain: Promise<void> = Promise.resolve();

  public setActiveIdentity(identity: CatalogSyncIdentity | null): number {
    const nextKey = identity ? buildCatalogIdentityKey(identity) : null;
    if (nextKey !== this.activeIdentityKey) {
      this.epoch += 1;
      this.activeIdentityKey = nextKey;
    }
    return this.epoch;
  }

  public invalidate(): number {
    this.epoch += 1;
    this.activeIdentityKey = null;
    return this.epoch;
  }

  public getEpoch(): number {
    return this.epoch;
  }

  public async sync(
    identity: CatalogSyncIdentity,
    fallbackSnapshot: readonly string[] | undefined,
    deps: CatalogSyncDeps
  ): Promise<CatalogSyncResult> {
    const identityKey = buildCatalogIdentityKey(identity);
    if (this.activeIdentityKey !== identityKey) {
      this.activeIdentityKey = identityKey;
      this.epoch += 1;
    }
    const capturedEpoch = this.epoch;
    const inflightKey = `${capturedEpoch}:${identityKey}`;
    const existingFlight = this.inFlight.get(inflightKey);
    if (existingFlight) {
      return existingFlight;
    }

    const promise = this.runSync(identity, identityKey, capturedEpoch, fallbackSnapshot, deps).finally(() => {
      if (this.inFlight.get(inflightKey) === promise) {
        this.inFlight.delete(inflightKey);
      }
    });
    this.inFlight.set(inflightKey, promise);
    return promise;
  }

  private async runSync(
    identity: CatalogSyncIdentity,
    identityKey: string,
    capturedEpoch: number,
    fallbackSnapshot: readonly string[] | undefined,
    deps: CatalogSyncDeps
  ): Promise<CatalogSyncResult> {
    let parsed: CatalogParseResult;
    try {
      parsed = await deps.fetchCatalog(identity);
    } catch (err) {
      parsed = {
        ok: false,
        reason: 'network_error',
        authInvalid: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }

    if (this.epoch !== capturedEpoch || this.activeIdentityKey !== identityKey) {
      return {
        status: 'discarded',
        models: [],
        providerWritten: false,
        discarded: true,
      };
    }

    if (parsed.ok === false) {
      const preserved = Array.isArray(fallbackSnapshot) ? [...fallbackSnapshot] : [];
      return {
        status: parsed.authInvalid ? 'auth_invalid' : Array.isArray(fallbackSnapshot) ? 'stale' : 'unconfirmed',
        models: preserved,
        providerWritten: false,
        reason: parsed.reason,
        error: parsed.message,
      };
    }

    const nextModels = parsed.models;

    let result: CatalogSyncResult = {
      status: 'discarded',
      models: [],
      providerWritten: false,
      discarded: true,
    };

    const nextWrite = this.writeChain.then(async () => {
      if (this.epoch !== capturedEpoch || this.activeIdentityKey !== identityKey) {
        result = {
          status: 'discarded',
          models: [],
          providerWritten: false,
          discarded: true,
        };
        return;
      }

      const currentState = await deps.readCurrentProviderModels(identity);
      if (this.epoch !== capturedEpoch || this.activeIdentityKey !== identityKey) {
        result = {
          status: 'discarded',
          models: [],
          providerWritten: false,
          discarded: true,
        };
        return;
      }

      const modelsChanged = !haveSameModelSet(currentState.models, nextModels);
      if (currentState.needsRepair || modelsChanged) {
        const providerId = await deps.writeProviderModels(identity, nextModels);
        result = {
          status: 'synced',
          models: nextModels,
          providerId,
          providerWritten: true,
          catalogSyncedAt: Date.now(),
        };
      } else {
        result = {
          status: 'synced',
          models: nextModels,
          providerId: currentState.providerId,
          providerWritten: false,
          catalogSyncedAt: Date.now(),
        };
      }
    });

    // Keep writeChain alive even if a single write fails so subsequent retries proceed.
    this.writeChain = nextWrite.catch((): undefined => undefined);
    await nextWrite;
    return result;
  }
}

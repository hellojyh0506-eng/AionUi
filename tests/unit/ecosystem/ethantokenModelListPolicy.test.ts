import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EthanTokenCatalogCoordinator,
  parseRemoteModelCatalogResponse,
  sortCatalogModels,
  type CatalogSyncDeps,
  type CatalogSyncIdentity,
} from '../../../packages/desktop/src/process/bridge/ethantokenCatalogSync';

const accountBarSource = readFileSync(
  join(__dirname, '../../../packages/desktop/src/renderer/components/layout/Sider/EthanTokenAccountBar.tsx'),
  'utf8'
);

describe('ethantoken dynamic model catalog sync', () => {
  const idA: CatalogSyncIdentity = { baseUrl: 'https://ethantoken.top', userId: 1, apiKey: 'sk-account-a' };
  const idB: CatalogSyncIdentity = { baseUrl: 'https://ethantoken.top', userId: 2, apiKey: 'sk-account-b' };

  it('parses valid catalogs, preserves exact IDs (including gpt-6.2-sol), and accepts valid empty []', () => {
    const ok = parseRemoteModelCatalogResponse(
      200,
      {
        object: 'list',
        success: true,
        data: [{ id: 'gpt-6.2-sol-pro' }, { id: 'deepseek-v4.1-flash-official' }, { id: 'gpt-6.2-sol' }],
      },
      ['gpt-6.2-sol']
    );
    expect(ok).toEqual({
      ok: true,
      models: ['gpt-6.2-sol', 'gpt-6.2-sol-pro', 'deepseek-v4.1-flash-official'],
    });

    const empty = parseRemoteModelCatalogResponse(200, { object: 'list', success: true, data: [] });
    expect(empty).toEqual({ ok: true, models: [] });
  });

  it('rejects auth errors, HTTP errors, success:false, non-array data, and any malformed entry', () => {
    expect(parseRemoteModelCatalogResponse(401, { error: 'unauthorized' })).toMatchObject({
      ok: false,
      reason: 'auth_invalid',
      authInvalid: true,
    });
    expect(parseRemoteModelCatalogResponse(403, {})).toMatchObject({
      ok: false,
      reason: 'auth_invalid',
      authInvalid: true,
    });
    expect(parseRemoteModelCatalogResponse(500, { data: [] })).toMatchObject({
      ok: false,
      reason: 'http_error',
      authInvalid: false,
    });
    expect(parseRemoteModelCatalogResponse(200, { success: false, message: 'group error', data: [] })).toMatchObject({
      ok: false,
      reason: 'api_error',
    });
    expect(parseRemoteModelCatalogResponse(200, { success: true, data: 'not-an-array' })).toMatchObject({
      ok: false,
      reason: 'malformed_data',
    });
    // One malformed entry must invalidate the whole response rather than dropping it and deleting models
    expect(
      parseRemoteModelCatalogResponse(200, {
        success: true,
        data: [{ id: 'gemini-4-neon' }, { id: '' }],
      })
    ).toMatchObject({
      ok: false,
      reason: 'malformed_entry',
    });
    expect(
      parseRemoteModelCatalogResponse(200, {
        success: true,
        data: [{ id: 'gemini-4-neon' }, null],
      })
    ).toMatchObject({
      ok: false,
      reason: 'malformed_entry',
    });
  });

  it('syncs [A, B] -> [A] -> [] -> [A, C] and skips redundant writes when unchanged', async () => {
    const coordinator = new EthanTokenCatalogCoordinator();
    let persisted: string[] = ['model-a', 'model-b'];
    const writeSpy = vi.fn(async (_id: CatalogSyncIdentity, models: string[]) => {
      persisted = [...models];
      return 'prov-1';
    });

    let remoteResponse = parseRemoteModelCatalogResponse(200, {
      success: true,
      data: [{ id: 'model-a' }, { id: 'model-b' }],
    });

    const deps: CatalogSyncDeps = {
      fetchCatalog: async () => remoteResponse,
      readCurrentProviderModels: async () => ({ providerId: 'prov-1', models: persisted, needsRepair: false }),
      writeProviderModels: writeSpy,
    };

    // Unchanged -> no write
    const r0 = await coordinator.sync(idA, persisted, deps);
    expect(r0.status).toBe('synced');
    expect(r0.providerWritten).toBe(false);
    expect(writeSpy).toHaveBeenCalledTimes(0);

    // [A, B] -> [A] (dynamic delist)
    remoteResponse = parseRemoteModelCatalogResponse(200, { success: true, data: [{ id: 'model-a' }] });
    const r1 = await coordinator.sync(idA, persisted, deps);
    expect(r1.status).toBe('synced');
    expect(r1.providerWritten).toBe(true);
    expect(persisted).toEqual(['model-a']);

    // [A] -> [] (authoritative empty list clears persisted models)
    remoteResponse = parseRemoteModelCatalogResponse(200, { success: true, data: [] });
    const r2 = await coordinator.sync(idA, persisted, deps);
    expect(r2.status).toBe('synced');
    expect(r2.providerWritten).toBe(true);
    expect(persisted).toEqual([]);

    // [] -> [A, C] (dynamic listing)
    remoteResponse = parseRemoteModelCatalogResponse(200, {
      success: true,
      data: [{ id: 'model-a' }, { id: 'model-c' }],
    });
    const r3 = await coordinator.sync(idA, persisted, deps);
    expect(r3.status).toBe('synced');
    expect(r3.providerWritten).toBe(true);
    expect(persisted).toEqual(['model-a', 'model-c']);
    expect(writeSpy).toHaveBeenCalledTimes(3);
  });

  it('preserves last good snapshot on failure and recovers on next valid response', async () => {
    const coordinator = new EthanTokenCatalogCoordinator();
    let persisted: string[] = ['model-a'];
    const writeSpy = vi.fn(async (_id: CatalogSyncIdentity, models: string[]) => {
      persisted = [...models];
      return 'prov-1';
    });

    const failDeps: CatalogSyncDeps = {
      fetchCatalog: async () => ({ ok: false, reason: 'network_error', authInvalid: false, message: 'timeout' }),
      readCurrentProviderModels: async () => ({ providerId: 'prov-1', models: persisted, needsRepair: false }),
      writeProviderModels: writeSpy,
    };
    const stale = await coordinator.sync(idA, persisted, failDeps);
    expect(stale.status).toBe('stale');
    expect(stale.models).toEqual(['model-a']);
    expect(writeSpy).not.toHaveBeenCalled();

    const recoverDeps: CatalogSyncDeps = {
      fetchCatalog: async () => ({ ok: true, models: ['model-a', 'gemini-4-neon'] }),
      readCurrentProviderModels: async () => ({ providerId: 'prov-1', models: persisted, needsRepair: false }),
      writeProviderModels: writeSpy,
    };
    const ok = await coordinator.sync(idA, persisted, recoverDeps);
    expect(ok.status).toBe('synced');
    expect(persisted).toEqual(['model-a', 'gemini-4-neon']);
  });

  it('discards late response from account A after switching to account B or logging out', async () => {
    const coordinator = new EthanTokenCatalogCoordinator();
    let persisted: string[] = ['init'];
    const writeSpy = vi.fn(async (_id: CatalogSyncIdentity, models: string[]) => {
      persisted = [...models];
      return 'prov-1';
    });

    let resolveA!: (v: ReturnType<typeof parseRemoteModelCatalogResponse>) => void;
    const promiseA = coordinator.sync(idA, persisted, {
      fetchCatalog: () =>
        new Promise((resolve) => {
          resolveA = resolve;
        }),
      readCurrentProviderModels: async () => ({ providerId: 'prov-1', models: persisted, needsRepair: false }),
      writeProviderModels: writeSpy,
    });

    // Switch to account B while A is still in flight
    coordinator.setActiveIdentity(idB);
    const resB = await coordinator.sync(idB, [], {
      fetchCatalog: async () => ({ ok: true, models: ['model-b-only'] }),
      readCurrentProviderModels: async () => ({ providerId: 'prov-1', models: persisted, needsRepair: false }),
      writeProviderModels: writeSpy,
    });
    expect(resB.status).toBe('synced');
    expect(persisted).toEqual(['model-b-only']);

    // Now A's stale response arrives late
    resolveA({ ok: true, models: ['model-a-stale'] });
    const resA = await promiseA;
    expect(resA.status).toBe('discarded');
    expect(resA.discarded).toBe(true);
    expect(persisted).toEqual(['model-b-only']);
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  it('recovers write queue after a transient local AionCore write failure', async () => {
    const coordinator = new EthanTokenCatalogCoordinator();
    let persisted: string[] = ['old'];
    let failOnce = true;

    const deps: CatalogSyncDeps = {
      fetchCatalog: async () => ({ ok: true, models: ['new-model'] }),
      readCurrentProviderModels: async () => ({ providerId: 'prov-1', models: persisted, needsRepair: false }),
      writeProviderModels: async (_id, models) => {
        if (failOnce) {
          failOnce = false;
          throw new Error('AionCore busy');
        }
        persisted = [...models];
        return 'prov-1';
      },
    };

    await expect(coordinator.sync(idA, persisted, deps)).rejects.toThrow('AionCore busy');
    expect(persisted).toEqual(['old']);

    const retry = await coordinator.sync(idA, persisted, deps);
    expect(retry.status).toBe('synced');
    expect(retry.providerWritten).toBe(true);
    expect(persisted).toEqual(['new-model']);
  });

  it('sortCatalogModels never injects defaults for empty input', () => {
    expect(sortCatalogModels([], ['deepseek-v4.1-flash'])).toEqual([]);
  });

  it('revalidates PROVIDERS_SWR_KEY on refresh, interval, focus, and logout in EthanTokenAccountBar', () => {
    expect(accountBarSource).toContain('mutate(PROVIDERS_SWR_KEY)');
    expect(accountBarSource).toMatch(/setInterval\([\s\S]*?syncFrontendCaches\(\)/);
    expect(accountBarSource).toMatch(/handleFocus[\s\S]*?syncFrontendCaches\(\)/);
  });
});

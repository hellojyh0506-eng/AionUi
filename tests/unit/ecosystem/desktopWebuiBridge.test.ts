/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startStaticServer, type StaticServerHandle } from '@aionui/web-host';
import { createDesktopWebuiApiHandler } from '@/process/bridge/desktopWebuiBridge';

function createMockRequest(opts: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}): http.IncomingMessage {
  const rawBody = opts.body === undefined ? '' : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  async function* bodyGen() {
    if (rawBody) {
      yield Buffer.from(rawBody, 'utf-8');
    }
  }
  const req = Object.assign(bodyGen(), {
    url: opts.url,
    method: opts.method ?? 'POST',
    headers: opts.headers ?? {},
  });
  return req as unknown as http.IncomingMessage;
}

function createMockResponse() {
  let statusCode = 200;
  let headers: Record<string, string> = {};
  let rawBody = '';
  const res = {
    writeHead(code: number, hdrs?: Record<string, string>) {
      statusCode = code;
      headers = hdrs ?? {};
      return this;
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) {
        rawBody += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : chunk;
      }
      return this;
    },
  };
  return {
    res: res as unknown as http.ServerResponse,
    read: () => ({
      statusCode,
      headers,
      json: rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : undefined,
    }),
  };
}

describe('desktopWebuiBridge', () => {
  const cleanupFns: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanupFns.splice(0).map((fn) => fn()));
  });

  it('rejects non-POST methods, non-allowlisted channels, and unauthenticated requests', async () => {
    const handlerFn = vi.fn(async () => ({ loggedIn: true }));
    const apiHandler = createDesktopWebuiApiHandler(19000, {
      fetchImpl: (async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })) as unknown as typeof fetch,
      getHandler: () => handlerFn,
    });

    const getRes = createMockResponse();
    const handledGet = await apiHandler(
      createMockRequest({ url: '/api/desktop-bridge/ethantoken%3Aget-status', method: 'GET' }),
      getRes.res
    );
    expect(handledGet).toBe(true);
    expect(getRes.read().statusCode).toBe(405);

    const disallowedRes = createMockResponse();
    const handledLogin = await apiHandler(
      createMockRequest({ url: '/api/desktop-bridge/ethantoken%3Alogin' }),
      disallowedRes.res
    );
    expect(handledLogin).toBe(true);
    expect(disallowedRes.read().statusCode).toBe(404);

    const unauthRes = createMockResponse();
    const handledUnauth = await apiHandler(
      createMockRequest({ url: '/api/desktop-bridge/ethantoken%3Aget-status' }),
      unauthRes.res
    );
    expect(handledUnauth).toBe(true);
    expect(unauthRes.read().statusCode).toBe(401);
    expect(handlerFn).not.toHaveBeenCalled();

    const unrelatedRes = createMockResponse();
    const handledOther = await apiHandler(createMockRequest({ url: '/api/providers', method: 'GET' }), unrelatedRes.res);
    expect(handledOther).toBe(false);
  });

  it('forwards cookies to /api/auth/user and executes allowlisted handlers with JSON wrapping', async () => {
    let seenCookie = '';
    const mockFetch = (async (_url: string, init?: RequestInit) => {
      seenCookie = String((init?.headers as Record<string, string> | undefined)?.cookie || '');
      return new Response(JSON.stringify({ success: true, data: { username: 'admin' } }), { status: 200 });
    }) as unknown as typeof fetch;

    const apiHandler = createDesktopWebuiApiHandler(19000, {
      fetchImpl: mockFetch,
      getHandler: (channel) => {
        if (channel === 'ethantoken:get-ledger') {
          return async (params) => ({ range: (params as { range?: string })?.range ?? '30d', total: 42 });
        }
        return undefined;
      },
    });

    const okRes = createMockResponse();
    await apiHandler(
      createMockRequest({
        url: '/api/desktop-bridge/ethantoken%3Aget-ledger',
        headers: { cookie: 'aion_session=abc' },
        body: { range: '7d' },
      }),
      okRes.res
    );
    expect(seenCookie).toBe('aion_session=abc');
    expect(okRes.read().statusCode).toBe(200);
    expect(okRes.read().json).toEqual({
      success: true,
      data: { range: '7d', total: 42 },
    });
  });

  it('integrates end-to-end with @aionui/web-host startStaticServer over HTTP', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ethantoken-webhost-'));
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html>ok</html>', 'utf-8');

    const mockBackend = http.createServer((req, res) => {
      if (req.url === '/api/auth/user' && req.headers.cookie === 'sid=valid') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: { username: 'admin' } }));
        return;
      }
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    });
    await new Promise<void>((resolve) => mockBackend.listen(0, '127.0.0.1', () => resolve()));
    const backendPort = (mockBackend.address() as { port: number }).port;

    const server: StaticServerHandle = await startStaticServer({
      staticDir: tmpDir,
      backendPort,
      port: 0,
      allowRemote: false,
      customApiHandler: createDesktopWebuiApiHandler(backendPort, {
        getHandler: (channel) => {
          if (channel === 'ethantoken:get-status') {
            return async () => ({ loggedIn: true, username: 'ethan', quotaUsd: 9.5, baseUrl: 'https://ethantoken.top' });
          }
          return undefined;
        },
      }),
    });

    cleanupFns.push(async () => {
      await server.stop();
      await new Promise<void>((resolve) => mockBackend.close(() => resolve()));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const unauthResp = await fetch(`${server.localUrl}/api/desktop-bridge/ethantoken%3Aget-status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(unauthResp.status).toBe(401);

    const authResp = await fetch(`${server.localUrl}/api/desktop-bridge/ethantoken%3Aget-status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'sid=valid' },
      body: '{}',
    });
    expect(authResp.status).toBe(200);
    const payload = (await authResp.json()) as { success: boolean; data: { loggedIn: boolean; quotaUsd: number } };
    expect(payload.success).toBe(true);
    expect(payload.data.loggedIn).toBe(true);
    expect(payload.data.quotaUsd).toBe(9.5);
  });
});

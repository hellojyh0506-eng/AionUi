/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isThinkingGatewayUrl,
  parseThinkingGatewayRequestPath,
  shouldWrapProviderForThinking,
  unwrapProviderBaseUrl,
  unwrapThinkingGatewayUrl,
  wrapThinkingGatewayUrl,
} from '@/common/utils/thinkingGatewayUrl';
import {
  applyThinkingEffortToRequestBody,
  ThinkingEffortGateway,
} from '@/process/services/thinkingEffortGateway';

describe('thinkingGatewayUrl', () => {
  it('wraps, unwraps idempotently, and preserves real URL in UI', () => {
    const wrapped = wrapThinkingGatewayUrl('https://ethantoken.top/v1/', 51234, 'tok123');
    expect(wrapped.startsWith('http://127.0.0.1:51234/et-thinking/tok123/')).toBe(true);
    expect(isThinkingGatewayUrl(wrapped)).toBe(true);
    expect(unwrapThinkingGatewayUrl(wrapped)).toBe('https://ethantoken.top/v1');

    // Never double-wraps
    const wrappedAgain = wrapThinkingGatewayUrl(wrapped, 59999, 'tok456');
    expect(unwrapThinkingGatewayUrl(wrappedAgain)).toBe('https://ethantoken.top/v1');
    expect(wrappedAgain).toContain('/tok456/');

    // Unwraps provider object cleanly
    const clean = unwrapProviderBaseUrl({ id: 'p1', base_url: wrapped });
    expect(clean.base_url).toBe('https://ethantoken.top/v1');
  });

  it('validates per-session token and extracts upstream path + query', () => {
    const wrapped = wrapThinkingGatewayUrl('https://ethantoken.top/v1', 51234, 'secret-token');
    const urlObj = new URL(wrapped);
    const parsed = parseThinkingGatewayRequestPath(urlObj.pathname + '/chat/completions?api-version=1', 'secret-token');
    expect(parsed).toEqual({
      upstreamBaseUrl: 'https://ethantoken.top/v1',
      restPath: '/chat/completions',
      search: '?api-version=1',
    });

    expect(parseThinkingGatewayRequestPath(urlObj.pathname + '/chat/completions', 'wrong-token')).toBeNull();
    expect(parseThinkingGatewayRequestPath('/other/path', 'secret-token')).toBeNull();
  });

  it('filters non-HTTP and Bedrock/GoogleAuth providers', () => {
    expect(shouldWrapProviderForThinking({ platform: 'new-api', base_url: 'https://ethantoken.top/v1' })).toBe(true);
    expect(shouldWrapProviderForThinking({ platform: 'custom', base_url: 'http://127.0.0.1:3425' })).toBe(true);
    expect(shouldWrapProviderForThinking({ platform: 'bedrock', base_url: 'https://bedrock.us-east-1.amazonaws.com' })).toBe(false);
    expect(shouldWrapProviderForThinking({ platform: 'gemini-with-google-auth', base_url: 'https://example.com' })).toBe(false);
    expect(shouldWrapProviderForThinking({ platform: 'custom', base_url: '' })).toBe(false);
  });
});

describe('applyThinkingEffortToRequestBody', () => {
  it('handles deepseek-v4.1-flash off via thinking=disabled + reasoning_effort=none, and max via reasoning_effort', () => {
    const offRes = applyThinkingEffortToRequestBody(
      { model: 'workbuddy/deepseek-v4.1-flash', reasoning_effort: 'high', messages: [{ role: 'user', content: 'ok' }] },
      'off',
      '/chat/completions'
    );
    expect(offRes.modified).toBe(true);
    expect(offRes.body.thinking).toEqual({ type: 'disabled' });
    // Both fields together are required: thinking=disabled alone still reasons on
    // ethantoken.top / workbuddy routes (measured live 2026-11-27).
    expect(offRes.body.reasoning_effort).toBe('none');

    const maxRes = applyThinkingEffortToRequestBody(
      { model: 'deepseek-v4.1-flash', thinking: { type: 'disabled' }, messages: [{ role: 'user', content: 'ok' }] },
      'max',
      '/chat/completions'
    );
    expect(maxRes.modified).toBe(true);
    expect(maxRes.body.reasoning_effort).toBe('max');
    expect('thinking' in maxRes.body).toBe(false);
  });

  it('handles OpenAI Chat Completions, Responses, Anthropic Messages, Gemini, and Qwen', () => {
    const gptXhigh = applyThinkingEffortToRequestBody(
      { model: 'gpt-6.2-sol', messages: [] },
      'xhigh',
      '/chat/completions'
    );
    expect(gptXhigh.body.reasoning_effort).toBe('xhigh');

    const responsesOff = applyThinkingEffortToRequestBody(
      { model: 'gpt-6.2-sol', input: 'hi' },
      'off',
      '/responses'
    );
    expect(responsesOff.body.reasoning).toEqual({ effort: 'none' });

    const anthropic5 = applyThinkingEffortToRequestBody(
      { model: 'claude-sonnet-5-5', messages: [], max_tokens: 4096 },
      'max',
      '/messages'
    );
    expect(anthropic5.body.thinking).toEqual({ type: 'adaptive' });
    expect(anthropic5.body.output_config).toEqual({ effort: 'max' });

    const anthropicLegacy = applyThinkingEffortToRequestBody(
      { model: 'claude-sonnet-4-20250514', messages: [], max_tokens: 4096 },
      'high',
      '/messages'
    );
    expect(anthropicLegacy.body.thinking).toEqual({ type: 'enabled', budget_tokens: 16384 });
    expect(anthropicLegacy.body.max_tokens).toBe(20480);

    const geminiOff = applyThinkingEffortToRequestBody(
      { model: 'gemini-2.5-flash', messages: [] },
      'off',
      '/chat/completions'
    );
    expect(geminiOff.body.reasoning_effort).toBe('none');

    const qwenOff = applyThinkingEffortToRequestBody(
      { model: 'qwen3-235b', messages: [] },
      'off',
      '/chat/completions'
    );
    expect(qwenOff.body.enable_thinking).toBe(false);
  });
});

describe('ThinkingEffortGateway live loopback HTTP integration', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
  });

  it('mutates outgoing POST bodies in real time, streams SSE chunks, passes GET untouched, and rejects invalid tokens', async () => {
    const receivedBodies: Array<Record<string, unknown>> = [];
    const upstreamServer = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'deepseek-v4.1-flash' }] }));
        return;
      }

      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>;
          receivedBodies.push(parsed);

          if (parsed.stream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write('data: {"chunk":1}\n\n');
            setTimeout(() => {
              res.write('data: {"chunk":2}\n\n');
              res.end('data: [DONE]\n\n');
            }, 15);
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ echoed: parsed }));
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const upstreamPort = await new Promise<number>((resolve) => {
      upstreamServer.listen(0, '127.0.0.1', () => {
        const addr = upstreamServer.address() as { port: number };
        resolve(addr.port);
      });
    });
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          upstreamServer.close(() => resolve());
        })
    );

    const gateway = new ThinkingEffortGateway({ upstreamFetch: fetch });
    const { port, token } = await gateway.start();
    cleanups.push(() => gateway.close());

    const wrappedBase = wrapThinkingGatewayUrl(`http://127.0.0.1:${upstreamPort}/v1`, port, token);

    // 1. Set DeepSeek V4.1 Flash -> off
    await gateway.setModelEffort('workbuddy/deepseek-v4.1-flash', 'off');
    const respOff = await fetch(`${wrappedBase}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-test' },
      body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'ok' }] }),
    });
    expect(respOff.status).toBe(200);
    expect(receivedBodies[0].thinking).toEqual({ type: 'disabled' });
    expect(receivedBodies[0].reasoning_effort).toBe('none');
    expect((receivedBodies[0].messages as Array<{ content: string }>)[0].content).toBe('ok');

    // 2. Switch live to max + stream SSE
    await gateway.setModelEffort('deepseek-v4.1-flash', 'max');
    const respStream = await fetch(`${wrappedBase}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true, messages: [{ role: 'user', content: 'ok' }] }),
    });
    expect(respStream.status).toBe(200);
    const sseText = await respStream.text();
    expect(sseText).toContain('data: {"chunk":1}');
    expect(sseText).toContain('data: {"chunk":2}');
    expect(receivedBodies[1].reasoning_effort).toBe('max');

    // 3. GET passthrough
    const modelsResp = await fetch(`${wrappedBase}/models`);
    expect(modelsResp.status).toBe(200);
    expect(await modelsResp.json()).toEqual({ data: [{ id: 'deepseek-v4.1-flash' }] });

    // 4. Reject invalid token with 403
    const badUrl = wrappedBase.replace(token, 'bad-token');
    const badResp = await fetch(`${badUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [] }),
    });
    expect(badResp.status).toBe(403);
  });
});

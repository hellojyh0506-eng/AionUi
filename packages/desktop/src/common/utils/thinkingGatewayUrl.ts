/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

export const THINKING_GATEWAY_PATH_PREFIX = '/et-thinking/';

function encodeBase64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(encoded: string): string | null {
  if (!encoded) return null;
  try {
    const padded = encoded.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((encoded.length + 3) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Checks whether a provider URL is a wrapped local thinking-effort gateway endpoint:
 * `http://127.0.0.1:<port>/et-thinking/<token>/<b64>...`
 */
export function isThinkingGatewayUrl(url?: string | null): boolean {
  if (typeof url !== 'string' || !url.trim()) return false;
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') {
      return false;
    }
    if (!parsed.pathname.startsWith(THINKING_GATEWAY_PATH_PREFIX)) {
      return false;
    }
    const rest = parsed.pathname.slice(THINKING_GATEWAY_PATH_PREFIX.length);
    const parts = rest.split('/').filter(Boolean);
    return parts.length >= 2 && Boolean(decodeBase64Url(parts[1]));
  } catch {
    return false;
  }
}

/**
 * Restores the real upstream base URL from a wrapped local thinking-effort gateway URL.
 * Returns `url ?? ''` unchanged if it is not a wrapped gateway URL.
 */
export function unwrapThinkingGatewayUrl(url?: string | null): string {
  if (typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (
      parsed.protocol !== 'http:' ||
      parsed.hostname !== '127.0.0.1' ||
      !parsed.pathname.startsWith(THINKING_GATEWAY_PATH_PREFIX)
    ) {
      return url;
    }
    const afterPrefix = parsed.pathname.slice(THINKING_GATEWAY_PATH_PREFIX.length);
    const segments = afterPrefix.split('/').filter(Boolean);
    if (segments.length < 2) return url;
    const decoded = decodeBase64Url(segments[1]);
    if (!decoded) return url;
    const decodedParsed = new URL(decoded);
    if (decodedParsed.protocol !== 'http:' && decodedParsed.protocol !== 'https:') {
      return url;
    }
    const trailingSegments = segments.slice(2);
    if (trailingSegments.length === 0) {
      return decoded;
    }
    return `${decoded.replace(/\/+$/, '')}/${trailingSegments.join('/')}${parsed.search}`;
  } catch {
    return url;
  }
}

/**
 * Wraps an HTTP/HTTPS upstream base URL behind the local loopback thinking-effort gateway.
 * Idempotent: unwraps first so URLs are never double-wrapped.
 */
export function wrapThinkingGatewayUrl(realBaseUrl: string, port: number, token: string): string {
  const unwrapped = unwrapThinkingGatewayUrl(realBaseUrl).trim().replace(/\/+$/, '');
  if (!unwrapped || !Number.isInteger(port) || port <= 0 || !token) {
    return unwrapped || realBaseUrl;
  }
  try {
    const parsed = new URL(unwrapped);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return realBaseUrl;
    }
    return `http://127.0.0.1:${port}${THINKING_GATEWAY_PATH_PREFIX}${token}/${encodeBase64Url(unwrapped)}`;
  } catch {
    return realBaseUrl;
  }
}

/**
 * Parses an incoming loopback request URL (`/et-thinking/<token>/<encoded>/<rest>?<search>`)
 * and validates the per-session token using constant-time comparison.
 */
export function parseThinkingGatewayRequestPath(
  rawUrlPath: string,
  expectedToken: string
): { upstreamBaseUrl: string; restPath: string; search: string } | null {
  if (!rawUrlPath || !expectedToken) return null;
  const qIdx = rawUrlPath.indexOf('?');
  const pathname = qIdx >= 0 ? rawUrlPath.slice(0, qIdx) : rawUrlPath;
  const search = qIdx >= 0 ? rawUrlPath.slice(qIdx) : '';

  if (!pathname.startsWith(THINKING_GATEWAY_PATH_PREFIX)) {
    return null;
  }

  const afterPrefix = pathname.slice(THINKING_GATEWAY_PATH_PREFIX.length);
  const firstSlash = afterPrefix.indexOf('/');
  if (firstSlash <= 0) return null;

  const token = afterPrefix.slice(0, firstSlash);
  if (!timingSafeStringEqual(token, expectedToken)) {
    return null;
  }

  const afterToken = afterPrefix.slice(firstSlash + 1);
  if (!afterToken) return null;

  const secondSlash = afterToken.indexOf('/');
  const encodedBase = secondSlash >= 0 ? afterToken.slice(0, secondSlash) : afterToken;
  const restPath = secondSlash >= 0 ? afterToken.slice(secondSlash) : '';

  const decoded = decodeBase64Url(encodedBase);
  if (!decoded) return null;

  try {
    const parsed = new URL(decoded);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return {
      upstreamBaseUrl: decoded.replace(/\/+$/, ''),
      restPath,
      search,
    };
  } catch {
    return null;
  }
}

/**
 * Returns true if the provider uses an HTTP(S) endpoint eligible for local thinking-effort injection.
 */
export function shouldWrapProviderForThinking(provider: { platform?: string; base_url?: string }): boolean {
  if (!provider || typeof provider.base_url !== 'string') return false;
  const platform = (provider.platform || '').trim().toLowerCase();
  if (platform === 'bedrock' || platform.includes('gemini-with-google-auth')) {
    return false;
  }
  const realUrl = unwrapThinkingGatewayUrl(provider.base_url).trim();
  return realUrl.startsWith('http://') || realUrl.startsWith('https://');
}

/**
 * Returns a copy of `provider` with `base_url` unwrapped back to the clean upstream URL.
 */
export function unwrapProviderBaseUrl<T extends { base_url?: string }>(provider: T): T {
  if (!provider || typeof provider.base_url !== 'string' || !isThinkingGatewayUrl(provider.base_url)) {
    return provider;
  }
  return {
    ...provider,
    base_url: unwrapThinkingGatewayUrl(provider.base_url),
  };
}

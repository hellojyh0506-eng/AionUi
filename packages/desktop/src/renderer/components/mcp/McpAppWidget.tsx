/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Spin, Tag } from '@arco-design/web-react';
import { ExpandTextInput, FullScreen, OffScreen, Refresh } from '@icon-park/react';
import { ipcBridge } from '@/common';
import { openExternalUrl } from '@/renderer/utils/platform';
import type { ResolvedMcpAppTarget } from '@/renderer/hooks/mcp/useMcpAppRegistry';

interface McpAppWidgetProps {
  target: ResolvedMcpAppTarget;
  rawInput?: string;
  rawOutput?: string;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function tryParseJsonObject(raw?: string): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore non-JSON text
  }
  return undefined;
}

function buildToolResultPayload(rawOutput?: string, embeddedStructuredContent?: Record<string, unknown>) {
  const parsed = tryParseJsonObject(rawOutput);
  if (parsed && (Array.isArray(parsed.content) || parsed.structuredContent)) {
    return {
      content: Array.isArray(parsed.content) ? parsed.content : [{ type: 'text', text: rawOutput || '' }],
      ...(parsed.structuredContent ? { structuredContent: parsed.structuredContent } : {}),
    };
  }
  return {
    content: rawOutput ? [{ type: 'text', text: rawOutput }] : [],
    ...(embeddedStructuredContent ? { structuredContent: embeddedStructuredContent } : {}),
  };
}

function getCurrentHostTheme(): 'dark' | 'light' {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'dark') return 'dark';
  if (document.body.getAttribute('arco-theme') === 'dark') return 'dark';
  return 'light';
}

const McpAppWidget: React.FC<McpAppWidgetProps> = ({ target, rawInput, rawOutput }) => {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [html, setHtml] = useState<string>('');
  const [prefersBorder, setPrefersBorder] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const [iframeHeight, setIframeHeight] = useState(280);
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);

  const parsedInput = useMemo(() => tryParseJsonObject(rawInput) ?? {}, [rawInput]);
  const toolResultPayload = useMemo(
    () => buildToolResultPayload(rawOutput, target.embeddedStructuredContent),
    [rawOutput, target.embeddedStructuredContent]
  );

  const loadWidgetResource = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await ipcBridge.mcpApps.readUiResource.invoke({
        serverId: target.serverId,
        serverName: target.serverName,
        resourceUri: target.resourceUri,
      });
      if (!res.success || !res.html) {
        setError(res.error || '未能加载 MCP App 视图资源');
        setHtml('');
        return;
      }
      setPrefersBorder(res.prefersBorder !== false);
      setHtml(res.html);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setHtml('');
    } finally {
      setLoading(false);
    }
  }, [target.resourceUri, target.serverId, target.serverName]);

  useEffect(() => {
    void loadWidgetResource();
  }, [loadWidgetResource, reloadNonce]);

  const postToIframe = useCallback((payload: unknown) => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage(payload, '*');
  }, []);

  const pushInitialToolData = useCallback(() => {
    postToIframe({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-input',
      params: { arguments: parsedInput },
    });
    postToIframe({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: toolResultPayload,
    });
  }, [parsedInput, postToIframe, toolResultPayload]);

  // Forward live theme updates when host theme flips.
  useEffect(() => {
    const observer = new MutationObserver(() => {
      postToIframe({
        jsonrpc: '2.0',
        method: 'ui/notifications/host-context-changed',
        params: { theme: getCurrentHostTheme() },
      });
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    observer.observe(document.body, { attributes: true, attributeFilter: ['arco-theme'] });
    return () => observer.disconnect();
  }, [postToIframe]);

  // JSON-RPC 2.0 host bridge over window.postMessage.
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) {
        return;
      }
      const msg = event.data as JsonRpcMessage | undefined;
      if (!msg || msg.jsonrpc !== '2.0' || !msg.method) return;

      const replyOk = (result: unknown) => {
        if (msg.id !== undefined) {
          postToIframe({ jsonrpc: '2.0', id: msg.id, result });
        }
      };
      const replyErr = (code: number, message: string) => {
        if (msg.id !== undefined) {
          postToIframe({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
        }
      };

      if (msg.method === 'ui/initialize') {
        replyOk({
          protocolVersion: '2026-01-26',
          hostInfo: { name: 'EthanToken-Desktop', version: '2.x' },
          hostCapabilities: {
            openLinks: {},
            serverTools: {},
            message: {},
          },
          hostContext: {
            theme: getCurrentHostTheme(),
          },
        });
        return;
      }

      if (msg.method === 'ui/notifications/initialized') {
        pushInitialToolData();
        return;
      }

      if (msg.method === 'ui/notifications/size-changed' || msg.method === 'ui/size-change') {
        const nextH = Number(msg.params?.height);
        if (Number.isFinite(nextH) && nextH > 0) {
          setIframeHeight(Math.max(180, Math.min(680, Math.round(nextH))));
        }
        return;
      }

      if (msg.method === 'ui/open-link') {
        const url = typeof msg.params?.url === 'string' ? msg.params.url.trim() : '';
        if (/^https?:\/\//iu.test(url)) {
          void openExternalUrl(url);
          replyOk({ ok: true });
        } else {
          replyErr(-32602, 'Only http/https URLs are permitted');
        }
        return;
      }

      if (msg.method === 'ui/message') {
        const contentArr = Array.isArray(msg.params?.content)
          ? (msg.params?.content as Array<{ type?: string; text?: string }>)
          : [];
        const text = contentArr
          .filter((c) => c?.type === 'text' && typeof c.text === 'string')
          .map((c) => c.text)
          .join('\n')
          .trim();
        if (text) {
          window.dispatchEvent(new CustomEvent('ethantoken:prefill-chat-input', { detail: { prompt: text } }));
        }
        replyOk({ ok: true });
        return;
      }

      if (msg.method === 'tools/call') {
        const toolName = typeof msg.params?.name === 'string' ? msg.params.name : '';
        const args =
          msg.params?.arguments && typeof msg.params.arguments === 'object'
            ? (msg.params.arguments as Record<string, unknown>)
            : {};
        if (!toolName) {
          replyErr(-32602, 'Missing tool name');
          return;
        }
        void ipcBridge.mcpApps.callTool
          .invoke({
            serverId: target.serverId,
            serverName: target.serverName,
            toolName,
            arguments: args,
          })
          .then((res) => {
            if (!res.success) {
              replyErr(-32000, res.error || 'Tool invocation failed');
              return;
            }
            replyOk({
              content: res.content || [],
              ...(res.structuredContent ? { structuredContent: res.structuredContent } : {}),
              isError: res.isError === true,
            });
          })
          .catch((err) => {
            replyErr(-32000, err instanceof Error ? err.message : String(err));
          });
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [postToIframe, pushInitialToolData, target.serverId, target.serverName]);

  // Re-push tool result whenever updated output arrives after widget initialized.
  useEffect(() => {
    if (html) {
      pushInitialToolData();
    }
  }, [html, pushInitialToolData]);

  return (
    <div
      className={
        fullscreenOpen
          ? 'fixed inset-16px z-1000 rd-12px overflow-hidden bg-base border border-solid border-[var(--color-border-2)] shadow-2xl flex flex-col'
          : `mt-8px rd-12px overflow-hidden bg-base ${
              prefersBorder ? 'border border-solid border-[var(--color-border-2)]' : ''
            }`
      }
    >
      <div className='px-12px py-6px flex items-center justify-between gap-8px bg-fill-1 border-b border-solid border-[var(--color-border-2)] border-x-0 border-t-0 shrink-0'>
        <div className='flex items-center gap-6px min-w-0'>
          <Tag size='small' color='arcoblue'>
            MCP 交互组件
          </Tag>
          <span className='text-12px font-500 text-t-primary truncate'>
            {target.serverName ? `${target.serverName} · ` : ''}
            {target.toolName}
          </span>
        </div>

        <div className='flex items-center gap-4px shrink-0'>
          <Button
            size='mini'
            type='text'
            icon={<Refresh size={13} />}
            onClick={() => setReloadNonce((n) => n + 1)}
            title='重新加载组件'
          />
          {!fullscreenOpen && (
            <Button
              size='mini'
              type='text'
              icon={<ExpandTextInput size={13} />}
              onClick={() => setCollapsed((c) => !c)}
              title={collapsed ? '展开组件' : '收起组件'}
            />
          )}
          {html && (
            <Button
              size='mini'
              type='text'
              icon={fullscreenOpen ? <OffScreen size={13} /> : <FullScreen size={13} />}
              onClick={() => setFullscreenOpen((v) => !v)}
              title={fullscreenOpen ? '退出全屏' : '放大查看'}
            />
          )}
        </div>
      </div>

      {(!collapsed || fullscreenOpen) && (
        <div className={`w-full bg-1 ${fullscreenOpen ? 'flex-1 min-h-0' : ''}`}>
          {loading ? (
            <div className='py-28px flex items-center justify-center gap-8px text-12px text-t-secondary'>
              <Spin size={16} />
              <span>正在加载交互组件...</span>
            </div>
          ) : error ? (
            <div className='px-12px py-10px text-12px text-t-secondary'>无法渲染交互组件：{error}</div>
          ) : (
            <iframe
              ref={iframeRef}
              title={`MCP App ${target.toolName}`}
              sandbox='allow-scripts'
              srcDoc={html}
              style={{
                width: '100%',
                height: fullscreenOpen ? '100%' : `${iframeHeight}px`,
                border: 'none',
                display: 'block',
              }}
            />
          )}
        </div>
      )}
    </div>
  );
};

export default React.memo(McpAppWidget);

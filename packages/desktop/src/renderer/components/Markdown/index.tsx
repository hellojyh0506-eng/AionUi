/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';

import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';

// Import KaTeX CSS to make it available in the document
import 'katex/dist/katex.min.css';

import { openExternalUrl } from '@/renderer/utils/platform';
import { parseHttpUrl } from '@/renderer/utils/url';
import { useConversationContextSafe } from '@/renderer/hooks/context/ConversationContext';
import { useOptionalPreviewContext } from '@/renderer/pages/conversation/Preview/context/PreviewContext';
import classNames from 'classnames';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { convertLatexDelimiters } from '@renderer/utils/chat/latexDelimiters';
import LocalImageView from '@renderer/components/media/LocalImageView';
import CodeBlock from './CodeBlock';
import LocalFileLink from './LocalFileLink';
import { resolveWorkspaceFileByCandidate } from './localFileLookup';
import { rehypeMarkStandaloneInlineCode, remarkBareLocalFilePaths } from './markdownLocalFilePlugins';
import ShadowView from './ShadowView';
import { DEFAULT_REHYPE_PLUGINS, MARKDOWN_REMARK_PLUGINS, MarkdownTable, MarkdownTd } from './markdownComponents';
import {
  resolveLocalFileLinkPath,
  resolveLocalFileLinkReference,
  resolveWorkspaceRelativeCandidate,
} from './markdownUtils';
import type { LocalFileLinkReference } from './markdownUtils';

const isLocalFilePath = (src: string): boolean => {
  if (src.startsWith('http://') || src.startsWith('https://')) return false;
  if (src.startsWith('data:')) return false;
  return true;
};

const WorkspaceRelativeAnchor: React.FC<{
  rawHref: string;
  workspace: string;
  onOpen: (path: string, reference?: LocalFileLinkReference) => void | Promise<void>;
  anchorProps: React.AnchorHTMLAttributes<HTMLAnchorElement>;
  onAnchorClick: (e: React.MouseEvent<HTMLAnchorElement>) => void;
}> = ({ rawHref, workspace, onOpen, anchorProps, onAnchorClick }) => {
  const [resolvedRef, setResolvedRef] = useState<LocalFileLinkReference | null>(null);

  useEffect(() => {
    let cancelled = false;
    void resolveWorkspaceFileByCandidate(rawHref, workspace).then((match) => {
      if (!cancelled) {
        setResolvedRef(match);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [rawHref, workspace]);

  if (resolvedRef) {
    return (
      <LocalFileLink reference={resolvedRef} onOpen={onOpen}>
        {anchorProps.children}
      </LocalFileLink>
    );
  }

  return <a {...anchorProps} href={anchorProps.href} target='_blank' rel='noreferrer' onClick={onAnchorClick} />;
};

type MarkdownViewProps = {
  children: string;
  hiddenCodeCopyButton?: boolean;
  codeStyle?: React.CSSProperties;
  className?: string;
  onRef?: (el?: HTMLDivElement | null) => void;
  onLocalFileLink?: (path: string, reference?: LocalFileLinkReference) => void | Promise<void>;
  /** Enable raw HTML rendering in markdown content. Use with caution — only for trusted sources. */
  allowHtml?: boolean;
};

const MarkdownView: React.FC<MarkdownViewProps> = React.memo(
  ({ hiddenCodeCopyButton, codeStyle, className, onRef, onLocalFileLink, allowHtml, children: childrenProp }) => {
    const { t } = useTranslation();
    const preview = useOptionalPreviewContext();
    const workspace = useConversationContextSafe()?.workspace;

    const normalizedChildren = useMemo(() => {
      if (typeof childrenProp === 'string') {
        let text = childrenProp.replace(/file:\/\//g, '');
        text = convertLatexDelimiters(text);
        return text;
      }
      return childrenProp;
    }, [childrenProp]);

    const handleLinkClick = useCallback(
      (e: React.MouseEvent<HTMLAnchorElement>) => {
        e.preventDefault();
        e.stopPropagation();
        const href = (e.currentTarget as HTMLAnchorElement).href;
        if (!href) return;
        // Prefer the built-in browser tab for http(s) links; fall back to the
        // system browser for other schemes or when no Preview panel is available.
        const httpUrl = parseHttpUrl(href);
        if (httpUrl && preview) {
          preview.openBrowserTab(httpUrl);
          return;
        }
        openExternalUrl(href).catch((error: unknown) => {
          console.error(t('messages.openLinkFailed'), error);
        });
      },
      [t, preview]
    );

    // Memoize components so React preserves component identity across re-renders.
    // Without this, every streaming update creates new function references → React
    // unmounts/remounts all custom components → hooks & DOM state are lost.
    const components = useMemo(
      () => ({
        span: ({ node: _node, className: cn, children: ch, ...rest }: Record<string, unknown>) => (
          <span {...(rest as React.HTMLAttributes<HTMLSpanElement>)} className={cn as string}>
            {ch as React.ReactNode}
          </span>
        ),
        code: (props: Record<string, unknown>) => (
          <CodeBlock
            {...(props as Parameters<typeof CodeBlock>[0])}
            codeStyle={codeStyle}
            hiddenCodeCopyButton={hiddenCodeCopyButton}
            diagramPanZoom
            onLocalFileLink={onLocalFileLink}
            workspace={workspace}
          />
        ),
        a: ({ node: _node, ...rest }: Record<string, unknown>) => {
          const anchorProps = rest as React.AnchorHTMLAttributes<HTMLAnchorElement>;
          const rawHref = typeof anchorProps.href === 'string' ? anchorProps.href : '';
          const localFileReference = resolveLocalFileLinkReference(rawHref);
          if (localFileReference) {
            return (
              <LocalFileLink reference={localFileReference} onOpen={onLocalFileLink}>
                {anchorProps.children}
              </LocalFileLink>
            );
          }
          if (onLocalFileLink && workspace && resolveWorkspaceRelativeCandidate(rawHref, workspace)) {
            return (
              <WorkspaceRelativeAnchor
                rawHref={rawHref}
                workspace={workspace}
                onOpen={onLocalFileLink}
                anchorProps={anchorProps}
                onAnchorClick={handleLinkClick}
              />
            );
          }
          return (
            <a {...anchorProps} href={anchorProps.href} target='_blank' rel='noreferrer' onClick={handleLinkClick} />
          );
        },
        table: MarkdownTable,
        td: MarkdownTd,
        img: ({ node: _node, ...rest }: Record<string, unknown>) => {
          const imgProps = rest as React.ImgHTMLAttributes<HTMLImageElement>;
          if (isLocalFilePath(imgProps.src || '')) {
            const src = decodeURIComponent(imgProps.src || '');
            return <LocalImageView src={src} alt={imgProps.alt || ''} className={imgProps.className} />;
          }
          return <img {...imgProps} alt={imgProps.alt || ''} />;
        },
      }),
      [codeStyle, hiddenCodeCopyButton, handleLinkClick, onLocalFileLink, workspace]
    );

    const remarkPlugins = useMemo(
      () => (onLocalFileLink ? [...MARKDOWN_REMARK_PLUGINS, remarkBareLocalFilePaths] : MARKDOWN_REMARK_PLUGINS),
      [onLocalFileLink]
    );

    const rehypePlugins = useMemo(() => {
      const base = allowHtml ? [rehypeRaw, rehypeKatex] : DEFAULT_REHYPE_PLUGINS;
      return onLocalFileLink ? [...(base || []), rehypeMarkStandaloneInlineCode] : base;
    }, [allowHtml, onLocalFileLink]);

    return (
      <div className={classNames('relative w-full', className)}>
        <ShadowView>
          <div ref={onRef} className='markdown-shadow-body'>
            <ReactMarkdown
              remarkPlugins={remarkPlugins}
              rehypePlugins={rehypePlugins}
              components={components}
              urlTransform={(url) => (resolveLocalFileLinkPath(url) || isLocalFilePath(url) ? url : defaultUrlTransform(url))}
            >
              {normalizedChildren}
            </ReactMarkdown>
          </div>
        </ShadowView>
      </div>
    );
  }
);

MarkdownView.displayName = 'MarkdownView';

export default MarkdownView;

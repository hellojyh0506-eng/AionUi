import { ipcBridge } from '@/common';
import { joinPath } from '@/common/chat/chatLib';
import { localFileRef } from '@/common/types/chatFile';
import { LoadingTwo } from '@icon-park/react';
import React, { useEffect, useMemo, useState } from 'react';
import { useConversationContextSafe } from '@renderer/hooks/context/ConversationContext';
import { iconColors } from '@/renderer/styles/colors';

const IMAGE_NOT_FOUND_B64_MARKER = 'kltYWdlIG5vdCBmb3VuZD';
const MAX_IMAGE_RETRIES = 4;
const IMAGE_RETRY_DELAY_MS = 500;

const LocalImageView: React.FC<{
  src: string;
  alt: string;
  className?: string;
}> = ({ src, alt, className }) => {
  const [loading, setLoading] = useState(true);
  const [url, setUrl] = useState(src);
  // Resolve relative image paths (e.g. ![](./chart.png)) against the conversation
  // workspace = the agent cwd, and pass it as the fs sandbox workspace. Outside a
  // conversation (settings markdown) there is no workspace, so the src is sent
  // through unchanged — matching the previous default root of ''.
  const root = useConversationContextSafe()?.workspace ?? '';

  const absolutePath = useMemo(() => {
    const trimmed = src.trim();
    if (!trimmed) return '';
    // Markdown/index.tsx strips `file://`, turning `file:///C:/...` into `/C:/...`.
    // Normalize `/C:/...` to `C:/...` before workspace-relative resolution.
    const normalizedSrc = /^\/[A-Za-z]:[\\/]/.test(trimmed) ? trimmed.slice(1) : trimmed;
    if (!root) return normalizedSrc;
    const isWindowsRoot = /^[A-Za-z]:/.test(root);
    if (normalizedSrc.startsWith('/') && !normalizedSrc.startsWith('//') && isWindowsRoot) {
      return joinPath(root, normalizedSrc.replace(/^\/+/, ''));
    }
    if (
      normalizedSrc.startsWith('http') ||
      normalizedSrc.startsWith('data:') ||
      normalizedSrc.startsWith('/') ||
      normalizedSrc.startsWith('file:') ||
      normalizedSrc.startsWith('\\') ||
      /^[A-Za-z]:/.test(normalizedSrc)
    ) {
      return normalizedSrc;
    }
    return joinPath(root, normalizedSrc);
  }, [src, root]);

  useEffect(() => {
    if (!absolutePath) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    let retryCount = 0;
    let retryTimer: ReturnType<typeof setTimeout>;
    setLoading(true);

    const isAbsoluteLocal = /^[A-Za-z]:[\\/]/.test(absolutePath) || absolutePath.startsWith('\\\\') || absolutePath.startsWith('/');

    const fetchViaContentRef = (): Promise<string | null> => {
      const readContent = ipcBridge?.fs?.readContent?.invoke;
      if (!isAbsoluteLocal || !readContent) return Promise.resolve(null);
      return readContent({ file: localFileRef(absolutePath), encoding: 'dataurl' }).catch((): null => null);
    };

    const fetchImage = () => {
      ipcBridge.fs.getImageBase64
        .invoke({ path: absolutePath, workspace: root || undefined })
        .catch(async (error) => {
          const fallback = await fetchViaContentRef();
          if (fallback) return fallback;
          throw error;
        })
        .then(async (base64) => {
          if (cancelled) return;
          if ((!base64 || base64.includes(IMAGE_NOT_FOUND_B64_MARKER)) && isAbsoluteLocal) {
            const fallback = await fetchViaContentRef();
            if (cancelled) return;
            if (fallback) {
              setUrl(fallback);
              setLoading(false);
              return;
            }
          }
          if (base64 && base64.includes(IMAGE_NOT_FOUND_B64_MARKER) && retryCount < MAX_IMAGE_RETRIES) {
            retryCount += 1;
            retryTimer = setTimeout(fetchImage, IMAGE_RETRY_DELAY_MS);
            return;
          }
          if (base64) {
            setUrl(base64);
          }
          setLoading(false);
        })
        .catch((error) => {
          if (cancelled) return;
          console.error('[LocalImageView] Failed to load image:', {
            path: absolutePath,
            workspace: root,
            error,
          });
          setLoading(false);
        });
    };

    fetchImage();
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
    };
  }, [absolutePath, root]);
  if (loading)
    return (
      <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
        <LoadingTwo
          className='loading'
          style={{ display: 'flex' }}
          theme='outline'
          size='14'
          fill={iconColors.primary}
          strokeWidth={2}
        />
        <span>{alt}</span>
      </span>
    );
  return <img src={url} alt={alt} className={className} />;
};

export default LocalImageView;

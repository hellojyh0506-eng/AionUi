import { ipcBridge } from '@/common';
import { joinPath } from '@/common/chat/chatLib';
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
    if (!root) return src;
    const isWindowsRoot = /^[A-Za-z]:/.test(root);
    if (src.startsWith('/') && !src.startsWith('//') && isWindowsRoot) {
      return joinPath(root, src.replace(/^\/+/, ''));
    }
    if (
      src.startsWith('http') ||
      src.startsWith('data:') ||
      src.startsWith('/') ||
      src.startsWith('file:') ||
      src.startsWith('\\') ||
      /^[A-Za-z]:/.test(src)
    ) {
      return src;
    }
    return joinPath(root, src);
  }, [src, root]);

  useEffect(() => {
    let cancelled = false;
    let retryCount = 0;
    let retryTimer: ReturnType<typeof setTimeout>;
    setLoading(true);

    const fetchImage = () => {
      ipcBridge.fs.getImageBase64
        .invoke({ path: absolutePath, workspace: root || undefined })
        .then((base64) => {
          if (cancelled) return;
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

/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import LocalImageView from '@renderer/components/media/LocalImageView';
import LocalFileLink from './LocalFileLink';
import { checkLocalFileExists, resolveWorkspaceFileByCandidate } from './localFileLookup';
import {
  isImageFilePath,
  resolveInlineAbsoluteFileReference,
  resolveWorkspaceRelativeCandidate,
} from './markdownUtils';
import type { LocalFileLinkReference } from './markdownUtils';

type InlineLocalFileCodeProps = {
  text: string;
  standalone?: boolean;
  workspace?: string;
  onOpen: (path: string, reference?: LocalFileLinkReference) => void | Promise<void>;
  className?: string;
  codeProps?: Record<string, unknown>;
};

const InlineLocalFileCode: React.FC<InlineLocalFileCodeProps> = ({
  text,
  standalone = false,
  workspace,
  onOpen,
  className,
  codeProps,
}) => {
  const absRef = useMemo(() => resolveInlineAbsoluteFileReference(text), [text]);
  const hasRelativeCandidate = useMemo(
    () => !absRef && Boolean(workspace) && Boolean(resolveWorkspaceRelativeCandidate(text, workspace)),
    [absRef, text, workspace]
  );

  const [resolvedRelRef, setResolvedRelRef] = useState<LocalFileLinkReference | null>(null);
  const [absImageExists, setAbsImageExists] = useState(false);

  useEffect(() => {
    if (!hasRelativeCandidate || !workspace) {
      setResolvedRelRef(null);
      return;
    }

    let cancelled = false;
    void resolveWorkspaceFileByCandidate(text, workspace).then((match) => {
      if (!cancelled) {
        setResolvedRelRef(match);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [hasRelativeCandidate, text, workspace]);

  const activeRef = absRef ?? resolvedRelRef;
  const shouldCheckAbsImage = Boolean(standalone && absRef && isImageFilePath(absRef.filePath));

  useEffect(() => {
    if (!shouldCheckAbsImage || !absRef) {
      setAbsImageExists(false);
      return;
    }

    let cancelled = false;
    void checkLocalFileExists(absRef.filePath, workspace).then((exists) => {
      if (!cancelled) {
        setAbsImageExists(exists);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [shouldCheckAbsImage, absRef, workspace]);

  if (!activeRef) {
    return (
      <code {...codeProps} className={className} style={{ fontWeight: 'bold' }}>
        {text}
      </code>
    );
  }

  const showInlineImage =
    standalone && isImageFilePath(activeRef.filePath) && (Boolean(resolvedRelRef) || absImageExists);

  if (showInlineImage) {
    const fileName = activeRef.filePath.split(/[\\/]/).pop() || activeRef.filePath;
    return (
      <span className='markdown-inline-image-card'>
        <button
          type='button'
          className='markdown-inline-image-preview'
          aria-label={fileName}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void onOpen(activeRef.filePath, activeRef);
          }}
        >
          <LocalImageView src={activeRef.filePath} alt={fileName} />
        </button>
        <LocalFileLink reference={activeRef} onOpen={onOpen} />
      </span>
    );
  }

  return <LocalFileLink reference={activeRef} onOpen={onOpen} />;
};

export default InlineLocalFileCode;

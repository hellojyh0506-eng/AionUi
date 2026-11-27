/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Link } from 'react-router-dom';
import type { KnowledgeCollection } from '@/common/types/knowledge';

export interface KnowledgeMenuOption {
  id: string; // '__all__' or collection id
  name: string;
  description?: string;
  documentCount: number;
  chunkCount: number;
  isAll?: boolean;
}

interface AtKnowledgeMenuProps {
  items: KnowledgeMenuOption[];
  activeIndex: number;
  loading?: boolean;
  onHoverItem: (index: number) => void;
  onSelectItem: (item: KnowledgeMenuOption) => void;
}

export function buildKnowledgeMenuOptions(
  collections: KnowledgeCollection[],
  filterQuery: string
): KnowledgeMenuOption[] {
  const q = filterQuery.trim().toLowerCase();
  const options: KnowledgeMenuOption[] = collections
    .filter((c) => !q || c.name.toLowerCase().includes(q) || (c.description || '').toLowerCase().includes(q))
    .map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      documentCount: c.documentCount,
      chunkCount: c.chunkCount,
    }));

  if (collections.length > 0 && (!q || '全部all'.includes(q))) {
    options.unshift({
      id: '__all__',
      name: '全部',
      description: `在全部 ${collections.length} 个本地知识库中联合检索`,
      documentCount: collections.reduce((sum, c) => sum + c.documentCount, 0),
      chunkCount: collections.reduce((sum, c) => sum + c.chunkCount, 0),
      isAll: true,
    });
  }
  return options;
}

const AtKnowledgeMenu: React.FC<AtKnowledgeMenuProps> = ({
  items,
  activeIndex,
  loading,
  onHoverItem,
  onSelectItem,
}) => {
  return (
    <div
      className='rd-12px bg-base border border-solid border-[var(--color-border-2)] shadow-lg overflow-hidden select-none'
      role='listbox'
      aria-label='本地知识库引用'
    >
      <div className='px-12px py-6px flex items-center justify-between border-b border-solid border-[var(--color-border-1)] border-x-0 border-t-0 text-11.5px text-t-tertiary'>
        <span>选择要引用的本地知识库（@kb / @知识）</span>
        <Link to='/knowledge' className='text-[rgb(var(--primary-6))] no-underline hover:underline'>
          管理知识库 →
        </Link>
      </div>
      <div className='max-h-220px overflow-y-auto p-4px'>
        {loading ? (
          <div className='py-14px text-center text-12px text-t-tertiary'>正在加载知识库...</div>
        ) : items.length === 0 ? (
          <div className='py-14px px-12px text-center text-12px text-t-tertiary'>
            暂无本地知识库，先点击右上角“管理知识库 →”导入文档目录即可引用。
          </div>
        ) : (
          items.map((item, idx) => {
            const active = idx === activeIndex;
            return (
              <button
                key={item.id}
                type='button'
                onMouseEnter={() => onHoverItem(idx)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelectItem(item);
                }}
                className={`w-full text-left px-10px py-7px rd-8px border-none cursor-pointer flex items-center justify-between gap-10px transition-colors ${
                  active ? 'bg-fill-2 text-t-primary' : 'bg-transparent text-t-secondary hover:bg-fill-1'
                }`}
              >
                <div className='min-w-0 flex-1'>
                  <div className='text-13px font-500 text-t-primary truncate'>
                    {item.isAll ? '全部本地知识库' : item.name}
                  </div>
                  {item.description && <div className='text-11.5px text-t-tertiary truncate'>{item.description}</div>}
                </div>
                <span className='text-11px text-t-tertiary shrink-0'>
                  {item.documentCount} 篇 · {item.chunkCount} 切片
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
};

export default AtKnowledgeMenu;

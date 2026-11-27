/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Tooltip } from '@arco-design/web-react';
import classNames from 'classnames';
import type { SiderTooltipProps } from '@renderer/utils/ui/siderTooltip';

interface SiderMarketplaceEntryProps {
  isMobile: boolean;
  isActive: boolean;
  collapsed: boolean;
  siderTooltipProps: SiderTooltipProps;
  onClick: () => void;
}

const MarketplaceGridIcon = ({ size = 16 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox='0 0 24 24'
    fill='none'
    stroke='currentColor'
    strokeWidth='1.75'
    strokeLinecap='round'
    strokeLinejoin='round'
    className='block leading-none shrink-0'
    style={{ lineHeight: 0 }}
  >
    <rect x='3' y='3' width='8' height='8' rx='1.5' />
    <rect x='13' y='3' width='8' height='8' rx='1.5' />
    <rect x='3' y='13' width='8' height='8' rx='1.5' />
    <path d='M17 13v8' />
    <path d='M13 17h8' />
  </svg>
);

const SiderMarketplaceEntry: React.FC<SiderMarketplaceEntryProps> = ({
  isMobile,
  isActive,
  collapsed,
  siderTooltipProps,
  onClick,
}) => {
  if (collapsed) {
    return (
      <Tooltip {...siderTooltipProps} content='插件市场' position='right'>
        <div
          className={classNames(
            'w-full h-34px flex items-center justify-center cursor-pointer transition-colors rd-8px text-t-primary',
            isActive ? 'bg-fill-3' : 'hover:bg-fill-3 active:bg-fill-4'
          )}
          onClick={onClick}
        >
          <MarketplaceGridIcon size={19} />
        </div>
      </Tooltip>
    );
  }

  return (
    <Tooltip {...siderTooltipProps} content='插件市场' position='right'>
      <div
        className={classNames(
          'box-border group h-34px w-full flex items-center justify-start gap-8px ps-10px pe-8px rd-0.5rem cursor-pointer shrink-0 transition-all text-t-primary',
          isMobile && 'sider-action-btn-mobile',
          isActive ? 'bg-fill-3' : 'hover:bg-fill-3 active:bg-fill-4'
        )}
        onClick={onClick}
      >
        <span className='size-22px flex items-center justify-center shrink-0 text-t-primary'>
          <MarketplaceGridIcon size={16} />
        </span>
        <span className='collapsed-hidden text-t-primary text-14px font-[500] leading-24px'>插件市场</span>
      </div>
    </Tooltip>
  );
};

export default SiderMarketplaceEntry;

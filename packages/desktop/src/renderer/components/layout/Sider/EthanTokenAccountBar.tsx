/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Message, Modal, Popover, Spin, Tooltip } from '@arco-design/web-react';
import { Down, Logout, MoreOne, Peoples, Refresh, User } from '@icon-park/react';
import { mutate } from 'swr';
import { ipcBridge } from '@/common';
import type { EthanTokenAccountState } from '@/common/adapter/ipcBridge';
import type { SiderTooltipProps } from '@renderer/utils/ui/siderTooltip';
import wechatQrImg from '@renderer/assets/ethantoken-wechat-qr.png';

interface EthanTokenAccountBarProps {
  collapsed?: boolean;
  siderTooltipProps: SiderTooltipProps;
}

interface CommunityConfig {
  wechatGroupName: string;
  wechatQrUrl: string;
  wechatVersion?: string;
  qqGroup: string;
  qqJoinUrl: string;
  qqQrUrl?: string;
}

const DEFAULT_COMMUNITY_CONFIG: CommunityConfig = {
  wechatGroupName: '微信交流群 · 羊毛出在AI身上',
  wechatQrUrl: wechatQrImg,
  qqGroup: '1134610506',
  qqJoinUrl: 'https://qm.qq.com/q/Lq38Kn6bMQ',
  qqQrUrl: '',
};

const EthanTokenAccountBar: React.FC<EthanTokenAccountBarProps> = ({ collapsed = false, siderTooltipProps }) => {
  const [account, setAccount] = useState<EthanTokenAccountState>({
    loggedIn: false,
    baseUrl: 'https://ethantoken.top',
  });
  const [loading, setLoading] = useState(false);
  const [authPending, setAuthPending] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [community, setCommunity] = useState<CommunityConfig>(DEFAULT_COMMUNITY_CONFIG);
  const loginSeqRef = useRef(0);
  const panelWrapperRef = useRef<HTMLDivElement | null>(null);

  const syncFrontendCaches = useCallback(async () => {
    await Promise.all([
      mutate('/api/providers'),
      mutate('/api/mcp/servers'),
      mutate('assistants.list'),
      mutate('skills.list'),
    ]);
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const st = await ipcBridge.ethantoken.getStatus.invoke();
      setAccount(st);
      if (st.loggedIn) {
        const fresh = await ipcBridge.ethantoken.refresh.invoke();
        setAccount(fresh);
        await syncFrontendCaches();
      }
    } catch {
      // ignore initial load errors
    }
  }, [syncFrontendCaches]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    const handleOpenCommunity = () => setGroupModalOpen(true);
    window.addEventListener('ethantoken:open-community-modal', handleOpenCommunity);
    return () => window.removeEventListener('ethantoken:open-community-modal', handleOpenCommunity);
  }, []);

  useEffect(() => {
    if (!groupModalOpen) return;
    let cancelled = false;
    fetch(`https://ethantoken.top/site-assets/community.json?t=${Date.now()}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: Partial<CommunityConfig> | null) => {
        if (cancelled || !data) return;
        const ver = data.wechatVersion ? `?v=${encodeURIComponent(data.wechatVersion)}` : `?t=${Date.now()}`;
        const rawWechat = data.wechatQrUrl?.trim();
        setCommunity({
          wechatGroupName: data.wechatGroupName?.trim() || DEFAULT_COMMUNITY_CONFIG.wechatGroupName,
          wechatQrUrl: rawWechat ? `${rawWechat.split('?')[0]}${ver}` : wechatQrImg,
          wechatVersion: data.wechatVersion,
          qqGroup: data.qqGroup?.trim() || DEFAULT_COMMUNITY_CONFIG.qqGroup,
          qqJoinUrl: data.qqJoinUrl?.trim() || DEFAULT_COMMUNITY_CONFIG.qqJoinUrl,
          qqQrUrl: data.qqQrUrl?.trim() ? `${data.qqQrUrl.trim().split('?')[0]}${ver}` : '',
        });
      })
      .catch(() => {
        // Keep bundled fallback when offline
      });
    return () => {
      cancelled = true;
    };
  }, [groupModalOpen]);

  useEffect(() => {
    if (!popoverOpen || collapsed) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (panelWrapperRef.current && !panelWrapperRef.current.contains(event.target as Node)) {
        setPopoverOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPopoverOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [popoverOpen, collapsed]);

  useEffect(() => {
    if (!account.loggedIn) return;
    const timer = setInterval(() => {
      void ipcBridge.ethantoken.refresh.invoke().then((fresh) => {
        setAccount(fresh);
      });
    }, 60000);
    return () => clearInterval(timer);
  }, [account.loggedIn]);

  const handleLogin = async () => {
    const seq = ++loginSeqRef.current;
    const wasLoggedIn = account.loggedIn;
    setPopoverOpen(false);
    setAuthPending(true);
    setLoading(true);
    try {
      const res = await ipcBridge.ethantoken.login.invoke();
      if (loginSeqRef.current !== seq) {
        return;
      }
      if (res.error === '已重新发起浏览器授权') {
        return;
      }
      if (res.error === '已取消登录授权') {
        const { error: _ignored, ...cleanState } = res;
        setAccount((prev) => (wasLoggedIn ? { ...cleanState, error: prev.error } : cleanState));
        Message.info('已取消登录授权');
        return;
      }
      if (res.error) {
        if (wasLoggedIn) {
          const { error: _ignored, ...cleanState } = res;
          setAccount((prev) => ({ ...cleanState, error: prev.error }));
          Message.warning(res.error);
          return;
        }
        setAccount(res);
        Message.error(res.error);
        return;
      }
      setAccount(res);
      if (res.loggedIn) {
        await syncFrontendCaches();
        Message.success(`已登录 ${res.username}，模型与工具已同步`);
      }
    } catch (err) {
      if (loginSeqRef.current === seq) {
        Message.error(err instanceof Error ? err.message : '授权失败');
      }
    } finally {
      if (loginSeqRef.current === seq) {
        setAuthPending(false);
        setLoading(false);
      }
    }
  };

  const handleCancelLogin = async () => {
    loginSeqRef.current += 1;
    setAuthPending(false);
    setLoading(false);
    try {
      const clean = await ipcBridge.ethantoken.cancelLogin.invoke();
      setAccount(clean);
      Message.info('已取消登录授权');
    } catch {
      // ignore cancel error
    }
  };

  const handleSwitchAccount = async (userId: number) => {
    setLoading(true);
    setPopoverOpen(false);
    try {
      const res = await ipcBridge.ethantoken.switchAccount.invoke({ userId });
      setAccount(res);
      if (res.loggedIn && !res.error) {
        await syncFrontendCaches();
        Message.success(`已切换到 ${res.username}`);
      } else if (res.error) {
        Message.warning(res.error);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = async (e?: React.MouseEvent) => {
    e?.stopPropagation();
    setLoading(true);
    try {
      const res = await ipcBridge.ethantoken.refresh.invoke();
      setAccount(res);
      await syncFrontendCaches();
      if (res.error) {
        Message.warning(res.error);
      } else {
        Message.success('已刷新账户余额与模型同步状态');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    setPopoverOpen(false);
    const res = await ipcBridge.ethantoken.logout.invoke();
    setAccount(res);
    Message.info('已退出登录');
  };

  const handleTopup = async () => {
    setPopoverOpen(false);
    await ipcBridge.ethantoken.openWallet.invoke();
  };

  const savedAccounts = account.accounts || [];
  const otherAccounts = savedAccounts.filter((item) => !account.loggedIn || item.userId !== account.userId);
  const avatarInitial = (account.username?.trim().charAt(0) || 'E').toUpperCase();
  const quotaText = `$${(account.quotaUsd ?? 0).toFixed(2)}`;
  const hasAttentionDot = Boolean(account.error) || (account.loggedIn && (account.quotaUsd ?? 0) < 0.05);

  const renderPanelBody = () => (
    <div className='select-none text-t-primary' onClick={(e) => e.stopPropagation()}>
      {account.loggedIn && (
        <>
          {/* 顶部身份头 */}
          <div className='flex items-center justify-between gap-6px px-4px pb-8px'>
            <div className='flex items-center gap-6px min-w-0'>
              <span className='size-22px rounded-full bg-[#18181b] dark:bg-[#f4f4f5] text-[#ffffff] dark:text-[#18181b] text-10.5px font-600 flex items-center justify-center shrink-0'>
                {avatarInitial}
              </span>
              <span className='text-13.5px font-600 text-t-primary truncate'>{account.username}</span>
              <Tooltip
                content={account.group ? `当前登录账户 · 分组：${account.group}` : '当前正在使用的登录账户'}
                position='top'
              >
                <span className='px-6px py-1px rd-999px bg-fill-2 text-10.5px font-500 text-t-secondary shrink-0 cursor-default'>
                  当前账户
                </span>
              </Tooltip>
            </div>

            <Tooltip content='刷新账户余额与同步状态' position='top'>
              <button
                type='button'
                disabled={loading}
                onClick={(e) => void handleRefresh(e)}
                aria-label='刷新账户余额'
                className='size-24px p-0 b-none bg-transparent rd-999px cursor-pointer text-t-tertiary hover:bg-fill-2 hover:text-t-primary flex items-center justify-center transition-colors shrink-0 disabled:opacity-40'
              >
                <Refresh theme='outline' size='13' fill='currentColor' className={loading ? 'animate-spin' : ''} />
              </button>
            </Tooltip>
          </div>

          {/* 同心圆角内嵌额度层（无硬边框，靠微底色层次嵌入） */}
          <div
            className='px-12px py-10px bg-fill-2 flex flex-col gap-6px mb-6px'
            style={{ borderRadius: 13 }}
          >
            <div className='flex items-center justify-between gap-8px'>
              <div className='flex flex-col gap-2px min-w-0'>
                <Tooltip content='站内 API 对话与生图工具通用的实时可用额度' position='top'>
                  <span className='text-11px text-t-secondary leading-none cursor-default'>账户可用额度</span>
                </Tooltip>
                <span className='text-18px font-700 text-t-primary tabular-nums tracking-tight leading-24px'>
                  {quotaText}
                </span>
              </div>

              <button
                type='button'
                onClick={() => void handleTopup()}
                className='h-28px px-12px b-none rd-999px cursor-pointer text-11.5px font-600 shrink-0 transition-opacity bg-[#18181b] hover:opacity-90 text-[#ffffff] dark:bg-[#f4f4f5] dark:text-[#18181b]'
              >
                补充额度
              </button>
            </div>

            {authPending ? (
              <div className='flex items-center justify-between gap-6px pt-6px border-t border-solid border-[var(--color-border-2)] border-x-0 border-b-0 text-11px text-t-secondary'>
                <span>正在浏览器等待授权...</span>
                <span
                  onClick={() => void handleCancelLogin()}
                  className='text-[rgb(var(--primary-6))] cursor-pointer hover:underline shrink-0'
                >
                  取消
                </span>
              </div>
            ) : account.error ? (
              <div className='flex items-center justify-between gap-6px pt-6px border-t border-solid border-[var(--color-border-2)] border-x-0 border-b-0 text-11px text-[rgb(var(--warning-6))]'>
                <span className='truncate'>{account.error}</span>
                <span
                  onClick={() => void handleLogin()}
                  className='shrink-0 font-500 text-[rgb(var(--primary-6))] cursor-pointer hover:underline'
                >
                  重新授权
                </span>
              </div>
            ) : null}
          </div>
        </>
      )}

      {/* 可切换的其他已保存账号 */}
      {otherAccounts.length > 0 && (
        <div className='pb-4px'>
          <div className='px-8px py-3px text-11px text-t-tertiary'>快速切换至</div>
          <div className='flex flex-col gap-2px'>
            {otherAccounts.map((item) => (
              <button
                key={item.userId}
                type='button'
                onClick={() => void handleSwitchAccount(item.userId)}
                className='w-full h-30px px-8px b-none bg-transparent rd-10px hover:bg-fill-2 cursor-pointer flex items-center justify-between gap-8px text-left transition-colors'
              >
                <span className='flex items-center gap-7px min-w-0'>
                  <span className='size-18px rounded-full bg-fill-3 text-t-secondary text-10px font-600 flex items-center justify-center shrink-0'>
                    {(item.username?.trim().charAt(0) || 'E').toUpperCase()}
                  </span>
                  <span className='text-12.5px text-t-primary truncate'>{item.username}</span>
                </span>
                <span className='text-11px text-t-tertiary tabular-nums shrink-0'>${item.quotaUsd.toFixed(2)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 统一动作区 */}
      <div className='flex flex-col gap-2px'>
        <button
          type='button'
          onClick={() => void handleLogin()}
          className='w-full h-32px px-8px b-none bg-transparent rd-10px hover:bg-fill-2 cursor-pointer flex items-center gap-8px text-13px font-500 text-t-primary transition-colors'
        >
          <Refresh theme='outline' size='13.5' fill='currentColor' className='text-t-secondary shrink-0' />
          <span>{account.loggedIn ? '切换或添加账号' : '浏览器登录'}</span>
        </button>

        {account.loggedIn && (
          <>
            <div className='my-3px mx-6px border-t border-solid border-[var(--color-border-2)] border-x-0 border-b-0' />
            <button
              type='button'
              onClick={() => void handleLogout()}
              className='w-full h-32px px-8px b-none bg-transparent rd-10px hover:bg-fill-2 cursor-pointer flex items-center gap-8px text-13px font-500 text-t-secondary hover:text-[rgb(var(--danger-6))] transition-colors'
            >
              <Logout theme='outline' size='13.5' fill='currentColor' className='shrink-0' />
              <span>退出登录</span>
            </button>
          </>
        )}
      </div>
    </div>
  );

  if (collapsed) {
    const accountTip = account.loggedIn
      ? `${account.username} · 可用额度 ${quotaText}`
      : authPending
        ? '点击取消浏览器授权'
        : '登录 EthanToken 账号';
    return (
      <div className='flex flex-col gap-2px mb-2px'>
        {account.loggedIn ? (
          <Popover
            content={<div className='w-216px'>{renderPanelBody()}</div>}
            trigger='click'
            position='tl'
            popupVisible={popoverOpen}
            onVisibleChange={setPopoverOpen}
            triggerProps={{ className: 'ethantoken-account-popover', showArrow: false }}
          >
            <Tooltip {...siderTooltipProps} content={accountTip} position='right'>
              <div className='w-full h-34px flex items-center justify-center rd-0.5rem cursor-pointer transition-colors hover:bg-fill-3 active:bg-fill-4'>
                <span className='size-24px rounded-full bg-[#18181b] dark:bg-[#f4f4f5] text-[#ffffff] dark:text-[#18181b] text-11px font-600 flex items-center justify-center relative'>
                  {avatarInitial}
                  {hasAttentionDot && (
                    <span className='w-6px h-6px rounded-full bg-[rgb(var(--warning-6))] absolute -top-1px -right-1px' />
                  )}
                </span>
              </div>
            </Tooltip>
          </Popover>
        ) : (
          <Tooltip {...siderTooltipProps} content={accountTip} position='right'>
            <div
              onClick={authPending ? handleCancelLogin : handleLogin}
              className='w-full h-34px flex items-center justify-center rd-0.5rem cursor-pointer transition-colors hover:bg-fill-3 active:bg-fill-4'
            >
              {authPending ? (
                <Spin size={14} />
              ) : (
                <User theme='outline' size='16' fill='currentColor' className='text-t-secondary' />
              )}
            </div>
          </Tooltip>
        )}

        <Tooltip {...siderTooltipProps} content='交流群' position='right'>
          <div
            onClick={() => setGroupModalOpen(true)}
            className='w-full h-34px flex items-center justify-center rd-0.5rem cursor-pointer transition-colors hover:bg-fill-3 active:bg-fill-4'
          >
            <Peoples theme='outline' size='16' fill='currentColor' className='text-t-secondary' />
          </div>
        </Tooltip>
      </div>
    );
  }

  return (
    <>
      <div className='flex flex-col gap-2px mb-2px'>
        <div ref={panelWrapperRef} className='relative'>
          {/* 与侧边栏严格同宽内嵌的大圆角浮卡 */}
          {popoverOpen && (account.loggedIn || otherAccounts.length > 0) && (
            <div
              className='absolute left-0 right-0 z-40 p-10px border border-solid border-[var(--color-border-2)]'
              style={{
                bottom: 'calc(100% + 6px)',
                borderRadius: 18,
                backgroundColor: 'var(--color-bg-popup)',
                boxShadow: '0 10px 28px -6px rgba(0, 0, 0, 0.12), 0 2px 8px -2px rgba(0, 0, 0, 0.05)',
              }}
            >
              {renderPanelBody()}
            </div>
          )}

          {!account.loggedIn ? (
            <div className='flex items-center gap-2px'>
              <div
                onClick={authPending ? undefined : handleLogin}
                className='group flex-1 min-w-0 h-34px flex items-center justify-start gap-8px ps-10px pe-8px rd-0.5rem cursor-pointer transition-colors hover:bg-fill-3 active:bg-fill-4'
              >
                <span className='size-22px flex items-center justify-center shrink-0 text-t-secondary'>
                  {authPending ? (
                    <Spin size={14} />
                  ) : (
                    <User theme='outline' size='16' fill='currentColor' className='block leading-none' />
                  )}
                </span>
                <span className='text-t-primary text-14px font-[500] leading-24px truncate'>
                  {authPending ? '等待浏览器授权...' : '登录 EthanToken'}
                </span>
              </div>

              {authPending ? (
                <span
                  onClick={() => void handleCancelLogin()}
                  className='px-8px h-28px flex items-center text-12px text-t-secondary hover:text-t-primary hover:bg-fill-3 rd-0.5rem cursor-pointer shrink-0 transition-colors'
                >
                  取消
                </span>
              ) : otherAccounts.length > 0 ? (
                <Tooltip content='切换已记住账号' position='top'>
                  <span
                    onClick={() => setPopoverOpen((v) => !v)}
                    className='size-28px flex items-center justify-center rd-0.5rem cursor-pointer text-t-secondary hover:bg-fill-3 hover:text-t-primary shrink-0 transition-colors'
                  >
                    <Down theme='outline' size='13' fill='currentColor' />
                  </span>
                </Tooltip>
              ) : null}
            </div>
          ) : (
            <div
              onClick={() => setPopoverOpen((v) => !v)}
              className={`group px-8px py-6px rd-12px cursor-pointer transition-colors flex items-center justify-between gap-8px ${
                popoverOpen ? 'bg-fill-3' : 'hover:bg-fill-3 active:bg-fill-4'
              }`}
            >
              <div className='flex items-center gap-9px min-w-0'>
                <span className='size-26px rounded-full bg-[#18181b] dark:bg-[#f4f4f5] text-[#ffffff] dark:text-[#18181b] text-11.5px font-600 flex items-center justify-center shrink-0 relative'>
                  {avatarInitial}
                  {hasAttentionDot && (
                    <span
                      className='w-7px h-7px rounded-full bg-[rgb(var(--warning-6))] absolute -top-1px -right-1px'
                      style={{ boxShadow: '0 0 0 2px var(--bg-base)' }}
                    />
                  )}
                </span>
                <div className='flex flex-col min-w-0'>
                  <span className='text-t-primary text-13.5px font-600 leading-18px truncate'>
                    {account.username}
                  </span>
                  <span className='text-t-tertiary text-11px leading-15px tabular-nums truncate'>
                    当前账户
                  </span>
                </div>
              </div>
              <span className='size-20px flex items-center justify-center text-t-tertiary opacity-65 group-hover:opacity-100 shrink-0 transition-opacity'>
                {authPending ? <Spin size={12} /> : <MoreOne theme='outline' size='15' fill='currentColor' />}
              </span>
            </div>
          )}
        </div>

        <div
          onClick={() => setGroupModalOpen(true)}
          className='group h-34px flex items-center justify-start gap-8px ps-10px pe-8px rd-0.5rem cursor-pointer transition-colors hover:bg-fill-3 active:bg-fill-4'
        >
          <span className='size-22px flex items-center justify-center shrink-0 text-t-secondary'>
            <Peoples theme='outline' size='16' fill='currentColor' className='block leading-none' />
          </span>
          <span className='text-t-primary text-14px font-[500] leading-24px truncate'>交流群</span>
        </div>
      </div>

      <Modal
        title='加入 EthanToken 交流群'
        visible={groupModalOpen}
        onCancel={() => setGroupModalOpen(false)}
        footer={null}
        style={{ width: 500, maxWidth: '92vw' }}
      >
        <div className='flex flex-col gap-12px text-13px text-t-primary'>
          <div className='px-12px py-8px rd-8px bg-fill-2 text-12px text-t-secondary leading-relaxed'>
            进群交流模型搭配、生图/写代码实战技巧，获取最新稳定通道推荐与大额充值优惠活动。
          </div>

          <div className='grid grid-cols-1 sm:grid-cols-2 gap-12px'>
            <div className='flex flex-col items-center justify-between p-12px rd-10px bg-fill-2 border border-solid border-[var(--color-border-2)] text-center'>
              <div className='text-13px font-600 text-t-primary mb-8px'>{community.wechatGroupName}</div>
              <div className='p-6px rd-8px bg-white shadow-sm'>
                <img
                  src={community.wechatQrUrl}
                  alt='微信交流群二维码'
                  onError={(e) => {
                    if (e.currentTarget.src !== wechatQrImg) {
                      e.currentTarget.src = wechatQrImg;
                    }
                  }}
                  className='w-148px h-148px object-contain block'
                />
              </div>
              <div className='mt-8px text-11px text-t-secondary leading-tight'>
                微信扫一扫加入（若群码过期，请加右侧 QQ 群获取最新码）
              </div>
            </div>

            <div className='flex flex-col justify-between p-12px rd-10px bg-fill-2 border border-solid border-[var(--color-border-2)]'>
              <div className='flex flex-col gap-6px'>
                <div className='text-13px font-600 text-t-primary'>QQ 交流群 / 售后直达</div>
                <div className='text-12px text-t-secondary'>适合反馈问题、领新群码与大额直充联系：</div>
                <div className='mt-4px px-10px py-6px rd-6px bg-fill-3 flex items-center justify-between'>
                  <span className='font-mono font-600 text-13px text-t-primary'>{community.qqGroup}</span>
                  <span
                    onClick={() => {
                      void navigator.clipboard?.writeText(community.qqGroup);
                      Message.success('已复制 QQ 群号');
                    }}
                    className='text-11px text-[rgb(var(--primary-6))] cursor-pointer hover:underline'
                  >
                    复制群号
                  </span>
                </div>
                {community.qqQrUrl ? (
                  <div className='mt-4px flex justify-center'>
                    <div className='p-4px rd-6px bg-white shadow-sm'>
                      <img src={community.qqQrUrl} alt='QQ 群二维码' className='w-92px h-92px object-contain block' />
                    </div>
                  </div>
                ) : null}
              </div>

              <div className='flex flex-col gap-8px mt-12px'>
                <Button
                  type='primary'
                  long
                  onClick={() => void ipcBridge.shell.openExternal.invoke(community.qqJoinUrl)}
                >
                  一键打开 QQ 加群
                </Button>
                <Button long onClick={() => void ipcBridge.shell.openExternal.invoke('https://ethantoken.top/')}>
                  打开 EthanToken 官网
                </Button>
              </div>
            </div>
          </div>
        </div>
      </Modal>
    </>
  );
};

export default EthanTokenAccountBar;

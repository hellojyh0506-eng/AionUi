/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Message, Modal, Popover, Spin, Tooltip } from '@arco-design/web-react';
import { Down, MoreOne, Refresh, User } from '@icon-park/react';
import { mutate } from 'swr';
import { ipcBridge } from '@/common';
import type { EthanTokenAccountState, EthanTokenLedgerData } from '@/common/adapter/ipcBridge';
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

type LedgerRange = 'today' | '7d' | '30d';
type LedgerTab = 'models' | 'logs';

const DEFAULT_COMMUNITY_CONFIG: CommunityConfig = {
  wechatGroupName: '微信用户群',
  wechatQrUrl: wechatQrImg,
  qqGroup: '1134610506',
  qqJoinUrl: 'https://qm.qq.com/q/Lq38Kn6bMQ',
  qqQrUrl: '',
};

const MONO_STYLE: React.CSSProperties = {
  fontFamily: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace',
};

const getHoursLeftToday = (expiredTime?: number): number => {
  if (expiredTime && expiredTime > 0) {
    return Math.max(1, Math.ceil((expiredTime * 1000 - Date.now()) / 3600000));
  }
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
  return Math.max(1, Math.ceil((midnight.getTime() - now.getTime()) / 3600000));
};

const formatTokensCompact = (count: number): string => {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
};

const pad2 = (n: number): string => String(n).padStart(2, '0');

const formatLogTime = (unixSec: number): string => {
  if (!unixSec) return '-';
  const d = new Date(unixSec * 1000);
  const now = new Date();
  const hhmmss = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  if (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  ) {
    return hhmmss;
  }
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hhmmss}`;
};

const formatRmb = (val: number): string => `¥${val.toFixed(val > 0 && val < 0.01 ? 4 : 2)}`;

const ChevronRightIcon = () => (
  <svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.75' strokeLinecap='round' strokeLinejoin='round'>
    <path d='m9 18 6-6-6-6' />
  </svg>
);

const ChartIcon = () => (
  <svg width='15' height='15' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.65' strokeLinecap='round' strokeLinejoin='round'>
    <path d='M3 3v18h18' />
    <path d='M18 17V9' />
    <path d='M13 17V5' />
    <path d='M8 17v-3' />
  </svg>
);

const InviteUserIcon = () => (
  <svg width='15' height='15' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.65' strokeLinecap='round' strokeLinejoin='round'>
    <path d='M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2' />
    <circle cx='9' cy='7' r='4' />
    <line x1='19' y1='8' x2='19' y2='14' />
    <line x1='22' y1='11' x2='16' y2='11' />
  </svg>
);

const SupportIcon = () => (
  <svg width='15' height='15' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.65' strokeLinecap='round' strokeLinejoin='round'>
    <path d='M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' />
  </svg>
);

const SwitchAccountIcon = () => (
  <svg width='15' height='15' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.65' strokeLinecap='round' strokeLinejoin='round'>
    <path d='M16 3h5v5' />
    <path d='M8 21H3v-5' />
    <path d='M21 3 14 10' />
    <path d='M3 21l7-7' />
  </svg>
);

const LogoutIcon = () => (
  <svg width='15' height='15' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.65' strokeLinecap='round' strokeLinejoin='round'>
    <path d='M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4' />
    <polyline points='16 17 21 12 16 7' />
    <line x1='21' y1='12' x2='9' y2='12' />
  </svg>
);

const GiftIcon = () => (
  <svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.75' strokeLinecap='round' strokeLinejoin='round'>
    <rect x='3' y='8' width='18' height='4' rx='1' />
    <path d='M12 8v13' />
    <path d='M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7' />
    <path d='M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5' />
  </svg>
);

const CloseMiniIcon = () => (
  <svg width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round'>
    <path d='M18 6 6 18M6 6l12 12' />
  </svg>
);

const EthanTokenAccountBar: React.FC<EthanTokenAccountBarProps> = ({ collapsed = false, siderTooltipProps }) => {
  const [account, setAccount] = useState<EthanTokenAccountState>({
    loggedIn: false,
    baseUrl: 'https://ethantoken.top',
  });
  const [loading, setLoading] = useState(false);
  const [authPending, setAuthPending] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);

  const [claiming, setClaiming] = useState(false);
  const [justClaimed, setJustClaimed] = useState(false);
  const [bubbleDismissed, setBubbleDismissed] = useState(false);
  const [bubbleHiding, setBubbleHiding] = useState(false);

  const [ledgerModalOpen, setLedgerModalOpen] = useState(false);
  const [ledgerRange, setLedgerRange] = useState<LedgerRange>('30d');
  const [ledgerTab, setLedgerTab] = useState<LedgerTab>('models');
  const [ledgerData, setLedgerData] = useState<EthanTokenLedgerData | null>(null);
  const [ledgerLoading, setLedgerLoading] = useState(false);

  const [inviteModalOpen, setInviteModalOpen] = useState(false);
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [community, setCommunity] = useState<CommunityConfig>(DEFAULT_COMMUNITY_CONFIG);
  const loginSeqRef = useRef(0);

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
    if (!ledgerModalOpen || !account.loggedIn) return;
    let cancelled = false;
    setLedgerLoading(true);
    void ipcBridge.ethantoken.getLedger
      .invoke({ range: ledgerRange })
      .then((res) => {
        if (!cancelled) {
          setLedgerData(res);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLedgerLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [ledgerModalOpen, ledgerRange, account.loggedIn]);

  useEffect(() => {
    if (!groupModalOpen) return;
    let cancelled = false;
    fetch(`https://ethantoken.top/site-assets/community.json?t=${Date.now()}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: Partial<CommunityConfig> | null) => {
        if (cancelled || !data) return;
        const ver = data.wechatVersion ? `?v=${encodeURIComponent(data.wechatVersion)}` : `?t=${Date.now()}`;
        const rawWechat = data.wechatQrUrl?.trim();
        const remoteName = data.wechatGroupName?.trim();
        const sanitizedWechatName =
          remoteName && !remoteName.includes('羊毛') ? remoteName : DEFAULT_COMMUNITY_CONFIG.wechatGroupName;
        setCommunity({
          wechatGroupName: sanitizedWechatName,
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

  const bonus = account.dailyBonus;
  const isBonusActive = Boolean(
    bonus?.claimed && bonus.remainUsd > 0.0005 && (!bonus.expiredTime || bonus.expiredTime * 1000 > Date.now())
  );

  const lastFocusRefreshRef = useRef(0);

  useEffect(() => {
    if (!account.loggedIn) return;
    const timer = setInterval(() => {
      void ipcBridge.ethantoken.refresh.invoke().then((fresh) => {
        setAccount(fresh);
      });
    }, 60000);

    const handleFocus = () => {
      const now = Date.now();
      if (now - lastFocusRefreshRef.current < 10000) return;
      lastFocusRefreshRef.current = now;
      void ipcBridge.ethantoken.refresh.invoke().then((fresh) => {
        setAccount(fresh);
      });
    };
    window.addEventListener('focus', handleFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', handleFocus);
    };
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
      setBubbleDismissed(false);
      setJustClaimed(false);
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
      setBubbleDismissed(false);
      setJustClaimed(false);
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
        Message.success('已刷新账户余额');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    setPopoverOpen(false);
    const res = await ipcBridge.ethantoken.logout.invoke();
    setAccount(res);
    setLedgerData(null);
    Message.info('已退出登录');
  };

  const handleTopup = async () => {
    setPopoverOpen(false);
    await ipcBridge.ethantoken.openWallet.invoke();
  };

  const handleCopyText = (text: string, successText: string) => {
    void navigator.clipboard?.writeText(text);
    Message.success(successText);
  };

  const handleBubbleClaim = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (claiming || justClaimed) return;
    setClaiming(true);
    try {
      const res = await ipcBridge.ethantoken.checkin.invoke();
      setAccount(res);
      if (res.error) {
        Message.error(res.error);
        return;
      }
      await syncFrontendCaches();
      setJustClaimed(true);
      Message.success('已领取 $0.20 今日限时额度（今晚 24:00 过期）');
      setTimeout(() => {
        setBubbleHiding(true);
        setTimeout(() => {
          setBubbleDismissed(true);
          setBubbleHiding(false);
        }, 220);
      }, 950);
    } catch (err) {
      Message.error(err instanceof Error ? err.message : '签到失败');
    } finally {
      setClaiming(false);
    }
  };

  const handleDismissBubble = (e: React.MouseEvent) => {
    e.stopPropagation();
    setBubbleHiding(true);
    setTimeout(() => {
      setBubbleDismissed(true);
      setBubbleHiding(false);
    }, 200);
  };

  const savedAccounts = account.accounts || [];
  const otherAccounts = savedAccounts.filter((item) => !account.loggedIn || item.userId !== account.userId);
  const avatarInitial = (account.username?.trim().charAt(0) || 'E').toUpperCase();
  const permanentQuotaText = `$${(account.quotaUsd ?? 0).toFixed(2)}`;
  const hasAttentionDot = Boolean(account.error) || (account.loggedIn && (account.quotaUsd ?? 0) < 0.05);

  const hoursLeftToday = getHoursLeftToday(bonus?.expiredTime);
  const needsDailyCheckin = Boolean(account.loggedIn && bonus && !bonus.claimed);
  const showCheckinBubble =
    !collapsed && account.loggedIn && !bubbleDismissed && !popoverOpen && !authPending && (needsDailyCheckin || justClaimed);

  const affCode = account.affCode?.trim() || '';
  const inviteUrl = affCode
    ? `${account.baseUrl.replace(/\/$/, '')}/register?aff=${encodeURIComponent(affCode)}`
    : `${account.baseUrl.replace(/\/$/, '')}/register`;

  const ledgerSummary = ledgerData?.summary;
  const ledgerModels = ledgerData?.models || [];
  const ledgerLogs = ledgerData?.logs || [];

  const renderPanelBody = () => (
    <div className='select-none text-t-primary box-border' onClick={(e) => e.stopPropagation()}>
      {account.loggedIn && (
        <>
          <div className='px-10px pt-6px pb-8px'>
            <div className='flex items-center justify-between gap-6px mb-10px'>
              <div className='flex items-center gap-7px min-w-0'>
                <span className='size-24px rounded-full bg-[#111111] dark:bg-[#f5f5f7] text-[#ffffff] dark:text-[#111111] text-10.5px font-600 flex items-center justify-center shrink-0'>
                  {avatarInitial}
                </span>
                <span className='text-13.5px font-600 text-t-primary truncate'>{account.username}</span>
                {account.group && (
                  <span className='px-6px py-1px rd-999px text-10px font-500 text-t-secondary border border-solid border-[var(--color-border-2)] shrink-0'>
                    {account.group}
                  </span>
                )}
              </div>

              <Tooltip content='刷新额度' position='top'>
                <button
                  type='button'
                  disabled={loading}
                  onClick={(e) => void handleRefresh(e)}
                  aria-label='刷新额度'
                  className='size-24px p-0 b-none bg-transparent rd-999px cursor-pointer text-t-tertiary hover:bg-fill-2 hover:text-t-primary flex items-center justify-center transition-colors shrink-0 disabled:opacity-40'
                >
                  <Refresh theme='outline' size='13' fill='currentColor' className={loading ? 'animate-spin' : ''} />
                </button>
              </Tooltip>
            </div>

            <div className='flex items-center justify-between gap-8px'>
              <div className='flex flex-col gap-1px min-w-0'>
                <span className='text-11px text-t-tertiary leading-14px'>可用余额</span>
                <span className='text-20px font-600 text-t-primary tabular-nums tracking-tight leading-24px'>
                  {permanentQuotaText}
                </span>
              </div>
              <button
                type='button'
                onClick={() => void handleTopup()}
                className='h-28px px-14px b-none rd-999px cursor-pointer text-12px font-600 shrink-0 transition-opacity bg-[#111111] hover:opacity-85 text-[#ffffff] dark:bg-[#f5f5f7] dark:text-[#111111]'
              >
                充值
              </button>
            </div>

            {isBonusActive && bonus && (
              <div className='mt-10px px-10px py-7px rd-10px bg-[#15803d]/[0.07] dark:bg-[#34d399]/[0.10] flex items-center justify-between gap-6px'>
                <span className='flex items-center gap-5px text-11.5px font-600 text-[#15803d] dark:text-[#34d399] tabular-nums'>
                  <span className='size-5px rounded-full bg-current inline-block shrink-0' />
                  <span>含今日限时 ${bonus.remainUsd.toFixed(2)}</span>
                </span>
                <span className='text-11px text-t-secondary whitespace-nowrap'>剩 {hoursLeftToday}h 过期</span>
              </div>
            )}
          </div>

          {authPending ? (
            <div className='flex items-center justify-between gap-6px px-10px pb-6px text-11px text-t-secondary'>
              <span>等待浏览器授权...</span>
              <span onClick={() => void handleCancelLogin()} className='text-[rgb(var(--primary-6))] cursor-pointer hover:underline'>
                取消
              </span>
            </div>
          ) : account.error ? (
            <div className='flex items-center justify-between gap-6px px-10px pb-6px text-11px text-[rgb(var(--warning-6))]'>
              <span className='truncate'>{account.error}</span>
              <span onClick={() => void handleLogin()} className='shrink-0 font-500 text-[rgb(var(--primary-6))] cursor-pointer hover:underline'>
                重新授权
              </span>
            </div>
          ) : null}

          <div className='my-3px mx-6px border-t border-solid border-[var(--color-border-2)] border-x-0 border-b-0' />
        </>
      )}

      <div className='flex flex-col'>
        {account.loggedIn && (
          <>
            <button
              type='button'
              onClick={() => {
                setPopoverOpen(false);
                setLedgerModalOpen(true);
              }}
              className='box-border w-full h-36px px-10px b-none bg-transparent rd-10px hover:bg-fill-2 cursor-pointer flex items-center justify-between text-13.5px font-400 text-t-primary transition-colors'
            >
              <span className='flex items-center gap-10px'>
                <span className='text-t-secondary flex items-center'>
                  <ChartIcon />
                </span>
                <span>用量与账单</span>
              </span>
              <span className='text-t-tertiary flex items-center'>
                <ChevronRightIcon />
              </span>
            </button>

            <button
              type='button'
              onClick={() => {
                setPopoverOpen(false);
                setInviteModalOpen(true);
              }}
              className='box-border w-full h-36px px-10px b-none bg-transparent rd-10px hover:bg-fill-2 cursor-pointer flex items-center justify-between text-13.5px font-400 text-t-primary transition-colors'
            >
              <span className='flex items-center gap-10px'>
                <span className='text-t-secondary flex items-center'>
                  <InviteUserIcon />
                </span>
                <span>邀请好友</span>
              </span>
              <span className='text-t-tertiary flex items-center'>
                <ChevronRightIcon />
              </span>
            </button>
          </>
        )}

        <button
          type='button'
          onClick={() => {
            setPopoverOpen(false);
            setGroupModalOpen(true);
          }}
          className='box-border w-full h-36px px-10px b-none bg-transparent rd-10px hover:bg-fill-2 cursor-pointer flex items-center justify-between text-13.5px font-400 text-t-primary transition-colors'
        >
          <span className='flex items-center gap-10px'>
            <span className='text-t-secondary flex items-center'>
              <SupportIcon />
            </span>
            <span>交流群与支持</span>
          </span>
          <span className='text-t-tertiary flex items-center'>
            <ChevronRightIcon />
          </span>
        </button>
      </div>

      {otherAccounts.length > 0 && (
        <>
          <div className='my-3px mx-6px border-t border-solid border-[var(--color-border-2)] border-x-0 border-b-0' />
          <div className='flex flex-col'>
            {otherAccounts.map((item) => (
              <button
                key={item.userId}
                type='button'
                onClick={() => void handleSwitchAccount(item.userId)}
                className='box-border w-full h-34px px-10px b-none bg-transparent rd-10px hover:bg-fill-2 cursor-pointer flex items-center justify-between gap-8px text-left transition-colors'
              >
                <span className='flex items-center gap-8px min-w-0'>
                  <span className='size-18px rounded-full bg-fill-3 text-t-secondary text-10px font-600 flex items-center justify-center shrink-0'>
                    {(item.username?.trim().charAt(0) || 'E').toUpperCase()}
                  </span>
                  <span className='text-13px text-t-primary truncate'>{item.username}</span>
                </span>
                <span className='text-11.5px text-t-tertiary tabular-nums shrink-0'>${item.quotaUsd.toFixed(2)}</span>
              </button>
            ))}
          </div>
        </>
      )}

      <div className='my-3px mx-6px border-t border-solid border-[var(--color-border-2)] border-x-0 border-b-0' />

      <div className='flex flex-col'>
        <button
          type='button'
          onClick={() => void handleLogin()}
          className='box-border w-full h-36px px-10px b-none bg-transparent rd-10px hover:bg-fill-2 cursor-pointer flex items-center gap-10px text-13.5px font-400 text-t-primary transition-colors'
        >
          <span className='text-t-secondary flex items-center'>
            <SwitchAccountIcon />
          </span>
          <span>{account.loggedIn ? '切换或添加账号' : '浏览器登录'}</span>
        </button>

        {account.loggedIn && (
          <button
            type='button'
            onClick={() => void handleLogout()}
            className='box-border w-full h-36px px-10px b-none bg-transparent rd-10px hover:bg-fill-2 cursor-pointer flex items-center gap-10px text-13.5px font-400 text-t-primary transition-colors'
          >
            <span className='text-t-secondary flex items-center'>
              <LogoutIcon />
            </span>
            <span>退出登录</span>
          </button>
        )}
      </div>
    </div>
  );

  const renderModals = () => (
    <>
      <Modal
        title={null}
        visible={ledgerModalOpen}
        onCancel={() => setLedgerModalOpen(false)}
        footer={null}
        style={{ width: 680, maxWidth: '94vw', borderRadius: 18 }}
      >
        <div className='p-6px text-t-primary select-none'>
          <div className='flex items-center justify-between gap-12px mb-16px flex-wrap'>
            <h3 className='m-0 text-17px font-600 text-t-primary'>用量与账单</h3>
            <div className='inline-flex p-2px rd-999px bg-fill-2 border border-solid border-[var(--color-border-2)]'>
              {(['today', '7d', '30d'] as LedgerRange[]).map((r) => (
                <button
                  key={r}
                  type='button'
                  onClick={() => setLedgerRange(r)}
                  className={`px-11px py-4px b-none rd-999px text-12px font-500 cursor-pointer transition-colors ${
                    ledgerRange === r
                      ? 'bg-[var(--color-bg-popup)] text-t-primary shadow-sm'
                      : 'bg-transparent text-t-secondary hover:text-t-primary'
                  }`}
                >
                  {r === 'today' ? '今日' : r === '7d' ? '近 7 天' : '近 30 天'}
                </button>
              ))}
            </div>
          </div>

          <div className='grid grid-cols-1 sm:grid-cols-3 border-y border-solid border-[var(--color-border-2)] border-x-0 mb-16px'>
            <div className='py-12px sm:pr-14px'>
              <div className='text-12px text-t-secondary mb-4px'>实际消费</div>
              <div className='text-22px font-600 tabular-nums text-t-primary'>
                {formatRmb(ledgerSummary?.paid_rmb ?? 0)}
              </div>
              <div className='mt-3px text-11.5px text-t-tertiary tabular-nums'>
                {ledgerSummary?.calls ?? 0} 次调用 ·{' '}
                {formatTokensCompact((ledgerSummary?.prompt_tokens ?? 0) + (ledgerSummary?.completion_tokens ?? 0))} Tokens
              </div>
            </div>
            <div className='py-12px sm:px-16px sm:border-l sm:border-y-0 sm:border-r-0 sm:border-solid sm:border-[var(--color-border-2)]'>
              <div className='text-12px text-t-secondary mb-4px'>官方原价</div>
              <div className='text-22px font-600 tabular-nums text-t-secondary'>
                {formatRmb(ledgerSummary?.official_rmb ?? 0)}
              </div>
              <div className='mt-3px text-11.5px text-t-tertiary'>官方公开价</div>
            </div>
            <div className='py-12px sm:pl-16px sm:border-l sm:border-y-0 sm:border-r-0 sm:border-solid sm:border-[var(--color-border-2)]'>
              <div className='text-12px text-t-secondary mb-4px'>已节省</div>
              <div className='text-22px font-600 tabular-nums text-[#15803d] dark:text-[#34d399]'>
                {formatRmb(ledgerSummary?.saved_rmb ?? 0)}
              </div>
              <div className='mt-3px text-11.5px text-t-tertiary tabular-nums'>
                节省 {(ledgerSummary?.save_pct ?? 0).toFixed(1)}%
              </div>
            </div>
          </div>

          <div className='flex items-center gap-18px border-b border-solid border-[var(--color-border-2)] border-x-0 border-t-0 mb-10px'>
            <button
              type='button'
              onClick={() => setLedgerTab('models')}
              className={`py-8px px-2px b-none bg-transparent text-13px cursor-pointer border-b-2 border-solid ${
                ledgerTab === 'models'
                  ? 'border-t-0 border-x-0 border-[var(--color-text-1)] font-600 text-t-primary'
                  : 'border-transparent font-500 text-t-secondary hover:text-t-primary'
              }`}
            >
              按模型统计
            </button>
            <button
              type='button'
              onClick={() => setLedgerTab('logs')}
              className={`py-8px px-2px b-none bg-transparent text-13px cursor-pointer border-b-2 border-solid ${
                ledgerTab === 'logs'
                  ? 'border-t-0 border-x-0 border-[var(--color-text-1)] font-600 text-t-primary'
                  : 'border-transparent font-500 text-t-secondary hover:text-t-primary'
              }`}
            >
              调用明细
            </button>
          </div>

          {ledgerLoading ? (
            <div className='py-36px flex items-center justify-center'>
              <Spin size={22} />
            </div>
          ) : ledgerData?.error ? (
            <div className='py-28px text-center text-13px text-t-secondary'>{ledgerData.error}</div>
          ) : ledgerTab === 'models' ? (
            ledgerModels.length === 0 ? (
              <div className='py-28px text-center text-13px text-t-tertiary'>当前时间范围内暂无调用记录</div>
            ) : (
              <div className='max-h-290px overflow-y-auto'>
                <table className='w-full border-collapse text-12.5px tabular-nums'>
                  <thead>
                    <tr className='border-b border-solid border-[var(--color-border-2)] border-x-0 border-t-0 text-11.5px text-t-tertiary'>
                      <th className='text-left font-500 py-8px px-6px'>模型</th>
                      <th className='text-right font-500 py-8px px-6px'>调用</th>
                      <th className='text-left font-500 py-8px px-6px'>Token（输入 / 输出 / 缓存）</th>
                      <th className='text-right font-500 py-8px px-6px'>实付</th>
                      <th className='text-right font-500 py-8px px-6px'>官方原价</th>
                      <th className='text-right font-500 py-8px px-6px'>节省</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledgerModels.map((row) => (
                      <tr
                        key={row.model}
                        className='border-b border-solid border-[var(--color-border-2)] border-x-0 border-t-0 last:border-b-0'
                      >
                        <td className='py-9px px-6px font-500' style={MONO_STYLE}>
                          {row.model}
                        </td>
                        <td className='py-9px px-6px text-right'>{row.calls}</td>
                        <td className='py-9px px-6px text-11.5px text-t-secondary'>
                          {row.prompt_tokens === 0 && row.completion_tokens === 0
                            ? `${row.calls} 次媒体生成`
                            : `${formatTokensCompact(row.prompt_tokens)} / ${formatTokensCompact(row.completion_tokens)} / ${formatTokensCompact(row.cache_tokens)}`}
                        </td>
                        <td className='py-9px px-6px text-right'>{formatRmb(row.paid_rmb)}</td>
                        <td className='py-9px px-6px text-right text-t-tertiary'>{formatRmb(row.official_rmb)}</td>
                        <td className='py-9px px-6px text-right font-600 text-[#15803d] dark:text-[#34d399]'>
                          {formatRmb(row.saved_rmb)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : ledgerLogs.length === 0 ? (
            <div className='py-28px text-center text-13px text-t-tertiary'>当前时间范围内暂无调用明细</div>
          ) : (
            <div className='max-h-290px overflow-y-auto'>
              <table className='w-full border-collapse text-12.5px tabular-nums'>
                <thead>
                  <tr className='border-b border-solid border-[var(--color-border-2)] border-x-0 border-t-0 text-11.5px text-t-tertiary'>
                    <th className='text-left font-500 py-8px px-6px'>时间</th>
                    <th className='text-left font-500 py-8px px-6px'>模型</th>
                    <th className='text-left font-500 py-8px px-6px'>Token 用量</th>
                    <th className='text-right font-500 py-8px px-6px'>实付</th>
                    <th className='text-right font-500 py-8px px-6px'>官方原价</th>
                  </tr>
                </thead>
                <tbody>
                  {ledgerLogs.map((row) => (
                    <tr
                      key={row.id}
                      className='border-b border-solid border-[var(--color-border-2)] border-x-0 border-t-0 last:border-b-0'
                    >
                      <td className='py-9px px-6px text-t-tertiary whitespace-nowrap'>{formatLogTime(row.created_at)}</td>
                      <td className='py-9px px-6px font-500' style={MONO_STYLE}>
                        <span>{row.model}</span>
                        {row.is_bonus && (
                          <span className='ml-6px px-5px py-1px rd-4px text-10px bg-[#15803d]/10 text-[#15803d] dark:bg-[#34d399]/15 dark:text-[#34d399]'>
                            签到抵扣
                          </span>
                        )}
                      </td>
                      <td className='py-9px px-6px text-11.5px text-t-secondary'>
                        {row.prompt_tokens === 0 && row.completion_tokens === 0
                          ? '媒体生成'
                          : `输入 ${formatTokensCompact(row.prompt_tokens)} · 缓存 ${formatTokensCompact(row.cache_tokens)} · 输出 ${formatTokensCompact(row.completion_tokens)}`}
                      </td>
                      <td className='py-9px px-6px text-right'>{formatRmb(row.paid_rmb)}</td>
                      <td className='py-9px px-6px text-right text-t-tertiary'>{formatRmb(row.official_rmb)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Modal>

      <Modal
        title={null}
        visible={inviteModalOpen}
        onCancel={() => setInviteModalOpen(false)}
        footer={null}
        style={{ width: 450, maxWidth: '94vw', borderRadius: 18 }}
      >
        <div className='p-6px text-t-primary select-none'>
          <h3 className='m-0 mb-6px text-17px font-600 text-t-primary'>邀请好友</h3>
          <p className='m-0 text-13px leading-relaxed text-t-secondary'>分享链接给好友注册。</p>

          <div className='my-16px p-6px pl-12px rd-11px bg-fill-2 border border-solid border-[var(--color-border-2)] flex items-center gap-8px'>
            <span className='flex-1 min-w-0 text-12px text-t-secondary truncate' style={MONO_STYLE}>
              {inviteUrl}
            </span>
            <button
              type='button'
              onClick={() => handleCopyText(inviteUrl, '已复制邀请链接')}
              className='h-28px px-12px b-none rd-999px text-11.5px font-600 shrink-0 cursor-pointer transition-opacity bg-[#111111] hover:opacity-85 text-[#ffffff] dark:bg-[#f5f5f7] dark:text-[#111111]'
            >
              复制链接
            </button>
          </div>

          <div className='pt-12px border-t border-solid border-[var(--color-border-2)] border-x-0 border-b-0 flex items-center justify-between text-12px text-t-tertiary'>
            <span>
              邀请码{' '}
              <strong className='text-t-primary font-600' style={MONO_STYLE}>
                {affCode || '读取中'}
              </strong>
            </span>
            <span>
              已邀请 {account.affCount ?? 0} 人 · 累计返利 ${(account.affHistoryUsd ?? 0).toFixed(2)}
            </span>
          </div>
        </div>
      </Modal>

      <Modal
        title={null}
        visible={groupModalOpen}
        onCancel={() => setGroupModalOpen(false)}
        footer={null}
        style={{ width: 480, maxWidth: '94vw', borderRadius: 18 }}
      >
        <div className='p-6px text-t-primary select-none'>
          <h3 className='m-0 mb-6px text-17px font-600 text-t-primary'>交流群与支持</h3>
          <p className='m-0 mb-16px text-13px leading-relaxed text-t-secondary'>
            问题排查、版本更新通知与日常模型使用交流。
          </p>

          <div className='grid grid-cols-1 sm:grid-cols-[170px_1fr] gap-18px items-center'>
            <div className='text-center'>
              <div className='p-8px rd-12px bg-white border border-solid border-[var(--color-border-2)] inline-block'>
                <img
                  src={community.wechatQrUrl}
                  alt='微信用户群二维码'
                  onError={(e) => {
                    if (e.currentTarget.src !== wechatQrImg) {
                      e.currentTarget.src = wechatQrImg;
                    }
                  }}
                  className='w-132px h-132px object-contain block'
                />
              </div>
              <div className='mt-8px text-12px font-500 text-t-primary'>{community.wechatGroupName}</div>
            </div>

            <div className='sm:border-l sm:border-y-0 sm:border-r-0 sm:border-solid sm:border-[var(--color-border-2)] sm:pl-18px'>
              <div className='text-13px font-600 text-t-primary'>QQ 交流群</div>
              <div className='my-10px px-10px py-8px rd-10px bg-fill-2 border border-solid border-[var(--color-border-2)] flex items-center justify-between gap-8px'>
                <span className='font-600 text-13px text-t-primary' style={MONO_STYLE}>
                  {community.qqGroup}
                </span>
                <button
                  type='button'
                  onClick={() => handleCopyText(community.qqGroup, '已复制 QQ 群号')}
                  className='px-9px py-3px rd-999px bg-[var(--color-bg-popup)] border border-solid border-[var(--color-border-3)] text-11px font-500 text-t-primary hover:bg-fill-3 cursor-pointer transition-colors'
                >
                  复制
                </button>
              </div>
              <div className='flex items-center gap-8px'>
                <button
                  type='button'
                  onClick={() => void ipcBridge.shell.openExternal.invoke(community.qqJoinUrl)}
                  className='flex-1 h-32px b-none rd-999px text-12px font-600 cursor-pointer transition-opacity bg-[#111111] hover:opacity-85 text-[#ffffff] dark:bg-[#f5f5f7] dark:text-[#111111]'
                >
                  打开 QQ 加群
                </button>
                <button
                  type='button'
                  onClick={() => void ipcBridge.shell.openExternal.invoke('https://ethantoken.top/')}
                  className='h-32px px-12px rd-999px bg-transparent border border-solid border-[var(--color-border-3)] text-12px font-500 text-t-primary hover:bg-fill-3 cursor-pointer transition-colors'
                >
                  官网
                </button>
              </div>
            </div>
          </div>
        </div>
      </Modal>
    </>
  );

  if (collapsed) {
    const accountTip = account.loggedIn
      ? `${account.username} · 永久 ${permanentQuotaText}${isBonusActive && bonus ? ` + 限时 $${bonus.remainUsd.toFixed(2)}` : ''}`
      : authPending
        ? '点击取消浏览器授权'
        : '登录 EthanToken 账号';
    return (
      <>
        <div className='flex flex-col gap-2px mb-2px'>
          {account.loggedIn ? (
            <Popover
              content={<div className='w-230px box-border'>{renderPanelBody()}</div>}
              trigger='click'
              position='tl'
              popupVisible={popoverOpen}
              onVisibleChange={setPopoverOpen}
              getPopupContainer={() => document.body}
              triggerProps={{ className: 'ethantoken-account-popover', showArrow: false, popupAlign: { top: 8 } }}
            >
              <Tooltip {...siderTooltipProps} content={accountTip} position='right'>
                <div className='w-full h-34px flex items-center justify-center rd-0.5rem cursor-pointer transition-colors hover:bg-fill-3 active:bg-fill-4'>
                  <span className='size-24px rounded-full bg-[#111111] dark:bg-[#f5f5f7] text-[#ffffff] dark:text-[#111111] text-11px font-600 flex items-center justify-center relative'>
                    {avatarInitial}
                    {(hasAttentionDot || needsDailyCheckin) && (
                      <span
                        className={`w-6px h-6px rounded-full absolute -top-1px -right-1px ${
                          hasAttentionDot ? 'bg-[rgb(var(--warning-6))]' : 'bg-[#15803d] dark:bg-[#34d399]'
                        }`}
                      />
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
        </div>
        {renderModals()}
      </>
    );
  }

  return (
    <>
      <div className='flex flex-col gap-2px mb-2px'>
        <div className='relative'>
          {showCheckinBubble && (
            <div
              onClick={(e) => e.stopPropagation()}
              className={`box-border absolute z-25 px-12px py-10px border border-solid border-[var(--color-border-2)] flex flex-col gap-8px transition-all duration-200 ${
                bubbleHiding ? 'opacity-0 translate-y-4px scale-95 pointer-events-none' : 'opacity-100 translate-y-0 scale-100'
              }`}
              style={{
                left: 0,
                width: '100%',
                maxWidth: 244,
                boxSizing: 'border-box',
                bottom: 'calc(100% + 10px)',
                borderRadius: 14,
                backgroundColor: 'var(--color-bg-popup)',
                boxShadow: '0 8px 24px -4px rgba(0, 0, 0, 0.09), 0 2px 6px rgba(0, 0, 0, 0.04)',
              }}
            >
              <div className='flex items-center justify-between gap-6px'>
                <span className='flex items-center gap-6px min-w-0'>
                  <span className='text-t-secondary flex items-center shrink-0'>
                    <GiftIcon />
                  </span>
                  <span className='text-12.5px font-600 text-t-primary whitespace-nowrap'>
                    {justClaimed ? '今日已签到' : '每日签到'}
                  </span>
                  <span className='text-11px text-t-tertiary whitespace-nowrap'>当日有效</span>
                </span>
                <button
                  type='button'
                  aria-label='稍后再说'
                  onClick={handleDismissBubble}
                  className='size-20px p-0 b-none bg-transparent rd-999px text-t-tertiary hover:bg-fill-2 hover:text-t-primary flex items-center justify-center cursor-pointer shrink-0 transition-colors'
                >
                  <CloseMiniIcon />
                </button>
              </div>

              <div className='flex items-center justify-between gap-8px'>
                <span className='text-12.5px font-600 text-t-primary tabular-nums whitespace-nowrap'>
                  {justClaimed ? '已领 +$0.20' : '今日可领 $0.20'}
                </span>
                <button
                  type='button'
                  disabled={claiming || justClaimed}
                  onClick={(e) => void handleBubbleClaim(e)}
                  className={
                    justClaimed
                      ? 'h-26px px-11px b-none rd-999px text-11.5px font-600 shrink-0 cursor-default bg-fill-2 text-[#15803d] dark:text-[#34d399]'
                      : 'h-26px px-12px b-none rd-999px text-11.5px font-600 shrink-0 cursor-pointer transition-opacity bg-[#111111] hover:opacity-85 text-[#ffffff] dark:bg-[#f5f5f7] dark:text-[#111111] disabled:opacity-50'
                  }
                >
                  {claiming ? '领取中' : justClaimed ? '+$0.20 ✓' : '签到'}
                </button>
              </div>
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
              ) : (
                <Popover
                  content={<div className='w-230px box-border'>{renderPanelBody()}</div>}
                  trigger='click'
                  position='tl'
                  popupVisible={popoverOpen}
                  onVisibleChange={setPopoverOpen}
                  getPopupContainer={() => document.body}
                  triggerProps={{ className: 'ethantoken-account-popover', showArrow: false, popupAlign: { top: 8 } }}
                >
                  <Tooltip content='账户与支持' position='top'>
                    <span className='size-28px flex items-center justify-center rd-0.5rem cursor-pointer text-t-secondary hover:bg-fill-3 hover:text-t-primary shrink-0 transition-colors'>
                      <Down theme='outline' size='13' fill='currentColor' />
                    </span>
                  </Tooltip>
                </Popover>
              )}
            </div>
          ) : (
            <Popover
              content={<div className='w-230px box-border'>{renderPanelBody()}</div>}
              trigger='click'
              position='tl'
              popupVisible={popoverOpen}
              onVisibleChange={setPopoverOpen}
              getPopupContainer={() => document.body}
              triggerProps={{ className: 'ethantoken-account-popover', showArrow: false, popupAlign: { top: 8 } }}
            >
              <div
                className={`group px-8px py-7px rd-10px cursor-pointer transition-colors flex items-center justify-between gap-8px ${
                  popoverOpen ? 'bg-fill-3' : 'hover:bg-fill-3 active:bg-fill-4'
                }`}
              >
                <div className='flex items-center gap-9px min-w-0'>
                  <span className='size-26px rounded-full bg-[#111111] dark:bg-[#f5f5f7] text-[#ffffff] dark:text-[#111111] text-11px font-600 flex items-center justify-center shrink-0 relative'>
                    {avatarInitial}
                    {(hasAttentionDot || needsDailyCheckin) && (
                      <span
                        className={`w-7px h-7px rounded-full absolute -top-1px -right-1px ${
                          hasAttentionDot ? 'bg-[rgb(var(--warning-6))]' : 'bg-[#15803d] dark:bg-[#34d399]'
                        }`}
                        style={{ boxShadow: '0 0 0 2px var(--bg-base)' }}
                      />
                    )}
                  </span>
                  <div className='flex flex-col min-w-0'>
                    <span className='text-t-primary text-13.5px font-500 leading-17px truncate'>
                      {account.username}
                    </span>
                    <span className='text-t-tertiary text-11px leading-15px tabular-nums truncate'>
                      {permanentQuotaText}
                      {isBonusActive && bonus && (
                        <span className='text-[#15803d] dark:text-[#34d399]'> · 含限时 ${bonus.remainUsd.toFixed(2)}</span>
                      )}
                    </span>
                  </div>
                </div>
                <span className='size-20px flex items-center justify-center text-t-tertiary opacity-65 group-hover:opacity-100 shrink-0 transition-opacity'>
                  {authPending ? <Spin size={12} /> : <MoreOne theme='outline' size='15' fill='currentColor' />}
                </span>
              </div>
            </Popover>
          )}
        </div>
      </div>

      {renderModals()}
    </>
  );
};

export default EthanTokenAccountBar;

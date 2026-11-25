/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Button, Dropdown, Menu, Message, Modal, Tooltip } from '@arco-design/web-react';
import { Down, Logout, Refresh, User, Wallet } from '@icon-park/react';
import { mutate } from 'swr';
import { ipcBridge } from '@/common';
import type { EthanTokenAccountState } from '@/common/adapter/ipcBridge';
import type { SiderTooltipProps } from '@renderer/utils/ui/siderTooltip';
import wechatQrImg from '@renderer/assets/ethantoken-wechat-qr.png';

interface EthanTokenAccountBarProps {
  collapsed?: boolean;
  siderTooltipProps: SiderTooltipProps;
}

const EthanTokenAccountBar: React.FC<EthanTokenAccountBarProps> = ({ collapsed = false, siderTooltipProps }) => {
  const [account, setAccount] = useState<EthanTokenAccountState>({
    loggedIn: false,
    baseUrl: 'https://ethantoken.top',
  });
  const [loading, setLoading] = useState(false);
  const [groupModalOpen, setGroupModalOpen] = useState(false);

  const syncFrontendCaches = useCallback(async () => {
    await Promise.all([mutate('/api/providers'), mutate('/api/mcp/servers')]);
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
    if (!account.loggedIn) return;
    const timer = setInterval(() => {
      void ipcBridge.ethantoken.refresh.invoke().then((fresh) => {
        setAccount(fresh);
      });
    }, 60000);
    return () => clearInterval(timer);
  }, [account.loggedIn]);

  const handleLogin = async () => {
    setLoading(true);
    try {
      const res = await ipcBridge.ethantoken.login.invoke();
      setAccount(res);
      if (res.loggedIn && !res.error) {
        await syncFrontendCaches();
        Message.success(`已授权登录 ${res.username}，模型与生图工具已自动同步`);
      } else if (res.error) {
        Message.error(res.error);
      }
    } catch (err) {
      Message.error(err instanceof Error ? err.message : '授权失败');
    } finally {
      setLoading(false);
    }
  };

  const handleSwitchAccount = async (userId: number) => {
    setLoading(true);
    try {
      const res = await ipcBridge.ethantoken.switchAccount.invoke({ userId });
      setAccount(res);
      if (res.loggedIn && !res.error) {
        await syncFrontendCaches();
        Message.success(`已切换到账号 ${res.username}`);
      } else if (res.error) {
        Message.warning(res.error);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = async () => {
    setLoading(true);
    try {
      const res = await ipcBridge.ethantoken.refresh.invoke();
      setAccount(res);
      await syncFrontendCaches();
      if (res.error) {
        Message.warning(res.error);
      } else {
        Message.success('余额已刷新');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    const res = await ipcBridge.ethantoken.logout.invoke();
    setAccount(res);
    Message.info('已退出当前 EthanToken 账号');
  };

  const handleTopup = async () => {
    await ipcBridge.ethantoken.openWallet.invoke();
  };

  const savedAccounts = account.accounts || [];

  const switchMenu = (
    <Menu
      onClickMenuItem={(key) => {
        if (key === '__add__') {
          void handleLogin();
        } else {
          const uid = Number(key);
          if (!Number.isNaN(uid) && uid !== account.userId) {
            void handleSwitchAccount(uid);
          }
        }
      }}
    >
      {savedAccounts.map((item) => (
        <Menu.Item key={String(item.userId)}>
          <div className='flex items-center justify-between gap-12px min-w-140px'>
            <span className={item.userId === account.userId ? 'font-600 text-[rgb(var(--primary-6))]' : ''}>
              {item.username}
              {item.userId === account.userId ? ' (当前)' : ''}
            </span>
            <span className='text-11px text-t-secondary'>${item.quotaUsd.toFixed(2)}</span>
          </div>
        </Menu.Item>
      ))}
      <Menu.Item key='__add__'>+ 浏览器登录 / 切换新账号</Menu.Item>
    </Menu>
  );

  if (collapsed) {
    const tip = account.loggedIn
      ? `${account.username} · 余额 $${(account.quotaUsd ?? 0).toFixed(2)}`
      : '登录 EthanToken 账号';
    return (
      <Tooltip {...siderTooltipProps} content={tip} position='right'>
        <div
          onClick={account.loggedIn ? handleTopup : handleLogin}
          className='w-full h-34px flex items-center justify-center rd-0.5rem cursor-pointer transition-colors hover:bg-fill-3 active:bg-fill-4 mb-4px'
        >
          {account.loggedIn ? (
            <Wallet theme='outline' size='16' fill='currentColor' className='text-t-primary' />
          ) : (
            <User theme='outline' size='16' fill='currentColor' className='text-t-secondary' />
          )}
        </div>
      </Tooltip>
    );
  }

  return (
    <>
      <div className='mb-6px px-8px py-8px rd-0.5rem bg-fill-2 border border-solid border-[var(--color-border-2)]'>
        {!account.loggedIn ? (
          <div className='flex flex-col gap-6px'>
            <div className='flex items-center justify-between'>
              <span className='text-12px font-500 text-t-primary'>EthanToken 账号</span>
              <span
                onClick={() => setGroupModalOpen(true)}
                className='text-11px text-t-secondary hover:text-t-primary cursor-pointer'
              >
                交流群
              </span>
            </div>
            <Button
              type='primary'
              size='small'
              long
              loading={loading}
              onClick={handleLogin}
              icon={<User theme='outline' size='14' fill='currentColor' />}
            >
              {loading ? '请在浏览器完成授权...' : '浏览器一键登录 / 注册'}
            </Button>
            {savedAccounts.length > 0 && (
              <Dropdown droplist={switchMenu} trigger='click' position='top'>
                <Button size='mini' long>
                  快速切换已记住账号 ({savedAccounts.length})
                </Button>
              </Dropdown>
            )}
          </div>
        ) : (
          <div className='flex flex-col gap-6px'>
            <div className='flex items-center justify-between gap-4px'>
              <Dropdown droplist={switchMenu} trigger='click' position='top'>
                <div className='flex items-center gap-4px min-w-0 cursor-pointer hover:opacity-80'>
                  <User theme='outline' size='14' fill='currentColor' className='text-t-secondary shrink-0' />
                  <span className='text-12px font-500 text-t-primary truncate'>{account.username}</span>
                  <Down theme='outline' size='12' fill='currentColor' className='text-t-secondary shrink-0' />
                </div>
              </Dropdown>
              <div className='flex items-center gap-4px shrink-0'>
                <Tooltip content='刷新余额' position='top'>
                  <span
                    onClick={loading ? undefined : handleRefresh}
                    className='p-4px rd-4px cursor-pointer text-t-secondary hover:bg-fill-3 hover:text-t-primary flex items-center'
                  >
                    <Refresh theme='outline' size='13' fill='currentColor' />
                  </span>
                </Tooltip>
                <Tooltip content='退出当前账号' position='top'>
                  <span
                    onClick={handleLogout}
                    className='p-4px rd-4px cursor-pointer text-t-secondary hover:bg-fill-3 hover:text-t-primary flex items-center'
                  >
                    <Logout theme='outline' size='13' fill='currentColor' />
                  </span>
                </Tooltip>
              </div>
            </div>

            <div className='flex items-center justify-between text-12px'>
              <span className='text-t-secondary'>余额</span>
              <span
                className={
                  (account.quotaUsd ?? 0) < 0.4
                    ? 'font-600 text-[rgb(var(--warning-6))]'
                    : 'font-600 text-t-primary'
                }
              >
                ${(account.quotaUsd ?? 0).toFixed(2)}
              </span>
            </div>

            <div className='flex items-center gap-6px'>
              <Button type='primary' size='mini' className='flex-1' onClick={handleTopup}>
                去充值
              </Button>
              <Button size='mini' onClick={() => setGroupModalOpen(true)}>
                交流群
              </Button>
            </div>
            {account.error && (
              <div className='flex items-center justify-between gap-6px text-11px text-[rgb(var(--warning-6))] leading-tight'>
                <span className='truncate'>{account.error}</span>
                <span
                  onClick={loading ? undefined : handleLogin}
                  className='shrink-0 underline cursor-pointer text-[rgb(var(--primary-6))]'
                >
                  重新授权
                </span>
              </div>
            )}
          </div>
        )}
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
              <div className='text-13px font-600 text-t-primary mb-8px'>微信交流群 · 羊毛出在AI身上</div>
              <div className='p-6px rd-8px bg-white shadow-sm'>
                <img src={wechatQrImg} alt='微信交流群二维码' className='w-148px h-148px object-contain block' />
              </div>
              <div className='mt-8px text-11px text-t-secondary leading-tight'>
                微信扫一扫加入（二维码若过期，请加右侧 QQ 群获取最新码）
              </div>
            </div>

            <div className='flex flex-col justify-between p-12px rd-10px bg-fill-2 border border-solid border-[var(--color-border-2)]'>
              <div className='flex flex-col gap-6px'>
                <div className='text-13px font-600 text-t-primary'>QQ 交流群 / 售后直达</div>
                <div className='text-12px text-t-secondary'>适合反馈问题、领新群码与大额直充联系：</div>
                <div className='mt-4px px-10px py-6px rd-6px bg-fill-3 flex items-center justify-between'>
                  <span className='font-mono font-600 text-13px text-t-primary'>1134610506</span>
                  <span
                    onClick={() => {
                      void navigator.clipboard?.writeText('1134610506');
                      Message.success('已复制 QQ 群号');
                    }}
                    className='text-11px text-[rgb(var(--primary-6))] cursor-pointer hover:underline'
                  >
                    复制群号
                  </span>
                </div>
              </div>

              <div className='flex flex-col gap-8px mt-12px'>
                <Button
                  type='primary'
                  long
                  onClick={() => void ipcBridge.shell.openExternal.invoke('https://qm.qq.com/q/Lq38Kn6bMQ')}
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

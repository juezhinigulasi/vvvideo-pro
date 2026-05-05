'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { supabase } from '../lib/supabase';

interface ImageHeaderProps {
  credits?: number;
  costPerImage?: number;
}

export default function ImageHeader({ credits: externalCredits, costPerImage }: ImageHeaderProps) {
  const [showLogin, setShowLogin] = useState(false);
  const [showCardRedeem, setShowCardRedeem] = useState(false);
  const [showPersonalCenter, setShowPersonalCenter] = useState(false);
  const [isRegisterMode, setIsRegisterMode] = useState(false);
  const [cardCode, setCardCode] = useState('');
  const [credits, setCredits] = useState(externalCredits || 0);
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginUsername, setLoginUsername] = useState('');
  const [transactions, setTransactions] = useState<any[]>([]);
  const [userProfile, setUserProfile] = useState<any>(null);
  const [totalRecharge, setTotalRecharge] = useState(0);
  const [showRechargeSuccess, setShowRechargeSuccess] = useState(false);
  const [rechargeAmount, setRechargeAmount] = useState(0);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        setUser(session.user);
        fetchUserPoints(session.user.id);
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        setUser(session.user);
        fetchUserPoints(session.user.id);
      } else {
        setUser(null);
        setCredits(0);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (externalCredits !== undefined) {
      setCredits(externalCredits);
    }
  }, [externalCredits]);

  const fetchUserPoints = async (userId: string) => {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single();

      if (data && !error) {
        setCredits(data.points || 0);
        setUserProfile(data);
      }
    } catch (error) {
      console.error('获取积分失败:', error);
    }
  };

  const fetchTransactions = async (userId: string) => {
    try {
      const { data, error } = await supabase
        .from('billing_history')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(50);

      if (data && !error) {
        setTransactions(data);
        const recharge = data
          .filter((tx: any) => tx.type === 'recharge' || tx.type === 'redeem')
          .reduce((sum: number, tx: any) => sum + tx.amount, 0);
        setTotalRecharge(recharge);
      }
    } catch (error) {
      console.error('获取账单失败:', error);
    }
  };

  const handleLogin = async () => {
    if (!loginEmail.trim() || !loginPassword.trim()) {
      alert('请输入邮箱和密码');
      return;
    }

    setLoading(true);
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: loginEmail,
        password: loginPassword,
      });

      if (error) {
        alert(error.message);
      } else {
        setUser(data.user);
        setShowLogin(false);
        setLoginEmail('');
        setLoginPassword('');
        alert('登录成功！');
      }
    } catch (error: any) {
      alert(error.message || '登录失败');
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async () => {
    if (!loginEmail.trim() || !loginPassword.trim() || !loginUsername.trim()) {
      alert('请输入用户名、邮箱和密码');
      return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(loginEmail)) {
      alert('请输入有效的邮箱地址（如 user@example.com）');
      return;
    }

    setLoading(true);
    try {
      const { data, error } = await supabase.auth.signUp({
        email: loginEmail,
        password: loginPassword,
        options: {
          data: {
            username: loginUsername,
          }
        }
      });

      if (error) {
        alert(error.message);
      } else if (data.user) {
        // 数据库触发器会自动创建 profile（0积分）
        // 这里延迟一下让数据库同步
        await new Promise(resolve => setTimeout(resolve, 500));
        
        setUser(data.user);
        setShowLogin(false);
        setLoginEmail('');
        setLoginPassword('');
        setLoginUsername('');
        alert('注册成功！初始积分为 0，请使用卡密充值');
      }
    } catch (error: any) {
      alert(error.message || '注册失败');
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setUser(null);
    setCredits(0);
    alert('已退出登录');
  };

  const redeemCard = async (code: string) => {
    if (!user) {
      alert('请先登录');
      return;
    }

    setLoading(true);
    try {
      const { data, error } = await supabase
        .rpc('redeem_gift_card', { card_code: code });

      if (error) {
        alert('兑换失败: ' + error.message);
      } else if (data && data.success) {
        setRechargeAmount(data.points || 0);
        setShowRechargeSuccess(true);
        setTimeout(() => {
          setShowRechargeSuccess(false);
        }, 3000);
        fetchUserPoints(user.id);
        setShowCardRedeem(false);
        setCardCode('');
      } else {
        alert(data?.message || '卡密无效或已使用');
      }
    } catch (error: any) {
      alert(error.message || '兑换失败');
    } finally {
      setLoading(false);
    }
  };

  const handleRedeem = () => {
    if (cardCode.trim()) {
      redeemCard(cardCode);
    }
  };

  return (
    <>
      <header className="py-8 text-center relative">
        <div className="flex justify-center gap-6 mb-8">
          <Link href="/">
            <button className="px-8 py-4 bg-[#2A2C2E] text-[#E5E5E5] rounded-2xl font-medium transition-all duration-300 hover:bg-[#3A3C3E] flex items-center gap-3 text-lg" style={{ border: '1px solid rgba(255, 255, 255, 0.1)' }}>
              🎬 视频生成工具
            </button>
          </Link>
          <Link href="/image-generator">
            <button className="px-8 py-4 bg-[#D4AF37] text-[#1A1C1E] rounded-2xl font-medium transition-all duration-300 hover:bg-[#E8C860] hover:shadow-lg hover:shadow-[#D4AF37]/20 flex items-center gap-3 text-lg" style={{ border: '1px solid rgba(212, 175, 55, 0.3)' }}>
              🎨 图像生成工具
            </button>
          </Link>
        </div>

        <div className="absolute top-4 right-4 flex items-center gap-4">
          <div className="flex items-center gap-2 px-5 py-2.5 bg-[#222428] rounded-full" style={{ border: '1px solid rgba(212, 175, 55, 0.4)' }}>
            <svg className="w-5 h-5 text-[#D4AF37]" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm.31-8.86c-1.77-.45-2.34-.94-2.34-1.67 0-.84.79-1.43 2.1-1.43 1.38 0 1.9.66 1.94 1.64h1.71c-.05-1.34-.87-2.57-2.49-2.97V5H10.9v1.69c-1.51.32-2.72 1.3-2.72 2.81 0 1.79 1.49 2.69 3.66 3.21 1.95.46 2.34 1.15 2.34 1.87 0 .53-.39 1.39-2.1 1.39-1.6 0-2.23-.72-2.32-1.64H10.4c.1 1.39.92 2.56 2.59 2.97V19h2.34v-1.67c1.52-.29 2.72-1.16 2.73-2.77-.01-2.2-1.9-2.96-3.75-3.42z"/>
            </svg>
            <span className="text-[#D4AF37] font-bold">{credits} 积分</span>
          </div>

          <div className="relative group">
            <button className="flex items-center gap-2 px-4 py-2.5 bg-[#222428] rounded-full transition-all duration-300 hover:bg-[#2A2C2E]" style={{ border: '1px solid rgba(255, 255, 255, 0.1)' }}>
              <svg className="w-5 h-5 text-[#E5E5E5]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
              <span className="text-[#E5E5E5] text-sm">{user ? (user.user_metadata?.username || user.email?.split('@')[0]) : '未登录'}</span>
            </button>

            <div className="absolute right-0 top-full mt-3 w-56 bg-[#222428] rounded-2xl shadow-xl border border-white/10 overflow-hidden opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-300" style={{ boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)' }}>
              <div className="p-3">
                {user ? (
                  <>
                    <div className="px-4 py-3 text-[#999] text-sm border-b border-white/10">
                      {user.email}
                    </div>
                    <button
                      onClick={() => {
                        setShowPersonalCenter(true);
                        fetchTransactions(user.id);
                      }}
                      className="w-full text-left px-4 py-3 text-[#E5E5E5] hover:bg-[#2A2C2E] rounded-xl flex items-center gap-3 text-sm transition-all duration-200 mt-2"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                      </svg>
                      个人中心
                    </button>
                    <button
                      onClick={() => setShowCardRedeem(true)}
                      className="w-full text-left px-4 py-3 text-[#E5E5E5] hover:bg-[#2A2C2E] rounded-xl flex items-center gap-3 text-sm transition-all duration-200"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                      </svg>
                      卡密充值
                    </button>
                    <div className="border-t border-white/10 my-2"></div>
                    <button
                      onClick={handleLogout}
                      className="w-full text-left px-4 py-3 text-[#E74C3C] hover:bg-[#2A2C2E] rounded-xl flex items-center gap-3 text-sm transition-all duration-200"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                      </svg>
                      退出登录
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => setShowLogin(true)}
                    className="w-full text-left px-4 py-3 text-[#E5E5E5] hover:bg-[#2A2C2E] rounded-xl flex items-center gap-3 text-sm transition-all duration-200"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
                    </svg>
                    登录 / 注册
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        <h1 className="text-4xl font-bold text-[#E5E5E5] tracking-wider" style={{ fontFamily: '"Noto Serif SC", "STSong", Georgia, serif' }}>
          明亮图像生成工具
        </h1>
        <p className="mt-4 text-base text-[#888] max-w-2xl mx-auto px-4">
          提供给学员专用版，学习短视频流量变现，购微：zhengnianxin123
        </p>
      </header>

      {showLogin && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50" onClick={() => setShowLogin(false)}>
          <div className="bg-[#222428] rounded-3xl p-10 max-w-md w-full mx-4 border border-white/10 shadow-2xl" onClick={(e) => e.stopPropagation()} style={{ boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)' }}>
            <div className="flex justify-between items-start mb-8">
              <div className="text-center flex-1">
                <div className="w-20 h-20 bg-[#D4AF37] rounded-full flex items-center justify-center mx-auto mb-5" style={{ boxShadow: '0 0 30px rgba(212, 175, 55, 0.3)' }}>
                  <svg className="w-10 h-10 text-[#1A1C1E]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                </div>
                <h2 className="text-2xl text-[#E5E5E5] mb-2" style={{ fontFamily: '"Noto Serif SC", Georgia, serif' }}>
                  {isRegisterMode ? '立即注册' : '欢迎登录'}
                </h2>
                <p className="text-[#888] text-sm">
                  {isRegisterMode ? '注册后即可获得 10 积分' : '请登录后使用完整功能'}
                </p>
              </div>
              <button onClick={() => setShowLogin(false)} className="text-[#666] hover:text-[#E5E5E5] transition-colors">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="space-y-5">
              {isRegisterMode && (
                <input
                  type="text"
                  value={loginUsername}
                  onChange={(e) => setLoginUsername(e.target.value)}
                  placeholder="请输入用户名"
                  className="w-full bg-[#1A1C1E] border border-white/10 rounded-xl px-5 py-4 text-[#E5E5E5] placeholder-[#666] focus:outline-none focus:border-[#D4AF37] transition-all text-base"
                />
              )}
              <input
                type="email"
                value={loginEmail}
                onChange={(e) => setLoginEmail(e.target.value)}
                placeholder="请输入邮箱"
                className="w-full bg-[#1A1C1E] border border-white/10 rounded-xl px-5 py-4 text-[#E5E5E5] placeholder-[#666] focus:outline-none focus:border-[#D4AF37] transition-all text-base"
              />
              <input
                type="password"
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                placeholder="请输入密码"
                onKeyDown={(e) => e.key === 'Enter' && (isRegisterMode ? handleRegister() : handleLogin())}
                className="w-full bg-[#1A1C1E] border border-white/10 rounded-xl px-5 py-4 text-[#E5E5E5] placeholder-[#666] focus:outline-none focus:border-[#D4AF37] transition-all text-base"
              />

              <button
                onClick={isRegisterMode ? handleRegister : handleLogin}
                disabled={loading}
                className="w-full py-4 bg-[#D4AF37] text-[#1A1C1E] rounded-xl font-bold transition-all duration-300 hover:bg-[#E8C860] hover:shadow-lg hover:shadow-[#D4AF37]/20 disabled:opacity-50 disabled:cursor-not-allowed text-lg"
              >
                {loading ? '处理中...' : (isRegisterMode ? '注册' : '登录')}
              </button>

              <div className="text-center mt-6">
                <button
                  onClick={() => setIsRegisterMode(!isRegisterMode)}
                  className="text-[#888] text-sm hover:text-[#E5E5E5] transition-colors"
                >
                  {isRegisterMode ? '已有账号？' : '还没有账号？'}
                  <span className="text-[#D4AF37] ml-1">{isRegisterMode ? '立即登录' : '立即注册'}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showCardRedeem && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50" onClick={() => setShowCardRedeem(false)}>
          <div className="bg-[#222428] rounded-3xl p-10 max-w-md w-full mx-4 border border-white/10 shadow-2xl" onClick={(e) => e.stopPropagation()} style={{ boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)' }}>
            <div className="flex justify-between items-start mb-8">
              <div className="text-center flex-1">
                <div className="w-20 h-20 bg-[#D4AF37] rounded-full flex items-center justify-center mx-auto mb-5" style={{ boxShadow: '0 0 30px rgba(212, 175, 55, 0.3)' }}>
                  <svg className="w-10 h-10 text-[#1A1C1E]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                  </svg>
                </div>
                <h2 className="text-2xl text-[#E5E5E5] mb-2" style={{ fontFamily: '"Noto Serif SC", Georgia, serif' }}>卡密充值</h2>
                <p className="text-[#888] text-sm">输入卡密兑换积分</p>
              </div>
              <button onClick={() => setShowCardRedeem(false)} className="text-[#666] hover:text-[#E5E5E5] transition-colors">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="space-y-5">
              <div className="relative">
                <input
                  type="text"
                  value={cardCode}
                  onChange={(e) => setCardCode(e.target.value.toUpperCase())}
                  placeholder="请输入卡密"
                  className="w-full bg-[#1A1C1E] border border-white/10 rounded-xl px-5 py-4 text-[#E5E5E5] placeholder-[#666] focus:outline-none focus:border-[#D4AF37] transition-all text-center text-lg font-mono tracking-widest"
                />
                {cardCode && (
                  <button onClick={() => setCardCode('')} className="absolute right-4 top-1/2 -translate-y-1/2 text-[#666] hover:text-[#E5E5E5]">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>

              <button
                onClick={handleRedeem}
                disabled={loading || !cardCode.trim()}
                className="w-full py-4 bg-[#D4AF37] text-[#1A1C1E] rounded-xl font-bold transition-all duration-300 hover:bg-[#E8C860] hover:shadow-lg hover:shadow-[#D4AF37]/20 flex items-center justify-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed text-lg"
              >
                {loading ? '兑换中...' : (
                  <>
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    立即兑换
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {showPersonalCenter && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50" onClick={() => setShowPersonalCenter(false)}>
          <div className="bg-[#222428] rounded-3xl p-8 max-w-lg w-full mx-4 border border-white/10 shadow-2xl max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()} style={{ boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)' }}>
            <div className="flex justify-between items-start mb-6">
              <div className="text-center flex-1">
                <div className="w-20 h-20 bg-[#D4AF37] rounded-full flex items-center justify-center mx-auto mb-4" style={{ boxShadow: '0 0 30px rgba(212, 175, 55, 0.3)' }}>
                  <svg className="w-10 h-10 text-[#1A1C1E]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                </div>
                <h2 className="text-2xl text-[#E5E5E5] mb-1" style={{ fontFamily: '"Noto Serif SC", Georgia, serif' }}>{user?.user_metadata?.username || user?.email?.split('@')[0]}</h2>
                <p className="text-[#666] text-sm mb-6">{user?.email}</p>

                <div className="grid grid-cols-3 gap-4 mb-6">
                  <div className="bg-[#1A1C1E] rounded-xl p-4 border border-white/10">
                    <p className="text-[#D4AF37] text-xl font-bold">{credits}</p>
                    <p className="text-[#888] text-xs mt-1">当前积分</p>
                  </div>
                  <div className="bg-[#1A1C1E] rounded-xl p-4 border border-white/10">
                    <p className="text-[#4ADE80] text-xl font-bold">+{totalRecharge}</p>
                    <p className="text-[#888] text-xs mt-1">累计充值</p>
                  </div>
                  <div className="bg-[#1A1C1E] rounded-xl p-4 border border-white/10">
                    <p className="text-[#A78BFA] text-xl font-bold">{userProfile?.created_at ? new Date(userProfile.created_at).toLocaleDateString('zh-CN') : '-'}</p>
                    <p className="text-[#888] text-xs mt-1">注册时间</p>
                  </div>
                </div>
              </div>
              <button onClick={() => setShowPersonalCenter(false)} className="text-[#666] hover:text-[#E5E5E5] transition-colors">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="border-t border-white/10 pt-6">
              <h3 className="text-lg text-[#E5E5E5] mb-4 flex items-center gap-3" style={{ fontFamily: '"Noto Serif SC", Georgia, serif' }}>
                <svg className="w-5 h-5 text-[#D4AF37]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
                账单明细
              </h3>

              <div className="space-y-3 max-h-72 overflow-y-auto pr-2">
                {transactions.length === 0 ? (
                  <div className="text-center py-12 text-[#666]">
                    <svg className="w-12 h-12 mx-auto mb-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                    </svg>
                    暂无账单记录
                  </div>
                ) : (
                  transactions.map((tx) => (
                    <div key={tx.id} className="bg-[#1A1C1E] rounded-xl p-4 flex items-center justify-between border border-white/10">
                      <div className="flex-1">
                        <p className="text-[#E5E5E5] text-sm font-medium">{tx.description}</p>
                        <p className="text-[#666] text-xs mt-1">
                          {new Date(tx.created_at).toLocaleString('zh-CN')}
                        </p>
                      </div>
                      <div className={`text-right font-bold ${tx.amount > 0 ? 'text-[#4ADE80]' : 'text-[#EF4444]'}`}>
                        {tx.amount > 0 ? '+' : ''}{tx.amount}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {showRechargeSuccess && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[100] pointer-events-none">
          <div className="relative">
            <div className="absolute inset-0 flex items-center justify-center">
              {[...Array(12)].map((_, i) => (
                <div
                  key={i}
                  className="absolute w-10 h-10 animate-coin-fly"
                  style={{
                    animationDelay: `${i * 0.1}s`,
                    '--tx': `${Math.cos((i * 30) * Math.PI / 180) * 150}px`,
                    '--ty': `${Math.sin((i * 30) * Math.PI / 180) * 150}px`,
                  } as React.CSSProperties}
                >
                  <div className="w-full h-full bg-[#D4AF37] rounded-full" style={{ boxShadow: '0 0 15px rgba(212, 175, 55, 0.5)' }}>
                    <span className="text-[#1A1C1E] font-bold text-sm flex items-center justify-center w-full h-full">$</span>
                  </div>
                </div>
              ))}
            </div>

            <div className="bg-[#222428] rounded-3xl p-10 border-2 border-[#D4AF37] shadow-2xl" style={{ boxShadow: '0 0 40px rgba(212, 175, 55, 0.3)' }}>
              <div className="text-center">
                <div className="w-24 h-24 mx-auto mb-4 bg-[#D4AF37] rounded-full flex items-center justify-center" style={{ boxShadow: '0 0 40px rgba(212, 175, 55, 0.5)' }}>
                  <span className="text-[#1A1C1E] font-black text-5xl">$</span>
                </div>
                <h3 className="text-3xl font-bold text-[#D4AF37] mb-2 animate-shine" style={{ fontFamily: '"Noto Serif SC", Georgia, serif' }}>充值成功！</h3>
                <p className="text-5xl font-black text-[#E5E5E5] mb-2">+{rechargeAmount}</p>
                <p className="text-[#888] text-lg">积分已到账</p>
              </div>
            </div>
          </div>

          <style>{`
            @keyframes coin-fly {
              0% {
                transform: translate(0, 0) scale(1);
                opacity: 1;
              }
              100% {
                transform: translate(var(--tx), var(--ty)) scale(0.5);
                opacity: 0;
              }
            }
            @keyframes shine {
              0%, 100% {
                filter: brightness(1);
              }
              50% {
                filter: brightness(1.3);
              }
            }
            .animate-coin-fly {
              animation: coin-fly 1s ease-out forwards;
            }
            .animate-shine {
              animation: shine 1s ease-in-out infinite;
            }
          `}</style>
        </div>
      )}
    </>
  );
}

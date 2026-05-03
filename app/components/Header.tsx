'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { supabase } from '../lib/supabase';

export default function Header() {
  const [showLogin, setShowLogin] = useState(false);
  const [showCardRedeem, setShowCardRedeem] = useState(false);
  const [showPersonalCenter, setShowPersonalCenter] = useState(false);
  const [isRegisterMode, setIsRegisterMode] = useState(false);
  const [cardCode, setCardCode] = useState('');
  const [points, setPoints] = useState(0);
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
        setPoints(0);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const fetchUserPoints = async (userId: string) => {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single();

      if (data && !error) {
        setPoints(data.points);
        setUserProfile(data);
      }
    } catch (error) {
      console.error('获取积分失败:', error);
    }
  };

  const fetchTransactions = async (userId: string) => {
    try {
      const { data, error } = await supabase
        .from('transactions')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(50);

      if (data && !error) {
        setTransactions(data);
        const recharge = data
          .filter((tx: any) => tx.type === 'redeem')
          .reduce((sum: number, tx: any) => sum + tx.points_change, 0);
        setTotalRecharge(recharge);
      }
    } catch (error) {
      console.error('获取账单失败:', error);
    }
  };

  const addTransaction = async (userId: string, type: string, description: string, pointsChange: number, balanceAfter: number) => {
    try {
      await supabase.from('transactions').insert({
        user_id: userId,
        type,
        description,
        points_change: pointsChange,
        balance_after: balanceAfter,
      });
    } catch (error) {
      console.error('写入账单失败:', error);
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
        const { error: profileError } = await supabase
          .from('profiles')
          .insert({
            id: data.user.id,
            username: loginUsername,
            email: loginEmail,
            points: 0,
          });

        if (profileError) {
          console.error('创建用户资料失败:', profileError);
        }

        setUser(data.user);
        setShowLogin(false);
        setLoginEmail('');
        setLoginPassword('');
        setLoginUsername('');
        alert('注册成功！');
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
    setPoints(0);
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
        setRechargeAmount(data.points);
        setShowRechargeSuccess(true);
        setTimeout(() => {
          setShowRechargeSuccess(false);
        }, 3000);
        const newBalance = points + data.points;
        await addTransaction(user.id, 'redeem', `卡密充值：${code}`, data.points, newBalance);
        setShowCardRedeem(false);
        setCardCode('');
        fetchUserPoints(user.id);
      } else {
        alert(data?.message || '卡密无效或已使用');
      }
    } catch (error: any) {
      alert(error.message || '兑换失败');
    } finally {
      setLoading(false);
    }
  };

  const deductPoints = async (amount: number, description: string = '生图') => {
    if (!user) return false;

    try {
      const { data, error } = await supabase
        .rpc('deduct_points', { amount });

      if (error) {
        console.error('扣费失败:', error);
        return false;
      }

      if (data && data.success) {
        const newBalance = points - amount;
        await addTransaction(user.id, 'generate_image', description, -amount, newBalance);
        fetchUserPoints(user.id);
        return true;
      } else {
        alert(data?.message || '积分不足');
        return false;
      }
    } catch (error) {
      console.error('扣费失败:', error);
      return false;
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
        <div className="flex justify-center gap-4 mb-6">
          <Link href="/">
            <button className="px-6 py-3 bg-gradient-to-r from-cyan-500 to-blue-500 text-white rounded-xl font-medium shadow-lg shadow-cyan-500/30 transition-all duration-200 flex items-center gap-2">
              🎬 视频生成工具
            </button>
          </Link>
          <Link href="/image-generator">
            <button className="px-6 py-3 bg-gray-700/50 hover:bg-gray-700 text-gray-300 rounded-xl font-medium transition-all duration-200 border border-gray-600/50 flex items-center gap-2">
              🎨 图像生成工具
            </button>
          </Link>
        </div>

        <div className="absolute top-4 right-4 flex items-center gap-3">
          <div className="flex items-center gap-2 px-4 py-2 bg-yellow-500/20 border border-yellow-500/40 rounded-full">
            <svg className="w-5 h-5 text-yellow-400" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm.31-8.86c-1.77-.45-2.34-.94-2.34-1.67 0-.84.79-1.43 2.1-1.43 1.38 0 1.9.66 1.94 1.64h1.71c-.05-1.34-.87-2.57-2.49-2.97V5H10.9v1.69c-1.51.32-2.72 1.3-2.72 2.81 0 1.79 1.49 2.69 3.66 3.21 1.95.46 2.34 1.15 2.34 1.87 0 .53-.39 1.39-2.1 1.39-1.6 0-2.23-.72-2.32-1.64H10.4c.1 1.39.92 2.56 2.59 2.97V19h2.34v-1.67c1.52-.29 2.72-1.16 2.73-2.77-.01-2.2-1.9-2.96-3.75-3.42z"/>
            </svg>
            <span className="text-yellow-400 font-bold">{points} 积分</span>
          </div>

          <div className="relative group">
            <button className="flex items-center gap-2 px-3 py-2 bg-gray-700/50 rounded-full hover:bg-gray-700 transition-colors">
              <svg className="w-5 h-5 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
              <span className="text-gray-300 text-sm">{user ? (user.user_metadata?.username || user.email?.split('@')[0]) : '未登录'}</span>
            </button>

            <div className="absolute right-0 top-full mt-2 w-48 bg-gray-800 rounded-xl shadow-2xl border border-gray-700/50 overflow-hidden opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200">
              <div className="p-2">
                {user ? (
                  <>
                    <div className="px-3 py-2 text-gray-400 text-xs border-b border-gray-700">
                      {user.email}
                    </div>
                    <button
                      onClick={() => {
                        setShowPersonalCenter(true);
                        fetchTransactions(user.id);
                      }}
                      className="w-full text-left px-3 py-2 text-gray-300 hover:bg-gray-700 rounded-lg flex items-center gap-2 text-sm"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                      </svg>
                      个人中心
                    </button>
                    <button
                      onClick={() => setShowCardRedeem(true)}
                      className="w-full text-left px-3 py-2 text-gray-300 hover:bg-gray-700 rounded-lg flex items-center gap-2 text-sm"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                      </svg>
                      卡密充值
                    </button>
                    <div className="border-t border-gray-700 my-1"></div>
                    <button
                      onClick={handleLogout}
                      className="w-full text-left px-3 py-2 text-red-400 hover:bg-gray-700 rounded-lg flex items-center gap-2 text-sm"
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
                    className="w-full text-left px-3 py-2 text-gray-300 hover:bg-gray-700 rounded-lg flex items-center gap-2 text-sm"
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

        <h1 className="text-3xl font-bold bg-gradient-to-r from-cyan-400 via-blue-500 to-purple-500 bg-clip-text text-transparent">
          明亮视频生成工具
        </h1>
        <p className="mt-3 text-sm text-blue-400/80 max-w-2xl mx-auto px-4">
          提供给学员专用版，学习短视频流量变现，购微：zhengnianxin123
        </p>
      </header>

      {showLogin && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50" onClick={() => setShowLogin(false)}>
          <div className="bg-gradient-to-br from-gray-900 to-gray-800 rounded-3xl p-8 max-w-md w-full mx-4 border border-gray-700/50 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-start mb-6">
              <div className="text-center flex-1">
                <div className="w-16 h-16 bg-gradient-to-br from-purple-500 to-pink-500 rounded-full flex items-center justify-center mx-auto mb-3">
                  <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                </div>
                <h2 className="text-2xl font-bold text-white mb-2">
                  {isRegisterMode ? '立即注册' : '欢迎登录'}
                </h2>
                <p className="text-gray-400 text-sm">
                  {isRegisterMode ? '注册后即可获得积分开始使用' : '请登录后使用完整功能'}
                </p>
              </div>
              <button onClick={() => setShowLogin(false)} className="text-gray-400 hover:text-white transition-colors">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="space-y-4">
              {isRegisterMode && (
                <input
                  type="text"
                  value={loginUsername}
                  onChange={(e) => setLoginUsername(e.target.value)}
                  placeholder="请输入用户名"
                  className="w-full bg-gray-700/50 border border-gray-600/50 rounded-xl px-4 py-3 text-white placeholder-gray-400 focus:outline-none focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20 transition-all"
                />
              )}
              <input
                type="email"
                value={loginEmail}
                onChange={(e) => setLoginEmail(e.target.value)}
                placeholder="请输入邮箱"
                className="w-full bg-gray-700/50 border border-gray-600/50 rounded-xl px-4 py-3 text-white placeholder-gray-400 focus:outline-none focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20 transition-all"
              />
              <input
                type="password"
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                placeholder="请输入密码"
                onKeyDown={(e) => e.key === 'Enter' && (isRegisterMode ? handleRegister() : handleLogin())}
                className="w-full bg-gray-700/50 border border-gray-600/50 rounded-xl px-4 py-3 text-white placeholder-gray-400 focus:outline-none focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20 transition-all"
              />

              <button
                onClick={isRegisterMode ? handleRegister : handleLogin}
                disabled={loading}
                className="w-full py-3 bg-gradient-to-r from-purple-500 to-pink-500 text-white rounded-xl font-bold shadow-lg shadow-purple-500/30 hover:shadow-purple-500/50 transition-all transform hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? '处理中...' : (isRegisterMode ? '注册' : '登录')}
              </button>

              <div className="text-center mt-4">
                <button
                  onClick={() => setIsRegisterMode(!isRegisterMode)}
                  className="text-gray-400 text-sm hover:text-white transition-colors"
                >
                  {isRegisterMode ? '已有账号？' : '还没有账号？'}
                  <span className="text-cyan-400 ml-1">{isRegisterMode ? '立即登录' : '立即注册'}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showCardRedeem && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50" onClick={() => setShowCardRedeem(false)}>
          <div className="bg-gradient-to-br from-gray-900 to-gray-800 rounded-3xl p-8 max-w-md w-full mx-4 border border-gray-700/50 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-start mb-6">
              <div className="text-center flex-1">
                <div className="w-16 h-16 bg-gradient-to-br from-yellow-500 to-orange-500 rounded-full flex items-center justify-center mx-auto mb-3">
                  <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                  </svg>
                </div>
                <h2 className="text-2xl font-bold text-white mb-2">卡密充值</h2>
                <p className="text-gray-400 text-sm">输入卡密兑换积分</p>
              </div>
              <button onClick={() => setShowCardRedeem(false)} className="text-gray-400 hover:text-white transition-colors">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="space-y-4">
              <div className="relative">
                <input
                  type="text"
                  value={cardCode}
                  onChange={(e) => setCardCode(e.target.value.toUpperCase())}
                  placeholder="请输入卡密"
                  className="w-full bg-gray-700/50 border border-gray-600/50 rounded-xl px-4 py-4 text-white placeholder-gray-400 focus:outline-none focus:border-yellow-500 focus:ring-2 focus:ring-yellow-500/20 transition-all text-center text-lg font-mono tracking-wider"
                />
                {cardCode && (
                  <button onClick={() => setCardCode('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>

              <button
                onClick={handleRedeem}
                disabled={loading || !cardCode.trim()}
                className="w-full py-4 bg-gradient-to-r from-yellow-500 to-orange-500 text-white rounded-xl font-bold shadow-lg shadow-yellow-500/30 hover:shadow-yellow-500/50 transition-all transform hover:scale-[1.02] active:scale-[0.98] flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
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
          <div className="bg-gradient-to-br from-gray-900 to-gray-800 rounded-3xl p-8 max-w-lg w-full mx-4 border border-gray-700/50 shadow-2xl max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-start mb-6">
              <div className="text-center flex-1">
                <div className="w-20 h-20 bg-gradient-to-br from-cyan-500 to-blue-500 rounded-full flex items-center justify-center mx-auto mb-3 shadow-lg shadow-cyan-500/30">
                  <svg className="w-10 h-10 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                </div>
                <h2 className="text-2xl font-bold text-white mb-1">{user?.user_metadata?.username || user?.email?.split('@')[0]}</h2>
                <p className="text-gray-500 text-sm mb-4">{user?.email}</p>

                <div className="grid grid-cols-3 gap-3 mb-4">
                  <div className="bg-gradient-to-br from-yellow-500/20 to-orange-500/20 rounded-xl p-3 border border-yellow-500/30">
                    <p className="text-yellow-400 text-xl font-bold">{points}</p>
                    <p className="text-gray-400 text-xs">当前积分</p>
                  </div>
                  <div className="bg-gradient-to-br from-green-500/20 to-emerald-500/20 rounded-xl p-3 border border-green-500/30">
                    <p className="text-green-400 text-xl font-bold">+{totalRecharge}</p>
                    <p className="text-gray-400 text-xs">累计充值</p>
                  </div>
                  <div className="bg-gradient-to-br from-purple-500/20 to-pink-500/20 rounded-xl p-3 border border-purple-500/30">
                    <p className="text-purple-400 text-xl font-bold">{userProfile?.created_at ? new Date(userProfile.created_at).toLocaleDateString('zh-CN') : '-'}</p>
                    <p className="text-gray-400 text-xs">注册时间</p>
                  </div>
                </div>
              </div>
              <button onClick={() => setShowPersonalCenter(false)} className="text-gray-400 hover:text-white transition-colors">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="border-t border-gray-700 pt-4">
              <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                <svg className="w-5 h-5 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
                账单明细
              </h3>

              <div className="space-y-3 max-h-80 overflow-y-auto pr-2">
                {transactions.length === 0 ? (
                  <div className="text-center py-8 text-gray-500">
                    <svg className="w-12 h-12 mx-auto mb-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                    </svg>
                    暂无账单记录
                  </div>
                ) : (
                  transactions.map((tx) => (
                    <div key={tx.id} className="bg-gray-700/30 rounded-xl p-4 flex items-center justify-between">
                      <div className="flex-1">
                        <p className="text-white text-sm font-medium">{tx.description}</p>
                        <p className="text-gray-500 text-xs mt-1">
                          {new Date(tx.created_at).toLocaleString('zh-CN')}
                        </p>
                      </div>
                      <div className={`text-right font-bold ${tx.points_change > 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {tx.points_change > 0 ? '+' : ''}{tx.points_change}
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
                  <div className="w-full h-full bg-gradient-to-br from-yellow-300 via-yellow-400 to-yellow-600 rounded-full shadow-lg shadow-yellow-500/50 flex items-center justify-center">
                    <span className="text-yellow-800 font-bold text-sm">$</span>
                  </div>
                </div>
              ))}
            </div>

            <div className="bg-gradient-to-br from-gray-900 to-gray-800 rounded-3xl p-10 border-4 border-yellow-500 shadow-2xl shadow-yellow-500/30 animate-bounce-in">
              <div className="text-center">
                <div className="w-24 h-24 mx-auto mb-4 bg-gradient-to-br from-yellow-300 via-yellow-400 to-yellow-600 rounded-full flex items-center justify-center shadow-lg shadow-yellow-500/50 animate-pulse">
                  <span className="text-yellow-900 font-black text-5xl">$</span>
                </div>
                <h3 className="text-3xl font-black text-yellow-400 mb-2 animate-shine">充值成功！</h3>
                <p className="text-5xl font-black text-white mb-2">+{rechargeAmount}</p>
                <p className="text-gray-400 text-lg">积分已到账</p>
              </div>
            </div>
          </div>

          <style jsx>{`
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
            @keyframes bounce-in {
              0% {
                transform: scale(0.5);
                opacity: 0;
              }
              50% {
                transform: scale(1.1);
              }
              100% {
                transform: scale(1);
                opacity: 1;
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
            .animate-bounce-in {
              animation: bounce-in 0.5s ease-out forwards;
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

'use client';
import { useState, useEffect } from 'react';
import { supabase } from '@/app/lib/supabase';
import { User } from '@supabase/supabase-js';
import Link from 'next/link';

export default function ProfilePage() {
  const [user, setUser] = useState<User | null>(null);
  const [credits, setCredits] = useState(0);
  const [billingHistory, setBillingHistory] = useState<Array<{
    id: string;
    type: string;
    amount: number;
    description: string;
    created_at: string;
    metadata?: Record<string, unknown>;
  }>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // 获取当前用户
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        setUser(session.user);
        fetchUserData(session.user.id);
      }
    });

    // 监听认证状态变化
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        setUser(session.user);
        fetchUserData(session.user.id);
      } else {
        setUser(null);
        setCredits(0);
        setBillingHistory([]);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const fetchUserData = async (userId: string) => {
    setLoading(true);
    
    // 获取积分
    const { data: profile } = await supabase
      .from('profiles')
      .select('points')
      .eq('id', userId)
      .single();
    
    if (profile) {
      setCredits(profile.points || 0);
    }

    // 获取账单明细
    const { data: history } = await supabase
      .from('billing_history')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    
    if (history) {
      setBillingHistory(history);
    }

    setLoading(false);
  };

  const getTypeLabel = (type: string) => {
    const labels: Record<string, string> = {
      'image_gen': '图片生成',
      'video_gen': '视频生成',
      'recharge': '积分充值',
      'refund': '积分返还',
    };
    return labels[type] || type;
  };

  const getTypeIcon = (type: string) => {
    const icons: Record<string, string> = {
      'image_gen': '🖼️',
      'video_gen': '🎬',
      'recharge': '💵',
      'refund': '🔄',
    };
    return icons[type] || '📝';
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  if (!user) {
    return (
      <div className="min-h-screen bg-[#0F1117] flex items-center justify-center">
        <div className="text-center">
          <p className="text-gray-400 mb-4">请先登录</p>
          <Link href="/" className="text-cyan-500 hover:text-cyan-400">
            返回首页
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0F1117]">
      {/* 顶部导航 */}
      <nav className="bg-[#1A1C1E] border-b border-white/10 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <Link href="/" className="text-xl font-bold text-white flex items-center gap-2">
            <span>🎬</span> VVVideo
          </Link>
          <div className="flex items-center gap-4">
            <Link href="/" className="text-gray-400 hover:text-white transition-colors">
              视频生成
            </Link>
            <Link href="/image-generator" className="text-gray-400 hover:text-white transition-colors">
              图片生成
            </Link>
            <Link href="/profile" className="text-cyan-500 font-medium">
              个人中心
            </Link>
          </div>
        </div>
      </nav>

      {/* 主内容区 */}
      <div className="max-w-4xl mx-auto px-6 py-8">
        {/* 用户信息卡片 */}
        <div className="bg-[#1A1C1E] rounded-2xl p-6 mb-8 border border-white/10">
          <div className="flex items-center gap-6">
            <div className="w-20 h-20 bg-gradient-to-br from-cyan-500 to-blue-500 rounded-full flex items-center justify-center">
              <span className="text-3xl">{user.email?.charAt(0).toUpperCase()}</span>
            </div>
            <div>
              <h2 className="text-2xl font-bold text-white mb-1">{user.email}</h2>
              <p className="text-gray-400 text-sm">用户ID: {user.id.substring(0, 8)}...</p>
            </div>
            <div className="ml-auto text-right">
              <div className="text-sm text-gray-400 mb-1">可用积分</div>
              <div className="text-3xl font-bold text-yellow-400">{credits}</div>
            </div>
          </div>
        </div>

        {/* 账单明细标题 */}
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-xl font-bold text-white">账单明细</h3>
          <button
            onClick={() => fetchUserData(user.id)}
            className="px-4 py-2 bg-[#1A1C1E] border border-white/10 rounded-lg text-gray-400 hover:text-white transition-colors"
          >
            🔄 刷新
          </button>
        </div>

        {/* 账单列表 */}
        {loading ? (
          <div className="text-center py-12">
            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-cyan-500 mx-auto mb-4"></div>
            <p className="text-gray-400">加载中...</p>
          </div>
        ) : billingHistory.length === 0 ? (
          <div className="bg-[#1A1C1E] rounded-2xl p-12 text-center border border-white/10">
            <div className="text-6xl mb-4">📋</div>
            <p className="text-gray-400">暂无账单记录</p>
          </div>
        ) : (
          <div className="space-y-3">
            {billingHistory.map((item) => (
              <div
                key={item.id}
                className="bg-[#1A1C1E] rounded-xl p-4 border border-white/10 hover:border-white/20 transition-colors"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <span className="text-2xl">{getTypeIcon(item.type)}</span>
                    <div>
                      <div className="text-white font-medium">{getTypeLabel(item.type)}</div>
                      <div className="text-gray-500 text-sm">{item.description}</div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className={`text-xl font-bold ${item.amount > 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {item.amount > 0 ? '+' : ''}{item.amount}
                    </div>
                    <div className="text-gray-500 text-sm">{formatDate(item.created_at)}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* 统计信息 */}
        <div className="grid grid-cols-3 gap-4 mt-8">
          <div className="bg-[#1A1C1E] rounded-xl p-4 border border-white/10">
            <div className="text-gray-400 text-sm mb-1">总消费</div>
            <div className="text-xl font-bold text-red-400">
              -{billingHistory.filter(h => h.type === 'image_gen' || h.type === 'video_gen').reduce((sum, h) => sum + Math.abs(h.amount), 0)}
            </div>
          </div>
          <div className="bg-[#1A1C1E] rounded-xl p-4 border border-white/10">
            <div className="text-gray-400 text-sm mb-1">总充值</div>
            <div className="text-xl font-bold text-green-400">
              +{billingHistory.filter(h => h.type === 'recharge').reduce((sum, h) => sum + h.amount, 0)}
            </div>
          </div>
          <div className="bg-[#1A1C1E] rounded-xl p-4 border border-white/10">
            <div className="text-gray-400 text-sm mb-1">总返还</div>
            <div className="text-xl font-bold text-yellow-400">
              +{billingHistory.filter(h => h.type === 'refund').reduce((sum, h) => sum + h.amount, 0)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
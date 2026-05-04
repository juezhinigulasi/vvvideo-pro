import { NextResponse } from 'next/server';
import { supabase } from '@/app/lib/supabase';

export async function GET(request: Request) {
  try {
    const { data: userData, error: authError } = await supabase.auth.getUser();
    
    if (authError || !userData.user) {
      return NextResponse.json({ error: '用户未登录' }, { status: 401 });
    }

    const userId = userData.user.id;

    const { data: transactions, error } = await supabase
      .from('point_transactions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      console.error('获取积分记录失败:', error);
      return NextResponse.json({ error: '获取记录失败' }, { status: 500 });
    }

    return NextResponse.json({ transactions: transactions || [] });
  } catch (error) {
    console.error('请求处理失败:', error);
    return NextResponse.json({ error: '请求处理失败' }, { status: 500 });
  }
}

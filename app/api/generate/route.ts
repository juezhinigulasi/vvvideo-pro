import { NextResponse } from 'next/server';
import { supabase } from '@/app/lib/supabase';
import { supabaseServer } from '@/app/lib/supabase-server';

const API_KEY = process.env.VIDEO_API_KEY || '';
const COST_PER_VIDEO = 3;

export async function POST(request: Request) {
  const startTime = Date.now();

  try {
    const body = await request.json();
    const { prompt, model, input_reference, poll, id, aspect_ratio, duration, user_id } = body;

    console.log('========== 视频生成请求 ==========');
    console.log('poll:', poll, 'id:', id);
    console.log('user_id:', user_id);
    console.log('API_KEY configured:', API_KEY ? 'Yes' : 'No');

    if (!API_KEY) {
      console.error('❌ 环境变量 VIDEO_API_KEY 未配置');
      return NextResponse.json({ error: '服务器配置错误，请联系管理员' }, { status: 500 });
    }

    // 轮询模式 - 查询任务状态
    if (poll && id) {
      return handlePollTask(id, user_id);
    }

    // 新建任务模式 - 创建视频
    if (!prompt) {
      return NextResponse.json({ error: '参数不完整：prompt 是必填项' }, { status: 400 });
    }

    // 检查用户是否登录
    if (!user_id) {
      return NextResponse.json({ error: '用户未登录' }, { status: 401 });
    }

    // 1. 检查并扣除积分
    console.log('🔍 开始检查积分...');
    
    let originalPoints = 0;
    
    try {
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('points')
        .eq('id', user_id)
        .single();

      console.log('📊 查询用户信息结果:', { profile, profileError });

      if (profileError) {
        console.error('❌ 获取用户信息失败:', profileError.message);
        return NextResponse.json({ error: '获取用户信息失败: ' + profileError.message }, { status: 400 });
      }

      if (!profile) {
        console.error('❌ 用户不存在');
        return NextResponse.json({ error: '用户不存在' }, { status: 400 });
      }

      originalPoints = profile.points || 0;
      
      if (originalPoints < COST_PER_VIDEO) {
        console.error('❌ 积分不足:', originalPoints);
        return NextResponse.json({ error: `积分不足！当前积分: ${originalPoints}，需要 ${COST_PER_VIDEO} 积分` }, { status: 400 });
      }

      // 扣减积分（使用服务端密钥绕过 RLS）
      console.log('💰 开始扣减积分:', COST_PER_VIDEO);
      const { error: updateError } = await supabaseServer
        .from('profiles')
        .update({ points: originalPoints - COST_PER_VIDEO })
        .eq('id', user_id);

      if (updateError) {
        console.error('❌ 扣减积分失败:', updateError.message);
        return NextResponse.json({ error: '扣减积分失败: ' + updateError.message }, { status: 500 });
      }

      // 记录账单
      console.log('📝 记录账单...');
      const { error: insertError } = await supabase.from('billing_history').insert({
        user_id,
        type: 'video_gen',
        amount: -COST_PER_VIDEO,
        description: '生成 AI 视频',
      });

      if (insertError) {
        console.error('❌ 记录账单失败:', insertError.message);
        // 返还积分
        await supabase.from('profiles')
          .update({ points: originalPoints })
          .eq('id', user_id);
        return NextResponse.json({ error: '记录账单失败: ' + insertError.message }, { status: 500 });
      }

      console.log('✅ 积分扣除成功');

    } catch (e) {
      console.error('❌ 积分操作异常:', e);
      return NextResponse.json({ error: '积分操作异常: ' + (e as Error).message }, { status: 500 });
    }

    // 2. 调用第三方API创建任务（简化：直接调用，不创建本地任务记录）
    console.log('🌐 开始调用视频生成API...');
    const requestBody = {
      model: model || 'grok-video-3-10s',
      prompt: prompt,
      aspect_ratio: aspect_ratio || '16:9',
      size: '720P',
      images: input_reference ? [input_reference.trim()] : [],
    };

    console.log('📤 请求体:', JSON.stringify(requestBody).substring(0, 100) + '...');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    try {
      const response = await fetch('https://yunwu.ai/v1/video/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEY}`,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      console.log('📡 视频API响应状态:', response.status);

      const responseText = await response.text();
      console.log('📥 视频API响应内容:', responseText.substring(0, 200) + '...');

      if (!response.ok) {
        console.error('❌ 视频API请求失败:', response.status, responseText);
        await refundPoints(user_id, COST_PER_VIDEO, 'API请求失败');
        let errorMessage = '生成失败';
        try {
          const errorJson = JSON.parse(responseText);
          errorMessage = errorJson.error?.message || errorJson.message || errorMessage;
        } catch {}
        return NextResponse.json({ error: errorMessage }, { status: response.status });
      }

      const result = JSON.parse(responseText);
      
      if (result.status === 'completed' && result.video_url) {
        console.log('✅ 视频生成成功');
        return NextResponse.json({ status: 'completed', video_url: result.video_url, cost: COST_PER_VIDEO });
      } else if (result.id) {
        console.log('✅ 视频任务已创建, task_id:', result.id);
        return NextResponse.json({ status: 'pending', id: result.id });
      }

      console.error('❌ 视频API返回格式错误:', result);
      await refundPoints(user_id, COST_PER_VIDEO, 'API返回格式错误');
      return NextResponse.json({ error: '视频生成失败' }, { status: 500 });

    } catch (fetchError) {
      clearTimeout(timeoutId);
      console.error('❌ 网络请求失败:', fetchError);
      await refundPoints(user_id, COST_PER_VIDEO, '网络请求失败');
      return NextResponse.json({ error: '网络请求失败: ' + (fetchError as Error).message }, { status: 500 });
    }

  } catch (error) {
    console.error('❌ 请求处理失败:', error);
    return NextResponse.json({ error: '请求解析失败: ' + (error as Error).message }, { status: 400 });
  }
}

// 轮询任务状态
async function handlePollTask(id: string, userId: string) {
  console.log('🔄 轮询任务状态:', id);
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    // 使用 GET 请求，参数通过 Query String 传递
    const response = await fetch(`https://yunwu.ai/v1/video/query?id=${encodeURIComponent(id)}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${process.env.VIDEO_API_KEY}`,
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const responseText = await response.text();
    console.log('📥 轮询响应状态:', response.status);
    console.log('📥 轮询响应内容:', responseText.substring(0, 300) + '...');

    if (!response.ok) {
      console.error('❌ 轮询任务状态失败:', response.status, responseText);
      let errorMessage = '查询任务状态失败';
      try {
        const errorJson = JSON.parse(responseText);
        errorMessage = errorJson.error?.message || errorJson.message || errorMessage;
      } catch {}
      return NextResponse.json({ error: errorMessage }, { status: response.status });
    }

    const result = JSON.parse(responseText);
    
    console.log('📋 云雾API原始响应:', JSON.stringify(result));
    
    // 统一返回格式，确保与前端期望一致
    // 处理成功状态
    if (result.status === 'completed' || result.status === 'success') {
      const videoUrl = result.video_url || result.url || result.data?.video_url;
      console.log('✅ 视频生成完成，URL:', videoUrl);
      return NextResponse.json({
        status: 'completed',
        video_url: videoUrl,
      });
    }
    // 处理失败状态
    else if (result.status === 'failed' || result.status === 'error') {
      const errorMsg = result.error || result.message || '视频生成失败';
      console.log('❌ 视频生成失败:', errorMsg);
      return NextResponse.json({
        status: 'failed',
        error: errorMsg,
      });
    }
    // 处理进行中状态（包括 pending, processing, running 等）
    else {
      console.log('⏳ 任务进行中，当前状态:', result.status);
      return NextResponse.json({
        status: 'processing',
        current_status: result.status,
      });
    }

  } catch (fetchError) {
    clearTimeout(timeoutId);
    console.error('❌ 轮询请求失败:', fetchError);
    return NextResponse.json({ error: '轮询请求失败: ' + (fetchError as Error).message }, { status: 500 });
  }
}

// 返还积分
async function refundPoints(userId: string, amount: number, reason: string) {
  try {
    const { data: profile } = await supabase
      .from('profiles')
      .select('points')
      .eq('id', userId)
      .single();

    if (profile) {
      await supabase
        .from('profiles')
        .update({ points: (profile.points || 0) + amount })
        .eq('id', userId);

      await supabase.from('billing_history').insert({
        user_id: userId,
        type: 'refund',
        amount: amount,
        description: `返还: ${reason}`,
      });
      console.log('✅ 积分已返还:', amount);
    }
  } catch (e) {
    console.error('❌ 积分返还失败:', e);
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/app/lib/supabase';
import { getSupabaseServer } from '@/app/lib/supabase-server';

const API_KEY = process.env.IMAGE_API_KEY || '';
const COST_PER_IMAGE = 2;

export async function POST(request: NextRequest) {
  try {
    const { prompt, model, size, n = 1, image, user_id } = await request.json();

    console.log('========== 图片生成请求 ==========');
    console.log('user_id:', user_id);
    console.log('prompt:', prompt?.substring(0, 50));
    console.log('API_KEY configured:', API_KEY ? 'Yes' : 'No');

    if (!API_KEY) {
      console.error('❌ 环境变量 IMAGE_API_KEY 未配置');
      return NextResponse.json({ error: '服务器配置错误' }, { status: 500 });
    }

    if (!prompt) {
      return NextResponse.json({ error: '请输入提示词' }, { status: 400 });
    }

    if (!user_id) {
      return NextResponse.json({ error: '请先登录' }, { status: 401 });
    }

    // 1. 检查并扣除积分
    let currentPoints = 0;
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

      if ((profile.points || 0) < COST_PER_IMAGE) {
        console.error('❌ 积分不足:', profile.points);
        return NextResponse.json({ error: `积分不足！当前积分: ${profile.points || 0}，需要 ${COST_PER_IMAGE} 积分` }, { status: 400 });
      }

      currentPoints = profile.points || 0;

      // 扣减积分（使用服务端密钥绕过 RLS）
      const { error: updateError } = await getSupabaseServer()
        .from('profiles')
        .update({ points: currentPoints - COST_PER_IMAGE })
        .eq('id', user_id);

      if (updateError) {
        console.error('❌ 扣减积分失败:', updateError.message);
        return NextResponse.json({ error: '扣减积分失败: ' + updateError.message }, { status: 500 });
      }

      // 记录账单
      const { error: insertError } = await supabase.from('billing_history').insert({
        user_id,
        type: 'image_gen',
        amount: -COST_PER_IMAGE,
        description: '生成 AI 图片',
      });

      if (insertError) {
        console.error('❌ 记录账单失败:', insertError.message);
        await getSupabaseServer().from('profiles')
          .update({ points: currentPoints })
          .eq('id', user_id);
        return NextResponse.json({ error: '记录账单失败: ' + insertError.message }, { status: 500 });
      }

      console.log('✅ 积分扣除成功');

    } catch (e) {
      console.error('❌ 积分操作异常:', e);
      return NextResponse.json({ error: '积分操作异常: ' + (e as Error).message }, { status: 500 });
    }

    // 2. 创建任务记录到数据库
    const taskId = `img_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const { error: taskError } = await supabase.from('tasks').insert({
      id: taskId,
      user_id,
      type: 'image',
      status: 'processing',
      prompt,
      result: null,
      error: null,
    });

    if (taskError) {
      console.error('❌ 创建任务记录失败:', taskError.message);
      await getSupabaseServer().from('profiles')
        .update({ points: currentPoints })
        .eq('id', user_id);
      return NextResponse.json({ error: '创建任务失败: ' + taskError.message }, { status: 500 });
    }

    console.log('📋 创建任务:', taskId);

    // 3. 异步调用第三方API（不等待，立即返回taskId）
    processImageGeneration(taskId, user_id, prompt, model, size, n, image).catch(console.error);

    // 4. 立即返回任务ID，前端开始轮询
    return NextResponse.json({
      status: 'processing',
      taskId,
      message: '任务已创建，请等待生成结果',
    });

  } catch (error) {
    console.error('❌ 请求处理失败:', error);
    return NextResponse.json({ error: '请求解析失败: ' + (error as Error).message }, { status: 400 });
  }
}

// 轮询获取任务状态
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const taskId = searchParams.get('taskId');
  const user_id = searchParams.get('user_id');

  if (!taskId || !user_id) {
    return NextResponse.json({ error: '缺少参数' }, { status: 400 });
  }

  // 从数据库获取任务状态
  const { data: task, error } = await supabase
    .from('tasks')
    .select('*')
    .eq('id', taskId)
    .eq('user_id', user_id)
    .single();

  if (error) {
    console.error('❌ 获取任务状态失败:', error.message);
    return NextResponse.json({ status: 'error', message: error.message });
  }

  if (!task) {
    return NextResponse.json({ status: 'not_found', message: '任务不存在' });
  }

  return NextResponse.json(task);
}

// 异步处理图片生成
async function processImageGeneration(
  taskId: string,
  userId: string,
  prompt: string,
  model?: string,
  size?: string,
  n?: number,
  image?: string[]
) {
  const COST = COST_PER_IMAGE;
  const apiUrl = 'https://yunwu.ai/v1/images/generations';
  const requestBody: Record<string, unknown> = {
    model: model || 'gpt-image-2-all',
    prompt: prompt,
    size: size || '1024x1024',
    n: parseInt(String(n)) || 1,
  };

  if (image && image.length > 0) {
    requestBody.image = image;
    requestBody.mode = 'image-to-image';
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120000);

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    console.log('📡 云雾API响应状态:', response.status);

    const responseText = await response.text();

    if (!response.ok) {
      console.error('❌ 云雾API请求失败:', response.status, responseText);
      await refundPoints(userId, COST, 'API请求失败');
      await updateTaskStatus(taskId, 'failed', null, '生成失败: ' + (JSON.parse(responseText)?.error?.message || '未知错误'));
      return;
    }

    const result = JSON.parse(responseText);
    const images = result.data || result.images || [];
    const urls = images.map((img: { url: string }) => img.url).filter(Boolean);

    if (urls.length === 0) {
      console.error('❌ 未生成任何图片');
      await refundPoints(userId, COST, '未生成任何图片');
      await updateTaskStatus(taskId, 'failed', null, '未生成任何图片');
      return;
    }

    console.log('✅ 图片生成成功:', urls.length, '张图片');
    await updateTaskStatus(taskId, 'completed', urls, null);

  } catch (fetchError) {
    clearTimeout(timeoutId);
    console.error('❌ 网络请求失败:', fetchError);
    await refundPoints(userId, COST, '网络请求失败');
    await updateTaskStatus(taskId, 'failed', null, '网络请求失败: ' + (fetchError as Error).message);
  }
}

// 更新任务状态
async function updateTaskStatus(taskId: string, status: string, urls: string[] | null, error: string | null) {
  const { error: updateError } = await getSupabaseServer()
    .from('tasks')
    .update({
      status,
      result: urls ? urls : null,
      error,
      updated_at: new Date().toISOString(),
    })
    .eq('id', taskId);

  if (updateError) {
    console.error('❌ 更新任务状态失败:', updateError.message);
  } else {
    console.log('📝 任务状态更新:', taskId, status);
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

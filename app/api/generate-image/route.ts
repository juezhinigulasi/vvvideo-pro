import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/app/lib/supabase';
import { getSupabaseServer } from '@/app/lib/supabase-server';

const API_KEY = process.env.IMAGE_API_KEY || '';
const COST_PER_IMAGE = 2;

export async function POST(request: NextRequest) {
  try {
    const { prompt, model, size, n = 1, image, user_id, task_id } = await request.json();

    console.log('========== 图片生成请求 ==========');
    console.log('user_id:', user_id);
    console.log('prompt:', prompt?.substring(0, 50));
    console.log('API_KEY configured:', API_KEY ? 'Yes' : 'No');
    console.log('前端传递的 task_id:', task_id || '未传递');

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

    // 使用前端传递的 task_id 或生成新的
    const taskId = task_id || `img-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

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

      if ((profile.points || 0) < COST_PER_IMAGE) {
        console.error('❌ 积分不足:', profile.points);
        return NextResponse.json({ error: `积分不足！当前积分: ${profile.points || 0}，需要 ${COST_PER_IMAGE} 积分` }, { status: 400 });
      }

      originalPoints = profile.points || 0;

      // 扣减积分（使用服务端密钥绕过 RLS）
      console.log('💰 开始扣减积分:', COST_PER_IMAGE);
      const { error: updateError } = await getSupabaseServer()
        .from('profiles')
        .update({ points: originalPoints - COST_PER_IMAGE })
        .eq('id', user_id);

      if (updateError) {
        console.error('❌ 扣减积分失败:', updateError.message);
        return NextResponse.json({ error: '扣减积分失败: ' + updateError.message }, { status: 500 });
      }

      console.log('✅ 积分扣减成功');

      // 记录账单
      console.log('📝 记录账单...');
      const { error: insertError } = await supabase.from('billing_history').insert({
        user_id,
        type: 'image_gen',
        amount: -COST_PER_IMAGE,
        description: '生成 AI 图片',
      });

      if (insertError) {
        console.error('❌ 记录账单失败:', insertError.message);
        await getSupabaseServer().from('profiles')
          .update({ points: originalPoints })
          .eq('id', user_id);
        return NextResponse.json({ error: '记录账单失败: ' + insertError.message }, { status: 500 });
      }

      console.log('✅ 积分扣除成功');

    } catch (e) {
      console.error('❌ 积分操作异常:', e);
      return NextResponse.json({ error: '积分操作异常: ' + (e as Error).message }, { status: 500 });
    }

    // 2. 创建任务记录（使用前端传递的或生成的 taskId）
    const { error: taskError } = await supabase.from('image_tasks').insert({
      task_id: taskId,
      user_id,
      prompt: prompt.substring(0, 500),
      status: 'processing',
    });

    if (taskError) {
      console.error('❌ 创建任务记录失败:', taskError.message);
      await refundPoints(user_id, COST_PER_IMAGE, '创建任务失败');
      return NextResponse.json({ error: '创建任务失败' }, { status: 500 });
    }

    console.log('✅ 任务创建成功，taskId:', taskId);

    // 3. 异步调用第三方图片生成API（不等待结果）
    processImageGeneration(taskId, user_id, prompt, model, size, n, image, COST_PER_IMAGE);

    // 4. 立即返回任务ID，前端使用轮询查询状态
    return NextResponse.json({ 
      status: 'pending', 
      taskId, 
      message: '任务已创建，请等待生成完成' 
    });

  } catch (error) {
    console.error('❌ 请求处理失败:', error);
    return NextResponse.json({ error: '请求解析失败: ' + (error as Error).message }, { status: 400 });
  }
}

// 查询任务状态
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const taskId = searchParams.get('taskId');
  const user_id = searchParams.get('user_id');

  console.log('========== 查询图片任务状态 ==========');
  console.log('taskId:', taskId);
  console.log('user_id:', user_id);

  if (!taskId || !user_id) {
    return NextResponse.json({ error: '缺少参数' }, { status: 400 });
  }

  const { data: task, error } = await supabase
    .from('image_tasks')
    .select('*')
    .eq('task_id', taskId)
    .eq('user_id', user_id)
    .single();

  if (error) {
    console.error('❌ 查询任务失败:', error.message);
    return NextResponse.json({ error: '查询任务失败' }, { status: 500 });
  }

  if (!task) {
    return NextResponse.json({ status: 'not_found' });
  }

  return NextResponse.json({
    status: task.status,
    taskId: task.task_id,
    urls: task.urls || [],
    error: task.error_message,
    createdAt: task.created_at,
  });
}

// 异步处理图片生成
async function processImageGeneration(
  taskId: string,
  userId: string,
  prompt: string,
  model: string,
  size: string,
  n: number,
  image: string[],
  cost: number
) {
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
      await updateTaskStatus(taskId, 'failed', null, '生成失败');
      await refundPoints(userId, cost, 'API请求失败');
      return;
    }

    const result = JSON.parse(responseText);
    const images = result.data || result.images || [];
    const urls = images.map((img: { url: string }) => img.url).filter(Boolean);

    if (urls.length === 0) {
      console.error('❌ 未生成任何图片');
      await updateTaskStatus(taskId, 'failed', null, '未生成任何图片');
      await refundPoints(userId, cost, '未生成任何图片');
      return;
    }

    console.log('✅ 图片生成成功:', urls.length, '张图片');
    await updateTaskStatus(taskId, 'completed', urls, null);

  } catch (fetchError) {
    clearTimeout(timeoutId);
    console.error('❌ 网络请求失败:', fetchError);
    await updateTaskStatus(taskId, 'failed', null, '网络请求失败');
    await refundPoints(userId, cost, '网络请求失败');
  }
}

// 更新任务状态
async function updateTaskStatus(taskId: string, status: string, urls: string[] | null, errorMessage: string | null) {
  try {
    const updateData: Record<string, unknown> = {
      status,
      updated_at: new Date().toISOString(),
    };

    if (urls) {
      updateData.urls = urls;
    }

    if (errorMessage) {
      updateData.error_message = errorMessage;
    }

    const { error } = await supabase
      .from('image_tasks')
      .update(updateData)
      .eq('task_id', taskId);

    if (error) {
      console.error('❌ 更新任务状态失败:', error.message);
    } else {
      console.log('✅ 任务状态更新成功:', taskId, status);
    }
  } catch (e) {
    console.error('❌ 更新任务状态异常:', e);
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
      await getSupabaseServer()
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

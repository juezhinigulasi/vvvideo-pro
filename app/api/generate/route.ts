import { NextResponse } from 'next/server';
import { supabase } from '@/app/lib/supabase';

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
    console.log('===================================');

    if (!API_KEY) {
      console.error('❌ 环境变量 VIDEO_API_KEY 未配置');
      return NextResponse.json({ error: '服务器配置错误，请联系管理员' }, { status: 500 });
    }

    // 轮询模式 - 查询任务状态
    if (poll && id) {
      return handlePollTask(id);
    }

    // 新建任务模式 - 创建视频
    if (!prompt) {
      return NextResponse.json({ error: '参数不完整：prompt 是必填项' }, { status: 400 });
    }

    // 检查用户是否登录
    if (!user_id) {
      return NextResponse.json({ error: '用户未登录' }, { status: 401 });
    }

    // 1. 创建任务记录（pending状态）
    const { data: task, error: taskError } = await supabase
      .from('tasks')
      .insert({
        user_id,
        type: 'video',
        status: 'pending',
        prompt,
        cost: COST_PER_VIDEO,
        metadata: { model, aspect_ratio, duration, input_reference },
      })
      .select()
      .single();

    if (taskError || !task) {
      console.error('❌ 创建任务记录失败:', taskError);
      return NextResponse.json({ error: '创建任务失败' }, { status: 500 });
    }

    console.log('✅ 任务记录已创建, task_id:', task.id);

    // 2. 使用新的安全扣费函数（原子性操作，同时扣除积分并插入账单记录）
    const deductResult = await supabase.rpc('handle_credit_deduction', {
      p_user_id: user_id,
      p_type: 'video_gen',
      p_amount: COST_PER_VIDEO,
      p_description: '生成 AI 视频',
    });

    if (!deductResult.data?.success) {
      console.error('❌ 扣费失败:', deductResult.data);
      await supabase.from('tasks').update({ status: 'failed', error_message: deductResult.data?.message || '扣费失败' }).eq('id', task.id);
      return NextResponse.json({ error: deductResult.data?.message || '扣费失败' }, { status: 400 });
    }

    console.log('✅ 积分已扣除:', COST_PER_VIDEO);

    // 3. 调用第三方API创建任务
    const requestBody = {
      model: model || 'grok-video-3-10s',
      prompt: prompt,
      aspect_ratio: aspect_ratio || '16:9',
      size: '720P',
      images: input_reference ? [input_reference.trim()] : [],
    };

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
      const responseText = await response.text();

      if (!response.ok) {
        console.error('❌ API请求失败:', response.status, responseText);

        // 返还积分
        await handleRefund(user_id, COST_PER_VIDEO, task.id, 'API请求失败');

        return NextResponse.json({ error: `API请求失败: ${response.status}` }, { status: response.status });
      }

      const result = JSON.parse(responseText);
      const externalTaskId = result.id;

      if (!externalTaskId) {
        console.error('❌ 响应中没有id:', result);
        await handleRefund(user_id, COST_PER_VIDEO, task.id, 'API响应无任务ID');
        return NextResponse.json({ error: '未获取到任务ID' }, { status: 500 });
      }

      // 更新任务状态为processing
      await supabase.from('tasks').update({ status: 'processing', metadata: { ...task.metadata, external_task_id: externalTaskId } }).eq('id', task.id);

      // 4. 轮询等待结果
      const videoUrl = await pollForResult(externalTaskId, task.id, user_id);

      // 5. 下载并上传到Supabase Storage
      const permanentUrl = await uploadToStorage(videoUrl, user_id, 'video');

      // 6. 更新任务状态为success
      await supabase.from('tasks').update({
        status: 'success',
        result_url: permanentUrl,
      }).eq('id', task.id);

      console.log('✅ 视频生成完成，耗时:', Date.now() - startTime, 'ms');

      return NextResponse.json({
        id: task.id,
        status: 'completed',
        video_url: permanentUrl,
        cost: COST_PER_VIDEO,
      });

    } catch (fetchError) {
      clearTimeout(timeoutId);
      console.error('❌ 网络请求失败:', fetchError);
      await handleRefund(user_id, COST_PER_VIDEO, task.id, '网络请求失败');
      return NextResponse.json({ error: '网络请求失败，请稍后重试' }, { status: 500 });
    }

  } catch (error) {
    console.error('❌ 请求处理失败:', error);
    return NextResponse.json({ error: '请求处理失败' }, { status: 500 });
  }
}

// 轮询任务状态
async function handlePollTask(taskId: string) {
  try {
    // 从数据库获取外部任务ID
    const { data: task } = await supabase.from('tasks').select('*').eq('id', taskId).single();

    if (!task) {
      return NextResponse.json({ error: '任务不存在' }, { status: 404 });
    }

    const externalTaskId = task.metadata?.external_task_id;

    if (!externalTaskId) {
      // 任务还在处理中
      if (task.status === 'pending') {
        return NextResponse.json({ status: 'pending', id: taskId });
      }
      return NextResponse.json({ status: task.status, id: taskId });
    }

    // 查询外部API状态
    const response = await fetch(`https://yunwu.ai/v1/video/query?id=${externalTaskId}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${API_KEY}` },
      signal: AbortSignal.timeout(30000),
    });

    const responseText = await response.text();

    if (!response.ok) {
      return NextResponse.json({ status: 'processing', id: taskId });
    }

    const result = JSON.parse(responseText);

    if (result.status === 'completed' || result.status === 'success') {
      const videoUrl = result.video_url || result.url || result.data?.video_url || result.output?.url || result.result?.video_url;

      if (!videoUrl) {
        return NextResponse.json({ status: 'processing', id: taskId });
      }

      // 上传到Supabase Storage
      const permanentUrl = await uploadToStorage(videoUrl, task.user_id, 'video');

      // 更新任务状态
      await supabase.from('tasks').update({
        status: 'success',
        result_url: permanentUrl,
      }).eq('id', taskId);

      return NextResponse.json({
        status: 'completed',
        id: taskId,
        video_url: permanentUrl,
      });
    } else if (result.status === 'failed' || result.status === 'error') {
      // 返还积分
      await handleRefund(task.user_id, COST_PER_VIDEO, taskId, result.error || '视频生成失败');

      return NextResponse.json({
        status: 'failed',
        id: taskId,
        error: result.error || result.message || '视频生成失败',
      });
    }

    return NextResponse.json({ status: result.status || 'processing', id: taskId });

  } catch (error) {
    console.error('❌ 轮询异常:', error);
    return NextResponse.json({ status: 'processing', id: taskId });
  }
}

// 轮询等待结果
async function pollForResult(externalTaskId: string, taskId: string, userId: string): Promise<string> {
  const maxRetries = 60;
  const pollInterval = 5000;

  for (let i = 0; i < maxRetries; i++) {
    await new Promise(resolve => setTimeout(resolve, pollInterval));

    try {
      const response = await fetch(`https://yunwu.ai/v1/video/query?id=${externalTaskId}`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${API_KEY}` },
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) continue;

      const result = JSON.parse(await response.text());

      if (result.status === 'completed' || result.status === 'success') {
        return result.video_url || result.url || result.data?.video_url || result.output?.url || result.result?.video_url;
      }

      if (result.status === 'failed' || result.status === 'error') {
        await handleRefund(userId, COST_PER_VIDEO, taskId, result.error || '视频生成失败');
        throw new Error(result.error || '视频生成失败');
      }

      console.log(`[轮询] 第 ${i + 1}/${maxRetries} 次，状态:`, result.status);

    } catch (error) {
      console.error(`[轮询] 第 ${i + 1} 次异常:`, error);
    }
  }

  throw new Error('视频生成超时');
}

// 使用新的返还函数
async function handleRefund(userId: string, amount: number, taskId: string, reason: string) {
  console.log('🔄 开始返还积分:', amount, '原因:', reason);

  const refundResult = await supabase.rpc('handle_credit_refund', {
    p_user_id: userId,
    p_type: 'video_gen',
    p_amount: amount,
    p_description: `生成失败返还: ${reason}`,
  });

  if (refundResult.data?.success) {
    console.log('✅ 积分已返还:', amount);
    await supabase.from('tasks').update({ status: 'failed', error_message: reason }).eq('id', taskId);
  } else {
    console.error('❌ 积分返还失败:', refundResult.error);
  }
}

// 上传文件到Supabase Storage
async function uploadToStorage(url: string, userId: string, type: 'image' | 'video'): Promise<string> {
  try {
    console.log('📤 开始上传到Supabase Storage:', url);

    // 下载文件
    const response = await fetch(url);
    if (!response.ok) {
      console.error('❌ 下载文件失败');
      return url; // 返回原URL
    }

    const buffer = await response.arrayBuffer();
    const contentType = response.headers.get('content-type') || (type === 'video' ? 'video/mp4' : 'image/png');

    // 生成文件名
    const timestamp = Date.now();
    const extension = type === 'video' ? 'mp4' : 'png';
    const fileName = `${type}s/${userId}/${timestamp}.${extension}`;

    // 上传到Supabase Storage
    const { data, error } = await supabase.storage
      .from('generations')
      .upload(fileName, buffer, {
        contentType,
        upsert: true,
      });

    if (error) {
      console.error('❌ 上传到Storage失败:', error);
      return url; // 返回原URL
    }

    // 获取公开URL
    const { data: urlData } = supabase.storage.from('generations').getPublicUrl(fileName);

    console.log('✅ 上传成功，永久URL:', urlData.publicUrl);
    return urlData.publicUrl;

  } catch (error) {
    console.error('❌ 上传异常:', error);
    return url; // 返回原URL
  }
}
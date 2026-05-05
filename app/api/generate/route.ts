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
    let deductSuccess = true;
    let deductError = '';

    try {
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('points')
        .eq('id', user_id)
        .single();

      if (profileError || !profile) {
        deductError = '获取用户信息失败';
        deductSuccess = false;
      } else if ((profile.points || 0) < COST_PER_VIDEO) {
        deductError = `积分不足！当前积分: ${profile.points || 0}`;
        deductSuccess = false;
      } else {
        // 扣减积分
        const { error: updateError } = await supabase
          .from('profiles')
          .update({ points: (profile.points || 0) - COST_PER_VIDEO })
          .eq('id', user_id);

        if (updateError) {
          deductError = '扣减积分失败';
          deductSuccess = false;
        } else {
          // 记录账单
          await supabase.from('billing_history').insert({
            user_id,
            type: 'video_gen',
            amount: -COST_PER_VIDEO,
            description: '生成 AI 视频',
          });
          console.log('✅ 积分已扣除:', COST_PER_VIDEO);
        }
      }
    } catch (e) {
      deductError = '积分操作异常';
      deductSuccess = false;
    }

    if (!deductSuccess) {
      console.error('❌ 扣费失败:', deductError);
      return NextResponse.json({ error: deductError }, { status: 400 });
    }

    // 2. 创建任务记录（pending状态）
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
      await refundPoints(user_id, COST_PER_VIDEO, '创建任务失败');
      return NextResponse.json({ error: '创建任务失败' }, { status: 500 });
    }

    console.log('✅ 任务记录已创建, task_id:', task.id);

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
        await supabase.from('tasks').update({ status: 'failed', error_message: 'API请求失败' }).eq('id', task.id);
        await refundPoints(user_id, COST_PER_VIDEO, 'API请求失败');

        let errorMessage = '生成失败';
        try {
          const errorJson = JSON.parse(responseText);
          errorMessage = errorJson.error?.message || errorJson.message || errorMessage;
        } catch {}

        return NextResponse.json({ error: errorMessage }, { status: response.status });
      }

      const result = JSON.parse(responseText);
      const taskId = result.task_id || result.id;

      if (!taskId) {
        console.error('❌ API未返回任务ID');
        await supabase.from('tasks').update({ status: 'failed', error_message: 'API未返回任务ID' }).eq('id', task.id);
        await refundPoints(user_id, COST_PER_VIDEO, 'API未返回任务ID');
        return NextResponse.json({ error: 'API未返回任务ID' }, { status: 500 });
      }

      // 更新任务记录，保存外部任务ID
      await supabase.from('tasks').update({ status: 'processing', metadata: { ...task.metadata, external_task_id: taskId } }).eq('id', task.id);

      console.log('✅ 视频任务已创建, 外部ID:', taskId);
      return NextResponse.json({ task_id: task.id, external_task_id: taskId });

    } catch (fetchError) {
      clearTimeout(timeoutId);
      console.error('❌ 网络请求失败:', fetchError);
      await supabase.from('tasks').update({ status: 'failed', error_message: '网络请求失败' }).eq('id', task.id);
      await refundPoints(user_id, COST_PER_VIDEO, '网络请求失败');
      return NextResponse.json({ error: '网络请求失败' }, { status: 500 });
    }

  } catch (error) {
    console.error('❌ 请求处理失败:', error);
    return NextResponse.json({ error: '请求解析失败' }, { status: 400 });
  }
}

// 轮询任务状态
async function handlePollTask(taskId: string, userId: string) {
  try {
    const { data: task, error: taskError } = await supabase
      .from('tasks')
      .select('*')
      .eq('id', taskId)
      .single();

    if (taskError || !task) {
      console.error('❌ 查询任务失败:', taskError);
      return NextResponse.json({ error: '任务不存在' }, { status: 404 });
    }

    // 如果任务已完成或失败，直接返回状态
    if (task.status === 'success' || task.status === 'failed') {
      return NextResponse.json({
        status: task.status,
        url: task.result_url,
        error: task.error_message,
      });
    }

    // 如果是pending或processing状态，查询外部API
    const externalTaskId = task.metadata?.external_task_id;
    if (!externalTaskId) {
      return NextResponse.json({ status: task.status });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch(`https://yunwu.ai/v1/video/status/${externalTaskId}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      const responseText = await response.text();

      if (!response.ok) {
        console.error('❌ 查询任务状态失败:', response.status, responseText);
        return NextResponse.json({ status: 'error' }, { status: response.status });
      }

      const result = JSON.parse(responseText);
      const status = result.status?.toLowerCase() || result.state?.toLowerCase();
      const videoUrl = result.url || result.video_url;

      // 更新本地任务状态
      let newStatus = task.status;

      if (status === 'completed' || status === 'success') {
        newStatus = 'success';
        await supabase.from('tasks').update({ status: 'success', result_url: videoUrl, updated_at: new Date() }).eq('id', taskId);
      } else if (status === 'failed' || status === 'error') {
        newStatus = 'failed';
        const errorMsg = result.message || result.error || '生成失败';
        await supabase.from('tasks').update({ status: 'failed', error_message: errorMsg, updated_at: new Date() }).eq('id', taskId);
        await refundPoints(userId, task.cost || COST_PER_VIDEO, '视频生成失败');
      } else if (status === 'processing' || status === 'pending') {
        newStatus = 'processing';
      }

      return NextResponse.json({
        status: newStatus,
        url: newStatus === 'success' ? videoUrl : null,
        error: newStatus === 'failed' ? (result.message || result.error || '生成失败') : null,
      });

    } catch (fetchError) {
      clearTimeout(timeoutId);
      console.error('❌ 轮询请求失败:', fetchError);
      return NextResponse.json({ status: 'error' }, { status: 500 });
    }

  } catch (error) {
    console.error('❌ 轮询处理失败:', error);
    return NextResponse.json({ error: '轮询失败' }, { status: 400 });
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

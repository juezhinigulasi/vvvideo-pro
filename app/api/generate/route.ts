import { NextResponse } from 'next/server';
import { supabase } from '@/app/lib/supabase';
import { getSupabaseServer } from '@/app/lib/supabase-server';

const GROK_API_KEY = process.env.GROK_API_KEY || '';
const VEO_API_KEY = process.env.VEO_API_KEY || '';
const COST_PER_VIDEO = 3;

// 模型映射：前端模型 -> 云雾API模型
const MODEL_MAPPING: Record<string, string> = {
  'grok-video-3-10s': 'grok-video-3-10s',
  'veo': 'veo_3_1-fast',
  'veo-4k': 'veo_3_1-fast-4K',
};

// 判断是否为VEO系列模型
const isVeoModel = (model: string): boolean => {
  return model === 'veo' || model === 'veo-4k' || model?.startsWith('veo');
};

// 获取当前模型对应的API密钥
const getApiKey = (model: string): string => {
  if (isVeoModel(model)) {
    return VEO_API_KEY;
  }
  return GROK_API_KEY;
};

export async function POST(request: Request) {
  const startTime = Date.now();

  try {
    const body = await request.json();
    const { prompt, model, input_reference, poll, id, aspect_ratio, duration, user_id } = body;

    console.log('========== 视频生成请求 ==========');
    console.log('poll:', poll, 'id:', id);
    console.log('user_id:', user_id);
    const currentApiKey = getApiKey(model || '');
    console.log('📋 当前模型:', model, '使用密钥:', currentApiKey ? '已配置' : '未配置');

    if (!currentApiKey) {
      const keyName = isVeoModel(model || '') ? 'VEO_API_KEY' : 'GROK_API_KEY';
      console.error('❌ 环境变量', keyName, '未配置');
      return NextResponse.json({ error: '服务器配置错误，请联系管理员' }, { status: 500 });
    }

    // 轮询模式 - 查询任务状态
    if (poll && id) {
      return handlePollTask(id, user_id, model || '');
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
      const { error: updateError } = await getSupabaseServer()
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
        // 返还积分（使用服务端密钥）
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

    // 2. 调用第三方API创建任务（简化：直接调用，不创建本地任务记录）
    console.log('🌐 开始调用视频生成API...');
    
    // 获取映射后的云雾API模型
    const apiModel = MODEL_MAPPING[model || 'grok-video-3-10s'] || 'grok-video-3-10s';
    console.log('📋 使用模型:', apiModel, '(前端模型:', model, ')');
    
    // 根据模型类型构建请求体
    // VEO模型使用新API格式，Grok模型使用原有格式
    let requestBody: Record<string, unknown>;
    
    if (isVeoModel(model || '')) {
      // VEO系列模型：使用新API格式
      requestBody = {
        model: apiModel,
        prompt: prompt,
        images: input_reference ? [input_reference.trim()] : [],
        enhance_prompt: true,
        enable_upsample: true,
        aspect_ratio: aspect_ratio || '16:9',
      };
    } else {
      // Grok模型：使用原有格式
      requestBody = {
        model: apiModel,
        prompt: prompt,
        aspect_ratio: aspect_ratio || '16:9',
        size: '720P',
        images: input_reference ? [input_reference.trim()] : [],
      };
    }

    console.log('📤 请求体:', JSON.stringify(requestBody));

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    try {
      const response = await fetch('https://yunwu.ai/v1/video/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${currentApiKey}`,
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
async function handlePollTask(id: string, userId: string, model: string = '') {
  console.log('🔄 轮询任务状态:', id, '模型:', model);
  
  // 根据模型获取对应的API密钥
  const apiKey = getApiKey(model);
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    // 使用 GET 请求，参数通过 Query String 传递
    const response = await fetch(`https://yunwu.ai/v1/video/query?id=${encodeURIComponent(id)}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
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
    console.log('📋 云雾API状态:', result.status);
    
    // 处理成功状态
    if (result.status === 'completed' || result.status === 'success' || result.status === 'succeeded') {
      // 从多个可能的字段提取视频URL
      const videoUrl = 
        result.video_url || 
        result.url || 
        result.data?.video_url ||
        (result.detail?.video_url) ||
        (result.detail?.url);
      console.log('✅ 视频生成完成，URL:', videoUrl);
      
      if (!videoUrl) {
        console.error('❌ 视频生成成功但未返回视频URL');
        await refundPoints(userId, COST_PER_VIDEO, '视频生成成功但未返回URL');
        return NextResponse.json({ 
          status: 'failed', 
          error: '视频生成成功但未返回视频URL',
          refunded: true 
        });
      }
      
      return NextResponse.json({
        status: 'completed',
        video_url: videoUrl,
      });
    }
    
    // 定义所有可能的失败状态
    const failedStatuses = ['failed', 'error', 'expired', 'timeout', 'cancelled', 'canceled', 'aborted', 'rejected'];
    
    // 处理失败状态 - 需要返还积分
    if (failedStatuses.includes(result.status) || result.status?.toLowerCase().includes('fail') || result.status?.toLowerCase().includes('error')) {
      // 从多个字段提取错误信息
      const errorMsg = 
        result.error_message || 
        result.error || 
        result.message || 
        result.reason || 
        (result.detail?.error_message) ||
        (result.detail?.message) ||
        `视频生成失败: ${result.status}`;
      console.log('❌ 视频生成失败:', errorMsg, '原始状态:', result.status);
      
      // 返还积分并记录账单
      await refundPoints(userId, COST_PER_VIDEO, errorMsg);
      
      return NextResponse.json({
        status: 'failed',
        error: errorMsg,
        refunded: true,
      });
    }
    
    // 处理进行中状态（包括 pending, processing, running 等）
    console.log('⏳ 任务进行中，当前状态:', result.status);
    return NextResponse.json({
      status: 'processing',
      current_status: result.status,
    });

  } catch (fetchError) {
    clearTimeout(timeoutId);
    console.error('❌ 轮询请求失败:', fetchError);
    return NextResponse.json({ error: '轮询请求失败: ' + (fetchError as Error).message }, { status: 500 });
  }
}

// 返还积分
async function refundPoints(userId: string, amount: number, reason: string) {
  console.log('🔄 开始返还积分:', { userId, amount, reason });
  
  try {
    // 使用服务端客户端查询用户信息（不受RLS限制）
    const serverClient = getSupabaseServer();
    const { data: profile, error: profileError } = await serverClient
      .from('profiles')
      .select('points')
      .eq('id', userId)
      .single();

    if (profileError) {
      console.error('❌ 查询用户信息失败:', profileError);
      return;
    }

    console.log('📊 用户当前积分:', profile?.points);

    if (profile) {
      const newPoints = (profile.points || 0) + amount;
      console.log('💰 返还后积分:', newPoints);
      
      // 使用服务端客户端更新积分（不受RLS限制）
      const { error: updateError } = await serverClient
        .from('profiles')
        .update({ points: newPoints })
        .eq('id', userId);

      if (updateError) {
        console.error('❌ 更新积分失败:', updateError);
        return;
      }

      console.log('✅ 积分更新成功');

      // 记录账单
      const { error: insertError } = await supabase.from('billing_history').insert({
        user_id: userId,
        type: 'refund',
        amount: amount,
        description: `返还: ${reason}`,
      });

      if (insertError) {
        console.error('❌ 记录账单失败:', insertError);
      } else {
        console.log('✅ 账单记录成功');
      }
    } else {
      console.error('❌ 未找到用户档案');
    }
  } catch (e) {
    console.error('❌ 积分返还异常:', e);
  }
}

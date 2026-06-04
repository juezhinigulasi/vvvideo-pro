import { NextResponse } from 'next/server';
import { supabase } from '@/app/lib/supabase';
import { getSupabaseServer } from '@/app/lib/supabase-server';
import COS from 'cos-nodejs-sdk-v5';

// 内存缓存：存储已处理的任务ID和对应的COS URL，防止重复上传
interface CachedTask {
  cosUrl: string;
  originalUrl: string;
  createdAt: number;
}

const taskCache = new Map<string, CachedTask>();
const CACHE_EXPIRE_MS = 7 * 24 * 60 * 60 * 1000; // 缓存7天

// 上传锁：防止同一任务重复上传
const uploadingTasks = new Set<string>();

// 清理过期缓存（每小时执行一次）
setInterval(() => {
  const now = Date.now();
  for (const [taskId, cache] of taskCache.entries()) {
    if (now - cache.createdAt > CACHE_EXPIRE_MS) {
      taskCache.delete(taskId);
    }
  }
}, 60 * 60 * 1000);

const GROK_API_KEY = process.env.GROK_API_KEY || '';
const VEO_API_KEY = process.env.VEO_API_KEY || '';
const RUNNINGHUB_API_KEY = process.env.RUNNINGHUB_API_KEY || '';
const COST_PER_VIDEO = 3;

// 腾讯云COS配置
const cosConfig = {
  SecretId: process.env.COS_SECRET_ID || '',
  SecretKey: process.env.COS_SECRET_KEY || '',
  Bucket: process.env.COS_BUCKET || '',
  Region: process.env.COS_REGION || 'ap-guangzhou'
};

// 初始化COS实例
let cosInstance: COS | null = null;
if (cosConfig.SecretId && cosConfig.SecretKey) {
  cosInstance = new COS({
    SecretId: cosConfig.SecretId,
    SecretKey: cosConfig.SecretKey
  });
}

// 上传视频到COS（含任务缓存检查+上传锁）- 强制要求taskId
async function uploadVideoToCOS(videoUrl: string, taskId: string): Promise<string> {
  if (!cosInstance) {
    console.warn('COS未配置，返回原始URL');
    return videoUrl;
  }

  // 1. 检查缓存：如果该任务已经上传过（cosUrl不为空），直接返回缓存的URL
  const cached = taskCache.get(taskId);
  if (cached && cached.cosUrl) {
    console.log('🔄 【缓存命中】使用已缓存的COS URL，防止重复上传:', taskId);
    return cached.cosUrl;
  }

  // 2. 检查上传锁：如果正在上传中，等待并返回已有结果
  if (uploadingTasks.has(taskId)) {
    console.log('🔒 【上传锁】检测到任务正在上传中，等待...', taskId);
    // 等待100ms后再次检查缓存
    await new Promise(resolve => setTimeout(resolve, 100));
    const cachedWait = taskCache.get(taskId);
    if (cachedWait && cachedWait.cosUrl) {
      console.log('🔄 【等待完成】任务上传完成，返回缓存URL:', taskId);
      return cachedWait.cosUrl;
    }
    // 100ms后还没上传完，暂时返回原始URL（避免阻塞）
    console.warn('⏳ 【超时】上传等待超时，暂时返回原始URL:', taskId);
    return videoUrl;
  }

  // 3. 获取上传锁
  uploadingTasks.add(taskId);
  console.log('📤 【获取锁】开始上传视频到COS，taskId:', taskId, 'videoUrl:', videoUrl.substring(0, 50) + '...');

  // 标记为正在上传
  taskCache.set(taskId, {
    cosUrl: '', // 临时标记，表示正在上传中
    originalUrl: videoUrl,
    createdAt: Date.now()
  });

  // 下载视频
  const videoResponse = await fetch(videoUrl);
  if (!videoResponse.ok) {
    console.error('下载视频失败:', videoResponse.status);
    return videoUrl;
  }

  const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());
  // 关键修复：用 taskId 代替时间戳作为文件名！
  // 即使多次上传也只会覆盖同一个文件，不会产生重复文件！
  const fileName = `video_${taskId}.mp4`;
  const key = `videos/${fileName}`;

  // 上传到COS
  return new Promise((resolve, reject) => {
    cosInstance!.putObject({
      Bucket: cosConfig.Bucket,
      Region: cosConfig.Region,
      Key: key,
      Body: videoBuffer,
      ContentLength: videoBuffer.length
    }, async (err, data) => {
      if (err) {
        console.error('❌ 上传到COS失败:', err);
        // 释放上传锁
        uploadingTasks.delete(taskId);
        reject(err);
      } else {
        console.log('✅ 上传到COS成功:', key);
        // 获取临时签名URL（3天有效期）
        cosInstance!.getObjectUrl({
          Bucket: cosConfig.Bucket,
          Region: cosConfig.Region,
          Key: key,
          Sign: true,
          Expires: 259200
        }, (urlErr, urlData) => {
          if (urlErr) {
            console.error('❌ 获取临时URL失败:', urlErr);
            // 释放上传锁
            uploadingTasks.delete(taskId);
            reject(urlErr);
          } else {
            console.log('✅ 获取临时URL成功:', urlData.Url);
            // 上传成功后保存到缓存
            taskCache.set(taskId, {
              cosUrl: urlData.Url,
              originalUrl: videoUrl,
              createdAt: Date.now()
            });
            console.log('💾 已将任务缓存，防止重复上传:', taskId);
            // 释放上传锁
            uploadingTasks.delete(taskId);
            console.log('🔓 【释放锁】任务上传完成，释放锁:', taskId);
            resolve(urlData.Url);
          }
        });
      }
    });
  });
}

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

// 判断是否为Running Hub模型
const isRunningHubModel = (model: string): boolean => {
  return model === 'grok-backup';
};

// 获取当前模型对应的API密钥
const getApiKey = (model: string): string => {
  if (isVeoModel(model)) {
    return VEO_API_KEY;
  }
  if (isRunningHubModel(model)) {
    return RUNNINGHUB_API_KEY;
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
      // 轮询时必须提供 model 参数，否则无法确定使用哪个API
      if (!model) {
        console.error('❌ 轮询请求缺少 model 参数');
        return NextResponse.json({ error: '轮询请求缺少 model 参数' }, { status: 400 });
      }
      return handlePollTask(id, user_id, model);
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
    // VEO模型使用新API格式，Grok模型使用原有格式，Running Hub使用自己的格式
    let requestBody: Record<string, unknown>;
    let apiUrl = 'https://yunwu.ai/v1/video/create'; // 默认云雾API
    
    if (isRunningHubModel(model || '')) {
      // Running Hub模型：使用image-to-video接口格式
      apiUrl = 'https://www.runninghub.cn/openapi/v2/rhart-video-g/image-to-video';
      requestBody = {
        prompt: prompt,
        imageUrls: input_reference ? [input_reference.trim()] : [],
        aspectRatio: aspect_ratio || '16:9',
        resolution: '720p',
        duration: duration || 10,
      };
    } else if (isVeoModel(model || '')) {
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
      const response = await fetch(apiUrl, {
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
      
      // Running Hub直接返回taskId，状态为QUEUED/RUNNING/SUCCESS/FAILED
      if (isRunningHubModel(model || '') && result.taskId) {
        console.log('✅ Running Hub任务已创建, task_id:', result.taskId);
        return NextResponse.json({ status: 'pending', id: result.taskId });
      }

      if (result.status === 'completed' && result.video_url) {
        console.log('✅ 视频生成成功');
        const taskId = result.id || result.taskId; // 兼容不同API的ID字段
        if (!taskId) {
          console.error('❌ 视频生成成功但缺少任务ID');
          return NextResponse.json({ status: 'completed', video_url: result.video_url, cost: COST_PER_VIDEO });
        }
        try {
          const cosVideoUrl = await uploadVideoToCOS(result.video_url, taskId);
          console.log('✅ 视频上传到COS成功:', cosVideoUrl);
          return NextResponse.json({ status: 'completed', video_url: cosVideoUrl, cost: COST_PER_VIDEO });
        } catch (uploadErr) {
          console.error('❌ 上传到COS失败，使用原始URL:', uploadErr);
          return NextResponse.json({ status: 'completed', video_url: result.video_url, cost: COST_PER_VIDEO });
        }
      } else if (result.id || result.taskId) {
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
    let response;
    
    // 根据模型类型选择不同的查询方式
    if (isRunningHubModel(model)) {
      // Running Hub使用POST请求查询
      const runningHubBody = { taskId: id };
      console.log('📤 Running Hub查询请求体:', JSON.stringify(runningHubBody));
      response = await fetch('https://www.runninghub.cn/openapi/v2/query', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(runningHubBody),
        signal: controller.signal,
      });
    } else {
      // 云雾API使用GET请求
      response = await fetch(`https://yunwu.ai/v1/video/query?id=${encodeURIComponent(id)}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
        signal: controller.signal,
      });
    }

    clearTimeout(timeoutId);
    const responseText = await response.text();
    console.log('📥 轮询响应状态:', response.status);
    console.log('📥 轮询响应内容:', responseText.substring(0, 300) + '...');

    if (!response.ok) {
      console.error('❌ 轮询任务状态失败:', response.status);
      console.error('❌ 完整错误响应:', responseText);
      let errorMessage = '查询任务状态失败';
      try {
        const errorJson = JSON.parse(responseText);
        console.error('❌ 解析后的错误JSON:', JSON.stringify(errorJson, null, 2));
        errorMessage = errorJson.error?.message || errorJson.message || errorJson.msg || errorMessage;
      } catch (parseError) {
        console.error('❌ 解析错误响应失败:', parseError);
        errorMessage = responseText || errorMessage;
      }
      return NextResponse.json({ error: errorMessage }, { status: response.status });
    }

    const result = JSON.parse(responseText);
    
    console.log('📋 API原始响应:', JSON.stringify(result, null, 2));
    console.log('📋 API状态:', result.status);
    console.log('📋 API响应类型:', typeof result);
    console.log('📋 API响应所有键:', result && typeof result === 'object' ? Object.keys(result) : 'N/A');
    
    // 处理Running Hub成功状态
    if (isRunningHubModel(model)) {
      console.log('🔍 检测到Running Hub模型，状态:', result.status);
      
      if (result.status === 'SUCCESS' || result.status === 'success' || result.status === 'completed') {
        // Running Hub从多个可能的字段提取视频URL
        console.log('🔍 尝试提取视频URL...');
        console.log('   - result.url:', result.url);
        console.log('   - result.videoUrl:', result.videoUrl);
        console.log('   - result.results:', result.results);
        console.log('   - result.data:', result.data);
        
        const videoUrl = 
          result.url || 
          result.videoUrl || 
          (result.results?.[0]?.url) ||      // 注意：是 results 复数！
          (result.results?.[0]?.videoUrl) ||
          (result.result?.[0]?.url) ||       // 兼容单数形式
          (result.result?.[0]?.videoUrl) ||
          (result.data?.url) ||
          (result.data?.videoUrl) ||
          (result.output?.url) ||
          (result.output?.videoUrl);
        console.log('✅ Running Hub视频生成完成，提取到的URL:', videoUrl);
        
        if (!videoUrl) {
          console.error('❌ 视频生成成功但未返回视频URL');
          await refundPoints(userId, COST_PER_VIDEO, '视频生成成功但未返回URL');
          return NextResponse.json({ 
            status: 'failed', 
            error: '视频生成成功但未返回视频URL',
            refunded: true 
          });
        }
        
        // 上传到COS（传入taskId防止重复）
        try {
          const cosVideoUrl = await uploadVideoToCOS(videoUrl, id);
          console.log('✅ Running Hub视频上传到COS成功:', cosVideoUrl);
          return NextResponse.json({
            status: 'completed',
            video_url: cosVideoUrl,
          });
        } catch (uploadErr) {
          console.error('❌ 上传到COS失败，使用原始URL:', uploadErr);
          return NextResponse.json({
            status: 'completed',
            video_url: videoUrl,
          });
        }
      }
      
      // Running Hub失败状态
      if (result.status === 'FAILED') {
        const errorMsg = result.failReason || result.error || result.message || `视频生成失败: ${result.status}`;
        console.log('❌ Running Hub视频生成失败:', errorMsg);
        await refundPoints(userId, COST_PER_VIDEO, errorMsg);
        return NextResponse.json({
          status: 'failed',
          error: errorMsg,
          refunded: true,
        });
      }
      
      // Running Hub进行中状态
      if (result.status === 'QUEUED' || result.status === 'RUNNING') {
        console.log('⏳ Running Hub任务进行中，当前状态:', result.status);
        return NextResponse.json({
          status: 'processing',
          current_status: result.status,
        });
      }
    }
    
    // 处理云雾API成功状态
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
      
      // 上传到COS（传入taskId防止重复）
      try {
        const cosVideoUrl = await uploadVideoToCOS(videoUrl, id);
        console.log('✅ 云雾API视频上传到COS成功:', cosVideoUrl);
        return NextResponse.json({
          status: 'completed',
          video_url: cosVideoUrl,
        });
      } catch (uploadErr) {
        console.error('❌ 上传到COS失败，使用原始URL:', uploadErr);
        return NextResponse.json({
          status: 'completed',
          video_url: videoUrl,
        });
      }
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

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '20mb',
    },
  },
};

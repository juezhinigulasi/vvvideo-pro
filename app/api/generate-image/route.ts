import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/app/lib/supabase';

const API_KEY = process.env.IMAGE_API_KEY || '';
const COST_PER_IMAGE = 2;

export async function POST(request: NextRequest) {
  const startTime = Date.now();

  try {
    const { prompt, model, size, n = 1, image, user_id } = await request.json();

    console.log('========== 图片生成请求 ==========');
    console.log('user_id:', user_id);
    console.log('prompt:', prompt?.substring(0, 50));
    console.log('mode:', image ? 'image-to-image' : 'text-to-image');
    console.log('===================================');

    if (!API_KEY) {
      console.error('❌ 环境变量 IMAGE_API_KEY 未配置');
      return NextResponse.json({ error: '服务器配置错误，请联系管理员' }, { status: 500 });
    }

    if (!prompt) {
      return NextResponse.json({ error: '参数不完整：prompt 是必填项' }, { status: 400 });
    }

    if (!user_id) {
      return NextResponse.json({ error: '用户未登录' }, { status: 401 });
    }

    // 1. 创建任务记录
    const { data: task, error: taskError } = await supabase
      .from('tasks')
      .insert({
        user_id,
        type: 'image',
        status: 'pending',
        prompt,
        cost: COST_PER_IMAGE,
        metadata: { model, size, n, hasImage: !!image },
      })
      .select()
      .single();

    if (taskError || !task) {
      console.error('❌ 创建任务记录失败:', taskError);
      return NextResponse.json({ error: '创建任务失败' }, { status: 500 });
    }

    console.log('✅ 任务记录已创建, task_id:', task.id);

    // 2. 扣减积分
    const deductResult = await supabase.rpc('deduct_credits', {
      user_id,
      amount: COST_PER_IMAGE,
    });

    if (!deductResult.data?.success) {
      console.error('❌ 积分不足:', deductResult.data);
      await supabase.from('tasks').update({ status: 'failed', error_message: '积分不足' }).eq('id', task.id);
      return NextResponse.json({ error: '积分不足' }, { status: 400 });
    }

    console.log('✅ 积分已扣除:', COST_PER_IMAGE);

    // 3. 添加积分消费记录
    await supabase.from('point_transactions').insert({
      user_id,
      type: 'consume',
      amount: COST_PER_IMAGE,
      description: '生成图片',
      metadata: { task_id: task.id, prompt: prompt?.substring(0, 100) },
    });

    // 4. 调用第三方API
    const apiUrl = 'https://api.yunwu.ai/v1/images/generations';

    const requestBody: Record<string, unknown> = {
      model: model || 'gpt-image-2-all',
      prompt: prompt,
      size: size || '1024x1024',
      n: n,
      response_format: 'url',
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
          'Authorization': `Bearer ${API_KEY}`,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      const responseText = await response.text();

      if (!response.ok) {
        console.error('❌ API请求失败:', response.status, responseText);

        let errorMessage = 'API请求失败';
        try {
          const errorJson = JSON.parse(responseText);
          errorMessage = errorJson.error?.message || errorJson.message || errorJson.error || errorMessage;
        } catch {}

        await refundCredits(user_id, COST_PER_IMAGE, task.id, errorMessage);

        return NextResponse.json({ error: errorMessage }, { status: response.status });
      }

      const result = JSON.parse(responseText);
      const images = result.data || result.images || [];
      const urls = images.map((img: { url: string }) => img.url).filter(Boolean);

      if (urls.length === 0) {
        console.error('❌ 未生成任何图片');
        await refundCredits(user_id, COST_PER_IMAGE, task.id, '未生成任何图片');
        return NextResponse.json({ error: '未生成任何图片' }, { status: 500 });
      }

      console.log('✅ 图片生成成功，数量:', urls.length);

      // 5. 上传到Supabase Storage获取永久URL
      const permanentUrls: string[] = [];
      for (const url of urls) {
        const permanentUrl = await uploadToStorage(url, user_id, 'image');
        permanentUrls.push(permanentUrl);
      }

      // 6. 更新任务状态
      await supabase.from('tasks').update({
        status: 'success',
        result_url: permanentUrls.join(','),
      }).eq('id', task.id);

      console.log('✅ 图片生成完成，耗时:', Date.now() - startTime, 'ms');

      return NextResponse.json({
        status: 'completed',
        urls: permanentUrls,
        cost: COST_PER_IMAGE,
      });

    } catch (fetchError) {
      clearTimeout(timeoutId);
      console.error('❌ 网络请求失败:', fetchError);
      await refundCredits(user_id, COST_PER_IMAGE, task.id, '网络请求失败');
      return NextResponse.json({ error: '网络请求失败，请稍后重试' }, { status: 500 });
    }

  } catch (error) {
    console.error('❌ 请求处理失败:', error);
    return NextResponse.json({ error: '请求解析失败' }, { status: 400 });
  }
}

// 返还积分
async function refundCredits(userId: string, amount: number, taskId: string, reason: string) {
  console.log('🔄 开始返还积分:', amount, '原因:', reason);

  const refundResult = await supabase.rpc('refund_credits', {
    user_id: userId,
    amount: amount,
  });

  if (refundResult.data?.success) {
    console.log('✅ 积分已返还:', amount);

    await supabase.from('point_transactions').insert({
      user_id: userId,
      type: 'refund',
      amount: amount,
      description: `生成失败返还: ${reason}`,
      metadata: { task_id: taskId },
    });

    await supabase.from('tasks').update({ status: 'failed', error_message: reason }).eq('id', taskId);
  } else {
    console.error('❌ 积分返还失败:', refundResult.error);
  }
}

// 上传文件到Supabase Storage
async function uploadToStorage(url: string, userId: string, type: 'image' | 'video'): Promise<string> {
  try {
    console.log('📤 开始上传到Supabase Storage:', url);

    const response = await fetch(url);
    if (!response.ok) {
      console.error('❌ 下载文件失败');
      return url;
    }

    const buffer = await response.arrayBuffer();
    const contentType = response.headers.get('content-type') || 'image/png';

    const timestamp = Date.now();
    const extension = type === 'video' ? 'mp4' : 'png';
    const fileName = `${type}s/${userId}/${timestamp}.${extension}`;

    const { data, error } = await supabase.storage
      .from('generations')
      .upload(fileName, buffer, {
        contentType,
        upsert: true,
      });

    if (error) {
      console.error('❌ 上传到Storage失败:', error);
      return url;
    }

    const { data: urlData } = supabase.storage.from('generations').getPublicUrl(fileName);

    console.log('✅ 上传成功，永久URL:', urlData.publicUrl);
    return urlData.publicUrl;

  } catch (error) {
    console.error('❌ 上传异常:', error);
    return url;
  }
}

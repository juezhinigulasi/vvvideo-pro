import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/app/lib/supabase';

const API_KEY = process.env.IMAGE_API_KEY || '';
const COST_PER_IMAGE = 2;

export async function POST(request: NextRequest) {
  try {
    const { prompt, model, size, n = 1, image, user_id } = await request.json();

    console.log('========== 图片生成请求 ==========');
    console.log('user_id:', user_id);
    console.log('prompt:', prompt?.substring(0, 50));
    console.log('mode:', image ? 'image-to-image' : 'text-to-image');

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

    // 1. 使用安全扣费函数（原子性操作，同时扣除积分并插入账单记录）
    const deductResult = await supabase.rpc('handle_credit_deduction', {
      p_user_id: user_id,
      p_type: 'image_gen',
      p_amount: COST_PER_IMAGE,
      p_description: '生成 AI 图片',
    });

    if (!deductResult.data?.success) {
      console.error('❌ 扣费失败:', deductResult.data);
      const message = deductResult.data?.message || '扣费失败';
      return NextResponse.json({ error: message }, { status: 400 });
    }

    console.log('✅ 积分已扣除:', COST_PER_IMAGE);

    // 2. 调用第三方API
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

        await handleRefund(user_id, COST_PER_IMAGE, errorMessage);
        return NextResponse.json({ error: errorMessage }, { status: response.status });
      }

      const result = JSON.parse(responseText);
      const images = result.data || result.images || [];
      const urls = images.map((img: { url: string }) => img.url).filter(Boolean);

      if (urls.length === 0) {
        console.error('❌ 未生成任何图片');
        await handleRefund(user_id, COST_PER_IMAGE, '未生成任何图片');
        return NextResponse.json({ error: '未生成任何图片' }, { status: 500 });
      }

      console.log('✅ 图片生成成功，数量:', urls.length);

      // 3. 上传到Supabase Storage获取永久URL
      const permanentUrls: string[] = [];
      for (const url of urls) {
        const permanentUrl = await uploadToStorage(url, user_id, 'image');
        permanentUrls.push(permanentUrl);
      }

      console.log('✅ 图片生成完成');

      return NextResponse.json({
        status: 'completed',
        urls: permanentUrls,
        cost: COST_PER_IMAGE,
      });

    } catch (fetchError) {
      clearTimeout(timeoutId);
      console.error('❌ 网络请求失败:', fetchError);
      await handleRefund(user_id, COST_PER_IMAGE, '网络请求失败');
      return NextResponse.json({ error: '网络请求失败，请稍后重试' }, { status: 500 });
    }

  } catch (error) {
    console.error('❌ 请求处理失败:', error);
    return NextResponse.json({ error: '请求解析失败' }, { status: 400 });
  }
}

// 积分返还函数
async function handleRefund(userId: string, amount: number, reason: string) {
  console.log('🔄 开始返还积分:', amount, '原因:', reason);

  const refundResult = await supabase.rpc('handle_credit_refund', {
    p_user_id: userId,
    p_type: 'image_gen',
    p_amount: amount,
    p_description: `生成失败返还: ${reason}`,
  });

  if (refundResult.data?.success) {
    console.log('✅ 积分已返还:', amount);
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

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

    // 检查 API Key
    if (!API_KEY) {
      console.error('❌ 环境变量 IMAGE_API_KEY 未配置');
      return NextResponse.json({ error: '服务器配置错误' }, { status: 500 });
    }

    // 检查参数
    if (!prompt) {
      return NextResponse.json({ error: '请输入提示词' }, { status: 400 });
    }

    if (!user_id) {
      return NextResponse.json({ error: '请先登录' }, { status: 401 });
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
      } else if ((profile.points || 0) < COST_PER_IMAGE) {
        deductError = `积分不足！当前积分: ${profile.points || 0}`;
        deductSuccess = false;
      } else {
        // 扣减积分
        const { error: updateError } = await supabase
          .from('profiles')
          .update({ points: (profile.points || 0) - COST_PER_IMAGE })
          .eq('id', user_id);

        if (updateError) {
          deductError = '扣减积分失败';
          deductSuccess = false;
        } else {
          // 记录账单
          await supabase.from('billing_history').insert({
            user_id,
            type: 'image_gen',
            amount: -COST_PER_IMAGE,
            description: '生成 AI 图片',
          });
          console.log('✅ 积分已扣除:', COST_PER_IMAGE);
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

    // 2. 调用第三方图片生成API
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
        
        // 返还积分
        await refundPoints(user_id, COST_PER_IMAGE, 'API请求失败');
        
        let errorMessage = '生成失败';
        try {
          const errorJson = JSON.parse(responseText);
          errorMessage = errorJson.error?.message || errorJson.message || errorMessage;
        } catch {}
        
        return NextResponse.json({ error: errorMessage }, { status: response.status });
      }

      const result = JSON.parse(responseText);
      const images = result.data || result.images || [];
      const urls = images.map((img: { url: string }) => img.url).filter(Boolean);

      if (urls.length === 0) {
        console.error('❌ 未生成任何图片');
        await refundPoints(user_id, COST_PER_IMAGE, '未生成任何图片');
        return NextResponse.json({ error: '未生成任何图片' }, { status: 500 });
      }

      console.log('✅ 图片生成成功');
      return NextResponse.json({ status: 'completed', urls, cost: COST_PER_IMAGE });

    } catch (fetchError) {
      clearTimeout(timeoutId);
      console.error('❌ 网络请求失败:', fetchError);
      await refundPoints(user_id, COST_PER_IMAGE, '网络请求失败');
      return NextResponse.json({ error: '网络请求失败' }, { status: 500 });
    }

  } catch (error) {
    console.error('❌ 请求处理失败:', error);
    return NextResponse.json({ error: '请求解析失败' }, { status: 400 });
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

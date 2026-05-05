import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/app/lib/supabase';
import { supabaseServer } from '@/app/lib/supabase-server';

const API_KEY = process.env.IMAGE_API_KEY || '';
const COST_PER_IMAGE = 2;

export async function POST(request: NextRequest) {
  try {
    const { prompt, model, size, n = 1, image, user_id } = await request.json();

    console.log('========== 图片生成请求 ==========');
    console.log('user_id:', user_id);
    console.log('prompt:', prompt?.substring(0, 50));
    console.log('API_KEY configured:', API_KEY ? 'Yes' : 'No');

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
    console.log('🔍 开始检查积分...');
    
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

      // 扣减积分（使用服务端密钥绕过 RLS）
      console.log('💰 开始扣减积分:', COST_PER_IMAGE);
      console.log('💰 用户ID:', user_id);
      console.log('💰 当前积分:', profile.points);
      console.log('💰 扣减后积分:', (profile.points || 0) - COST_PER_IMAGE);
      
      const { error: updateError } = await supabaseServer
        .from('profiles')
        .update({ points: (profile.points || 0) - COST_PER_IMAGE })
        .eq('id', user_id);

      if (updateError) {
        console.error('❌ 扣减积分失败:', updateError.message);
        return NextResponse.json({ error: '扣减积分失败: ' + updateError.message }, { status: 500 });
      }

      console.log('✅ 积分扣减成功');
      
      // 验证更新结果
      const { data: updatedProfile, error: verifyError } = await supabaseServer
        .from('profiles')
        .select('points')
        .eq('id', user_id)
        .single();
      
      if (verifyError) {
        console.error('❌ 验证积分失败:', verifyError.message);
      } else {
        console.log('✅ 验证积分成功，当前积分:', updatedProfile?.points);
      }

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
        // 返还积分
        await supabase.from('profiles')
          .update({ points: (profile.points || 0) })
          .eq('id', user_id);
        return NextResponse.json({ error: '记录账单失败: ' + insertError.message }, { status: 500 });
      }

      console.log('✅ 积分扣除成功');

    } catch (e) {
      console.error('❌ 积分操作异常:', e);
      return NextResponse.json({ error: '积分操作异常: ' + (e as Error).message }, { status: 500 });
    }

    // 2. 调用第三方图片生成API
    console.log('🌐 开始调用云雾API...');
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
      console.log('📡 云雾API响应状态:', response.status);

      const responseText = await response.text();

      if (!response.ok) {
        console.error('❌ 云雾API请求失败:', response.status, responseText);
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

      console.log('✅ 图片生成成功:', urls.length, '张图片');
      return NextResponse.json({ status: 'completed', urls, cost: COST_PER_IMAGE });

    } catch (fetchError) {
      clearTimeout(timeoutId);
      console.error('❌ 网络请求失败:', fetchError);
      await refundPoints(user_id, COST_PER_IMAGE, '网络请求失败');
      return NextResponse.json({ error: '网络请求失败: ' + (fetchError as Error).message }, { status: 500 });
    }

  } catch (error) {
    console.error('❌ 请求处理失败:', error);
    return NextResponse.json({ error: '请求解析失败: ' + (error as Error).message }, { status: 400 });
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

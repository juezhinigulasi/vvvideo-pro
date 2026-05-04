import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/app/lib/supabase';

const API_KEY = process.env.IMAGE_API_KEY || '';
const COST_PER_IMAGE = 2;

export async function POST(request: NextRequest) {
  const startTime = Date.now();

  try {
    const { prompt, model, size, n = 1, image, user_id } = await request.json();

    console.log('========== Image Generation Request Started ==========');
    console.log('Timestamp:', new Date().toISOString());
    console.log('Request body:', {
      hasPrompt: !!prompt,
      promptLength: prompt?.length || 0,
      model,
      size,
      n,
      hasImage: !!image,
      imageCount: image?.length || 0,
      user_id,
    });

    if (!API_KEY) {
      console.error('ERROR: 环境变量 IMAGE_API_KEY 未配置');
      return NextResponse.json(
        { error: '服务器配置错误，请联系管理员' },
        { status: 500 }
      );
    }

    if (!prompt) {
      console.error('ERROR: Prompt is required');
      return NextResponse.json(
        { error: '参数不完整：prompt 是必填项' },
        { status: 400 }
      );
    }

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

    console.log('========== Sending Request to YunWu API ==========');
    console.log('URL:', apiUrl);
    console.log('Headers:', {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    });
    console.log('Body:', JSON.stringify(requestBody, null, 2));
    console.log('====================================================');

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
      const responseTime = Date.now() - startTime;

      console.log('========== Response Received ==========');
      console.log('Status:', response.status);
      console.log('Response Time:', `${responseTime}ms`);

      const responseText = await response.text();
      console.log('Raw Response:', responseText);

      if (!response.ok) {
        let errorMessage = `HTTP Error: ${response.status}`;
        try {
          const errorJson = JSON.parse(responseText);
          errorMessage = errorJson.error?.message || errorJson.message || errorJson.error || responseText;
        } catch {
          errorMessage = responseText || `HTTP Error: ${response.status}`;
        }

        console.error('ERROR:', errorMessage);
        return NextResponse.json(
          { error: errorMessage, cost: 0 },
          { status: response.status }
        );
      }

      const result = JSON.parse(responseText);
      console.log('SUCCESS:', JSON.stringify(result, null, 2));

      const images = result.data || result.images || [];
      const urls = images.map((img: { url: string }) => img.url).filter(Boolean);

      if (urls.length === 0) {
        console.error('ERROR: No images returned');
        return NextResponse.json(
          { error: '未生成任何图片', cost: 0 },
          { status: 500 }
        );
      }

      // 扣除积分
      let pointsDeducted = false;
      if (user_id) {
        try {
          const { data, error } = await supabase.rpc('deduct_points', { 
            user_id: user_id,
            amount: COST_PER_IMAGE 
          });
          if (!error && data) {
            pointsDeducted = true;
            console.log('✅ 积分扣除成功:', COST_PER_IMAGE);
            
            // 添加积分记录
            await supabase.from('point_transactions').insert({
              user_id: user_id,
              type: 'consume',
              amount: COST_PER_IMAGE,
              description: '生成图片',
              metadata: { prompt: prompt?.substring(0, 100) },
            });
            console.log('✅ 积分记录已添加');
          } else {
            console.error('❌ 积分扣除失败:', error);
          }
        } catch (e) {
          console.error('❌ 积分扣除异常:', e);
        }
      }

      return NextResponse.json({
        status: 'completed',
        urls: urls,
        cost: pointsDeducted ? COST_PER_IMAGE : 0,
      });

    } catch (fetchError) {
      clearTimeout(timeoutId);
      console.error('FETCH ERROR:', fetchError);
      return NextResponse.json(
        { error: '网络请求失败，请稍后重试', cost: 0 },
        { status: 500 }
      );
    }

  } catch (error) {
    console.error('REQUEST PARSE ERROR:', error);
    return NextResponse.json(
      { error: '请求解析失败', cost: 0 },
      { status: 400 }
    );
  }
}
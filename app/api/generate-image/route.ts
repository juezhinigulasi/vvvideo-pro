import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/app/lib/supabase';
import { getSupabaseServer } from '@/app/lib/supabase-server';

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
      
      const { error: updateError } = await getSupabaseServer()
        .from('profiles')
        .update({ points: (profile.points || 0) - COST_PER_IMAGE })
        .eq('id', user_id);

      if (updateError) {
        console.error('❌ 扣减积分失败:', updateError.message);
        return NextResponse.json({ error: '扣减积分失败: ' + updateError.message }, { status: 500 });
      }

      console.log('✅ 积分扣减成功');
      
      // 验证更新结果
      const { data: updatedProfile, error: verifyError } = await getSupabaseServer()
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
        // 返还积分（使用服务端密钥）
        await getSupabaseServer().from('profiles')
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
    const apiUrl = 'https://yunwu.ai/v1/images/generations';
    const requestBody: Record<string, unknown> = {
      model: model || 'gpt-image-2-all', // 切换回 gpt-image-2-all，使用标准响应格式
      prompt: prompt,
      size: size || '1024x1024',
      n: parseInt(String(n)) || 1, // 确保是数字类型
    };

    if (image && image.length > 0) {
      requestBody.image = image;
      requestBody.mode = 'image-to-image';
    }

    const controller = new AbortController();
    // 增加超时时间到5分钟（300秒），因为图片生成可能需要较长时间
    const timeoutId = setTimeout(() => controller.abort(), 300000);

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
      console.log('📋 云雾API响应详情:', JSON.stringify(result, null, 2));
      console.log('📋 响应类型:', typeof result);
      console.log('📋 响应所有键:', Object.keys(result));
      
      // 尝试多种可能的响应结构
      let urls: string[] = [];
      
      // 标准结构: result.data[].url
      if (result.data && Array.isArray(result.data)) {
        console.log('🔍 data数组长度:', result.data.length);
        if (result.data.length > 0) {
          console.log('🔍 data[0]的类型:', typeof result.data[0]);
          console.log('🔍 data[0]的字段:', typeof result.data[0] === 'object' ? Object.keys(result.data[0]) : '不是对象');
          console.log('🔍 data[0]的完整内容:', JSON.stringify(result.data[0], null, 2));
        }
        
        // 尝试多种可能的URL字段名，同时处理双层嵌套的data结构
        urls = result.data.flatMap((item: unknown) => {
          const strItem = item as string;
          // 检查是否为字符串类型（可能是 Base64 直接返回）
          if (typeof strItem === 'string') {
            if (strItem.startsWith('data:image/') || strItem.length > 1000) {
              console.log('🔍 data数组中发现字符串类型的Base64数据，长度:', strItem.length);
              return [strItem];
            }
            return [];
          }
          
          const itemObj = item as Record<string, unknown>;
          // 检查是否为双层嵌套结构: data[0].data[0].url
          const nestedData = (itemObj as { data: unknown[] }).data;
          if (nestedData && Array.isArray(nestedData)) {
            console.log('🔍 发现双层嵌套data结构，长度:', nestedData.length);
            return nestedData.flatMap((nestedItem: unknown) => {
              // 嵌套项也可能是字符串类型
              const strNestedItem = nestedItem as string;
              if (typeof strNestedItem === 'string') {
                if (strNestedItem.startsWith('data:image/') || strNestedItem.length > 1000) {
                  // 如果不是 data:image 开头，添加前缀
                  if (!strNestedItem.startsWith('data:')) {
                    return [`data:image/jpeg;base64,${strNestedItem}`];
                  }
                  return [strNestedItem];
                }
                return [];
              }
              
              const nestedObj = nestedItem as Record<string, unknown>;
              const url = (nestedObj as { url: string }).url ||
                          (nestedObj as { image_url: string }).image_url ||
                          (nestedObj as { imageUrl: string }).imageUrl ||
                          (nestedObj as { output_url: string }).output_url ||
                          '';
              console.log('🔍 从嵌套data提取URL:', url);
              
              if (url) {
                return [url];
              }
              
              // 检查嵌套项中的Base64字段
              const base64Fields = ['b64_json', 'data', 'image', 'imageData', 'base64', 'content'];
              for (const field of base64Fields) {
                const value = nestedObj[field] as string;
                if (typeof value === 'string' && value.length > 1000) {
                  console.log('🔍 从嵌套data项提取Base64数据，字段:', field, '长度:', value.length);
                  // 如果不是 data:image 开头，添加前缀
                  if (!value.startsWith('data:')) {
                    return [`data:image/jpeg;base64,${value}`];
                  }
                  return [value];
                }
              }
              return [];
            }).filter(Boolean);
          }
          
          // 普通结构: data[0].url
          const url = (itemObj as { url: string }).url ||
                      (itemObj as { image_url: string }).image_url ||
                      (itemObj as { imageUrl: string }).imageUrl ||
                      (itemObj as { output_url: string }).output_url ||
                      '';
          console.log('🔍 从data提取URL:', url);
          
          // 检查是否包含 Base64 字段
          if (!url) {
            const base64Fields = ['b64_json', 'data', 'image', 'imageData', 'base64', 'content'];
            for (const field of base64Fields) {
              const value = itemObj[field] as string;
              if (typeof value === 'string' && value.length > 1000) {
                console.log('🔍 从data项提取Base64数据，字段:', field, '长度:', value.length);
                // 如果不是 data:image 开头，添加前缀
                if (!value.startsWith('data:')) {
                  return [`data:image/jpeg;base64,${value}`];
                }
                return [value];
              }
            }
          }
          
          return url ? [url] : [];
        }).filter(Boolean);
      }
      
      // 备用结构: result.images[].url
      if (urls.length === 0 && result.images && Array.isArray(result.images)) {
        urls = result.images.flatMap((img: unknown) => {
          const strImg = img as string;
          if (typeof strImg === 'string') {
            return (strImg.startsWith('data:image/') || strImg.length > 1000) ? [strImg] : [];
          }
          const imgObj = img as Record<string, unknown>;
          const url = (imgObj as { url: string }).url ||
                      (imgObj as { image_url: string }).image_url ||
                      '';
          return url ? [url] : [];
        }).filter(Boolean);
      }
      
      // 备用结构: result.output[].url
      if (urls.length === 0 && result.output && Array.isArray(result.output)) {
        urls = result.output.flatMap((img: unknown) => {
          const strImg = img as string;
          if (typeof strImg === 'string') {
            return (strImg.startsWith('data:image/') || strImg.length > 1000) ? [strImg] : [];
          }
          const imgObj = img as Record<string, unknown>;
          const url = (imgObj as { url: string }).url ||
                      (imgObj as { image_url: string }).image_url ||
                      '';
          return url ? [url] : [];
        }).filter(Boolean);
      }

      // 备用结构: result.url (单张图片)
      if (urls.length === 0 && typeof result.url === 'string') {
        urls = [result.url];
      }

      // 备用结构: result.output_url
      if (urls.length === 0 && typeof result.output_url === 'string') {
        urls = [result.output_url];
      }

      // 检查顶层是否有 Base64 数据
      if (urls.length === 0) {
        console.log('🔍 检查顶层 Base64 数据...');
        const topLevelFields = ['data', 'image', 'imageData', 'base64', 'content', 'result'];
        for (const field of topLevelFields) {
          const value = (result as Record<string, unknown>)[field];
          if (typeof value === 'string' && (value.startsWith('data:image/') || value.length > 1000)) {
            console.log('🔍 在顶层发现 Base64 图片数据，字段:', field, '长度:', value.length);
            urls.push(value);
          }
        }
      }

      console.log('🔍 最终提取到的图片URL/Base64:', urls.length > 0 ? `共${urls.length}张` : '无');

      if (urls.length === 0) {
        console.error('❌ 未生成任何图片');
        console.error('❌ 完整响应结构:', JSON.stringify(Object.keys(result)));
        console.error('❌ data数组内容:', result.data ? JSON.stringify(result.data).substring(0, 500) + '...' : 'undefined');
        
        // 检查是否是内容安全问题（可能被拒绝生成）
        const usage = result.usage;
        if (usage) {
          console.log('📊 API使用情况:', JSON.stringify(usage));
        }
        
        // 将原始响应返回给前端用于调试
        // 注意：生产环境应该移除这个调试信息
        await refundPoints(user_id, COST_PER_IMAGE, '未生成任何图片');
        return NextResponse.json({ 
          error: '未生成任何图片',
          debug: {
            responseKeys: Object.keys(result),
            hasData: !!result.data,
            dataType: result.data ? typeof result.data : 'undefined',
            isDataArray: Array.isArray(result.data),
            dataSample: result.data ? JSON.stringify(result.data).substring(0, 1000) : 'undefined',
            fullResponse: JSON.stringify(result).substring(0, 3000) // 返回完整响应的前3000字符
          }
        }, { status: 500 });
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
    // 使用服务端客户端查询用户信息（不受RLS限制）
    const { data: profile } = await getSupabaseServer()
      .from('profiles')
      .select('points')
      .eq('id', userId)
      .single();

    if (profile) {
      // 使用服务端客户端更新积分（不受RLS限制）
      await getSupabaseServer()
        .from('profiles')
        .update({ points: (profile.points || 0) + amount })
        .eq('id', userId);

      // 记录账单
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

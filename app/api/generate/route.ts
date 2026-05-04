import { NextResponse } from 'next/server';

const API_KEY = process.env.VIDEO_API_KEY || '';
const COST_PER_VIDEO = 3;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { prompt, model, input_reference, poll, id, aspect_ratio, duration, user_id } = body;

    if (!API_KEY) {
      console.error('❌ 环境变量 VIDEO_API_KEY 未配置');
      return NextResponse.json({ error: '服务器配置错误，请联系管理员' }, { status: 500 });
    }

    if (poll && id) {
      const taskId = id;
      if (!taskId) {
        console.error('[轮询] 缺少任务ID');
        return NextResponse.json({ error: '缺少任务ID' }, { status: 400 });
      }

      console.log('[轮询] 收到轮询请求，id:', taskId);

      try {
        const response = await fetch(`https://yunwu.ai/v1/video/query?id=${taskId}`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout(30000),
        });

        const responseText = await response.text();
        console.log('[轮询] 响应内容:', responseText);

        if (!response.ok) {
          console.error('[轮询] HTTP错误:', response.status);
          return NextResponse.json({ status: 'processing', id: taskId });
        }

        const result = JSON.parse(responseText);
        console.log('[轮询] 解析结果:', JSON.stringify(result, null, 2));

        if (result.status === 'completed' || result.status === 'success') {
          const videoUrl = result.video_url || result.url || result.data?.video_url || result.output?.url || result.result?.video_url;
          console.log('[轮询] ✅ 任务完成，视频URL:', videoUrl);
          
          if (!videoUrl) {
            console.warn('[轮询] 任务完成但未找到视频URL');
            return NextResponse.json({ status: 'processing', id: taskId });
          }

          return NextResponse.json({
            status: 'completed',
            id: taskId,
            video_url: videoUrl,
            url: videoUrl,
          });
        } else if (result.status === 'failed' || result.status === 'error') {
          console.log('[轮询] 任务失败:', result.error);
          return NextResponse.json({
            status: 'failed',
            id: taskId,
            error: result.error || result.message || result.error_msg || '视频生成失败',
          });
        } else {
          console.log('[轮询] 任务进行中，状态:', result.status);
          return NextResponse.json({ status: result.status || 'processing', id: taskId });
        }
      } catch (error) {
        console.error('[轮询] 查询异常:', error);
        return NextResponse.json({ status: 'processing', id: taskId });
      }
    }

    console.log('========== 后端接收到的请求 ==========');
    console.log('prompt:', prompt);
    console.log('model:', model);
    console.log('aspect_ratio:', aspect_ratio);
    console.log('duration:', duration);
    console.log('user_id:', user_id);
    console.log('========================================');

    if (!prompt) {
      return NextResponse.json({ error: '参数不完整：prompt 是必填项' }, { status: 400 });
    }

    const requestBody = {
      model: model || 'grok-video-3-10s',
      prompt: prompt,
      aspect_ratio: aspect_ratio || '16:9',
      size: '720P',
      images: input_reference ? [input_reference.trim()] : [],
    };

    console.log('========== 发送的 JSON 数据 ==========');
    console.log(JSON.stringify(requestBody, null, 2));
    console.log('===================================');

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
      console.log('响应状态:', response.status, response.statusText);
      const responseText = await response.text();
      console.log('响应内容:', responseText);

      if (!response.ok) {
        let errorDetail = '未知错误';
        if (response.status === 404) errorDetail = '404 - 接口地址不存在';
        else if (response.status === 401) errorDetail = '401 - 认证失败，请检查服务器配置';
        else if (response.status === 403) errorDetail = '403 - 权限不足';
        else if (response.status === 500) errorDetail = '500 - 服务器内部错误';
        else if (response.status === 502) errorDetail = '502 - 网关错误';
        else if (response.status === 503) errorDetail = '503 - 服务不可用';
        else {
          try {
            const errorJson = JSON.parse(responseText);
            errorDetail = errorJson.error?.message || errorJson.message || errorJson.error || responseText;
          } catch {
            errorDetail = responseText;
          }
        }

        console.error('❌ API 请求失败:', { status: response.status, error: errorDetail });
        return NextResponse.json({ error: errorDetail }, { status: response.status });
      }

      const result = JSON.parse(responseText);
      console.log('✅ 创建任务成功:', result);

      const taskId = result.id;
      if (!taskId) {
        console.error('❌ 响应中没有 id 字段:', result);
        return NextResponse.json({ error: '未获取到 id，请检查API响应' }, { status: 500 });
      }

      const maxRetries = 60;
      const pollInterval = 5000;

      for (let i = 0; i < maxRetries; i++) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));

        try {
          const queryUrl = `https://yunwu.ai/v1/video/query?id=${taskId}`;
          console.log(`[轮询] 第 ${i + 1} 次查询:`, queryUrl);

          const statusResponse = await fetch(queryUrl, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${API_KEY}` },
            signal: AbortSignal.timeout(30000),
          });

          const statusText = await statusResponse.text();
          console.log(`[轮询] 第 ${i + 1} 次响应:`, statusText);

          if (!statusResponse.ok) {
            console.log(`[轮询] 查询失败，继续重试`);
            continue;
          }

          const statusResult = JSON.parse(statusText);

          if (statusResult.status === 'completed' || statusResult.status === 'success') {
            console.log('✅ 视频生成成功!');
            const finalVideoUrl = statusResult.video_url || statusResult.url || statusResult.data?.video_url || statusResult.result?.video_url || statusResult.output_url;
            console.log('✅ 最终使用的视频URL:', finalVideoUrl);

            return NextResponse.json({
              id: taskId,
              status: 'completed',
              video_url: finalVideoUrl,
              cost: COST_PER_VIDEO,
            });
          } else if (statusResult.status === 'failed' || statusResult.status === 'error') {
            console.error('❌ 视频生成失败:', statusResult);
            return NextResponse.json({
              id: taskId,
              status: 'failed',
              error: statusResult.error || statusResult.message || statusResult.error_msg || '视频生成失败',
              cost: 0,
            }, { status: 200 });
          } else {
            console.log(`[轮询] 任务进行中，状态: ${statusResult.status}`);
          }
        } catch (pollError) {
          console.error(`[轮询] 第 ${i + 1} 次查询异常:`, pollError);
        }
      }

      console.log('[轮询] 超时未获取结果，返回 id 供前端继续查询');
      return NextResponse.json({
        id: taskId,
        status: 'processing',
        message: '任务已提交，正在处理中',
        cost: COST_PER_VIDEO,
      });

    } catch (fetchError: unknown) {
      clearTimeout(timeoutId);
      console.error('❌ Fetch 请求失败:', fetchError);
      return NextResponse.json({ error: '网络请求失败，请稍后重试' }, { status: 500 });
    }
  } catch (error) {
    console.error('❌ 请求处理失败:', error);
    return NextResponse.json({ error: '请求处理失败' }, { status: 500 });
  }
}
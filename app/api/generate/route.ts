import { NextResponse } from 'next/server';

// 从环境变量获取 API Key
const API_KEY = process.env.VIDEO_API_KEY || '';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { prompt, model, input_reference, poll, id, aspect_ratio, duration } = body;

    // 检查环境变量中是否配置了 API Key
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

      const statusUrl = `https://yunwu.ai/v1/video/query?id=${taskId}`;
      console.log('[轮询] 查询地址:', statusUrl);

      try {
        const response = await fetch(statusUrl, {
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
        console.log('[轮询] 状态:', result.status);
        console.log('[轮询] 视频URL字段:', {
          video_url: result.video_url,
          url: result.url,
          data: result.data,
          output: result.output,
        });

        if (result.status === 'completed' || result.status === 'success') {
          const videoUrl = result.video_url || result.url || result.data?.video_url || result.output?.url;
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
            error: result.error || result.message || '视频生成失败',
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
    console.log('input_reference:', input_reference || '无参考图');
    console.log('aspect_ratio:', aspect_ratio);
    console.log('duration:', duration);
    console.log('========================================');

    if (!prompt) {
      console.error('❌ 参数不完整：缺少 prompt');
      return NextResponse.json({ error: '参数不完整：prompt 是必填项' }, { status: 400 });
    }

    const createUrl = 'https://yunwu.ai/v1/video/create';

    console.log('[URL验证] 创建视频接口:', createUrl);

    const images: string[] = [];
    if (input_reference && input_reference.trim()) {
      images.push(input_reference.trim());
    }

    const requestBody = {
      model: model || 'grok-video-3-10s',
      prompt: prompt,
      aspect_ratio: aspect_ratio || '16:9',
      size: '720P',
      images: images,
    };

    console.log('========== 发送的 JSON 数据 ==========');
    console.log(JSON.stringify(requestBody, null, 2));
    console.log('===================================');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    try {
      const response = await fetch(createUrl, {
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

        if (response.status === 404) {
          errorDetail = '404 - 接口地址不存在';
        } else if (response.status === 401) {
          errorDetail = '401 - 认证失败，请检查服务器配置';
        } else if (response.status === 403) {
          errorDetail = '403 - 权限不足';
        } else if (response.status === 500) {
          errorDetail = '500 - 服务器内部错误';
        } else if (response.status === 502) {
          errorDetail = '502 - 网关错误';
        } else if (response.status === 503) {
          errorDetail = '503 - 服务不可用';
        } else {
          try {
            const errorJson = JSON.parse(responseText);
            errorDetail = errorJson.error?.message || errorJson.message || errorJson.error || responseText;
          } catch {
            errorDetail = responseText;
          }
        }

        console.error('❌ API 请求失败:', {
          status: response.status,
          statusText: response.statusText,
          error: errorDetail,
        });

        return NextResponse.json({ error: errorDetail }, { status: response.status });
      }

      const result = JSON.parse(responseText);
      console.log('✅ 创建任务成功:', result);

      const taskId = result.id;
      if (!taskId) {
        console.error('❌ 响应中没有 id 字段:', result);
        return NextResponse.json({ error: '未获取到 id，请检查API响应' }, { status: 500 });
      }

      console.log('[轮询] 开始后台轮询，id:', taskId);

      const maxRetries = 60;
      const pollInterval = 5000;

      for (let i = 0; i < maxRetries; i++) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));

        try {
          const queryUrl = `https://yunwu.ai/v1/video/query?id=${taskId}`;
          console.log(`[轮询] 第 ${i + 1} 次查询:`, queryUrl);

          const statusResponse = await fetch(queryUrl, {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${API_KEY}`,
            },
            signal: AbortSignal.timeout(30000),
          });

          const statusText = await statusResponse.text();
          console.log(`[轮询] 第 ${i + 1} 次响应:`, statusText);

          if (!statusResponse.ok) {
            console.log(`[轮询] 查询失败，继续重试`);
            continue;
          }

          const statusResult = JSON.parse(statusText);

          if (statusResult.status === 'completed') {
            console.log('✅ 视频生成成功!');
            console.log('✅ 完整响应对象:', JSON.stringify(statusResult, null, 2));
            console.log('✅ 视频URL字段检查:', {
              hasVideoUrl: !!statusResult.video_url,
              hasUrl: !!statusResult.url,
              hasData: !!statusResult.data,
              hasResult: !!statusResult.result,
              videoUrl: statusResult.video_url,
              url: statusResult.url,
              dataVideoUrl: statusResult.data?.video_url,
              resultVideoUrl: statusResult.result?.video_url,
              allKeys: Object.keys(statusResult)
            });

            const finalVideoUrl = statusResult.video_url || statusResult.url || statusResult.data?.video_url || statusResult.result?.video_url || statusResult.output_url;
            console.log('✅ 最终使用的视频URL:', finalVideoUrl);

            return NextResponse.json({
              id: taskId,
              status: 'completed',
              video_url: finalVideoUrl,
            });
          } else if (statusResult.status === 'failed') {
            console.error('❌ 视频生成失败:', statusResult);
            return NextResponse.json({
              id: taskId,
              status: 'failed',
              error: statusResult.error || '视频生成失败',
            }, { status: 500 });
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
      });

    } catch (fetchError: unknown) {
      clearTimeout(timeoutId);

      console.error('❌ Fetch 请求失败，详细错误信息:');

      if (fetchError instanceof Error) {
        console.error('错误名称:', fetchError.name);
        console.error('错误消息:', fetchError.message);

        if ((fetchError as NodeJS.ErrnoException).code) {
          console.error('错误代码:', (fetchError as NodeJS.ErrnoException).code);
        }

        console.error('完整错误对象:', JSON.stringify(fetchError, null, 2));

        if (fetchError.name === 'AbortError') {
          console.error('原因: 请求超时（超过60秒）');
          return NextResponse.json({ error: '超时 - 服务器连接超时，请检查网络' }, { status: 504 });
        }

        if (fetchError.message.includes('fetch failed') || fetchError.message.includes('Network request failed')) {
          console.error('原因: 网络连接失败');
          const errorCode = (fetchError as NodeJS.ErrnoException).code;
          let hint = '网络连接失败';

          if (errorCode === 'ETIMEDOUT') {
            hint = '超时 - 连接超时，请检查网络';
          } else if (errorCode === 'ENOTFOUND') {
            hint = '域名解析失败 - 请检查API域名是否正确';
          } else if (errorCode === 'ECONNREFUSED') {
            hint = '连接被拒绝 - API服务器可能未启动';
          } else if (errorCode === 'ECONNRESET') {
            hint = '连接被重置 - 服务器主动断开连接';
          } else if (errorCode === 'EHOSTUNREACH') {
            hint = '主机不可达 - 请检查网络连接';
          }

          return NextResponse.json({ error: hint }, { status: 502 });
        }

        return NextResponse.json({ error: `请求失败: ${fetchError.message}` }, { status: 500 });
      }

      console.error('未知错误类型:', fetchError);
      return NextResponse.json({ error: '发生未知错误' }, { status: 500 });
    }

  } catch (error) {
    console.error('❌ 后端处理异常:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : '后端处理异常' }, { status: 500 });
  }
}
import { NextRequest, NextResponse } from 'next/server';

// 从环境变量获取 API Key
const API_KEY = process.env.IMAGE_API_KEY || '';

export async function POST(request: NextRequest) {
  const startTime = Date.now();

  try {
    const { prompt, model, size, n = 1, image } = await request.json();

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
    });

    // 检查环境变量中是否配置了 API Key
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
        { error: 'Prompt is required' },
        { status: 400 }
      );
    }

    const requestBody: Record<string, any> = {
      model: model || 'gpt-image-2-all',
      prompt,
      size: size || '1024x1024',
      n,
    };

    if (image && Array.isArray(image) && image.length > 0) {
      console.log('检测到图生图模式，图片数量:', image.length);
      console.log('第一张图片格式:', image[0]?.startsWith('data:') ? 'Data URL' : '纯 base64');
      
      if (image[0]?.startsWith('data:')) {
        requestBody.image = image;
        console.log('使用完整 Data URL 格式');
      } else {
        requestBody.image = image;
        console.log('使用纯 base64 格式');
      }
      
      requestBody.mode = 'image-to-image';
      console.log('已添加图生图模式参数');
      console.log('第一张图片数据长度:', image[0]?.length || 0, '字符');
    }

    const apiUrl = 'https://yunwu.ai/v1/images/generations';
    console.log('Sending request to:', apiUrl);
    console.log('Request body size:', JSON.stringify(requestBody).length, 'bytes');
    console.log('Request body preview:', JSON.stringify(requestBody).substring(0, 500) + '...');

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    };

    console.log('Headers:', { ...headers, Authorization: 'Bearer ***' });

    let response;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120000);

      console.log('Attempting to fetch from:', apiUrl);

      response = await fetch(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
        keepalive: true,
      });

      clearTimeout(timeoutId);
      console.log('Fetch successful, status:', response.status);
    } catch (fetchError) {
      console.error('FETCH ERROR START ====');
      console.error('Error type:', fetchError instanceof Error ? fetchError.name : 'Unknown');
      console.error('Error message:', fetchError instanceof Error ? fetchError.message : fetchError);
      console.error('Stack:', fetchError instanceof Error ? fetchError.stack : 'N/A');
      console.error('FETCH ERROR END ====');
      
      if (fetchError instanceof Error && fetchError.name === 'AbortError') {
        return NextResponse.json(
          { error: '请求超时，请稍后重试' },
          { status: 504 }
        );
      }
      return NextResponse.json(
        { error: `网络错误: ${fetchError instanceof Error ? fetchError.message : 'Unknown'}` },
        { status: 503 }
      );
    }

    const duration = Date.now() - startTime;
    console.log('API response received in:', duration, 'ms');
    console.log('Response status:', response.status, response.statusText);

    if (!response.ok) {
      let errorData;
      try {
        errorData = await response.json();
      } catch {
        errorData = { message: await response.text().catch(() => 'Unknown error') };
      }
      console.error('API Error Response:', {
        status: response.status,
        statusText: response.statusText,
        errorData,
      });
      return NextResponse.json(
        { error: errorData.message || errorData.error || `API request failed: ${response.status} ${response.statusText}` },
        { status: response.status }
      );
    }

    const data = await response.json();
    console.log('Success! Response data:', {
      hasData: !!data,
      dataLength: data?.data?.length || 0,
    });
    console.log('========== Image Generation Request Completed ==========');

    return NextResponse.json(data);
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error('========== Image Generation Request Failed ==========');
    console.error('Duration:', duration, 'ms');
    console.error('Error:', error);
    console.error('========== End Error ==========');

    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to generate image' },
      { status: 500 }
    );
  }
}
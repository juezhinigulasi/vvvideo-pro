import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  const startTime = Date.now();

  try {
    const { apiKey, prompt, model, size, n = 1, image } = await request.json();

    console.log('========== Image Generation Request Started ==========');
    console.log('Timestamp:', new Date().toISOString());
    console.log('Request body:', {
      hasApiKey: !!apiKey,
      apiKeyLength: apiKey?.length || 0,
      hasPrompt: !!prompt,
      promptLength: prompt?.length || 0,
      model,
      size,
      n,
      hasImage: !!image,
      imageCount: image?.length || 0,
    });

    if (!apiKey) {
      console.error('ERROR: API key is required');
      return NextResponse.json(
        { error: 'API key is required' },
        { status: 400 }
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
      requestBody.image = image;
    }

    const apiUrl = 'https://yunwu.ai/v1/images/generations';
    console.log('Sending request to:', apiUrl);
    console.log('Request body:', JSON.stringify(requestBody).substring(0, 500) + '...');

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };

    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
      console.log('Authorization header added');
    }

    let response;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120000);

      response = await fetch(apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
    } catch (fetchError) {
      console.error('FETCH ERROR:', fetchError);
      if (fetchError instanceof Error && fetchError.name === 'AbortError') {
        return NextResponse.json(
          { error: '请求超时，请稍后重试' },
          { status: 504 }
        );
      }
      return NextResponse.json(
        { error: `Network error: ${fetchError instanceof Error ? fetchError.message : 'Unknown'}` },
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
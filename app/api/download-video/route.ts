import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const videoUrl = searchParams.get('url');
    
    if (!videoUrl) {
      return NextResponse.json({ error: '缺少视频URL' }, { status: 400 });
    }

    const response = await fetch(videoUrl, {
      headers: {
        'Referrer-Policy': 'no-referrer',
      },
    });

    if (!response.ok) {
      return NextResponse.json({ error: '无法获取视频' }, { status: response.status });
    }

    const blob = await response.blob();
    
    const urlObj = new URL(videoUrl);
    const pathname = urlObj.pathname;
    const filename = pathname.split('/').pop() || `video-${Date.now()}.mp4`;

    return new NextResponse(blob, {
      headers: {
        'Content-Type': blob.type || 'video/mp4',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (error) {
    console.error('下载视频失败:', error);
    return NextResponse.json({ error: '下载失败' }, { status: 500 });
  }
}
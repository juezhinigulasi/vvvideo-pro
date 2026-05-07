import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const imageUrl = searchParams.get('url');
    
    if (!imageUrl) {
      return NextResponse.json({ error: '缺少图片URL' }, { status: 400 });
    }

    // 下载图片
    const response = await fetch(imageUrl, {
      headers: {
        'Referrer-Policy': 'no-referrer',
      },
    });

    if (!response.ok) {
      return NextResponse.json({ error: '无法获取图片' }, { status: response.status });
    }

    // 获取图片数据
    const blob = await response.blob();
    
    // 获取文件名（从URL中提取或生成）
    const urlObj = new URL(imageUrl);
    const pathname = urlObj.pathname;
    const filename = pathname.split('/').pop() || `image-${Date.now()}.png`;

    // 返回图片
    return new NextResponse(blob, {
      headers: {
        'Content-Type': blob.type || 'image/png',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (error) {
    console.error('下载图片失败:', error);
    return NextResponse.json({ error: '下载失败' }, { status: 500 });
  }
}

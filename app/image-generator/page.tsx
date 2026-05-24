"use client";

import { useState, useEffect } from "react";
import ImageHeader from '../components/ImageHeader';
import { supabase } from '../lib/supabase';

const COST_PER_IMAGE = 2;

interface GenerationRecord {
  id: string;
  prompt: string;
  model: string;
  ratio: string;
  images: string[];
  status: 'generating' | 'success' | 'failed';
  createdAt: number;
  error?: string;
}

export default function ImageGenerator() {
  const [mode, setMode] = useState<'text' | 'image'>('text');
  const [prompt, setPrompt] = useState("");
  const [ratio, setRatio] = useState("9:16");
  const [generationHistory, setGenerationHistory] = useState<GenerationRecord[]>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('yunwuai_generation_history');
      if (saved) {
        const parsed = JSON.parse(saved);
        // 将刷新页面时还在生成中的记录标记为失败
        return parsed.map((record: GenerationRecord) => 
          record.status === 'generating' 
            ? { ...record, status: 'failed' as const, error: '刷新页面导致任务中断' }
            : record
        );
      }
      return [];
    }
    return [];
  });
  const [filterStatus, setFilterStatus] = useState<'all' | 'generating' | 'success' | 'failed'>('all');
  const [isGenerating, setIsGenerating] = useState(false);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [uploadedImages, setUploadedImages] = useState<string[]>([]);
  const [recordToDelete, setRecordToDelete] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recognition, setRecognition] = useState<any>(null);
  const [credits, setCredits] = useState(0);

  useEffect(() => {
    loadUserCredits();
  }, []);

  const loadUserCredits = async () => {
    try {
      const response = await fetch('/api/get-user-points');
      if (response.ok) {
        const data = await response.json();
        setCredits(data.credits || 0);
      }
    } catch (error) {
      console.error('Failed to load user credits:', error);
    }
  };

  const MAX_HISTORY_RECORDS = 10; // 最多保存10条记录

  const saveHistory = (history: GenerationRecord[]) => {
    try {
      // 限制记录数量，避免 localStorage 溢出
      const limitedHistory = history.slice(0, MAX_HISTORY_RECORDS);
      localStorage.setItem('yunwuai_generation_history', JSON.stringify(limitedHistory));
    } catch (error) {
      console.warn('Failed to save history to localStorage:', error);
      // 如果存储失败，尝试清空并重新保存
      try {
        localStorage.removeItem('yunwuai_generation_history');
        const limitedHistory = history.slice(0, 5); // 只保存前5条
        localStorage.setItem('yunwuai_generation_history', JSON.stringify(limitedHistory));
      } catch (e) {
        console.error('Failed to save history even after clearing:', e);
      }
    }
  };

  const ratios = ["9:16", "16:9", "1:1", "3:2", "2:3", "4:3"];

  const compressImage = async (file: File): Promise<string> => {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
          // 目标大小：4MB = 4 * 1024 * 1024 = 4194304 字节
          const MAX_SIZE = 4 * 1024 * 1024;
          const MAX_DIMENSION = 1536; // 最大尺寸
          
          let width = img.width;
          let height = img.height;
          let quality = 0.9; // 初始质量
          
          // 第一步：缩放图片到最大尺寸
          if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
            const ratio = Math.min(MAX_DIMENSION / width, MAX_DIMENSION / height);
            width = Math.round(width * ratio);
            height = Math.round(height * ratio);
          }
          
          const compress = (currentQuality: number): void => {
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            
            if (!ctx) {
              resolve(event.target?.result as string);
              return;
            }
            
            // 绘制图片
            ctx.drawImage(img, 0, 0, width, height);
            
            // 转换为 base64
            const compressedDataUrl = canvas.toDataURL('image/jpeg', currentQuality);
            const compressedSize = compressedDataUrl.length * 0.75; // base64 大约增加 33%
            
            console.log(`压缩尝试 - 质量: ${(currentQuality * 100).toFixed(0)}%, 大小: ${(compressedSize / 1024 / 1024).toFixed(2)} MB`);
            
            // 如果还太大，降低质量继续压缩
            if (compressedSize > MAX_SIZE && currentQuality > 0.1) {
              // 如果尺寸还能缩小，先缩小尺寸
              if (width > 512 || height > 512) {
                width = Math.round(width * 0.8);
                height = Math.round(height * 0.8);
              }
              // 降低质量
              compress(Math.max(0.1, currentQuality - 0.1));
            } else {
              console.log(`图片压缩完成 - 原大小: ${(file.size / 1024 / 1024).toFixed(2)} MB, 压缩后: ${(compressedSize / 1024 / 1024).toFixed(2)} MB, 质量: ${(currentQuality * 100).toFixed(0)}%`);
              resolve(compressedDataUrl);
            }
          };
          
          // 开始压缩
          compress(quality);
        };
        img.src = event.target?.result as string;
      };
      reader.readAsDataURL(file);
    });
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      const newImages: string[] = [];
      for (const file of Array.from(files)) {
        console.log('开始处理图片:', file.name, '大小:', file.size, '字节');
        const compressedImage = await compressImage(file);
        newImages.push(compressedImage);
      }
      setUploadedImages(newImages);
      console.log('所有图片上传完成，共:', newImages.length, '张');
    }
  };

  const removeUploadedImage = (index: number) => {
    setUploadedImages(prev => prev.filter((_, i) => i !== index));
  };

  const toggleVoiceInput = () => {
    if (isRecording) {
      // 停止录音
      if (recognition) {
        recognition.stop();
        setRecognition(null);
      }
      setIsRecording(false);
    } else {
      // 开始录音
      if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
        const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        const rec = new SpeechRecognition();
        rec.continuous = true;
        rec.interimResults = true;
        rec.lang = 'zh-CN';

        rec.onresult = (event: any) => {
          let transcript = '';
          for (let i = event.resultIndex; i < event.results.length; i++) {
            transcript += event.results[i][0].transcript;
          }
          setPrompt(transcript);
        };

        rec.onerror = (event: any) => {
          console.error('语音识别错误:', event.error);
          setIsRecording(false);
          setRecognition(null);
          if (event.error === 'not-allowed') {
            alert('请在浏览器设置中允许麦克风权限');
          }
        };

        rec.onend = () => {
          // 手动模式：录音结束后不自动重新开始
          // 用户需要手动点击结束
        };

        rec.start();
        setRecognition(rec);
        setIsRecording(true);
      } else {
        alert('您的浏览器不支持语音识别功能');
      }
    }
  };

  const getSizeFromRatio = (ratio: string): string => {
    const sizeMap: Record<string, string> = {
      '9:16': '1024x1536',
      '16:9': '1536x1024',
      '1:1': '1024x1024',
      '3:2': '1024x768',
      '2:3': '768x1024',
      '4:3': '1024x768',
    };
    return sizeMap[ratio] || '1024x1024';
  };

  const handleDownload = (imageUrl: string) => {
    // 判断是base64格式还是URL格式
    if (imageUrl.startsWith('data:')) {
      // base64格式：直接下载
      const link = document.createElement('a');
      link.href = imageUrl;
      link.download = `generated-image-${Date.now()}.png`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } else {
      // URL格式：使用后端代理API下载，避免CORS问题
      const encodedUrl = encodeURIComponent(imageUrl);
      const downloadUrl = `/api/download-image?url=${encodedUrl}`;
      
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = `generated-image-${Date.now()}.png`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  const handleGenerate = async () => {
    console.log('========== 开始生成图片 ==========');
    console.log('prompt:', prompt?.substring(0, 50));
    console.log('mode:', mode);
    console.log('uploadedImages:', uploadedImages?.length || 0, '张');

    if (!prompt.trim()) {
      console.log('❌ 提示词为空');
      return;
    }

    const { data } = await supabase.auth.getSession();
    const user = data?.session?.user;
    console.log('user:', user ? '已登录' : '未登录');
    if (!user) {
      console.log('❌ 用户未登录');
      alert('请先登录后再使用生图功能');
      return;
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('points')
      .eq('id', user.id)
      .single();

    console.log('profile:', profile);
    console.log('points:', profile?.points || 0);
    if (!profile || profile.points < COST_PER_IMAGE) {
      console.log('❌ 积分不足');
      alert(`积分不足！当前积分: ${profile?.points || 0}，生成图片需要 ${COST_PER_IMAGE} 积分`);
      return;
    }
    
    if (mode === 'image' && uploadedImages.length === 0) {
      console.log('❌ 图生图模式但未上传图片');
      alert('请先上传图片');
      return;
    }
    
    console.log('✅ 所有检查通过，准备发送请求');
    console.log('上传的图片:', uploadedImages?.map((img, i) => `图片${i+1}: ${img?.substring(0, 30)}...`));
    
    const recordId = Date.now().toString();
    const newRecord: GenerationRecord = {
      id: recordId,
      prompt,
      model: 'gpt-image-2-all',
      ratio,
      images: [],
      status: 'generating',
      createdAt: Date.now(),
    };
    
    setGenerationHistory(prev => {
      const updated = [newRecord, ...prev];
      saveHistory(updated);
      return updated;
    });
    
    try {
      const bodyData: Record<string, any> = {
        prompt,
        model: 'gpt-image-2-all',
        size: getSizeFromRatio(ratio),
        n: 1,
        user_id: user.id,
      };

      if (mode === 'image' && uploadedImages.length > 0) {
        bodyData.image = uploadedImages;
        console.log('图生图模式 - 图片数量:', uploadedImages.length);
        console.log('图片格式:', uploadedImages[0]?.substring(0, 50) || 'N/A');
      }

      console.log('Sending request to /api/generate-image:', {
        mode,
        bodyData: { ...bodyData, apiKey: '***', image: bodyData.image ? '[' + bodyData.image.length + ' images]' : undefined },
      });

      console.log('========== 发送图生图请求 ==========');
      console.log('请求体大小:', JSON.stringify(bodyData).length, '字节');
      console.log('图片数据长度:', bodyData.image ? bodyData.image[0]?.length : 'N/A');
      
      // 检查请求体大小是否超过限制（4MB = 4 * 1024 * 1024 = 4194304 字节）
      const requestSize = JSON.stringify(bodyData).length;
      const maxSize = 4 * 1024 * 1024; // 4MB
      if (requestSize > maxSize) {
        const errorMsg = `图片文件过大，请压缩后重试！当前大小: ${(requestSize / 1024 / 1024).toFixed(2)} MB，最大限制: 4 MB`;
        console.error(errorMsg);
        alert(errorMsg);
        throw new Error(errorMsg);
      }
      
      const response = await fetch('/api/generate-image', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(bodyData),
      });

      console.log('Response status:', response.status, response.statusText);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('API error status:', response.status);
        console.error('API error response:', errorText);
        
        let errorData;
        try {
          errorData = JSON.parse(errorText);
        } catch {
          errorData = { error: errorText || 'Unknown error' };
        }
        
        console.error('Parsed error:', errorData);
        
        // 转换错误信息为中文
        let errorMsg = errorData.error || errorData.message || errorData.detail || errorData.msg || `请求失败: ${response.status}`;
        
        // 确保 errorMsg 是字符串
        if (typeof errorMsg !== 'string') {
          errorMsg = JSON.stringify(errorMsg);
        }
        
        console.log('原始错误信息:', errorMsg);
        
        // 替换常见的英文错误信息（不区分大小写）
        const lowerMsg = errorMsg.toLowerCase();
        
        if (lowerMsg.includes('request entity too large') || 
            lowerMsg.includes('function_payload_too_large') || 
            lowerMsg.includes('payload too large')) {
          errorMsg = '图片文件过大，请尝试上传更小的图片或使用图片压缩工具';
        } else if (lowerMsg.includes('413')) {
          errorMsg = '请求过大，请压缩图片后重试';
        } else if (lowerMsg.includes('timeout') || lowerMsg.includes('time out')) {
          errorMsg = '请求超时，请稍后重试';
        } else if (lowerMsg.includes('network') || 
                   lowerMsg.includes('connection') || 
                   lowerMsg.includes('fetch failed')) {
          errorMsg = '网络错误，请检查网络连接';
        } else if (lowerMsg.includes('invalid') || lowerMsg.includes('bad request')) {
          errorMsg = '请求参数错误，请检查输入';
        } else if (lowerMsg.includes('unauthorized') || 
                   lowerMsg.includes('invalid key') || 
                   lowerMsg.includes('api key')) {
          errorMsg = 'API Key 无效，请检查您的 API Key';
        } else if (lowerMsg.includes('forbidden') || lowerMsg.includes('403')) {
          errorMsg = '访问被拒绝，请检查权限';
        } else if (lowerMsg.includes('not found') || lowerMsg.includes('404')) {
          errorMsg = '请求的资源未找到';
        } else if (lowerMsg.includes('server error') || 
                   lowerMsg.includes('500') || 
                   lowerMsg.includes('502') || 
                   lowerMsg.includes('503')) {
          errorMsg = '服务器错误，请稍后重试';
        } else if (response.status === 413) {
          errorMsg = '图片文件过大，请压缩后重试（最大 4MB）';
        }
        
        console.log('转换后的中文错误:', errorMsg);
        throw new Error(errorMsg);
      }

      const data = await response.json();
      console.log('Received response:', data);
      
      // 后端返回的格式是 { status, urls, cost }
      if (data.status === 'completed' && data.urls && data.urls.length > 0) {
        const images = data.urls;
        console.log('Generated images:', images);

        setGenerationHistory(prev => {
          const updated = prev.map(r => 
            r.id === recordId 
              ? { ...r, images, status: 'success' as const }
              : r
          );
          saveHistory(updated);
          return updated;
        });

        // 刷新积分显示
        loadUserCredits();
        // 同时刷新 Header 的积分显示
        if ((window as any).refreshUserCredits) {
          (window as any).refreshUserCredits();
        }
      } else {
        console.warn('No images returned in response');
        throw new Error('API 返回的数据格式不正确');
      }
    } catch (error) {
      console.error('Error generating image:', error);
      const errorMessage = error instanceof Error ? error.message : '生成图片失败，请稍后重试';
      alert(errorMessage);
      
      setGenerationHistory(prev => {
        const updated = prev.map(r => 
          r.id === recordId 
            ? { ...r, status: 'failed' as const, error: errorMessage }
            : r
        );
        saveHistory(updated);
        return updated;
      });
    }
  };

  const handleDeleteRecord = (id: string) => {
    if (confirm('确定要删除这张图片吗？')) {
      setGenerationHistory(prev => {
        const updated = prev.filter(r => r.id !== id);
        saveHistory(updated);
        return updated;
      });
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900">
      <ImageHeader credits={credits} costPerImage={2} />

      <div className="max-w-7xl mx-auto px-6 mb-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-1 space-y-6">
            <div className="bg-[#222428] rounded-2xl border border-white/10 p-6" style={{ boxShadow: '0 4px 20px rgba(0, 0, 0, 0.2)' }}>
              <div className="flex gap-2 mb-6 pb-4 border-b border-white/10">
                <button
                  onClick={() => setMode('text')}
                  className={`flex-1 px-4 py-3 rounded-xl text-sm font-medium transition-all duration-300 ${
                    mode === 'text'
                      ? 'bg-gradient-to-r from-cyan-500 to-blue-500 text-white'
                      : 'bg-[#1A1C1E] text-[#888] border border-white/10 hover:bg-[#2A2C2E]'
                  }`}
                >
                  文生图
                </button>
                <button
                  onClick={() => setMode('image')}
                  className={`flex-1 px-4 py-3 rounded-xl text-sm font-medium transition-all duration-300 ${
                    mode === 'image'
                      ? 'bg-gradient-to-r from-cyan-500 to-blue-500 text-white'
                      : 'bg-[#1A1C1E] text-[#888] border border-white/10 hover:bg-[#2A2C2E]'
                  }`}
                >
                  图生图
                </button>
              </div>

              <div className="space-y-4">
                {mode === 'image' && (
                  <div>
                    <label className="block text-sm text-[#888] mb-2">上传图片</label>
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={handleImageUpload}
                      className="w-full bg-[#1A1C1E] border border-white/10 rounded-xl px-5 py-3 text-[#E5E5E5] placeholder-[#666] focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500/50 transition-all cursor-pointer"
                    />
                    {uploadedImages.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {uploadedImages.map((img, index) => (
                          <div key={index} className="relative w-16 h-16 rounded-lg overflow-hidden border border-white/10 bg-[#1A1C1E]">
                            <img src={img} alt={`上传 ${index + 1}`} className="w-full h-full object-cover" />
                            <button
                              onClick={() => removeUploadedImage(index)}
                              className="absolute top-0 right-0 w-5 h-5 bg-[#EF4444] flex items-center justify-center text-white text-xs hover:bg-[#DC2626] transition-colors"
                            >
                              ×
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                <div>
                  <label className="flex items-center gap-2 text-cyan-400 text-sm font-medium mb-2">
                    <span className="w-2 h-2 bg-cyan-400 rounded-full"></span>
                    提示词
                  </label>
                  <div className="relative">
                    <textarea
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      placeholder="根据主题描述生成内容，描述生成的场景，主题，一键成片"
                      className="w-full h-32 p-4 bg-gray-900/80 border border-gray-700 rounded-xl text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500/50 resize-none transition-all text-sm"
                    />
                    <button
                      onClick={toggleVoiceInput}
                      className={`absolute bottom-3 right-3 w-9 h-9 rounded-full flex items-center justify-center transition-all duration-300 ${
                        isRecording 
                          ? 'bg-red-500 text-white animate-pulse' 
                          : 'bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30'
                      }`}
                      title={isRecording ? '停止录音' : '语音输入'}
                    >
                      {isRecording ? (
                        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
                        </svg>
                      ) : (
                        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M12 14c1.66 0 2.99-1.34 2.99-3S13.66 8 12 8 9 9.34 9 11s1.34 3 3 3zm5.66-1.34c0-2.21-1.79-4-4-4s-4 1.79-4 4 1.79 4 4 4h.06l2.28-2.28z"/>
                        </svg>
                      )}
                    </button>
                  </div>
                  <div className="flex items-center justify-end mt-2">
                    <span className="text-xs text-gray-500">{prompt.length}/5000</span>
                    {isRecording && (
                      <span className="text-xs text-red-400 ml-2 animate-pulse">正在录音...</span>
                    )}
                  </div>
                </div>

                <div>
                  <label className="flex items-center gap-2 text-cyan-400 text-sm font-medium mb-2">
                    <span className="w-2 h-2 bg-cyan-400 rounded-full"></span>
                    生图比例
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {ratios.map((r) => (
                      <button
                        key={r}
                        onClick={() => setRatio(r)}
                        className={`px-4 py-2 rounded-xl text-sm font-medium transition-all ${
                          ratio === r
                            ? "bg-cyan-500/20 text-cyan-400 border border-cyan-500/50"
                            : "bg-gray-700/50 text-gray-300 border border-gray-600/50 hover:bg-gray-700"
                        }`}
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                </div>

                <button
                  onClick={handleGenerate}
                  disabled={!prompt.trim()}
                  className="w-full px-6 py-3 bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-600 hover:to-blue-600 disabled:from-gray-600 disabled:to-gray-600 text-white rounded-xl font-medium shadow-lg shadow-cyan-500/30 transition-all duration-200 flex items-center justify-center gap-2"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  生成图像 <span className="text-yellow-400 text-sm">消耗 {COST_PER_IMAGE} 积分</span>
                </button>
              </div>
            </div>
          </div>

          <div className="lg:col-span-2">
            <div className="bg-[#222428] rounded-2xl border border-white/10 p-6 mb-6" style={{ boxShadow: '0 4px 20px rgba(0, 0, 0, 0.2)' }}>
              <div className="flex items-center justify-between mb-6 pb-4 border-b border-white/10">
                <h3 className="text-lg font-semibold text-[#E5E5E5]" style={{ fontFamily: '"Noto Serif SC", Georgia, serif' }}>生成记录</h3>
                <span className="text-sm text-[#888]">共 {generationHistory.length} 条</span>
                <div className="flex gap-2">
                  <button
                    onClick={() => setFilterStatus('all')}
                    className={`px-3 py-1 text-xs rounded-lg transition-all duration-300 ${
                      filterStatus === 'all'
                        ? 'bg-[#2A2C2E] text-[#E5E5E5] border border-white/10'
                        : 'text-[#666] hover:text-[#E5E5E5]'
                    }`}
                  >
                    全部
                  </button>
                  <button
                    onClick={() => setFilterStatus('generating')}
                    className={`px-3 py-1 text-xs rounded-lg transition-all duration-300 ${
                      filterStatus === 'generating'
                        ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/50'
                        : 'text-[#666] hover:text-[#E5E5E5]'
                    }`}
                  >
                    生成中
                  </button>
                  <button
                    onClick={() => setFilterStatus('success')}
                    className={`px-3 py-1 text-xs rounded-lg transition-all duration-300 ${
                      filterStatus === 'success'
                        ? 'bg-[#22C55E]/20 text-[#22C55E] border border-[#22C55E]/50'
                        : 'text-[#666] hover:text-[#E5E5E5]'
                    }`}
                  >
                    成功
                  </button>
                  <button
                    onClick={() => setFilterStatus('failed')}
                    className={`px-3 py-1 text-xs rounded-lg transition-all duration-300 ${
                      filterStatus === 'failed'
                        ? 'bg-[#EF4444]/20 text-[#EF4444] border border-[#EF4444]/50'
                        : 'text-[#666] hover:text-[#E5E5E5]'
                    }`}
                  >
                    失败
                  </button>
                </div>
              </div>

              {(() => {
                const filteredHistory = filterStatus === 'all'
                  ? generationHistory
                  : generationHistory.filter(record => record.status === filterStatus);

                if (filteredHistory.length > 0) {
                  return (
                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                      {filteredHistory.map((record, recordIndex) => (
                        <div
                          key={record.id}
                          className="relative group bg-[#1A1C1E] rounded-xl overflow-hidden border border-white/10"
                        >
                          {record.status === 'generating' ? (
                            <div className="w-full aspect-[9/16] bg-[#2A2C2E] flex items-center justify-center">
                              <div className="flex flex-col items-center gap-3">
                                <svg className="w-10 h-10 animate-spin text-cyan-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                </svg>
                                <span className="text-[#888] text-sm">生成中...</span>
                              </div>
                            </div>
                          ) : record.status === 'failed' ? (
                            <div className="w-full aspect-[9/16] bg-[#2A2C2E] flex items-center justify-center">
                              <div className="flex flex-col items-center gap-3">
                                <svg className="w-10 h-10 text-[#EF4444]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                                <span className="text-[#888] text-sm">生成失败</span>
                              </div>
                            </div>
                          ) : record.images.length > 0 ? (
                            <img
                              src={record.images[0]}
                              alt={`生成图片 ${recordIndex + 1}`}
                              className="w-full object-cover"
                              style={{ aspectRatio: record.ratio === '16:9' ? '16/9' : '9/16' }}
                            />
                          ) : (
                            <div className="w-full aspect-[9/16] bg-[#2A2C2E] flex items-center justify-center">
                              <span className="text-[#666] text-sm">暂无图片</span>
                            </div>
                          )}
                          
                          {/* 删除按钮 */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteRecord(record.id);
                            }}
                            className="absolute top-2 right-2 p-1.5 bg-[#EF4444]/90 hover:bg-[#DC2626] rounded-full opacity-0 group-hover:opacity-100 transition-all duration-300 z-10"
                          >
                            <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>

                          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-3/4 opacity-0 group-hover:opacity-100 transition-all duration-300 flex gap-3 z-20">
                            {record.status === 'success' && record.images.length > 0 && (
                              <>
                                <button
                                  onClick={() => setSelectedImage(record.images[0])}
                                  className="p-2.5 bg-[#222428] hover:bg-[#2A2C2E] rounded-full transition-all duration-300 border border-white/10"
                                >
                                  <svg className="w-5 h-5 text-[#E5E5E5]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                  </svg>
                                </button>
                                <button
                                  onClick={() => handleDownload(record.images[0])}
                                  className="p-2.5 bg-[#222428] hover:bg-[#2A2C2E] rounded-full transition-all duration-300 border border-white/10"
                                >
                                  <svg className="w-5 h-5 text-[#E5E5E5]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                                  </svg>
                                </button>
                              </>
                            )}
                          </div>

                          <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-[#1A1C1E]/95 to-transparent z-10">
                            <div className="flex items-center gap-2 mb-3">
                              {record.status === 'generating' && (
                                <span className="px-2 py-1 bg-yellow-500/20 text-yellow-400 text-xs rounded">生成中</span>
                              )}
                              {record.status === 'success' && (
                                <span className="px-2 py-1 bg-green-500/20 text-green-400 text-xs rounded">成功</span>
                              )}
                              {record.status === 'failed' && (
                                <span className="px-2 py-1 bg-red-500/20 text-red-400 text-xs rounded">失败</span>
                              )}
                              <span className="text-cyan-400 text-xs">{record.ratio}</span>
                            </div>
                            <p className="text-[#E5E5E5] text-sm line-clamp-2 mb-3">{record.prompt}</p>
                            <div className="flex gap-2">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  navigator.clipboard.writeText(record.prompt);
                                  alert('提示词已复制');
                                }}
                                className="flex-1 px-3 py-1.5 bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-400 text-xs rounded transition-all duration-300 flex items-center justify-center gap-1.5 border border-cyan-500/30"
                              >
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                </svg>
                                复制提示词
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                } else {
                  return (
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                      {[1, 2, 3, 4, 5, 6].map((i) => (
                        <div key={i} className="bg-[#1A1C1E] rounded-xl border border-white/10 aspect-square flex items-center justify-center">
                          <span className="text-[#666] text-sm">点击生成图片</span>
                        </div>
                      ))}
                    </div>
                  );
                }
              })()}
            </div>
          </div>
        </div>
      </div>

      {selectedImage && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50" onClick={() => setSelectedImage(null)}>
          <img src={selectedImage} alt="预览" className="max-w-[90vw] max-h-[90vh] rounded-xl" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </div>
  );
}
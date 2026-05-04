"use client";

import { useState, useEffect } from "react";
import ImageHeader from '../components/ImageHeader';
import { supabase } from '../lib/supabase';

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

const COST_PER_IMAGE = 2;

export default function ImageGenerator() {
  const [mode, setMode] = useState<'text' | 'image'>('text');
  const [prompt, setPrompt] = useState("");
  const [ratio, setRatio] = useState("9:16");
  const [generationHistory, setGenerationHistory] = useState<GenerationRecord[]>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('yunwuai_generation_history');
      return saved ? JSON.parse(saved) : [];
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
  const [points, setPoints] = useState(0);

  useEffect(() => {
    loadUserPoints();
  }, []);

  const loadUserPoints = async () => {
    const { data } = await supabase.auth.getSession();
    const user = data?.session?.user;
    if (user) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('points')
        .eq('id', user.id)
        .single();
      setPoints(profile?.points || 0);
    }
  };

  const saveHistory = (history: GenerationRecord[]) => {
    localStorage.setItem('yunwuai_generation_history', JSON.stringify(history));
  };

  const ratios = ["9:16", "16:9", "1:1", "3:2", "2:3", "4:3"];

  const compressImage = async (file: File): Promise<string> => {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
          const MAX_SIZE = 4 * 1024 * 1024;
          const MAX_DIMENSION = 1536;
          
          let width = img.width;
          let height = img.height;
          let quality = 0.9;
          
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

            ctx.drawImage(img, 0, 0, width, height);

            const compressedDataUrl = canvas.toDataURL('image/jpeg', currentQuality);
            const compressedSize = compressedDataUrl.length * 0.75;

            console.log(`压缩尝试 - 质量: ${(currentQuality * 100).toFixed(0)}%, 大小: ${(compressedSize / 1024 / 1024).toFixed(2)} MB`);

            if (compressedSize > MAX_SIZE && currentQuality > 0.1) {
              if (width > 512 || height > 512) {
                width = Math.round(width * 0.8);
                height = Math.round(height * 0.8);
              }
              compress(Math.max(0.1, currentQuality - 0.1));
            } else {
              console.log(`图片压缩完成 - 原大小: ${(file.size / 1024 / 1024).toFixed(2)} MB, 压缩后: ${(compressedSize / 1024 / 1024).toFixed(2)} MB, 质量: ${(currentQuality * 100).toFixed(0)}%`);
              resolve(compressedDataUrl);
            }
          };

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
      if (recognition) {
        recognition.stop();
        setRecognition(null);
      }
      setIsRecording(false);
    } else {
      if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
        const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        const rec = new SpeechRecognition();
        rec.continuous = true;
        rec.interimResults = true;
        rec.lang = 'zh-CN';

        rec.onresult = (event: any) => {
          let newTranscript = '';
          for (let i = event.resultIndex; i < event.results.length; i++) {
            newTranscript += event.results[i][0].transcript;
          }
          setPrompt(prev => prev + newTranscript);
        };

        rec.onerror = (event: any) => {
          console.error('语音识别错误:', event.error);
          setIsRecording(false);
          setRecognition(null);
          if (event.error === 'not-allowed') {
            alert('请在浏览器设置中允许麦克风权限');
          }
        };

        rec.onend = () => {};

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

  const handleDownload = async (imageUrl: string) => {
    try {
      const response = await fetch(imageUrl);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `generated-image-${Date.now()}.png`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (error) {
      console.error('下载失败:', error);
      alert('下载失败，请稍后重试');
    }
  };

  const handleGenerate = async () => {
    console.log('========== 开始生成图片 ==========');
    console.log('prompt:', prompt?.substring(0, 50));
    console.log('mode:', mode);
    console.log('uploadedImages:', uploadedImages?.length || 0, '张');

    if (!prompt.trim()) {
      console.log('❌ 提示词为空');
      alert('请输入提示词');
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

    const currentPoints = profile?.points || 0;
    console.log('points:', currentPoints);
    
    if (currentPoints < COST_PER_IMAGE) {
      console.log('❌ 积分不足');
      alert(`积分不足！当前积分: ${currentPoints}，生成图片需要 ${COST_PER_IMAGE} 积分`);
      return;
    }
    
    if (mode === 'image' && uploadedImages.length === 0) {
      console.log('❌ 图生图模式但未上传图片');
      alert('请先上传图片');
      return;
    }
    
    console.log('✅ 所有检查通过，准备发送请求');
    
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
      };

      if (mode === 'image' && uploadedImages.length > 0) {
        bodyData.image = uploadedImages;
      }

      console.log('Sending request to /api/generate-image');
      
      const response = await fetch('/api/generate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyData),
      });

      console.log('Response status:', response.status, response.statusText);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('API error:', errorText);
        
        let errorData;
        try {
          errorData = JSON.parse(errorText);
        } catch {
          errorData = { error: errorText || 'Unknown error' };
        }
        
        let errorMsg = errorData.error || errorData.message || `请求失败: ${response.status}`;
        alert(errorMsg);
        throw new Error(errorMsg);
      }

      const data = await response.json();
      console.log('Received response:', data);
      
      if (data.urls && data.urls.length > 0) {
        const images = data.urls;
        console.log('Generated images:', images);

        const newBalance = currentPoints - (data.cost || COST_PER_IMAGE);
        await supabase.from('profiles').update({ points: newBalance }).eq('id', user.id);
        await supabase.from('transactions').insert({
          user_id: user.id,
          type: 'generate_image',
          description: `生图扣费 ${data.cost || COST_PER_IMAGE} 积分`,
          points_change: -(data.cost || COST_PER_IMAGE),
          balance_after: newBalance,
        });
        setPoints(newBalance);

        setGenerationHistory(prev => {
          const updated = prev.map(r => 
            r.id === recordId 
              ? { ...r, images, status: 'success' as const }
              : r
          );
          saveHistory(updated);
          return updated;
        });
      } else if (data.error) {
        throw new Error(data.error);
      } else {
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

  const filteredHistory = generationHistory.filter(record => {
    if (filterStatus === 'all') return true;
    return record.status === filterStatus;
  });

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900">
      <ImageHeader points={points} />
      
      <div className="max-w-6xl mx-auto px-4 py-8">
        <div className="bg-slate-800/50 backdrop-blur-lg rounded-2xl p-6 mb-8">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl font-bold text-white">AI 图像生成</h2>
            <div className="flex items-center gap-4">
              <div className="text-yellow-400 font-semibold">
                💰 积分: {points}
              </div>
              <div className="text-gray-400 text-sm">
                每次生成消耗 {COST_PER_IMAGE} 积分
              </div>
            </div>
          </div>

          <div className="flex gap-4 mb-6">
            <button
              onClick={() => setMode('text')}
              className={`px-6 py-2 rounded-lg font-semibold transition-all ${
                mode === 'text'
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-700 text-gray-300 hover:bg-slate-600'
              }`}
            >
              文生图
            </button>
            <button
              onClick={() => setMode('image')}
              className={`px-6 py-2 rounded-lg font-semibold transition-all ${
                mode === 'image'
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-700 text-gray-300 hover:bg-slate-600'
              }`}
            >
              图生图
            </button>
          </div>

          <div className="mb-6">
            <label className="block text-white mb-2 font-semibold">提示词</label>
            <div className="relative">
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="描述你想要生成的图片..."
                className="w-full h-32 p-4 bg-slate-900 text-white rounded-lg border border-slate-700 focus:border-blue-500 focus:outline-none resize-none"
              />
              <button
                onClick={toggleVoiceInput}
                className={`absolute right-3 bottom-3 p-2 rounded-full transition-all ${
                  isRecording ? 'bg-red-500 text-white' : 'bg-slate-700 text-gray-400 hover:bg-slate-600'
                }`}
              >
                🎤
              </button>
            </div>
          </div>

          {mode === 'image' && (
            <div className="mb-6">
              <label className="block text-white mb-2 font-semibold">参考图（可选）</label>
              <div className="border-2 border-dashed border-slate-600 rounded-lg p-8 text-center">
                {uploadedImages.length === 0 ? (
                  <label className="cursor-pointer">
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={handleImageUpload}
                      className="hidden"
                    />
                    <div className="text-gray-400">
                      <div className="text-4xl mb-2">📷</div>
                      <p>点击上传图片</p>
                    </div>
                  </label>
                ) : (
                  <div className="grid grid-cols-3 gap-4">
                    {uploadedImages.map((img, index) => (
                      <div key={index} className="relative">
                        <img src={img} alt={`参考图 ${index + 1}`} className="w-full h-32 object-cover rounded-lg" />
                        <button
                          onClick={() => removeUploadedImage(index)}
                          className="absolute top-1 right-1 p-1 bg-red-500 text-white rounded-full hover:bg-red-600"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="flex items-center justify-between">
            <div className="flex gap-2">
              {ratios.map((r) => (
                <button
                  key={r}
                  onClick={() => setRatio(r)}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                    ratio === r
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-700 text-gray-300 hover:bg-slate-600'
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
            
            <button
              onClick={handleGenerate}
              disabled={isGenerating || !prompt.trim()}
              className="px-8 py-3 bg-gradient-to-r from-blue-600 to-purple-600 text-white font-semibold rounded-lg hover:from-blue-700 hover:to-purple-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              🎨 生成图片
            </button>
          </div>
        </div>

        <div className="mb-6">
          <div className="flex gap-4">
            {(['all', 'generating', 'success', 'failed'] as const).map((status) => (
              <button
                key={status}
                onClick={() => setFilterStatus(status)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                  filterStatus === status
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-700 text-gray-300 hover:bg-slate-600'
                }`}
              >
                {status === 'all' && '全部'}
                {status === 'generating' && '生成中'}
                {status === 'success' && '成功'}
                {status === 'failed' && '失败'}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredHistory.map((record) => (
            <div
              key={record.id}
              className="bg-slate-800/50 backdrop-blur-lg rounded-xl overflow-hidden"
            >
              <div className="p-4 border-b border-slate-700">
                <div className="flex items-center justify-between mb-2">
                  <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                    record.status === 'generating' ? 'bg-yellow-500/20 text-yellow-400' :
                    record.status === 'success' ? 'bg-green-500/20 text-green-400' :
                    'bg-red-500/20 text-red-400'
                  }`}>
                    {record.status === 'generating' && '生成中'}
                    {record.status === 'success' && '生成完成'}
                    {record.status === 'failed' && '生成失败'}
                  </span>
                  <button
                    onClick={() => handleDeleteRecord(record.id)}
                    className="text-gray-400 hover:text-red-400 transition-colors"
                  >
                    🗑️
                  </button>
                </div>
                <p className="text-white text-sm line-clamp-2">{record.prompt}</p>
              </div>
              
              {record.status === 'generating' && (
                <div className="p-8 text-center">
                  <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
                  <p className="text-gray-400">正在生成中...</p>
                </div>
              )}
              
              {record.status === 'success' && record.images.length > 0 && (
                <div className="p-4">
                  <img
                    src={record.images[0]}
                    alt="Generated"
                    className="w-full h-48 object-cover rounded-lg cursor-pointer hover:opacity-90 transition-opacity"
                    onClick={() => setSelectedImage(record.images[0])}
                  />
                  <div className="flex gap-2 mt-4">
                    <button
                      onClick={() => handleDownload(record.images[0])}
                      className="flex-1 px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition-colors"
                    >
                      📥 下载
                    </button>
                    <button
                      onClick={() => setSelectedImage(record.images[0])}
                      className="px-4 py-2 bg-slate-700 text-white text-sm rounded-lg hover:bg-slate-600 transition-colors"
                    >
                      🔍 查看
                    </button>
                  </div>
                </div>
              )}
              
              {record.status === 'failed' && (
                <div className="p-8 text-center">
                  <div className="text-4xl mb-4">❌</div>
                  <p className="text-red-400 text-sm">{record.error}</p>
                </div>
              )}
            </div>
          ))}
        </div>

        {selectedImage && (
          <div
            className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4"
            onClick={() => setSelectedImage(null)}
          >
            <img
              src={selectedImage}
              alt="Preview"
              className="max-w-full max-h-full object-contain rounded-lg"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        )}
      </div>
    </div>
  );
}
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

export default function ImageGenerator() {
  const [apiKey, setApiKey] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('yunwuai_api_key') || '';
    }
    return '';
  });
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

  const saveHistory = (history: GenerationRecord[]) => {
    localStorage.setItem('yunwuai_generation_history', JSON.stringify(history));
  };

  const ratios = ["9:16", "16:9", "1:1", "3:2", "2:3", "4:3"];

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      const newImages: string[] = [];
      Array.from(files).forEach((file) => {
        const reader = new FileReader();
        reader.onload = (event) => {
          if (event.target?.result) {
            newImages.push(event.target.result as string);
            if (newImages.length === files.length) {
              setUploadedImages(newImages);
            }
          }
        };
        reader.readAsDataURL(file);
      });
    }
  };

  const removeUploadedImage = (index: number) => {
    setUploadedImages(prev => prev.filter((_, i) => i !== index));
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
    if (!prompt.trim()) return;
    if (!apiKey.trim()) {
      alert('请先输入 API Key');
      return;
    }

    const { data } = await supabase.auth.getSession();
    const user = data?.session?.user;
    if (!user) {
      alert('请先登录后再使用生图功能');
      return;
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('points')
      .eq('id', user.id)
      .single();

    if (!profile || profile.points < 10) {
      alert('积分不足，请先充值！最低需要 10 积分');
      return;
    }
    
    if (mode === 'image' && uploadedImages.length === 0) {
      alert('请先上传图片');
      return;
    }
    
    setIsGenerating(true);
    
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
        apiKey,
        prompt,
        model: 'gpt-image-2-all',
        size: getSizeFromRatio(ratio),
        n: 1,
      };

      if (mode === 'image' && uploadedImages.length > 0) {
        bodyData.image = uploadedImages;
      }

      console.log('Sending request to /api/generate-image:', {
        bodyData: { ...bodyData, apiKey: '***' },
      });

      const response = await fetch('/api/generate-image', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(bodyData),
      });

      console.log('Response status:', response.status, response.statusText);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
        console.error('API error:', errorData);
        throw new Error(errorData.error || `请求失败: ${response.status}`);
      }

      const data = await response.json();
      console.log('Received response:', data);
      
      if (data.data && data.data.length > 0) {
        const images = data.data.map((item: any) => item.url || item.b64_json);
        console.log('Generated images:', images);

        const { data: { user } } = await supabase.auth.getSession();
        if (user) {
          const { data: profile } = await supabase.from('profiles').select('points').eq('id', user.id).single();
          const newBalance = (profile?.points || 0) - 10;
          await supabase.from('transactions').insert({
            user_id: user.id,
            type: 'generate_image',
            description: `生图扣费`,
            points_change: -10,
            balance_after: newBalance,
          });
        }
        await supabase.rpc('deduct_points', { amount: 10 });

        setGenerationHistory(prev => {
          const updated = prev.map(r => 
            r.id === recordId 
              ? { ...r, images, status: 'success' as const }
              : r
          );
          saveHistory(updated);
          return updated;
        });
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
    } finally {
      setIsGenerating(false);
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

  const handleSaveApiKey = () => {
    localStorage.setItem('yunwuai_api_key', apiKey);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900 py-8 px-4">
      <div className="max-w-7xl mx-auto">
        <ImageHeader />

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-1 space-y-6">
            <div className="bg-gray-800/80 backdrop-blur-sm rounded-2xl shadow-2xl p-6 border border-gray-700/50">
              <div className="flex gap-2 mb-4">
                <button
                  onClick={() => setMode('text')}
                  className={`flex-1 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                    mode === 'text'
                      ? 'bg-gradient-to-r from-purple-600 to-pink-600 text-white'
                      : 'bg-gray-700/50 text-gray-300 border border-gray-600/50 hover:bg-gray-700'
                  }`}
                >
                  文生图
                </button>
                <button
                  onClick={() => setMode('image')}
                  className={`flex-1 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                    mode === 'image'
                      ? 'bg-gradient-to-r from-purple-600 to-pink-600 text-white'
                      : 'bg-gray-700/50 text-gray-300 border border-gray-600/50 hover:bg-gray-700'
                  }`}
                >
                  图生图
                </button>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="flex items-center gap-2 text-cyan-400 text-sm font-medium mb-2">
                    <span className="w-2 h-2 bg-cyan-400 rounded-full"></span>
                    API Key
                  </label>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    onBlur={handleSaveApiKey}
                    placeholder="请输入你的云雾 AI API Key"
                    className="w-full p-4 bg-gray-900/80 border border-gray-700 rounded-xl text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500/50 transition-all text-sm"
                  />
                  <p className="text-gray-500 text-xs mt-2">
                    API Key 会保存在本地浏览器中
                  </p>
                </div>

                {mode === 'image' && (
                  <div>
                    <label className="flex items-center gap-2 text-cyan-400 text-sm font-medium mb-2">
                      <span className="w-2 h-2 bg-cyan-400 rounded-full"></span>
                      上传图片
                    </label>
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={handleImageUpload}
                      className="w-full p-4 bg-gray-900/80 border border-gray-700 rounded-xl text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500/50 transition-all text-sm cursor-pointer"
                    />
                    {uploadedImages.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {uploadedImages.map((img, index) => (
                          <div key={index} className="relative w-16 h-16 rounded-lg overflow-hidden border border-gray-600">
                            <img src={img} alt={`上传 ${index + 1}`} className="w-full h-full object-cover" />
                            <button
                              onClick={() => removeUploadedImage(index)}
                              className="absolute top-0 right-0 w-5 h-5 bg-red-500/80 flex items-center justify-center text-white text-xs hover:bg-red-500"
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
                  <textarea
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="根据主题描述生成内容，描述生成的场景，主题，一键成片"
                    className="w-full h-32 p-4 bg-gray-900/80 border border-gray-700 rounded-xl text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500/50 resize-none transition-all text-sm"
                  />
                  <div className="flex items-center justify-end mt-2">
                    <span className="text-xs text-gray-500">0/5000</span>
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
                  disabled={isGenerating || !prompt.trim()}
                  className="w-full px-6 py-3 bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-600 hover:to-blue-600 disabled:from-gray-600 disabled:to-gray-600 text-white rounded-xl font-medium shadow-lg shadow-cyan-500/30 transition-all duration-200 flex items-center justify-center gap-2"
                >
                  {isGenerating ? (
                    <>
                      <svg className="w-5 h-5 animate-spin" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      生成中...
                    </>
                  ) : (
                    <>
                      🎨 生成生图
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>

          <div className="lg:col-span-2">
            <div className="bg-gray-800/80 backdrop-blur-sm rounded-2xl shadow-2xl p-6 border border-gray-700/50">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-gray-300 font-medium">生成记录</h3>
                <span className="text-gray-500 text-sm">共 {generationHistory.length} 条</span>
                <div className="flex gap-2">
                  <button
                    onClick={() => setFilterStatus('all')}
                    className={`px-3 py-1 text-xs rounded-lg transition-all ${
                      filterStatus === 'all'
                        ? 'bg-gray-700/50 text-gray-300'
                        : 'text-gray-500 hover:text-gray-300'
                    }`}
                  >
                    全部
                  </button>
                  <button
                    onClick={() => setFilterStatus('generating')}
                    className={`px-3 py-1 text-xs rounded-lg transition-all ${
                      filterStatus === 'generating'
                        ? 'bg-yellow-500/20 text-yellow-400'
                        : 'text-gray-500 hover:text-gray-300'
                    }`}
                  >
                    生成中
                  </button>
                  <button
                    onClick={() => setFilterStatus('success')}
                    className={`px-3 py-1 text-xs rounded-lg transition-all ${
                      filterStatus === 'success'
                        ? 'bg-green-500/20 text-green-400'
                        : 'text-gray-500 hover:text-gray-300'
                    }`}
                  >
                    成功
                  </button>
                  <button
                    onClick={() => setFilterStatus('failed')}
                    className={`px-3 py-1 text-xs rounded-lg transition-all ${
                      filterStatus === 'failed'
                        ? 'bg-red-500/20 text-red-400'
                        : 'text-gray-500 hover:text-gray-300'
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
                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                      {filteredHistory.map((record, recordIndex) => (
                        <div
                          key={record.id}
                          className="relative group bg-gray-900/80 rounded-xl overflow-hidden border border-gray-700/50"
                        >
                          {record.status === 'generating' ? (
                            <div className="w-full aspect-[9/16] bg-gray-800 flex items-center justify-center">
                              <div className="flex flex-col items-center gap-2">
                                <svg className="w-8 h-8 animate-spin text-cyan-400" viewBox="0 0 24 24">
                                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                                </svg>
                                <span className="text-gray-400 text-xs">生成中...</span>
                              </div>
                            </div>
                          ) : record.status === 'failed' ? (
                            <div className="w-full aspect-[9/16] bg-gray-800 flex items-center justify-center">
                              <div className="flex flex-col items-center gap-2">
                                <svg className="w-8 h-8 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                                <span className="text-gray-400 text-xs">生成失败</span>
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
                            <div className="w-full aspect-[9/16] bg-gray-800 flex items-center justify-center">
                              <span className="text-gray-600 text-sm">暂无图片</span>
                            </div>
                          )}
                          
                          {/* 删除按钮 */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteRecord(record.id);
                            }}
                            className="absolute top-2 right-2 p-1.5 bg-red-500/80 hover:bg-red-600 rounded-full opacity-0 group-hover:opacity-100 transition-opacity z-10"
                          >
                            <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>

                          <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                            {record.status === 'success' && record.images.length > 0 && (
                              <>
                                <button
                                  onClick={() => setSelectedImage(record.images[0])}
                                  className="p-2 bg-white/20 hover:bg-white/30 rounded-full transition-colors"
                                >
                                  <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                  </svg>
                                </button>
                                <button
                                  onClick={() => handleDownload(record.images[0])}
                                  className="p-2 bg-white/20 hover:bg-white/30 rounded-full transition-colors"
                                >
                                  <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                                  </svg>
                                </button>
                              </>
                            )}
                          </div>

                          <div className="absolute bottom-0 left-0 right-0 p-3 bg-gradient-to-t from-black/80 to-transparent">
                            <div className="flex items-center gap-2 mb-2">
                              {record.status === 'generating' && (
                                <span className="px-2 py-0.5 bg-yellow-500/20 text-yellow-400 text-xs rounded">生成中</span>
                              )}
                              {record.status === 'success' && (
                                <span className="px-2 py-0.5 bg-green-500/20 text-green-400 text-xs rounded">成功</span>
                              )}
                              {record.status === 'failed' && (
                                <span className="px-2 py-0.5 bg-red-500/20 text-red-400 text-xs rounded">失败</span>
                              )}
                              <span className="text-cyan-400 text-xs">{record.ratio}</span>
                            </div>
                            <p className="text-white text-xs truncate mb-2">{record.prompt.substring(0, 30)}...</p>
                            <div className="flex gap-2">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  navigator.clipboard.writeText(record.prompt);
                                  alert('提示词已复制');
                                }}
                                className="flex-1 px-2 py-1 bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-400 text-xs rounded transition-colors flex items-center justify-center gap-1"
                              >
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
                        <div key={i} className="bg-gray-900/80 rounded-xl border border-gray-700/50 aspect-square flex items-center justify-center">
                          <span className="text-gray-600 text-sm">点击生成图片</span>
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
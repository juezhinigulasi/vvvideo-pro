"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import ImageHeader from '../components/ImageHeader';
import { supabase } from '../lib/supabase';

const COST_PER_IMAGE = 2;
const POLL_INTERVAL = 3000; // 轮询间隔 3 秒

interface GenerationRecord {
  id: string;
  prompt: string;
  model: string;
  ratio: string;
  images: string[];
  status: 'generating' | 'success' | 'failed';
  createdAt: number;
  taskId: string; // 任务ID（前端预先生成）
  error?: string;
}

// 生成任务ID（与后端格式一致）
const generateTaskId = (): string => {
  return `img-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
};

export default function ImageGenerator() {
  const [mode, setMode] = useState<'text' | 'image'>('text');
  const [prompt, setPrompt] = useState("");
  const [ratio, setRatio] = useState("9:16");
  const [generationHistory, setGenerationHistory] = useState<GenerationRecord[]>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('yunwuai_generation_history');
      if (saved) {
        try {
          return JSON.parse(saved);
        } catch {
          return [];
        }
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

  // 轮询定时器引用
  const pollingIntervalsRef = useRef<Record<string, ReturnType<typeof setInterval>>>({});

  useEffect(() => {
    loadUserCredits();
    
    // 页面加载时，恢复正在生成中的任务轮询
    const pendingTasks = generationHistory.filter(
      record => record.status === 'generating' && record.taskId
    );
    if (pendingTasks.length > 0) {
      console.log(`[图片生成] 恢复 ${pendingTasks.length} 个任务的轮询`);
      for (const record of pendingTasks) {
        if (record.taskId && !pollingIntervalsRef.current[record.id]) {
          startPolling(record.taskId, record.id);
        }
      }
    }
  }, []);

  // 保存历史记录到 localStorage
  const saveHistory = useCallback((history: GenerationRecord[]) => {
    localStorage.setItem('yunwuai_generation_history', JSON.stringify(history));
  }, []);

  useEffect(() => {
    saveHistory(generationHistory);
  }, [generationHistory, saveHistory]);

  // 清理轮询定时器
  useEffect(() => {
    return () => {
      Object.values(pollingIntervalsRef.current).forEach(clearInterval);
    };
  }, []);

  const loadUserCredits = async () => {
    try {
      const { data } = await supabase.auth.getSession();
      const user = data?.session?.user;
      if (user) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('points')
          .eq('id', user.id)
          .single();
        setCredits(profile?.points || 0);
      }
    } catch (error) {
      console.error('获取积分失败:', error);
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

  // 开始轮询任务状态
  const startPolling = (taskId: string, recordId: string) => {
    if (pollingIntervalsRef.current[recordId]) {
      clearInterval(pollingIntervalsRef.current[recordId]);
    }

    pollingIntervalsRef.current[recordId] = setInterval(async () => {
      try {
        const { data } = await supabase.auth.getSession();
        const user = data?.session?.user;
        
        if (!user) {
          stopPolling(recordId);
          return;
        }

        const response = await fetch(`/api/generate-image?taskId=${encodeURIComponent(taskId)}&user_id=${encodeURIComponent(user.id)}`);
        const result = await response.json();

        console.log(`[轮询] 任务 ${taskId} 状态:`, result.status);

        if (result.status === 'completed') {
          // 任务完成
          setGenerationHistory(prev => prev.map(record =>
            record.id === recordId
              ? { ...record, status: 'success' as const, images: result.urls || [] }
              : record
          ));
          stopPolling(recordId);
          loadUserCredits();
          // 刷新 Header 积分
          if ((window as any).refreshUserCredits) {
            (window as any).refreshUserCredits();
          }
        } else if (result.status === 'failed') {
          // 任务失败
          setGenerationHistory(prev => prev.map(record =>
            record.id === recordId
              ? { ...record, status: 'failed' as const, error: result.error || '生成失败' }
              : record
          ));
          stopPolling(recordId);
          loadUserCredits();
        } else if (result.status === 'not_found') {
          // 任务不存在
          stopPolling(recordId);
        }
        // 其他状态继续轮询
      } catch (error) {
        console.error(`[轮询] 任务 ${taskId} 失败:`, error);
      }
    }, POLL_INTERVAL);
  };

  // 停止轮询
  const stopPolling = (recordId: string) => {
    if (pollingIntervalsRef.current[recordId]) {
      clearInterval(pollingIntervalsRef.current[recordId]);
      delete pollingIntervalsRef.current[recordId];
    }
  };

  const handleGenerate = async () => {
    console.log('========== 开始生成图片 ==========');

    if (!prompt.trim()) {
      alert('请输入提示词');
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

    if (!profile || profile.points < COST_PER_IMAGE) {
      alert(`积分不足！当前积分: ${profile?.points || 0}，生成图片需要 ${COST_PER_IMAGE} 积分`);
      return;
    }
    
    if (mode === 'image' && uploadedImages.length === 0) {
      alert('请先上传图片');
      return;
    }
    
    console.log('✅ 所有检查通过，准备发送请求');

    // 预先生成任务ID，确保刷新后能恢复轮询
    const recordId = Date.now().toString();
    const taskId = generateTaskId();
    
    const newRecord: GenerationRecord = {
      id: recordId,
      prompt,
      model: 'gpt-image-2-all',
      ratio,
      images: [],
      status: 'generating',
      createdAt: Date.now(),
      taskId, // 立即设置 taskId
    };
    
    setGenerationHistory(prev => {
      const updated = [newRecord, ...prev];
      saveHistory(updated);
      return updated;
    });
    
    // 立即开始轮询（即使请求还没返回）
    startPolling(taskId, recordId);
    
    try {
      const bodyData: Record<string, any> = {
        prompt,
        model: 'gpt-image-2-all',
        size: getSizeFromRatio(ratio),
        n: 1,
        user_id: user.id,
        task_id: taskId, // 传递预先生成的 taskId 给后端
      };

      if (mode === 'image' && uploadedImages.length > 0) {
        bodyData.image = uploadedImages;
      }

      const response = await fetch('/api/generate-image', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(bodyData),
      });

      console.log('Response status:', response.status);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('API error:', errorText);
        
        let errorMsg = '请求失败';
        try {
          const errorData = JSON.parse(errorText);
          errorMsg = errorData.error || errorData.message || errorMsg;
        } catch {}

        // 更新状态为失败
        setGenerationHistory(prev => prev.map(record =>
          record.id === recordId
            ? { ...record, status: 'failed' as const, error: errorMsg }
            : record
        ));
        stopPolling(recordId);
        alert(errorMsg);
        return;
      }

      const result = await response.json();
      console.log('API response:', result);

      // 任务已在进行中，轮询会处理状态更新
      if (result.status === 'completed' && result.urls) {
        // 直接完成（快速响应情况）
        setGenerationHistory(prev => prev.map(record =>
          record.id === recordId
            ? { ...record, status: 'success' as const, images: result.urls }
            : record
        ));
        stopPolling(recordId);
        loadUserCredits();
        if ((window as any).refreshUserCredits) {
          (window as any).refreshUserCredits();
        }
      }

    } catch (error) {
      console.error('请求失败:', error);
      setGenerationHistory(prev => prev.map(record =>
        record.id === recordId
          ? { ...record, status: 'failed' as const, error: '请求失败: ' + (error as Error).message }
          : record
      ));
      stopPolling(recordId);
      alert('请求失败: ' + (error as Error).message);
    }
  };

  const handleDelete = (id: string) => {
    setGenerationHistory(prev => {
      const updated = prev.filter(record => record.id !== id);
      saveHistory(updated);
      return updated;
    });
    setRecordToDelete(null);
  };

  const handleImageUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    const newImages: string[] = [];
    let count = 0;

    Array.from(files).forEach(file => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const result = e.target?.result as string;
        if (result) {
          newImages.push(result);
        }
        count++;
        if (count === files.length) {
          setUploadedImages(prev => [...prev, ...newImages]);
        }
      };
      reader.readAsDataURL(file);
    });
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
        };

        rec.start();
        setRecognition(rec);
        setIsRecording(true);
      } else {
        alert('您的浏览器不支持语音识别功能');
      }
    }
  };

  const filteredHistory = generationHistory.filter(record => {
    if (filterStatus === 'all') return true;
    return record.status === filterStatus;
  });

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900">
      <ImageHeader credits={credits} />
      
      <div className="max-w-7xl mx-auto px-4 py-6">
        <h1 className="text-3xl font-bold text-center text-white mb-8">明亮图像生成工具</h1>
        <p className="text-center text-gray-400 mb-8">提供给学员专用版，学习短视频流量变现，购微：zhengnianxin123</p>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* 左侧控制面板 */}
          <div className="lg:col-span-1">
            <div className="bg-gray-800/50 backdrop-blur rounded-xl p-6 border border-gray-700">
              {/* 模式切换 */}
              <div className="flex gap-4 mb-6">
                <button
                  onClick={() => setMode('text')}
                  className={`flex-1 py-3 px-4 rounded-lg font-medium transition-all ${
                    mode === 'text'
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  文生图
                </button>
                <button
                  onClick={() => setMode('image')}
                  className={`flex-1 py-3 px-4 rounded-lg font-medium transition-all ${
                    mode === 'image'
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  图生图
                </button>
              </div>

              {/* 提示词输入 */}
              <div className="mb-6">
                <label className="block text-gray-300 text-sm font-medium mb-2">提示词</label>
                <div className="relative">
                  <textarea
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="根据主题描述生成内容，描述生成的场景，主题，一键成片"
                    className="w-full h-32 p-4 bg-gray-700/50 border border-gray-600 rounded-lg text-white placeholder-gray-400 resize-none focus:outline-none focus:border-blue-500"
                  />
                  <div className="absolute bottom-3 right-3 flex gap-2">
                    <button
                      onClick={toggleVoiceInput}
                      className={`p-2 rounded-lg transition-all ${
                        isRecording
                          ? 'bg-red-500 text-white'
                          : 'bg-gray-600 text-gray-300 hover:bg-gray-500'
                      }`}
                    >
                      <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                        {isRecording ? (
                          <path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm-5.5 0c0-.55-.45-1-1-1H4v2h8c.55 0 1-.45 1-1zm2 5.5c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm-5.5 0c0-.55-.45-1-1-1H4v2h8c.55 0 1-.45 1-1zM12 4c-4.42 0-8 3.58-8 8s3.58 8 8 8 8-3.58 8-8-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6s2.69-6 6-6 6 2.69 6 6-2.69 6-6 6z"/>
                        ) : (
                          <path d="M12 14c1.66 0 2.99-1.34 2.99-3S13.66 8 12 8 9 9.34 9 11s1.34 3 3 3zm-1-9c-4.97 0-9 4.03-9 9s4.02 9 9 9 9-4.03 9-9-4.03-9-9-9zm0 16c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z"/>
                        )}
                      </svg>
                    </button>
                  </div>
                </div>
                <p className="text-gray-400 text-sm mt-2">{prompt.length}/5000</p>
              </div>

              {/* 生图比例 */}
              <div className="mb-6">
                <label className="block text-gray-300 text-sm font-medium mb-2">生图比例</label>
                <div className="grid grid-cols-3 gap-2">
                  {['9:16', '16:9', '1:1', '3:2', '2:3', '4:3'].map((r) => (
                    <button
                      key={r}
                      onClick={() => setRatio(r)}
                      className={`py-2 px-3 rounded-lg text-sm font-medium transition-all ${
                        ratio === r
                          ? 'bg-blue-600 text-white'
                          : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                      }`}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>

              {/* 图生图上传区域 */}
              {mode === 'image' && (
                <div className="mb-6">
                  <label className="block text-gray-300 text-sm font-medium mb-2">上传图片</label>
                  <div
                    className="border-2 border-dashed border-gray-600 rounded-lg p-4 text-center hover:border-blue-500 transition-colors cursor-pointer"
                    onClick={() => document.getElementById('image-upload')?.click()}
                  >
                    <input
                      id="image-upload"
                      type="file"
                      multiple
                      accept="image/*"
                      onChange={handleImageUpload}
                      className="hidden"
                    />
                    {uploadedImages.length === 0 ? (
                      <p className="text-gray-400">点击或拖拽上传图片</p>
                    ) : (
                      <div className="text-gray-300">
                        <p>已上传 {uploadedImages.length} 张图片</p>
                        <div className="flex flex-wrap gap-2 mt-2">
                          {uploadedImages.map((img, index) => (
                            <div key={index} className="relative">
                              <img
                                src={img}
                                alt={`uploaded-${index}`}
                                className="w-16 h-16 object-cover rounded"
                              />
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  removeUploadedImage(index);
                                }}
                                className="absolute -top-2 -right-2 w-5 h-5 bg-red-500 rounded-full text-white text-xs flex items-center justify-center"
                              >
                                ×
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* 生成按钮 */}
              <button
                onClick={handleGenerate}
                disabled={isGenerating || !prompt.trim()}
                className={`w-full py-4 rounded-lg font-medium text-white transition-all flex items-center justify-center gap-2 ${
                  isGenerating || !prompt.trim()
                    ? 'bg-gray-600 cursor-not-allowed'
                    : 'bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700'
                }`}
              >
                {isGenerating ? (
                  <>
                    <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
                    </svg>
                    生成中...
                  </>
                ) : (
                  <>
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/>
                    </svg>
                    生成图像 ({COST_PER_IMAGE}积分)
                  </>
                )}
              </button>
            </div>
          </div>

          {/* 右侧生成记录 */}
          <div className="lg:col-span-2">
            <div className="bg-gray-800/50 backdrop-blur rounded-xl border border-gray-700">
              {/* 过滤标签 */}
              <div className="flex gap-2 p-4 border-b border-gray-700">
                {[
                  { key: 'all', label: '全部' },
                  { key: 'generating', label: '生成中' },
                  { key: 'success', label: '成功' },
                  { key: 'failed', label: '失败' },
                ].map(({ key, label }) => (
                  <button
                    key={key}
                    onClick={() => setFilterStatus(key as typeof filterStatus)}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                      filterStatus === key
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                    }`}
                  >
                    {label}
                    ({generationHistory.filter(r => r.status === key).length})
                  </button>
                ))}
              </div>

              {/* 生成记录列表 */}
              <div className="p-4">
                {filteredHistory.length === 0 ? (
                  <div className="text-center py-12 text-gray-400">
                    <svg className="w-16 h-16 mx-auto mb-4 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/>
                    </svg>
                    <p>暂无生成记录</p>
                    <p className="text-sm mt-1">输入提示词开始生成图片</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                    {filteredHistory.map((record) => (
                      <div
                        key={record.id}
                        className="relative bg-gray-700/50 rounded-lg overflow-hidden border border-gray-600"
                      >
                        {/* 状态标签 */}
                        <div className={`absolute top-2 right-2 px-2 py-1 rounded-full text-xs font-medium z-10 ${
                          record.status === 'generating'
                            ? 'bg-yellow-500/90 text-black'
                            : record.status === 'success'
                            ? 'bg-green-500/90 text-white'
                            : 'bg-red-500/90 text-white'
                        }`}>
                          {record.status === 'generating' ? '生成中' : record.status === 'success' ? '成功' : '失败'}
                        </div>

                        {/* 图片展示 */}
                        <div className="aspect-square bg-gray-800">
                          {record.status === 'generating' ? (
                            <div className="w-full h-full flex items-center justify-center">
                              <svg className="animate-spin h-10 w-10 text-blue-500" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/>
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
                              </svg>
                            </div>
                          ) : record.status === 'success' && record.images.length > 0 ? (
                            <img
                              src={record.images[0]}
                              alt={record.prompt}
                              className="w-full h-full object-cover cursor-pointer hover:opacity-90"
                              onClick={() => setSelectedImage(record.images[0])}
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-gray-500">
                              <svg className="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/>
                              </svg>
                            </div>
                          )}
                        </div>

                        {/* 提示词 */}
                        <div className="p-3">
                          <p className="text-sm text-gray-300 truncate" title={record.prompt}>
                            {record.prompt}
                          </p>
                          <div className="flex items-center justify-between mt-2">
                            <span className="text-xs text-gray-500">
                              {new Date(record.createdAt).toLocaleString('zh-CN')}
                            </span>
                            <button
                              onClick={() => setRecordToDelete(record.id)}
                              className="text-gray-400 hover:text-red-400 transition-colors"
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
                              </svg>
                            </button>
                          </div>
                          {record.status === 'failed' && record.error && (
                            <p className="text-xs text-red-400 mt-2">{record.error}</p>
                          )}
                        </div>

                        {/* 成功时显示下载按钮 */}
                        {record.status === 'success' && record.images.length > 0 && (
                          <div className="px-3 pb-3">
                            <div className="flex gap-2">
                              {record.images.map((img, index) => (
                                <button
                                  key={index}
                                  onClick={() => handleDownload(img)}
                                  className="flex-1 py-2 px-3 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded-lg transition-colors"
                                >
                                  下载
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 图片预览弹窗 */}
      {selectedImage && (
        <div
          className="fixed inset-0 bg-black/80 flex items-center justify-center z-50"
          onClick={() => setSelectedImage(null)}
        >
          <div className="relative max-w-4xl max-h-[80vh]">
            <button
              onClick={() => setSelectedImage(null)}
              className="absolute -top-12 right-0 text-white hover:text-gray-300 text-2xl"
            >
              ×
            </button>
            <img
              src={selectedImage}
              alt="preview"
              className="max-w-full max-h-[80vh] object-contain rounded-lg"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        </div>
      )}

      {/* 删除确认弹窗 */}
      {recordToDelete && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-medium text-white mb-4">确认删除</h3>
            <p className="text-gray-400 mb-6">确定要删除这条生成记录吗？</p>
            <div className="flex gap-4">
              <button
                onClick={() => setRecordToDelete(null)}
                className="flex-1 py-2 px-4 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors"
              >
                取消
              </button>
              <button
                onClick={() => handleDelete(recordToDelete)}
                className="flex-1 py-2 px-4 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

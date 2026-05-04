"use client";

import { useState, useCallback, useEffect, useRef } from 'react';
import Header from './components/Header';

type TaskStatus = 'idle' | 'pending' | 'processing' | 'completed' | 'failed' | 'error';

interface Task {
  id: number;
  prompt: string;
  imageUrl: string;
  imagePreview: string;
  status: TaskStatus;
  videoUrl: string;
  taskId: string;
}

interface GlobalConfig {
  model: string;
  videoRatio: string;
  duration: number;
}

const COST_PER_VIDEO = 3;

export default function Home() {
  const [tasks, setTasks] = useState<Task[]>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('videoTasks');
      if (saved) {
        try {
          return JSON.parse(saved);
        } catch {
          // 如果解析失败，返回默认值
        }
      }
    }
    return [
      { id: 1, prompt: '', imageUrl: '', imagePreview: '', status: 'idle', videoUrl: '', taskId: '' },
      { id: 2, prompt: '', imageUrl: '', imagePreview: '', status: 'idle', videoUrl: '', taskId: '' },
      { id: 3, prompt: '', imageUrl: '', imagePreview: '', status: 'idle', videoUrl: '', taskId: '' },
    ];
  });

  const [globalConfig, setGlobalConfig] = useState<GlobalConfig>({
    model: 'grok-video-3-10s',
    videoRatio: '16:9',
    duration: 10,
  });

  const [points, setPoints] = useState(0);

  const pollingIntervalsRef = useRef<Record<number, ReturnType<typeof setInterval>>>({});
  const fileInputRef = useRef<Record<number, HTMLInputElement | null>>({});

  useEffect(() => {
    loadUserPoints();
    localStorage.setItem('videoTasks', JSON.stringify(tasks));
  }, [tasks]);

  useEffect(() => {
    loadUserPoints();
  }, []);

  const loadUserPoints = async () => {
    try {
      const response = await fetch('/api/get-user-points');
      if (response.ok) {
        const data = await response.json();
        setPoints(data.points || 0);
      }
    } catch (error) {
      console.error('Failed to load user points:', error);
    }
  };

  const isGenerating = (status: TaskStatus): boolean => {
    return ['pending', 'processing'].includes(status);
  };

  const addTask = () => {
    const newId = tasks.length > 0 ? Math.max(...tasks.map(t => t.id)) + 1 : 1;
    setTasks([...tasks, { id: newId, prompt: '', imageUrl: '', imagePreview: '', status: 'idle', videoUrl: '', taskId: '' }]);
  };

  const clearAll = () => {
    Object.values(pollingIntervalsRef.current).forEach(interval => clearInterval(interval));
    pollingIntervalsRef.current = {};
    setTasks([
      { id: 1, prompt: '', imageUrl: '', imagePreview: '', status: 'idle', videoUrl: '', taskId: '' },
      { id: 2, prompt: '', imageUrl: '', imagePreview: '', status: 'idle', videoUrl: '', taskId: '' },
      { id: 3, prompt: '', imageUrl: '', imagePreview: '', status: 'idle', videoUrl: '', taskId: '' },
    ]);
    setGlobalConfig({
      model: 'grok-video-3-10s',
      videoRatio: '16:9',
      duration: 10,
    });
  };

  const deleteTask = useCallback((taskId: number) => {
    if (pollingIntervalsRef.current[taskId]) {
      clearInterval(pollingIntervalsRef.current[taskId]);
      delete pollingIntervalsRef.current[taskId];
    }
    setTasks(prevTasks => prevTasks.filter(t => t.id !== taskId));
  }, []);

  const stopGeneration = useCallback((taskId: number) => {
    if (pollingIntervalsRef.current[taskId]) {
      clearInterval(pollingIntervalsRef.current[taskId]);
      delete pollingIntervalsRef.current[taskId];
    }
    setTasks(prevTasks => prevTasks.map(t =>
      t.id === taskId ? { ...t, status: 'idle' as TaskStatus, videoUrl: '', taskId: '' } : t
    ));
  }, []);

  const handleFileSelect = useCallback((taskId: number, file: File | null) => {
    if (!file) return;

    const previewUrl = URL.createObjectURL(file);
    setTasks(prevTasks => prevTasks.map(t =>
      t.id === taskId ? { ...t, imagePreview: previewUrl } : t
    ));

    const reader = new FileReader();
    reader.onload = (e) => {
      const base64 = e.target?.result as string;
      setTasks(prevTasks => prevTasks.map(t =>
        t.id === taskId ? { ...t, imageUrl: base64 } : t
      ));
    };
    reader.readAsDataURL(file);
  }, []);

  const pollTask = useCallback(async (taskIdStr: string, taskIdNum: number) => {
    setTasks(prevTasks => prevTasks.map(t =>
      t.id === taskIdNum ? { ...t, status: 'processing' as TaskStatus } : t
    ));

    let pollCount = 0;
    const maxPollCount = 120;

    const pollInterval = setInterval(async () => {
      try {
        pollCount++;
        console.log(`[前端轮询] 第 ${pollCount} 次轮询，任务ID: ${taskIdStr}`);

        const pollResponse = await fetch('/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: taskIdStr, poll: true }),
        });

        const pollText = await pollResponse.text();
        console.log('[前端轮询] 响应内容:', pollText);

        if (!pollResponse.ok) {
          console.log(`[前端轮询] HTTP错误: ${pollResponse.status}`);
          if (pollCount >= maxPollCount) {
            clearInterval(pollInterval);
            delete pollingIntervalsRef.current[taskIdNum];
            setTasks(prevTasks => prevTasks.map(t =>
              t.id === taskIdNum ? { ...t, status: 'failed' as TaskStatus } : t
            ));
            alert('轮询超时');
          }
          return;
        }

        const pollResult = JSON.parse(pollText);

        console.log('[前端轮询] 任务状态:', pollResult.status);
        console.log('[前端轮询] 视频URL:', pollResult.video_url || pollResult.url);

        if (pollResult.status === 'completed') {
          const videoUrl = pollResult.video_url || pollResult.url;
          clearInterval(pollInterval);
          delete pollingIntervalsRef.current[taskIdNum];
          console.log('[前端轮询] ✅ 任务完成，视频URL:', videoUrl);
          setTasks(prevTasks => prevTasks.map(t =>
            t.id === taskIdNum ? { ...t, status: 'completed' as TaskStatus, videoUrl } : t
          ));
        } else if (pollResult.status === 'failed') {
          clearInterval(pollInterval);
          delete pollingIntervalsRef.current[taskIdNum];
          setTasks(prevTasks => prevTasks.map(t =>
            t.id === taskIdNum ? { ...t, status: 'failed' as TaskStatus } : t
          ));
          alert(`视频生成失败:\n${pollResult.error || '未知错误'}`);
        } else if (pollCount >= maxPollCount) {
          clearInterval(pollInterval);
          delete pollingIntervalsRef.current[taskIdNum];
          setTasks(prevTasks => prevTasks.map(t =>
            t.id === taskIdNum ? { ...t, status: 'failed' as TaskStatus } : t
          ));
          alert('视频生成超时，请重试');
        } else {
          console.log(`[前端轮询] 任务进行中: ${pollResult.status || 'processing'}`);
        }
      } catch (error) {
        console.error('[前端轮询] 轮询异常:', error);
        if (pollCount >= maxPollCount) {
          clearInterval(pollInterval);
          delete pollingIntervalsRef.current[taskIdNum];
          setTasks(prevTasks => prevTasks.map(t =>
            t.id === taskIdNum ? { ...t, status: 'failed' as TaskStatus } : t
          ));
          alert('轮询异常');
        }
      }
    }, 5000);

    pollingIntervalsRef.current[taskIdNum] = pollInterval;
  }, []);

  const updateTask = (taskId: number, field: string, value: string) => {
    setTasks(prevTasks => prevTasks.map(task =>
      task.id === taskId ? { ...task, [field]: value } : task
    ));
  };

  const updateGlobalConfig = useCallback((field: keyof GlobalConfig, value: string | number) => {
    setGlobalConfig(prevConfig => ({
      ...prevConfig,
      [field]: value,
    }));
  }, []);

  const downloadVideo = useCallback(async (videoUrl: string, taskId: number) => {
    try {
      const response = await fetch(videoUrl);
      if (!response.ok) throw new Error('下载失败');
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `video_${taskId}_${Date.now()}.mp4`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch {
      alert('下载失败，请重试');
    }
  }, []);

  const copyToClipboard = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      alert('复制成功');
    } catch {
      alert('复制失败，请重试');
    }
  }, []);

  const handleGenerate = useCallback(async (taskId: number) => {
    const task = tasks.find(t => t.id === taskId);
    if (!task || isGenerating(task.status)) return;
    if (!task.prompt.trim()) {
      alert('请输入提示词');
      return;
    }

    if (points < COST_PER_VIDEO) {
      alert(`积分不足！当前积分: ${points}，生成视频需要 ${COST_PER_VIDEO} 积分`);
      return;
    }

    const { model, videoRatio, duration } = globalConfig;

    setTasks(prevTasks => prevTasks.map(t =>
      t.id === taskId ? { ...t, status: 'pending' as TaskStatus } : t
    ));

    const requestBody: Record<string, unknown> = {
      prompt: task.prompt,
      model,
      aspect_ratio: videoRatio,
      duration: duration,
    };

    if (task.imageUrl && task.imageUrl.trim()) {
      requestBody.input_reference = task.imageUrl;
    }

    try {
      const response = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      const responseText = await response.text();

      if (!response.ok) {
        let errorDetail = '未知错误';
        try {
          const errorJson = JSON.parse(responseText);
          errorDetail = errorJson.error || errorJson.message || responseText;
        } catch {
          errorDetail = responseText;
        }
        setTasks(prevTasks => prevTasks.map(t =>
          t.id === taskId ? { ...t, status: 'error' as TaskStatus } : t
        ));
        alert(`请求失败 (${response.status}):\n${errorDetail}`);
        return;
      }

      const data = JSON.parse(responseText);

      if (data.cost) {
        setPoints(prev => prev - data.cost);
      }

      if (data.status === 'completed' && data.video_url) {
        setTasks(prevTasks => prevTasks.map(t =>
          t.id === taskId ? { ...t, status: 'completed' as TaskStatus, videoUrl: data.video_url, taskId: data.id } : t
        ));
      } else if (data.status === 'failed') {
        setTasks(prevTasks => prevTasks.map(t =>
          t.id === taskId ? { ...t, status: 'failed' as TaskStatus } : t
        ));
        alert(`视频生成失败:\n${data.error}`);
      } else if (data.id) {
        const idStr = data.id;
        setTasks(prevTasks => prevTasks.map(t =>
          t.id === taskId ? { ...t, taskId: idStr } : t
        ));
        pollTask(idStr, taskId);
      } else {
        setTasks(prevTasks => prevTasks.map(t =>
          t.id === taskId ? { ...t, status: 'error' as TaskStatus } : t
        ));
        alert('未获取到任务ID');
      }
    } catch (error) {
      console.error('生成请求失败:', error);
      setTasks(prevTasks => prevTasks.map(t =>
        t.id === taskId ? { ...t, status: 'error' as TaskStatus } : t
      ));
      alert('生成请求失败，请稍后重试');
    }
  }, [tasks, globalConfig, pollTask, points]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900">
      <Header points={points} costPerVideo={COST_PER_VIDEO} />
      
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {tasks.map((task) => (
            <div
              key={task.id}
              className="bg-slate-800/50 backdrop-blur-lg rounded-2xl overflow-hidden"
            >
              <div className="p-4 border-b border-slate-700">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-white font-semibold">任务 {task.id}</span>
                  <div className="flex gap-2">
                    {task.status === 'idle' && (
                      <button
                        onClick={() => deleteTask(task.id)}
                        className="text-gray-400 hover:text-red-400 transition-colors"
                      >
                        🗑️
                      </button>
                    )}
                    {isGenerating(task.status) && (
                      <button
                        onClick={() => stopGeneration(task.id)}
                        className="px-3 py-1 bg-red-600 text-white text-sm rounded-lg hover:bg-red-700 transition-colors"
                      >
                        终止
                      </button>
                    )}
                  </div>
                </div>
                
                <div className="flex items-center gap-2">
                  <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                    task.status === 'idle' ? 'bg-slate-700 text-gray-300' :
                    task.status === 'pending' ? 'bg-yellow-500/20 text-yellow-400' :
                    task.status === 'processing' ? 'bg-blue-500/20 text-blue-400' :
                    task.status === 'completed' ? 'bg-green-500/20 text-green-400' :
                    'bg-red-500/20 text-red-400'
                  }`}>
                    {task.status === 'idle' && '准备就绪'}
                    {task.status === 'pending' && '提交中...'}
                    {task.status === 'processing' && '渲染中...'}
                    {task.status === 'completed' && '生成完成'}
                    {task.status === 'failed' && '生成失败'}
                    {task.status === 'error' && '请求错误'}
                  </span>
                </div>
              </div>

              <div className="p-4">
                <textarea
                  value={task.prompt}
                  onChange={(e) => updateTask(task.id, 'prompt', e.target.value)}
                  placeholder="输入视频描述..."
                  className="w-full h-32 p-3 bg-slate-900 text-white rounded-lg border border-slate-700 focus:border-blue-500 focus:outline-none resize-none text-sm mb-4"
                  disabled={isGenerating(task.status)}
                />

                <div className="border-2 border-dashed border-slate-600 rounded-lg p-4 text-center mb-4">
                  {task.imagePreview ? (
                    <div className="relative">
                      <img
                        src={task.imagePreview}
                        alt="预览"
                        className="w-full h-32 object-cover rounded-lg"
                      />
                      <button
                        onClick={() => {
                          setTasks(prevTasks => prevTasks.map(t =>
                            t.id === task.id ? { ...t, imagePreview: '', imageUrl: '' } : t
                          ));
                        }}
                        className="absolute top-1 right-1 p-1 bg-red-500 text-white rounded-full"
                      >
                        ×
                      </button>
                    </div>
                  ) : (
                    <label className="cursor-pointer">
                      <input
                        ref={(el) => { fileInputRef.current[task.id] = el; }}
                        type="file"
                        accept="image/*"
                        onChange={(e) => handleFileSelect(task.id, e.target.files?.[0] || null)}
                        className="hidden"
                        disabled={isGenerating(task.status)}
                      />
                      <div className="text-gray-400">
                        <div className="text-3xl mb-1">📷</div>
                        <p className="text-sm">点击上传参考图（可选）</p>
                      </div>
                    </label>
                  )}
                </div>

                {task.status === 'completed' && task.videoUrl && (
                  <div className="mb-4">
                    <video
                      src={task.videoUrl}
                      controls
                      className="w-full rounded-lg"
                      poster=""
                    />
                    <div className="flex gap-2 mt-3">
                      <button
                        onClick={() => downloadVideo(task.videoUrl, task.id)}
                        className="flex-1 px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition-colors"
                      >
                        📥 下载视频
                      </button>
                      <button
                        onClick={() => copyToClipboard(task.videoUrl)}
                        className="px-4 py-2 bg-slate-700 text-white text-sm rounded-lg hover:bg-slate-600 transition-colors"
                      >
                        🔗 复制链接
                      </button>
                    </div>
                  </div>
                )}

                {task.status === 'failed' && (
                  <div className="p-4 bg-red-500/10 rounded-lg text-center mb-4">
                    <div className="text-red-400">❌ 视频生成失败</div>
                    <div className="text-gray-400 text-sm mt-1">请检查提示词后重试</div>
                  </div>
                )}

                {task.status === 'processing' && (
                  <div className="py-8 text-center">
                    <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-3"></div>
                    <p className="text-gray-400">正在渲染中...</p>
                    <div className="mt-2 w-full bg-slate-700 rounded-full h-2">
                      <div className="bg-blue-600 h-2 rounded-full animate-pulse" style={{ width: '60%' }}></div>
                    </div>
                  </div>
                )}

                {task.status === 'idle' && (
                  <button
                    onClick={() => handleGenerate(task.id)}
                    className="w-full py-3 bg-gradient-to-r from-blue-600 to-purple-600 text-white font-semibold rounded-lg hover:from-blue-700 hover:to-purple-700 transition-all"
                  >
                    🎬 生成视频
                  </button>
                )}

                {task.status === 'pending' && (
                  <button
                    disabled
                    className="w-full py-3 bg-gradient-to-r from-blue-600 to-purple-600 text-white font-semibold rounded-lg opacity-50"
                  >
                    📤 提交中...
                  </button>
                )}

                {task.status === 'completed' && (
                  <button
                    onClick={() => handleGenerate(task.id)}
                    className="w-full py-3 bg-gradient-to-r from-green-600 to-teal-600 text-white font-semibold rounded-lg hover:from-green-700 hover:to-teal-700 transition-all"
                  >
                    🔄 重新生成
                  </button>
                )}
              </div>
            </div>
          ))}

          <button
            onClick={addTask}
            className="bg-slate-800/50 backdrop-blur-lg rounded-2xl border-2 border-dashed border-slate-600 flex items-center justify-center h-64 hover:border-blue-500 transition-colors"
          >
            <div className="text-gray-400 text-center">
              <div className="text-4xl mb-2">➕</div>
              <p>添加任务</p>
            </div>
          </button>
        </div>

        <div className="mt-8 bg-slate-800/50 backdrop-blur-lg rounded-2xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-white font-semibold">全局配置</h3>
            <button
              onClick={clearAll}
              className="px-4 py-2 bg-red-600/20 text-red-400 text-sm rounded-lg hover:bg-red-600/30 transition-colors"
            >
              清空所有任务
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div>
              <label className="block text-gray-400 text-sm mb-2">模型选择</label>
              <select
                value={globalConfig.model}
                onChange={(e) => updateGlobalConfig('model', e.target.value)}
                className="w-full p-3 bg-slate-900 text-white rounded-lg border border-slate-700 focus:border-blue-500 focus:outline-none"
              >
                <option value="grok-video-3-10s">Grok Video 3 (10秒)</option>
                <option value="grok-video-3-20s">Grok Video 3 (20秒)</option>
                <option value="grok-video-3-30s">Grok Video 3 (30秒)</option>
              </select>
            </div>

            <div>
              <label className="block text-gray-400 text-sm mb-2">视频比例</label>
              <select
                value={globalConfig.videoRatio}
                onChange={(e) => updateGlobalConfig('videoRatio', e.target.value)}
                className="w-full p-3 bg-slate-900 text-white rounded-lg border border-slate-700 focus:border-blue-500 focus:outline-none"
              >
                <option value="16:9">16:9 (横屏)</option>
                <option value="9:16">9:16 (竖屏)</option>
                <option value="1:1">1:1 (正方形)</option>
              </select>
            </div>

            <div>
              <label className="block text-gray-400 text-sm mb-2">生成时长</label>
              <select
                value={globalConfig.duration}
                onChange={(e) => updateGlobalConfig('duration', parseInt(e.target.value))}
                className="w-full p-3 bg-slate-900 text-white rounded-lg border border-slate-700 focus:border-blue-500 focus:outline-none"
              >
                <option value={10}>10秒</option>
                <option value={20}>20秒</option>
                <option value={30}>30秒</option>
              </select>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
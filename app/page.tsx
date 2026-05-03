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
  apiKey: string;
  model: string;
  videoRatio: string;
  duration: number;
}

export default function Home() {
  const [tasks, setTasks] = useState<Task[]>([
    { id: 1, prompt: '', imageUrl: '', imagePreview: '', status: 'idle', videoUrl: '', taskId: '' },
    { id: 2, prompt: '', imageUrl: '', imagePreview: '', status: 'idle', videoUrl: '', taskId: '' },
    { id: 3, prompt: '', imageUrl: '', imagePreview: '', status: 'idle', videoUrl: '', taskId: '' },
  ]);

  const [globalConfig, setGlobalConfig] = useState<GlobalConfig>({
    apiKey: typeof window !== 'undefined' ? localStorage.getItem('videoApiKey') || '' : '',
    model: 'grok-video-3-10s',
    videoRatio: '16:9',
    duration: 10,
  });

  const pollingIntervalsRef = useRef<Record<number, ReturnType<typeof setInterval>>>({});
  const fileInputRef = useRef<Record<number, HTMLInputElement | null>>({});

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
      apiKey: '',
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

  const pollTask = useCallback(async (taskIdStr: string, taskIdNum: number, apiKey: string) => {
    setTasks(prevTasks => prevTasks.map(t =>
      t.id === taskIdNum ? { ...t, status: 'processing' as TaskStatus } : t
    ));

    const pollInterval = setInterval(async () => {
      try {
        const pollResponse = await fetch('/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey, id: taskIdStr, poll: true }),
        });

        const pollText = await pollResponse.text();
        const pollResult = JSON.parse(pollText);

        if (pollResult.status === 'completed') {
          clearInterval(pollInterval);
          delete pollingIntervalsRef.current[taskIdNum];
          setTasks(prevTasks => prevTasks.map(t =>
            t.id === taskIdNum ? { ...t, status: 'completed' as TaskStatus, videoUrl: pollResult.video_url } : t
          ));
        } else if (pollResult.status === 'failed') {
          clearInterval(pollInterval);
          delete pollingIntervalsRef.current[taskIdNum];
          setTasks(prevTasks => prevTasks.map(t =>
            t.id === taskIdNum ? { ...t, status: 'failed' as TaskStatus } : t
          ));
          alert(`视频生成失败:\n${pollResult.error}`);
        }
      } catch (error) {
        console.error('轮询失败:', error);
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
    setGlobalConfig(prevConfig => {
      const newConfig = { ...prevConfig, [field]: value };
      if (field === 'apiKey') {
        localStorage.setItem('videoApiKey', String(value));
      }
      return newConfig;
    });
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

    const { apiKey, model, videoRatio, duration } = globalConfig;
    if (!apiKey) {
      alert('请检查 API 配置：API KEY 不能为空');
      return;
    }

    setTasks(prevTasks => prevTasks.map(t =>
      t.id === taskId ? { ...t, status: 'pending' as TaskStatus } : t
    ));

    const requestBody: Record<string, unknown> = {
      prompt: task.prompt,
      apiKey,
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
        pollTask(idStr, taskId, apiKey);
      } else {
        setTasks(prevTasks => prevTasks.map(t =>
          t.id === taskId ? { ...t, status: 'error' as TaskStatus } : t
        ));
        alert('未获取到任务ID');
      }
    } catch (error) {
      setTasks(prevTasks => prevTasks.map(t =>
        t.id === taskId ? { ...t, status: 'error' as TaskStatus } : t
      ));
      alert(`请求失败: ${error instanceof Error ? error.message : '未知错误'}`);
    }
  }, [tasks, globalConfig, pollTask]);

  useEffect(() => {
    return () => {
      Object.values(pollingIntervalsRef.current).forEach(interval => clearInterval(interval));
    };
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900">
      <Header />

      <div className="max-w-7xl mx-auto px-4 mb-8">
        <div className="bg-blue-900/40 backdrop-blur-md rounded-2xl border-2 border-cyan-500/40 shadow-xl shadow-cyan-500/10 p-6">
          <div className="flex items-center gap-2 mb-6 pb-4 border-b-2 border-cyan-500/30">
            <div className="w-8 h-8 bg-gradient-to-br from-cyan-400 to-blue-500 rounded-lg flex items-center justify-center shadow-md">
              <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </div>
            <h2 className="text-lg font-semibold text-white">全局配置</h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
            <div>
              <label className="block text-sm text-blue-300/80 mb-2">API KEY</label>
              <input
                type="password"
                value={globalConfig.apiKey}
                onChange={(e) => updateGlobalConfig('apiKey', e.target.value)}
                className="w-full bg-slate-800/80 border-2 border-cyan-500/30 rounded-xl px-4 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:border-cyan-400 focus:ring-2 focus:ring-cyan-500/20 transition-all shadow-sm"
                placeholder="请输入云雾 API Key"
              />
            </div>
            <div>
              <label className="block text-sm text-blue-300/80 mb-2">API 类型</label>
              <select
                value={globalConfig.model}
                onChange={(e) => updateGlobalConfig('model', e.target.value)}
                className="w-full bg-slate-800/80 border-2 border-cyan-500/30 rounded-xl px-4 py-2.5 text-white focus:outline-none focus:border-cyan-400 focus:ring-2 focus:ring-cyan-500/20 transition-all appearance-none cursor-pointer shadow-sm"
              >
                <option value="grok-video-3-10s">XAI (Grok Video)</option>
              </select>
            </div>
            <div>
              <label className="block text-sm text-blue-300/80 mb-2">视频比例</label>
              <select
                value={globalConfig.videoRatio}
                onChange={(e) => updateGlobalConfig('videoRatio', e.target.value)}
                className="w-full bg-slate-800/80 border-2 border-cyan-500/30 rounded-xl px-4 py-2.5 text-white focus:outline-none focus:border-cyan-400 focus:ring-2 focus:ring-cyan-500/20 transition-all appearance-none cursor-pointer shadow-sm"
              >
                <option value="16:9">横屏 16:9</option>
                <option value="9:16">竖屏 9:16</option>
              </select>
            </div>
            <div>
              <label className="block text-sm text-blue-300/80 mb-2">生成时长</label>
              <select
                value={globalConfig.duration}
                onChange={(e) => updateGlobalConfig('duration', Number(e.target.value))}
                className="w-full bg-slate-800/80 border-2 border-cyan-500/30 rounded-xl px-4 py-2.5 text-white focus:outline-none focus:border-cyan-400 focus:ring-2 focus:ring-cyan-500/20 transition-all appearance-none cursor-pointer shadow-sm"
              >
                <option value={10}>10秒</option>
              </select>
            </div>
          </div>

          <div className="flex gap-3">
            <button
              onClick={addTask}
              className="px-6 py-2.5 bg-gradient-to-r from-cyan-500 to-blue-500 text-white font-medium rounded-xl hover:from-cyan-400 hover:to-blue-400 transition-all duration-200 flex items-center gap-2 shadow-lg shadow-cyan-500/30 border-2 border-cyan-400/50"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              添加任务
            </button>
            <button
              onClick={clearAll}
              className="px-6 py-2.5 bg-red-900/30 text-red-400 font-medium rounded-xl hover:bg-red-800/40 transition-all duration-200 flex items-center gap-2 border-2 border-red-500/30 shadow-md"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              清空所有
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 pb-8">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {tasks.map((task) => (
            <div
              key={task.id}
              className="bg-blue-900/30 backdrop-blur-md rounded-2xl border-2 border-cyan-500/30 shadow-xl shadow-cyan-500/5 overflow-hidden"
            >
              <div className="flex items-center justify-between px-4 py-3 bg-blue-800/40 border-b-2 border-cyan-500/20">
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 bg-gradient-to-br from-cyan-400 to-blue-500 rounded-md flex items-center justify-center shadow-sm">
                    <svg className="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                    </svg>
                  </div>
                  <span className="text-sm font-medium text-white">任务 #{task.id}</span>
                </div>
                <div className="flex items-center gap-2">
                  {isGenerating(task.status) && (
                    <span className="px-3 py-1 bg-purple-500/80 text-white text-xs font-medium rounded-full animate-pulse">
                      生成中
                    </span>
                  )}
                  {task.status === 'completed' && (
                    <span className="px-3 py-1 bg-green-500/80 text-white text-xs font-medium rounded-full">
                      已完成
                    </span>
                  )}
                  {task.status === 'failed' && (
                    <span className="px-3 py-1 bg-red-500/80 text-white text-xs font-medium rounded-full">
                      失败
                    </span>
                  )}
                  {task.status === 'error' && (
                    <span className="px-3 py-1 bg-red-500/80 text-white text-xs font-medium rounded-full">
                      错误
                    </span>
                  )}
                  <button
                    onClick={() => deleteTask(task.id)}
                    className="text-slate-400 hover:text-red-400 transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>

              <div className="p-4 space-y-4">
                <div>
                  <label className="block text-xs text-blue-300/70 mb-1">提示词</label>
                  <textarea
                    value={task.prompt}
                    onChange={(e) => updateTask(task.id, 'prompt', e.target.value)}
                    placeholder="描述你想要的视频..."
                    rows={3}
                    className="w-full bg-slate-800/60 border-2 border-cyan-500/20 rounded-xl px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-400 focus:ring-2 focus:ring-cyan-500/20 resize-none transition-all shadow-sm"
                  />
                </div>

                <div>
                  <label className="block text-xs text-blue-300/70 mb-1">参考图（可选）</label>
                  <input
                    ref={(el) => { fileInputRef.current[task.id] = el; }}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => handleFileSelect(task.id, e.target.files?.[0] || null)}
                  />
                  {task.imagePreview ? (
                    <div className="space-y-2">
                      <div className="relative border-2 border-cyan-500/20 rounded-xl overflow-hidden bg-slate-800/40">
                        <img src={task.imagePreview} alt="预览" className="w-full h-32 object-contain" />
                        <button
                          onClick={() => {
                            setTasks(prevTasks => prevTasks.map(t =>
                              t.id === task.id ? { ...t, imagePreview: '', imageUrl: '' } : t
                            ));
                            const fileInput = fileInputRef.current[task.id];
                            if (fileInput) {
                              fileInput.value = '';
                            }
                          }}
                          className="absolute top-2 right-2 w-6 h-6 bg-red-500/80 text-white rounded-full flex items-center justify-center hover:bg-red-600/80 transition-colors"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={task.imageUrl}
                          onChange={(e) => updateTask(task.id, 'imageUrl', e.target.value)}
                          className="flex-1 bg-slate-800/60 border-2 border-cyan-500/20 rounded-xl px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-400 focus:ring-2 focus:ring-cyan-500/20 transition-all shadow-sm"
                          placeholder="图片 URL"
                        />
                        <button
                          onClick={() => copyToClipboard(task.imageUrl)}
                          className="px-3 py-2 text-sm bg-cyan-500/20 text-cyan-400 border-2 border-cyan-500/30 rounded-xl hover:bg-cyan-500/30 transition-all shadow-sm"
                        >
                          复制
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div
                      onClick={() => fileInputRef.current[task.id]?.click()}
                      className="border-2 border-cyan-500/20 rounded-xl p-4 text-center hover:border-cyan-400 hover:bg-cyan-500/5 transition-all cursor-pointer bg-slate-800/40"
                    >
                      <div className="flex flex-col items-center gap-2">
                        <svg className="w-8 h-8 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                        <span className="text-sm text-slate-400">点击上传</span>
                      </div>
                    </div>
                  )}
                </div>

                {isGenerating(task.status) ? (
                  <>
                    <button
                      onClick={() => stopGeneration(task.id)}
                      className="w-full py-3 font-medium rounded-xl transition-all duration-200 flex items-center justify-center gap-2 shadow-lg border-2 bg-gradient-to-r from-red-500 to-rose-500 shadow-red-500/30 border-red-400/50 hover:from-red-400 hover:to-rose-400 text-white"
                    >
                      <svg className="w-5 h-5 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                      终止生成
                    </button>
                    <div className="space-y-2">
                      <div className="flex items-center justify-center text-sm text-cyan-400">
                        <svg className="w-4 h-4 mr-2 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                        渲染中...
                      </div>
                      <div className="w-full h-2 bg-slate-700/60 rounded-full overflow-hidden">
                        <div className="h-full bg-gradient-to-r from-cyan-400 to-blue-500 animate-pulse rounded-full" style={{ width: '100%' }} />
                      </div>
                    </div>
                  </>
                ) : (
                  <button
                    onClick={() => handleGenerate(task.id)}
                    disabled={isGenerating(task.status)}
                    className={`w-full py-3 font-medium rounded-xl transition-all duration-200 flex items-center justify-center gap-2 shadow-lg border-2 ${
                      task.status === 'completed'
                        ? 'bg-gradient-to-r from-green-500 to-emerald-500 shadow-green-500/30 border-green-400/50 hover:from-green-400 hover:to-emerald-400'
                        : task.status === 'failed' || task.status === 'error'
                        ? 'bg-gradient-to-r from-red-500 to-rose-500 shadow-red-500/30 border-red-400/50 hover:from-red-400 hover:to-rose-400'
                        : 'bg-gradient-to-r from-cyan-500 to-blue-500 shadow-cyan-500/30 border-cyan-400/50 hover:from-cyan-400 hover:to-blue-400'
                    } text-white`}
                  >
                    {task.status === 'completed' && (
                      <>
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                        生成完成
                      </>
                    )}
                    {(task.status === 'failed' || task.status === 'error') && (
                      <>
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        重试
                      </>
                    )}
                    {task.status === 'idle' && (
                      <>
                        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M8 5v14l11-7z" />
                        </svg>
                        生成视频
                      </>
                    )}
                  </button>
                )}

                {task.status === 'completed' && task.videoUrl && (
                  <div className="space-y-3">
                    <div className="relative rounded-xl overflow-hidden bg-black" style={{ aspectRatio: '16/9' }}>
                      <video src={task.videoUrl} className="w-full h-full object-contain" controls preload="metadata" />
                    </div>
                    <button
                      onClick={() => downloadVideo(task.videoUrl, task.id)}
                      className="w-full py-3 font-medium rounded-xl transition-all duration-200 flex items-center justify-center gap-2 shadow-lg border-2 bg-gradient-to-r from-blue-500 to-cyan-500 shadow-blue-500/30 border-blue-400/50 hover:from-blue-400 hover:to-cyan-400 text-white"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                      </svg>
                      下载视频
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

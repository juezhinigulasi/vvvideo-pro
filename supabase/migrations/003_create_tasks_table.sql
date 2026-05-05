-- 创建 tasks 表用于存储生成任务记录
CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('image', 'video')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'success', 'failed')),
  prompt TEXT,
  cost INTEGER DEFAULT 0,
  result_url TEXT,
  error_message TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at DESC);

-- 启用 RLS
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

-- 用户只能查看自己的任务
DROP POLICY IF EXISTS "Users can view own tasks" ON tasks;
CREATE POLICY "Users can view own tasks" ON tasks
  FOR SELECT USING (auth.uid() = user_id);

-- 服务角色可以插入任务
DROP POLICY IF EXISTS "Service role can insert tasks" ON tasks;
CREATE POLICY "Service role can insert tasks" ON tasks
  FOR INSERT WITH CHECK (true);

-- 服务角色可以更新任务
DROP POLICY IF EXISTS "Service role can update tasks" ON tasks;
CREATE POLICY "Service role can update tasks" ON tasks
  FOR UPDATE USING (true);

-- ================================================
-- Supabase 数据库迁移脚本
-- 运行此脚本在 Supabase SQL Editor 中
-- ================================================

-- 1. 确保 profiles 表存在，且包含 credits 字段（Integer，默认值 3100）
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS credits INTEGER DEFAULT 3100;

-- 为现有用户设置初始积分（如果 credits 为 NULL）
UPDATE profiles SET credits = 3100 WHERE credits IS NULL;

-- 2. 创建 tasks 表用于记录生成任务
CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('image', 'video')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'success', 'failed')),
  prompt TEXT,
  result_url TEXT,
  error_message TEXT,
  cost INTEGER DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at DESC);

-- 3. 创建安全的积分扣减函数（原子性操作，防止并发刷分）
CREATE OR REPLACE FUNCTION deduct_credits(user_id UUID, amount INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  current_credits INTEGER;
  new_credits INTEGER;
  result JSONB;
BEGIN
  -- 检查参数
  IF amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'message', '扣减金额必须大于0');
  END IF;

  -- 使用行锁查询当前积分
  SELECT credits INTO current_credits
  FROM profiles
  WHERE id = user_id
  FOR UPDATE;

  -- 检查用户是否存在
  IF current_credits IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', '用户不存在');
  END IF;

  -- 检查积分是否充足
  IF current_credits < amount THEN
    RETURN jsonb_build_object(
      'success', false,
      'message', '积分不足',
      'current_credits', current_credits,
      'required', amount
    );
  END IF;

  -- 执行扣减
  new_credits := current_credits - amount;
  UPDATE profiles SET credits = new_credits WHERE id = user_id;

  -- 返回结果
  RETURN jsonb_build_object(
    'success', true,
    'message', '积分扣减成功',
    'previous_credits', current_credits,
    'new_credits', new_credits,
    'deducted', amount
  );
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'message', '积分扣减失败: ' || SQLERRM);
END;
$$;

-- 4. 创建积分返还函数
CREATE OR REPLACE FUNCTION refund_credits(user_id UUID, amount INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  current_credits INTEGER;
  new_credits INTEGER;
BEGIN
  IF amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'message', '返还金额必须大于0');
  END IF;

  SELECT credits INTO current_credits FROM profiles WHERE id = user_id FOR UPDATE;

  IF current_credits IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', '用户不存在');
  END IF;

  new_credits := current_credits + amount;
  UPDATE profiles SET credits = new_credits WHERE id = user_id;

  RETURN jsonb_build_object(
    'success', true,
    'message', '积分返还成功',
    'previous_credits', current_credits,
    'new_credits', new_credits,
    'refunded', amount
  );
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'message', '积分返还失败: ' || SQLERRM);
END;
$$;

-- 5. 创建 point_transactions 表（如果不存在）
CREATE TABLE IF NOT EXISTS point_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('consume', 'recharge', 'refund', 'reward')),
  amount INTEGER NOT NULL,
  description TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_point_transactions_user_id ON point_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_point_transactions_created_at ON point_transactions(created_at DESC);

-- 6. 启用 RLS（行级安全策略）
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE point_transactions ENABLE ROW LEVEL SECURITY;

-- 7. 创建 RLS 策略（用户只能操作自己的数据）
DROP POLICY IF EXISTS "Users can manage own tasks" ON tasks;
CREATE POLICY "Users can manage own tasks" ON tasks
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can view own transactions" ON point_transactions;
CREATE POLICY "Users can view own transactions" ON point_transactions
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role can insert transactions" ON point_transactions;
CREATE POLICY "Service role can insert transactions" ON point_transactions
  FOR INSERT WITH CHECK (true);

-- 8. 创建触发器函数，新用户注册时自动创建profile记录
CREATE OR REPLACE FUNCTION public.handle_new_user() 
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, credits)
  VALUES (NEW.id, 3100)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 9. 创建触发器
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 8. 创建函数用于自动更新 updated_at 字段
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 9. 创建触发器
DROP TRIGGER IF EXISTS update_tasks_updated_at ON tasks;
CREATE TRIGGER update_tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ================================================
-- 验证脚本
-- ================================================
-- SELECT 'profiles' as table_name, column_name, data_type, column_default
-- FROM information_schema.columns
-- WHERE table_name = 'profiles' AND column_name = 'credits';

-- SELECT 'tasks' as table_name, column_name, data_type
-- FROM information_schema.columns
-- WHERE table_name = 'tasks';

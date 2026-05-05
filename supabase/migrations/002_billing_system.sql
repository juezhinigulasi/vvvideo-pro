-- ================================================
-- Supabase 数据库迁移脚本 - 积分扣费与账单系统
-- 运行此脚本在 Supabase SQL Editor 中
-- ================================================

-- 1. 确保 profiles 表存在 points 字段（Integer，默认值 3100）
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS points INTEGER DEFAULT 3100;

-- 为现有用户设置初始积分（如果 points 为 NULL）
UPDATE profiles SET points = 3100 WHERE points IS NULL;

-- 2. 创建 billing_history 表（账单明细）
CREATE TABLE IF NOT EXISTS billing_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('image_gen', 'video_gen', 'recharge', 'refund')),
  amount INTEGER NOT NULL,
  description TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_billing_history_user_id ON billing_history(user_id);
CREATE INDEX IF NOT EXISTS idx_billing_history_created_at ON billing_history(created_at DESC);

-- 3. 创建安全扣费函数（原子性操作）
CREATE OR REPLACE FUNCTION handle_credit_deduction(p_user_id UUID, p_type TEXT, p_amount INTEGER, p_description TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  current_points INTEGER;
  new_points INTEGER;
BEGIN
  -- 检查参数
  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'message', '扣减金额必须大于0');
  END IF;

  IF p_type NOT IN ('image_gen', 'video_gen') THEN
    RETURN jsonb_build_object('success', false, 'message', '无效的扣费类型');
  END IF;

  -- 使用行锁查询当前积分
  SELECT points INTO current_points
  FROM profiles
  WHERE id = p_user_id
  FOR UPDATE;

  -- 检查用户是否存在
  IF current_points IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', '用户不存在');
  END IF;

  -- 检查积分是否充足
  IF current_points < p_amount THEN
    RETURN jsonb_build_object(
      'success', false,
      'message', '积分不足',
      'current_points', current_points,
      'required', p_amount
    );
  END IF;

  -- 执行扣减
  new_points := current_points - p_amount;
  UPDATE profiles SET points = new_points WHERE id = p_user_id;

  -- 插入账单记录（负数表示消耗）
  INSERT INTO billing_history (user_id, type, amount, description, metadata)
  VALUES (p_user_id, p_type, -p_amount, p_description, jsonb_build_object('previous_points', current_points, 'new_points', new_points));

  -- 返回结果
  RETURN jsonb_build_object(
    'success', true,
    'message', '积分扣减成功',
    'previous_points', current_points,
    'new_points', new_points,
    'deducted', p_amount
  );

EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'message', '扣费失败: ' || SQLERRM);
END;
$$;

-- 4. 创建积分返还函数
CREATE OR REPLACE FUNCTION handle_credit_refund(p_user_id UUID, p_type TEXT, p_amount INTEGER, p_description TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  current_points INTEGER;
  new_points INTEGER;
BEGIN
  -- 检查参数
  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'message', '返还金额必须大于0');
  END IF;

  IF p_type NOT IN ('image_gen', 'video_gen') THEN
    RETURN jsonb_build_object('success', false, 'message', '无效的返还类型');
  END IF;

  -- 使用行锁查询当前积分
  SELECT points INTO current_points
  FROM profiles
  WHERE id = p_user_id
  FOR UPDATE;

  -- 检查用户是否存在
  IF current_points IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', '用户不存在');
  END IF;

  -- 执行返还
  new_points := current_points + p_amount;
  UPDATE profiles SET points = new_points WHERE id = p_user_id;

  -- 插入账单记录（正数表示返还）
  INSERT INTO billing_history (user_id, type, amount, description, metadata)
  VALUES (p_user_id, 'refund', p_amount, p_description, jsonb_build_object('previous_points', current_points, 'new_points', new_points));

  -- 返回结果
  RETURN jsonb_build_object(
    'success', true,
    'message', '积分返还成功',
    'previous_points', current_points,
    'new_points', new_points,
    'refunded', p_amount
  );

EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'message', '返还失败: ' || SQLERRM);
END;
$$;

-- 5. 创建充值函数
CREATE OR REPLACE FUNCTION handle_credit_recharge(p_user_id UUID, p_amount INTEGER, p_description TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  current_points INTEGER;
  new_points INTEGER;
BEGIN
  -- 检查参数
  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'message', '充值金额必须大于0');
  END IF;

  -- 使用行锁查询当前积分
  SELECT points INTO current_points
  FROM profiles
  WHERE id = p_user_id
  FOR UPDATE;

  -- 检查用户是否存在
  IF current_points IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', '用户不存在');
  END IF;

  -- 执行充值
  new_points := current_points + p_amount;
  UPDATE profiles SET points = new_points WHERE id = p_user_id;

  -- 插入账单记录（正数表示增加）
  INSERT INTO billing_history (user_id, type, amount, description, metadata)
  VALUES (p_user_id, 'recharge', p_amount, p_description, jsonb_build_object('previous_points', current_points, 'new_points', new_points));

  -- 返回结果
  RETURN jsonb_build_object(
    'success', true,
    'message', '充值成功',
    'previous_points', current_points,
    'new_points', new_points,
    'recharged', p_amount
  );

EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'message', '充值失败: ' || SQLERRM);
END;
$$;

-- 6. 创建新用户触发器函数
CREATE OR REPLACE FUNCTION public.handle_new_user() 
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, points)
  VALUES (NEW.id, 3100)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 创建触发器
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 7. 配置行级安全策略（RLS）
ALTER TABLE billing_history ENABLE ROW LEVEL SECURITY;

-- 用户只能查看自己的账单
DROP POLICY IF EXISTS "Users can view own billing history" ON billing_history;
CREATE POLICY "Users can view own billing history" ON billing_history
  FOR SELECT USING (auth.uid() = user_id);

-- 服务角色可以插入账单记录
DROP POLICY IF EXISTS "Service role can insert billing history" ON billing_history;
CREATE POLICY "Service role can insert billing history" ON billing_history
  FOR INSERT WITH CHECK (true);

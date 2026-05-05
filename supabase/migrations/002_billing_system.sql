-- ================================================
-- Supabase 数据库迁移脚本 - 积分扣费与账单系统
-- 运行此脚本在 Supabase SQL Editor 中
-- ================================================

-- 1. 确保 profiles 表存在，且包含 credits 字段（Integer，默认值 3100）
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS credits INTEGER DEFAULT 3100;

-- 为现有用户设置初始积分（如果 credits 为 NULL）
UPDATE profiles SET credits = 3100 WHERE credits IS NULL;

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
  current_credits INTEGER;
  new_credits INTEGER;
BEGIN
  -- 检查参数
  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'message', '扣减金额必须大于0');
  END IF;

  IF p_type NOT IN ('image_gen', 'video_gen') THEN
    RETURN jsonb_build_object('success', false, 'message', '无效的扣费类型');
  END IF;

  -- 开始事务（PostgreSQL函数默认在事务中执行）
  
  -- 使用行锁查询当前积分
  SELECT credits INTO current_credits
  FROM profiles
  WHERE id = p_user_id
  FOR UPDATE;

  -- 检查用户是否存在
  IF current_credits IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', '用户不存在');
  END IF;

  -- 检查积分是否充足
  IF current_credits < p_amount THEN
    RETURN jsonb_build_object(
      'success', false,
      'message', '积分不足',
      'current_credits', current_credits,
      'required', p_amount
    );
  END IF;

  -- 执行扣减
  new_credits := current_credits - p_amount;
  UPDATE profiles SET credits = new_credits WHERE id = p_user_id;

  -- 插入账单记录（负数表示消耗）
  INSERT INTO billing_history (user_id, type, amount, description, metadata)
  VALUES (p_user_id, p_type, -p_amount, p_description, jsonb_build_object('previous_credits', current_credits, 'new_credits', new_credits));

  -- 返回结果
  RETURN jsonb_build_object(
    'success', true,
    'message', '积分扣减成功',
    'previous_credits', current_credits,
    'new_credits', new_credits,
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
  current_credits INTEGER;
  new_credits INTEGER;
BEGIN
  -- 检查参数
  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'message', '返还金额必须大于0');
  END IF;

  IF p_type NOT IN ('image_gen', 'video_gen') THEN
    RETURN jsonb_build_object('success', false, 'message', '无效的返还类型');
  END IF;

  -- 使用行锁查询当前积分
  SELECT credits INTO current_credits
  FROM profiles
  WHERE id = p_user_id
  FOR UPDATE;

  -- 检查用户是否存在
  IF current_credits IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', '用户不存在');
  END IF;

  -- 执行返还
  new_credits := current_credits + p_amount;
  UPDATE profiles SET credits = new_credits WHERE id = p_user_id;

  -- 插入账单记录（正数表示返还）
  INSERT INTO billing_history (user_id, type, amount, description, metadata)
  VALUES (p_user_id, 'refund', p_amount, p_description, jsonb_build_object('previous_credits', current_credits, 'new_credits', new_credits));

  -- 返回结果
  RETURN jsonb_build_object(
    'success', true,
    'message', '积分返还成功',
    'previous_credits', current_credits,
    'new_credits', new_credits,
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
  current_credits INTEGER;
  new_credits INTEGER;
BEGIN
  -- 检查参数
  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'message', '充值金额必须大于0');
  END IF;

  -- 使用行锁查询当前积分
  SELECT credits INTO current_credits
  FROM profiles
  WHERE id = p_user_id
  FOR UPDATE;

  -- 检查用户是否存在
  IF current_credits IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', '用户不存在');
  END IF;

  -- 执行充值
  new_credits := current_credits + p_amount;
  UPDATE profiles SET credits = new_credits WHERE id = p_user_id;

  -- 插入账单记录（正数表示充值）
  INSERT INTO billing_history (user_id, type, amount, description, metadata)
  VALUES (p_user_id, 'recharge', p_amount, p_description, jsonb_build_object('previous_credits', current_credits, 'new_credits', new_credits));

  -- 返回结果
  RETURN jsonb_build_object(
    'success', true,
    'message', '充值成功',
    'previous_credits', current_credits,
    'new_credits', new_credits,
    'recharged', p_amount
  );

EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'message', '充值失败: ' || SQLERRM);
END;
$$;

-- 6. 启用 RLS（行级安全策略）
ALTER TABLE billing_history ENABLE ROW LEVEL SECURITY;

-- 7. 创建 RLS 策略
DROP POLICY IF EXISTS "Users can view own billing history" ON billing_history;
CREATE POLICY "Users can view own billing history" ON billing_history
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role can insert billing history" ON billing_history;
CREATE POLICY "Service role can insert billing history" ON billing_history
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

-- ================================================
-- 验证脚本
-- ================================================
-- SELECT * FROM billing_history LIMIT 10;
-- SELECT credits FROM profiles WHERE id = auth.uid();
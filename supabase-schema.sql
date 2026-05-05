-- ===========================================
-- Supabase 数据库建表 SQL (安全更新版)
-- 在 Supabase 后台 -> SQL Editor 中运行此文件
-- ===========================================

-- 1. 创建 profiles 表 - 用户积分表
CREATE TABLE IF NOT EXISTS profiles (
  id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  username TEXT,
  email TEXT,
  points INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_profiles_email ON profiles(email);

-- 启用行级安全策略（如果还没启用）
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- 策略（使用 OR REPLACE 避免重复）
DROP POLICY IF EXISTS "Users can view own profile" ON profiles;
CREATE POLICY "Users can view own profile"
  ON profiles FOR SELECT
  USING (auth.uid() = id);

DROP POLICY IF EXISTS "Users can update own profile" ON profiles;
CREATE POLICY "Users can update own profile"
  ON profiles FOR UPDATE
  USING (auth.uid() = id);

DROP POLICY IF EXISTS "Anyone can view profiles" ON profiles;
CREATE POLICY "Anyone can view profiles"
  ON profiles FOR SELECT
  USING (true);

-- ===========================================

-- 2. 创建 billing_history 表 - 账单记录表
CREATE TABLE IF NOT EXISTS billing_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('image_gen', 'video_gen', 'recharge', 'refund', 'redeem')),
  amount INTEGER NOT NULL,
  description TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_billing_history_user_id ON billing_history(user_id);
CREATE INDEX IF NOT EXISTS idx_billing_history_created_at ON billing_history(created_at DESC);

-- 启用行级安全策略
ALTER TABLE billing_history ENABLE ROW LEVEL SECURITY;

-- 策略
DROP POLICY IF EXISTS "Users can view own billing history" ON billing_history;
CREATE POLICY "Users can view own billing history"
  ON billing_history FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own billing history" ON billing_history;
CREATE POLICY "Users can insert own billing history"
  ON billing_history FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- ===========================================

-- 3. 创建 gift_cards 表 - 卡密表
CREATE TABLE IF NOT EXISTS gift_cards (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  points INTEGER NOT NULL,
  is_used BOOLEAN DEFAULT FALSE,
  used_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  used_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_gift_cards_code ON gift_cards(code);
CREATE INDEX IF NOT EXISTS idx_gift_cards_is_used ON gift_cards(is_used);

-- 启用行级安全策略
ALTER TABLE gift_cards ENABLE ROW LEVEL SECURITY;

-- 策略
DROP POLICY IF EXISTS "Anyone can view gift cards" ON gift_cards;
CREATE POLICY "Anyone can view gift cards"
  ON gift_cards FOR SELECT
  USING (true);

-- ===========================================

-- 4. 兑换卡密的 RPC 函数（使用 OR REPLACE）
CREATE OR REPLACE FUNCTION redeem_gift_card(card_code TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  card_record gift_cards%ROWTYPE;
  current_points INTEGER;
BEGIN
  SELECT * INTO card_record FROM gift_cards WHERE code = card_code;
  
  IF card_record IS NULL THEN
    RETURN json_build_object('success', false, 'message', '卡密不存在');
  END IF;
  
  IF card_record.is_used THEN
    RETURN json_build_object('success', false, 'message', '卡密已使用');
  END IF;
  
  SELECT points INTO current_points FROM profiles WHERE id = auth.uid();
  
  IF current_points IS NULL THEN
    INSERT INTO profiles (id, points) VALUES (auth.uid(), 0);
    current_points := 0;
  END IF;
  
  UPDATE gift_cards SET is_used = true, used_by = auth.uid(), used_at = NOW() WHERE id = card_record.id;
  UPDATE profiles SET points = points + card_record.points, updated_at = NOW() WHERE id = auth.uid();
  INSERT INTO billing_history (user_id, type, amount, description) VALUES (auth.uid(), 'redeem', card_record.points, '卡密充值: ' || card_code);
  
  RETURN json_build_object('success', true, 'message', '兑换成功', 'points', card_record.points, 'new_balance', current_points + card_record.points);
END;
$$;

-- ===========================================

-- 5. 扣除积分的 RPC 函数（使用 OR REPLACE）
CREATE OR REPLACE FUNCTION deduct_points(deduct_amount INTEGER, description TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_points INTEGER;
BEGIN
  SELECT points INTO current_points FROM profiles WHERE id = auth.uid();
  
  IF current_points IS NULL OR current_points < deduct_amount THEN
    RETURN json_build_object('success', false, 'message', '积分不足', 'current_points', COALESCE(current_points, 0));
  END IF;
  
  UPDATE profiles SET points = points - deduct_amount, updated_at = NOW() WHERE id = auth.uid();
  INSERT INTO billing_history (user_id, type, amount, description) VALUES (auth.uid(), 'image_gen', -deduct_amount, description);
  
  RETURN json_build_object('success', true, 'message', '扣费成功', 'deducted', deduct_amount, 'new_balance', current_points - deduct_amount);
END;
$$;

-- ===========================================

-- 6. 获取用户积分的函数（使用 OR REPLACE）
CREATE OR REPLACE FUNCTION get_user_points()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  user_points INTEGER;
BEGIN
  SELECT points INTO user_points FROM profiles WHERE id = auth.uid();
  
  IF user_points IS NULL THEN
    RETURN json_build_object('success', false, 'message', '用户不存在', 'points', 0);
  END IF;
  
  RETURN json_build_object('success', true, 'points', user_points);
END;
$$;

-- ===========================================

-- 7. 创建触发器：用户注册时自动创建 profile
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO profiles (id, email, username, points)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'username', split_part(NEW.email, '@', 1)),
    0
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 先删除旧触发器再创建
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ===========================================

-- 8. 创建触发器：自动更新 updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 先删除旧触发器再创建
DROP TRIGGER IF EXISTS update_profiles_updated_at ON profiles;
CREATE TRIGGER update_profiles_updated_at
BEFORE UPDATE ON profiles
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ===========================================

-- 插入测试卡密（已存在则跳过）
INSERT INTO gift_cards (code, points) VALUES
  ('VIP100', 100),
  ('VIP50', 50),
  ('VIP20', 20),
  ('TEST10', 10)
ON CONFLICT (code) DO NOTHING;

-- ===========================================
-- 执行完成！
-- ===========================================

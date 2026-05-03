-- ===========================================
-- Supabase 数据库建表 SQL
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

-- 添加索引
CREATE INDEX IF NOT EXISTS idx_profiles_email ON profiles(email);

-- 启用行级安全策略
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- 策略：用户只能查看和编辑自己的资料
CREATE POLICY "Users can view own profile" 
  ON profiles FOR SELECT 
  USING (auth.uid() = id);

CREATE POLICY "Users can update own profile" 
  ON profiles FOR UPDATE 
  USING (auth.uid() = id);

-- ===========================================

-- 2. 创建 gift_cards 表 - 卡密表
CREATE TABLE IF NOT EXISTS gift_cards (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  points INTEGER NOT NULL,
  is_used BOOLEAN DEFAULT FALSE,
  used_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  used_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

-- 添加索引
CREATE INDEX IF NOT EXISTS idx_gift_cards_code ON gift_cards(code);
CREATE INDEX IF NOT EXISTS idx_gift_cards_is_used ON gift_cards(is_used);

-- 启用行级安全策略
ALTER TABLE gift_cards ENABLE ROW LEVEL SECURITY;

-- 策略：只有管理员可以查看和创建卡密（这里简化为所有认证用户都可以读取）
CREATE POLICY "Authenticated users can view gift cards" 
  ON gift_cards FOR SELECT 
  USING (auth.role() = 'authenticated');

-- ===========================================

-- 3. 创建兑换卡密的 RPC 函数
CREATE OR REPLACE FUNCTION redeem_gift_card(card_code TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  card_record gift_cards%ROWTYPE;
  result JSON;
BEGIN
  -- 查找卡密
  SELECT * INTO card_record FROM gift_cards WHERE code = card_code;
  
  -- 检查卡密是否存在
  IF card_record IS NULL THEN
    RETURN json_build_object('success', false, 'message', '卡密不存在');
  END IF;
  
  -- 检查卡密是否已使用
  IF card_record.is_used THEN
    RETURN json_build_object('success', false, 'message', '卡密已使用');
  END IF;
  
  -- 更新卡密状态
  UPDATE gift_cards 
  SET is_used = true, used_by = auth.uid(), used_at = NOW()
  WHERE id = card_record.id;
  
  -- 增加用户积分
  UPDATE profiles 
  SET points = points + card_record.points, updated_at = NOW()
  WHERE id = auth.uid();
  
  -- 如果用户不存在则创建新用户
  IF NOT FOUND THEN
    INSERT INTO profiles(id, points, created_at, updated_at)
    VALUES (auth.uid(), card_record.points, NOW(), NOW());
  END IF;
  
  -- 返回结果
  RETURN json_build_object(
    'success', true, 
    'message', '兑换成功', 
    'points', card_record.points
  );
  
EXCEPTION
  WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'message', SQLERRM);
END $$;

-- ===========================================

-- 4. 创建扣积分的 RPC 函数
CREATE OR REPLACE FUNCTION deduct_points(amount INTEGER)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  current_points INTEGER;
  result JSON;
BEGIN
  -- 获取当前积分
  SELECT points INTO current_points FROM profiles WHERE id = auth.uid();
  
  -- 检查用户是否存在
  IF current_points IS NULL THEN
    RETURN json_build_object('success', false, 'message', '用户不存在');
  END IF;
  
  -- 检查积分是否足够
  IF current_points < amount THEN
    RETURN json_build_object('success', false, 'message', '积分不足');
  END IF;
  
  -- 扣除积分
  UPDATE profiles 
  SET points = points - amount, updated_at = NOW()
  WHERE id = auth.uid();
  
  -- 返回结果
  RETURN json_build_object(
    'success', true, 
    'message', '扣费成功', 
    'remaining_points', current_points - amount
  );
  
EXCEPTION
  WHEN OTHERS THEN
    RETURN json_build_object('success', false, 'message', SQLERRM);
END $$;

-- ===========================================

-- 5. 创建示例卡密（用于测试，可删除）
INSERT INTO gift_cards (code, points) VALUES
('TEST-CARD-1000', 1000),
('TEST-CARD-5000', 5000),
('TEST-CARD-10000', 10000)
ON CONFLICT (code) DO NOTHING;

-- ===========================================
-- 使用说明：
-- 1. 登录 Supabase 后台
-- 2. 进入 SQL Editor
-- 3. 新建查询，复制粘贴此文件内容
-- 4. 点击 "Run" 执行
-- ===========================================

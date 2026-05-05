import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// 服务端专用客户端，使用服务端密钥，不受 RLS 限制
export const supabaseServer = createClient(supabaseUrl, supabaseServiceKey);

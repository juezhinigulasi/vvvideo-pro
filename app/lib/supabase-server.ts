import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// 服务端专用客户端，使用服务端密钥，不受 RLS 限制
let supabaseServerInstance: SupabaseClient | null = null;

export function getSupabaseServer(): SupabaseClient {
  if (!supabaseServerInstance) {
    if (!supabaseServiceKey) {
      throw new Error('SUPABASE_SERVICE_ROLE_KEY 环境变量未配置');
    }
    supabaseServerInstance = createClient(supabaseUrl, supabaseServiceKey);
  }
  return supabaseServerInstance;
}

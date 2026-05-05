import { NextResponse } from 'next/server';
import { supabase } from '../../lib/supabase';

export async function GET(request: Request) {
  try {
    const { data } = await supabase.auth.getSession();
    const user = data?.session?.user;
    
    if (!user) {
      return NextResponse.json({ credits: 0 }, { status: 200 });
    }

    const { data: profile, error } = await supabase
      .from('profiles')
      .select('credits')
      .eq('id', user.id)
      .single();

    if (error) {
      console.error('Failed to get user credits:', error);
      return NextResponse.json({ credits: 0 }, { status: 200 });
    }

    return NextResponse.json({ credits: profile?.credits || 0 }, { status: 200 });
  } catch (error) {
    console.error('Error getting user credits:', error);
    return NextResponse.json({ credits: 0 }, { status: 200 });
  }
}
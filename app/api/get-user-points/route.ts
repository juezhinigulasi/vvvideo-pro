import { NextResponse } from 'next/server';
import { supabase } from '../../lib/supabase';

export async function GET(request: Request) {
  try {
    const { data } = await supabase.auth.getSession();
    const user = data?.session?.user;
    
    if (!user) {
      return NextResponse.json({ points: 0 }, { status: 200 });
    }

    const { data: profile, error } = await supabase
      .from('profiles')
      .select('points')
      .eq('id', user.id)
      .single();

    if (error) {
      console.error('Failed to get user points:', error);
      return NextResponse.json({ points: 0 }, { status: 200 });
    }

    return NextResponse.json({ points: profile?.points || 0 }, { status: 200 });
  } catch (error) {
    console.error('Error getting user points:', error);
    return NextResponse.json({ points: 0 }, { status: 200 });
  }
}
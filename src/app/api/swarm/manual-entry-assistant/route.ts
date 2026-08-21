import { NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import { SWARM_BASE_URL, swarmAuthHeaders } from '@/lib/swarm';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  
  if (!session?.user) {
    return NextResponse.json({ error: 'Forbidden: Authentication required.' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const res = await fetch(`${SWARM_BASE_URL}/api/agent/manual-entry-assistant`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...swarmAuthHeaders(),
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorText = await res.text();
      return NextResponse.json({ error: `Swarm API error: ${res.status} ${errorText}` }, { status: res.status });
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (err: any) {
    console.error('Failed to proxy manual-entry-assistant:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

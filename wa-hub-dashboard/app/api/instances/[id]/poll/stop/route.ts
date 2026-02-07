import { NextRequest, NextResponse } from 'next/server';
import { stopPoll } from '@/lib/pollers';
import { broadcastSse } from '@/lib/store';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await _request.json().catch(() => ({}));
  const type = (body.type ?? 'status') as 'status' | 'qr';

  stopPoll(id, type);
  broadcastSse({ type: 'polling', data: { instanceId: id, type, state: 'stopped' } });

  return NextResponse.json({ ok: true, type });
}

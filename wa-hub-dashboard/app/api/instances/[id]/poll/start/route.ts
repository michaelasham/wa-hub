import { NextRequest, NextResponse } from 'next/server';
import { stopPoll } from '@/lib/pollers';

/**
 * Poll API is disabled. Status and QR are webhook-driven.
 * Stopping any existing pollers and returning without starting new ones.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const type = (body.type ?? 'status') as 'status' | 'qr';

  stopPoll(id, type);

  return NextResponse.json({
    ok: true,
    type,
    message: 'Polling disabled. Status and QR are webhook-driven.',
  });
}

import { NextRequest, NextResponse } from 'next/server';
import { verifyWebhookSignature } from '@/lib/hmac';
import {
  addWebhookEvent,
  setInstanceMeta,
  lifecycleRankFromEvent,
  broadcastSse,
} from '@/lib/store';

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get('x-wa-hub-signature');
  const secret = process.env.WA_HUB_WEBHOOK_SIGNATURE_SECRET ?? '';
  const signatureValid = secret ? verifyWebhookSignature(rawBody, signature, secret) : null;

  let payload: { event?: string; instanceId?: string; data?: unknown };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const event = payload.event ?? 'unknown';
  const instanceId = payload.instanceId ?? null;
  const rank = lifecycleRankFromEvent(event);
  const summary = `${event}${instanceId ? ` @ ${instanceId}` : ''}`;

  const webhookEvent = addWebhookEvent({
    timestamp: new Date().toISOString(),
    instanceId,
    event,
    payload,
    signatureValid,
    summary,
  });

  if (instanceId) {
    const updates: Parameters<typeof setInstanceMeta>[1] = {
      lastEventAt: webhookEvent.timestamp,
      waStatus: event,
    };
    if (rank !== null) {
      updates.lifecycleRank = rank;
    }
    setInstanceMeta(instanceId, updates);
  }

  broadcastSse({ type: 'webhook', data: webhookEvent });

  return NextResponse.json({ ok: true });
}

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
  const data = payload.data as { status?: string } | undefined;
  const rank = lifecycleRankFromEvent(event, data);
  const summary =
    event === 'change_state' && data?.status
      ? `${event}:${data.status}${instanceId ? ` @ ${instanceId}` : ''}`
      : `${event}${instanceId ? ` @ ${instanceId}` : ''}`;

  const webhookEvent = addWebhookEvent({
    timestamp: new Date().toISOString(),
    instanceId,
    event,
    payload,
    signatureValid,
    summary,
  });

  if (instanceId) {
    const waStatus =
      event === 'change_state' && data?.status ? `change_state:${data.status}` : event;
    const updates: Parameters<typeof setInstanceMeta>[1] = {
      lastEventAt: webhookEvent.timestamp,
      waStatus,
    };
    if (rank !== null) {
      updates.lifecycleRank = rank;
    }
    if (event === 'qr' && payload.data && typeof (payload.data as { qr?: string }).qr === 'string') {
      updates.lastQrBase64 = (payload.data as { qr: string }).qr;
    }
    setInstanceMeta(instanceId, updates);
  }

  broadcastSse({ type: 'webhook', data: webhookEvent });

  // Broadcast qr/status for UI panels that use webhooks (not polling)
  if (instanceId && event === 'qr' && payload.data && typeof (payload.data as { qr?: string }).qr === 'string') {
    broadcastSse({
      type: 'qr',
      data: {
        instanceId,
        qr: (payload.data as { qr: string }).qr,
        classification: 'READY',
      },
    });
  }

  return NextResponse.json({ ok: true });
}

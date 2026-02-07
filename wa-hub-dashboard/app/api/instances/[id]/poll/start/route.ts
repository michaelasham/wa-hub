import { NextRequest, NextResponse } from 'next/server';
import { setInstanceMeta, broadcastSse } from '@/lib/store';
import { startStatusPoll, startQrPoll, stopPoll } from '@/lib/pollers';

const BASE = process.env.WA_HUB_BASE_URL ?? 'http://localhost:3000';
const TOKEN = process.env.WA_HUB_TOKEN ?? '';
const POLL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? '3000', 10);
const QR_POLL_MS = parseInt(process.env.QR_POLL_INTERVAL_MS ?? '4000', 10);
const QR_MAX = parseInt(process.env.QR_POLL_MAX_ATTEMPTS ?? '30', 10);

function fetchWaHub(path: string, options?: RequestInit): Promise<Response> {
  const url = `${BASE.replace(/\/$/, '')}${path}`;
  return fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
}

function classifyQr404(instanceId: string, body: unknown): 'WAITING_FOR_QR' | 'INSTANCE_NOT_FOUND' {
  const err = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : '';
  const lower = err.toLowerCase();
  if (lower.includes('not available') || lower.includes('not ready') || lower.includes('qr')) {
    return 'WAITING_FOR_QR';
  }
  if (lower.includes('not found') || lower.includes('404')) {
    return 'INSTANCE_NOT_FOUND';
  }
  return 'INSTANCE_NOT_FOUND';
}

async function instanceExists(instanceId: string): Promise<boolean> {
  try {
    const res = await fetchWaHub('/instances');
    const list = (await res.json()) as Array<{ id: string }>;
    return Array.isArray(list) && list.some((i) => i.id === instanceId);
  } catch {
    return false;
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const type = (body.type ?? 'status') as 'status' | 'qr';

  if (type === 'status') {
    stopPoll(id, 'status');
    startStatusPoll(
      id,
      async () => {
        try {
          const res = await fetchWaHub(`/instances/${id}/client/status`);
          const data = await res.json();
          const status = data?.clientStatus ?? data;
          setInstanceMeta(id, {
            lastClientStatus: status,
            waStatus: status?.instanceStatus ?? status?.state ?? null,
          });
          broadcastSse({ type: 'status', data: { instanceId: id, status } });
        } catch (err) {
          broadcastSse({
            type: 'status',
            data: { instanceId: id, status: { error: String(err) } },
          });
        }
      },
      POLL_MS
    );
    broadcastSse({ type: 'polling', data: { instanceId: id, type: 'status', state: 'started' } });
  } else if (type === 'qr') {
    stopPoll(id, 'qr');
    startQrPoll(
      id,
      async () => {
        try {
          const res = await fetchWaHub(`/instances/${id}/client/qr`);
          const data = await res.json().catch(() => null);

          if (res.ok && data?.qrCode?.data?.qr_code) {
            const qr = data.qrCode.data.qr_code;
            setInstanceMeta(id, {
              lastQrBase64: qr,
              lastQrClassification: 'READY',
              lastQrError: null,
            });
            broadcastSse({
              type: 'qr',
              data: { instanceId: id, qr, classification: 'READY' },
            });
            return true;
          }

          if (res.status === 404) {
            const exists = await instanceExists(id);
            const classification = exists
              ? classifyQr404(id, data)
              : 'INSTANCE_NOT_FOUND';
            const err = data?.error ?? 'QR not available';
            setInstanceMeta(id, {
              lastQrClassification: classification,
              lastQrError: err,
            });
            broadcastSse({
              type: 'qr',
              data: {
                instanceId: id,
                qr: null,
                classification,
                error: err,
              },
            });
            return false;
          }

          setInstanceMeta(id, {
            lastQrError: data?.error ?? `HTTP ${res.status}`,
          });
          broadcastSse({
            type: 'qr',
            data: {
              instanceId: id,
              qr: null,
              classification: 'WAITING_FOR_QR',
              error: data?.error ?? `HTTP ${res.status}`,
            },
          });
          return false;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setInstanceMeta(id, { lastQrError: msg });
          broadcastSse({
            type: 'qr',
            data: { instanceId: id, qr: null, classification: 'WAITING_FOR_QR', error: msg },
          });
          return false;
        }
      },
      QR_POLL_MS,
      QR_MAX
    );
    broadcastSse({ type: 'polling', data: { instanceId: id, type: 'qr', state: 'started' } });
  }

  return NextResponse.json({ ok: true, type });
}

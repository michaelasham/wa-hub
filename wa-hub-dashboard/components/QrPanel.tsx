'use client';

import { useMemo, useState, useEffect } from 'react';
import { Card, Text, BlockStack, Badge, Banner } from '@shopify/polaris';
import { SseEvent } from '@/hooks/useSSE';
import { waHubRequest } from '@/lib/wahubClient';

/**
 * QR Panel - webhook-driven primary; auto-fetch from API when webhooks fail (e.g. 401).
 * Hidden when status is ready or authenticating (syncing/initializing).
 */
export function QrPanel({
  instanceId,
  events,
  status,
}: {
  instanceId: string;
  events: SseEvent[];
  status?: Record<string, unknown> | null;
}) {
  const isReady =
    status?.state === 'ready' || (status?.instanceStatus as string) === 'ready';
  const isAuthenticating =
    status?.state === 'connecting' ||
    (status?.instanceStatus as string) === 'initializing';
  const hideQrSection = isReady || isAuthenticating;

  if (hideQrSection) return null;
  const [qrFromApi, setQrFromApi] = useState<string | null>(null);

  const qrFromWebhooks = useMemo(() => {
    // Prefer explicit 'qr' broadcast (from webhook handler)
    const qrEv = events.find(
      (e) =>
        e.type === 'qr' && (e.data as { instanceId?: string }).instanceId === instanceId
    );
    if (qrEv) {
      const d = qrEv.data as { qr?: string };
      return d.qr ?? null;
    }
    // Fallback: webhook event with qr payload
    const webhookEv = events.find(
      (e) =>
        e.type === 'webhook' &&
        (e.data as { instanceId?: string }).instanceId === instanceId &&
        (e.data as { event?: string }).event === 'qr'
    );
    if (webhookEv) {
      const payload = (webhookEv.data as { payload?: { data?: { qr?: string } } }).payload;
      return payload?.data?.qr ?? null;
    }
    // Fallback: instance meta from initial payload (webhook arrived before SSE connect)
    const initEv = events.find((e) => e.type === 'initial');
    if (initEv) {
      const meta = (initEv.data as { instanceMeta?: { lastQrBase64?: string | null } }).instanceMeta;
      if (meta?.lastQrBase64) return meta.lastQrBase64;
    }
    return null;
  }, [events, instanceId]);

  const qr = qrFromWebhooks ?? qrFromApi;

  // Derive needs_qr from webhook events (webhook-only, no status polling)
  const lastWh = events.find((e) => e.type === 'webhook' && (e.data as { instanceId?: string }).instanceId === instanceId)?.data as { event?: string } | undefined;
  const needsQr = lastWh?.event === 'qr';

  // Auto-fetch QR from API only when status is needs_qr and webhooks don't have it
  useEffect(() => {
    if (!needsQr || qrFromWebhooks) {
      if (!needsQr) setQrFromApi(null);
      return;
    }
    let cancelled = false;
    const fetchQr = async () => {
      const res = await waHubRequest<{ qrCode?: { data?: { qr_code?: string } } }>({
        method: 'GET',
        path: `/instances/${instanceId}/client/qr`,
      });
      if (!cancelled && res.ok && res.data?.qrCode?.data?.qr_code) {
        setQrFromApi(res.data.qrCode.data.qr_code);
      }
    };
    fetchQr();
    const interval = setInterval(fetchQr, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [instanceId, needsQr, qrFromWebhooks]);

  return (
    <Card>
      <div style={{ padding: '1rem' }}>
        <Text variant="headingMd" as="h2">
          QR Code
        </Text>
        <BlockStack gap="400">
          <Badge tone="info">Webhook-driven (API fallback)</Badge>
          {!qr && (
            <Banner tone="info">
              <p>
                Loading QR… (webhook-driven; auto-fetching from API if needed)
              </p>
            </Banner>
          )}
          {qr && (
            <div style={{ textAlign: 'center' }}>
              <img
                src={qr.startsWith('data:') ? qr : `data:image/png;base64,${qr}`}
                alt="QR Code"
                style={{
                  maxHeight: '256px',
                  borderRadius: '0.5rem',
                  border: '1px solid var(--p-color-border-subdued)',
                }}
              />
            </div>
          )}
        </BlockStack>
      </div>
    </Card>
  );
}

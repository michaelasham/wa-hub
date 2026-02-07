'use client';

import { useMemo } from 'react';
import { Card, Text, BlockStack, Badge, Banner } from '@shopify/polaris';
import { SseEvent } from '@/hooks/useSSE';

/**
 * QR Panel - webhook-driven. Wa-hub sends qr events via webhook; no polling.
 */
export function QrPanel({
  instanceId,
  events,
}: {
  instanceId: string;
  events: SseEvent[];
}) {
  const qr = useMemo(() => {
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

  return (
    <Card>
      <div style={{ padding: '1rem' }}>
        <Text variant="headingMd" as="h2">
          QR Code
        </Text>
        <BlockStack gap="400">
          <Badge tone="info">Webhook-driven (no polling)</Badge>
          {!qr && (
            <Banner tone="info">
              <p>
                QR will appear when wa-hub sends a qr webhook. Ensure the instance webhook URL
                points to this dashboard and the instance is in needs_qr state.
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

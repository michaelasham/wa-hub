'use client';

import { useState, useEffect } from 'react';
import { Card, Text, Button, BlockStack, InlineStack, Banner, Badge, Spinner } from '@shopify/polaris';
import { SseEvent } from '@/hooks/useSSE';

export function QrPanel({
  instanceId,
  events,
}: {
  instanceId: string;
  events: SseEvent[];
}) {
  const [polling, setPolling] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [classification, setClassification] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(0);

  useEffect(() => {
    const ev = events.find(
      (e) => e.type === 'qr' && (e.data as { instanceId?: string }).instanceId === instanceId
    );
    if (ev) {
      const d = ev.data as { qr?: string; classification?: string; error?: string };
      setQr(d.qr ?? null);
      setClassification(d.classification ?? null);
      setError(d.error ?? null);
    }
  }, [events, instanceId]);

  useEffect(() => {
    const ev = events.find(
      (e) =>
        e.type === 'polling' &&
        (e.data as { instanceId?: string; type?: string }).instanceId === instanceId &&
        (e.data as { type?: string }).type === 'qr'
    );
    if (ev) {
      const d = ev.data as { state?: string };
      setPolling(d.state === 'started');
    }
  }, [events, instanceId]);

  const startPolling = async () => {
    setPolling(true);
    setQr(null);
    setError(null);
    setAttempts(0);
    await fetch(`/api/instances/${encodeURIComponent(instanceId)}/poll/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'qr' }),
    });
  };

  const stopPolling = async () => {
    setPolling(false);
    await fetch(`/api/instances/${encodeURIComponent(instanceId)}/poll/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'qr' }),
    });
  };

  const getClassificationBadge = (classification: string) => {
    switch (classification) {
      case 'READY':
        return <Badge tone="success">{classification}</Badge>;
      case 'INSTANCE_NOT_FOUND':
        return <Badge tone="critical">{classification}</Badge>;
      default:
        return <Badge tone="attention">{classification}</Badge>;
    }
  };

  return (
    <Card>
      <div style={{ padding: '1rem' }}>
        <Text variant="headingMd" as="h2">
          QR Code
        </Text>
        <BlockStack gap="400">
          <InlineStack gap="200">
            <Button onClick={startPolling} disabled={polling} variant="primary">
              Start QR polling
            </Button>
            <Button onClick={stopPolling} disabled={!polling}>
              Stop polling
            </Button>
          </InlineStack>
          {classification && (
            <div>
              <Text as="p" variant="bodyMd" fontWeight="semibold">
                Classification:
              </Text>
              <div style={{ marginTop: '0.5rem' }}>
                {getClassificationBadge(classification)}
              </div>
            </div>
          )}
          {error && (
            <Banner tone="critical">
              <p>{error}</p>
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
          {polling && !qr && (
            <div style={{ textAlign: 'center' }}>
              <Spinner accessibilityLabel="Polling for QR code" size="small" />
              <div style={{ marginTop: '0.5rem' }}>
                <Text as="p" variant="bodySm" tone="subdued">
                  Polling... (wait for QR or max attempts)
                </Text>
              </div>
            </div>
          )}
        </BlockStack>
      </div>
    </Card>
  );
}

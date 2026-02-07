'use client';

import { useState, useEffect } from 'react';
import { Card, Text, Button, BlockStack, InlineStack } from '@shopify/polaris';

export function StatusPollControl({ instanceId }: { instanceId: string }) {
  const [polling, setPolling] = useState(false);

  useEffect(() => {
    const es = new EventSource(`/api/stream?instanceId=${encodeURIComponent(instanceId)}`);
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data);
        if (ev.type === 'polling' && ev.data?.instanceId === instanceId && ev.data?.type === 'status') {
          setPolling(ev.data.state === 'started');
        }
      } catch {}
    };
    return () => es.close();
  }, [instanceId]);

  const start = async () => {
    setPolling(true);
    await fetch(`/api/instances/${encodeURIComponent(instanceId)}/poll/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'status' }),
    });
  };

  const stop = async () => {
    setPolling(false);
    await fetch(`/api/instances/${encodeURIComponent(instanceId)}/poll/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'status' }),
    });
  };

  return (
    <Card>
      <div style={{ padding: '1rem' }}>
        <Text variant="headingMd" as="h2">
          Status Polling
        </Text>
        <BlockStack gap="200">
          <InlineStack gap="200">
            <Button onClick={start} disabled={polling} variant="primary">
              Start status poll
            </Button>
            <Button onClick={stop} disabled={!polling}>
              Stop
            </Button>
          </InlineStack>
          <Text as="p" variant="bodySm" tone="subdued">
            {polling ? 'Polling /client/status every 3s' : 'Stopped'}
          </Text>
        </BlockStack>
      </div>
    </Card>
  );
}

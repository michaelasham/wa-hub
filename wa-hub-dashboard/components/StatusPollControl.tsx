'use client';

import { useState, useEffect } from 'react';
import { Card, Text, Button, Stack } from '@shopify/polaris';

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
        <Stack vertical spacing="tight">
          <Stack>
            <Button onClick={start} disabled={polling} primary>
              Start status poll
            </Button>
            <Button onClick={stop} disabled={!polling}>
              Stop
            </Button>
          </Stack>
          <Text as="p" variant="bodySm" color="subdued">
            {polling ? 'Polling /client/status every 3s' : 'Stopped'}
          </Text>
        </Stack>
      </div>
    </Card>
  );
}

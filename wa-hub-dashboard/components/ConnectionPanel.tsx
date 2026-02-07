'use client';

import { Card, Text, Badge, Spinner, Collapsible, Stack, InlineCode } from '@shopify/polaris';
import { SseEvent } from '@/hooks/useSSE';
import { useState } from 'react';

const RANK_LABELS: Record<number, string> = {
  0: 'disconnected',
  1: 'needs_qr',
  2: 'syncing',
  3: 'active',
};

export function ConnectionPanel({
  instanceId,
  status,
  loading,
  events,
}: {
  instanceId: string;
  status: Record<string, unknown> | null;
  loading: boolean;
  events: SseEvent[];
}) {
  const [showRawStatus, setShowRawStatus] = useState(false);
  const webhooks = events.filter(
    (e) => e.type === 'webhook' && (e.data as { instanceId?: string }).instanceId === instanceId
  );
  const lastWebhook = webhooks[0]?.data as { event?: string; timestamp?: string } | undefined;
  const rank =
    lastWebhook?.event === 'ready'
      ? 3
      : lastWebhook?.event === 'authenticated'
      ? 2
      : lastWebhook?.event === 'qr'
      ? 1
      : lastWebhook?.event === 'disconnected' || lastWebhook?.event === 'auth_failure'
      ? 0
      : 1;

  const getLifecycleBadge = (rank: number) => {
    switch (rank) {
      case 3:
        return <Badge status="success">{RANK_LABELS[rank]}</Badge>;
      case 2:
        return <Badge status="info">{RANK_LABELS[rank]}</Badge>;
      case 1:
        return <Badge status="attention">{RANK_LABELS[rank]}</Badge>;
      default:
        return <Badge status="critical">{RANK_LABELS[rank]}</Badge>;
    }
  };

  return (
    <Card>
      <div style={{ padding: '1rem' }}>
        <Text variant="headingMd" as="h2">
          Connection Status
        </Text>
        {loading ? (
          <div style={{ marginTop: '1rem', textAlign: 'center' }}>
            <Spinner accessibilityLabel="Loading connection status" size="small" />
          </div>
        ) : (
          <Stack vertical spacing="tight">
            <div>
              <Text as="p" variant="bodyMd" fontWeight="semibold">
                wa-hub status:
              </Text>
              <InlineCode>
                {String(status?.instanceStatus ?? status?.state ?? 'unknown')}
              </InlineCode>
            </div>
            <div>
              <Text as="p" variant="bodyMd" fontWeight="semibold">
                Lifecycle:
              </Text>
              <div style={{ marginTop: '0.5rem' }}>
                {getLifecycleBadge(rank)}
              </div>
              <Text as="p" variant="bodySm" color="subdued" style={{ marginTop: '0.25rem' }}>
                needs_qr → syncing → active
              </Text>
            </div>
            {lastWebhook && (
              <div>
                <Text as="p" variant="bodyMd" fontWeight="semibold">
                  Last webhook:
                </Text>
                <Text as="p" variant="bodySm">
                  {lastWebhook.event} at {lastWebhook.timestamp}
                </Text>
              </div>
            )}
            {status && (
              <div>
                <button
                  onClick={() => setShowRawStatus(!showRawStatus)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--p-color-text-subdued)',
                    cursor: 'pointer',
                    textDecoration: 'underline',
                    fontSize: '0.875rem',
                  }}
                >
                  {showRawStatus ? 'Hide' : 'Show'} raw status
                </button>
                <Collapsible
                  open={showRawStatus}
                  id="raw-status-collapsible"
                  transition={{ duration: '200ms', timingFunction: 'ease-in-out' }}
                >
                  <div style={{ marginTop: '0.5rem', padding: '0.75rem', backgroundColor: 'var(--p-color-bg-surface-secondary)', borderRadius: '0.5rem' }}>
                    <pre style={{ fontSize: '0.75rem', overflow: 'auto', margin: 0 }}>
                      {JSON.stringify(status, null, 2)}
                    </pre>
                  </div>
                </Collapsible>
              </div>
            )}
          </Stack>
        )}
      </div>
    </Card>
  );
}

'use client';

import { Card, Text, Badge, Spinner, Collapsible, BlockStack, InlineCode, InlineStack, Button } from '@shopify/polaris';
import { SseEvent } from '@/hooks/useSSE';
import { useState, useEffect } from 'react';

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
  onRefresh,
}: {
  instanceId: string;
  status: Record<string, unknown> | null;
  loading: boolean;
  events: SseEvent[];
  onRefresh?: () => void;
}) {
  const [showRawStatus, setShowRawStatus] = useState(false);
  const webhooks = events.filter(
    (e) => e.type === 'webhook' && (e.data as { instanceId?: string }).instanceId === instanceId
  );
  const lastWebhook = webhooks[0]?.data as { event?: string; timestamp?: string } | undefined;
  const initEv = events.find((e) => e.type === 'initial');
  const instanceMeta = initEv
    ? (initEv.data as { instanceMeta?: { waStatus?: string | null } }).instanceMeta
    : null;

  // Webhook-driven status (primary); fallback to instance meta; then one-time fetch
  const displayStatus =
    lastWebhook?.event ??
    instanceMeta?.waStatus ??
    (status?.instanceStatus as string) ??
    (status?.state as string) ??
    'unknown';

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
        return <Badge tone="success">{RANK_LABELS[rank]}</Badge>;
      case 2:
        return <Badge tone="info">{RANK_LABELS[rank]}</Badge>;
      case 1:
        return <Badge tone="attention">{RANK_LABELS[rank]}</Badge>;
      default:
        return <Badge tone="critical">{RANK_LABELS[rank]}</Badge>;
    }
  };

  // Countdown: only after authenticated, when waiting for ready (syncing)
  const s = status as { readyWatchdogStartAt?: string; readyWatchdogMs?: number } | null;
  const isWaiting = rank === 2 && s?.readyWatchdogStartAt && s?.readyWatchdogMs;
  const [countdownSec, setCountdownSec] = useState<number | null>(null);

  useEffect(() => {
    if (!isWaiting || !s?.readyWatchdogStartAt || !s?.readyWatchdogMs) {
      setCountdownSec(null);
      return;
    }
    const update = () => {
      const start = new Date(s.readyWatchdogStartAt!).getTime();
      const elapsed = Date.now() - start;
      const remaining = Math.max(0, Math.floor((s.readyWatchdogMs! - elapsed) / 1000));
      setCountdownSec(remaining);
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [isWaiting, s?.readyWatchdogStartAt, s?.readyWatchdogMs]);

  return (
    <Card>
      <div style={{ padding: '1rem' }}>
        <InlineStack align="space-between" blockAlign="center" gap="200">
          <Text variant="headingMd" as="h2">
            Connection Status
          </Text>
          {onRefresh && (
            <Button variant="plain" size="slim" onClick={onRefresh} disabled={loading}>
              Refresh
            </Button>
          )}
        </InlineStack>
        {loading ? (
          <div style={{ marginTop: '1rem', textAlign: 'center' }}>
            <Spinner accessibilityLabel="Loading connection status" size="small" />
          </div>
        ) : (
          <BlockStack gap="200">
            <div>
              <Text as="p" variant="bodyMd" fontWeight="semibold">
                Status (webhook-driven):
              </Text>
              <InlineCode>{String(displayStatus)}</InlineCode>
            </div>
            <div>
              <Text as="p" variant="bodyMd" fontWeight="semibold">
                Lifecycle:
              </Text>
              <div style={{ marginTop: '0.5rem' }}>
                {getLifecycleBadge(rank)}
              </div>
              <div style={{ marginTop: '0.25rem' }}>
                <Text as="p" variant="bodySm" tone="subdued">
                  needs_qr → syncing → active
                </Text>
              </div>
              {countdownSec !== null && countdownSec >= 0 && (
                <div style={{ marginTop: '0.5rem' }}>
                  <Text as="p" variant="bodySm" fontWeight="medium">
                    Restart in: {Math.floor(countdownSec / 60)}:{String(countdownSec % 60).padStart(2, '0')}
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Instance will soft-restart if not ready in time
                  </Text>
                </div>
              )}
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
          </BlockStack>
        )}
      </div>
    </Card>
  );
}

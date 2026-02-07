'use client';

import { useState } from 'react';
import { Card, Text, Select, Stack, Collapsible, Badge, InlineCode, EmptyState } from '@shopify/polaris';
import { SseEvent } from '@/hooks/useSSE';

export function WebhooksPanel({
  instanceId,
  events,
}: {
  instanceId: string;
  events: SseEvent[];
}) {
  const [filter, setFilter] = useState<string>('');
  const [openItems, setOpenItems] = useState<Set<number>>(new Set());
  const webhooks = events.filter(
    (e) =>
      e.type === 'webhook' &&
      (e.data as { instanceId?: string }).instanceId === instanceId
  );
  const filtered = filter
    ? webhooks.filter((e) => (e.data as { event?: string }).event === filter)
    : webhooks;

  const eventTypes = [...new Set(webhooks.map((e) => (e.data as { event?: string }).event).filter(Boolean))];

  const toggleItem = (index: number) => {
    const newOpen = new Set(openItems);
    if (newOpen.has(index)) {
      newOpen.delete(index);
    } else {
      newOpen.add(index);
    }
    setOpenItems(newOpen);
  };

  const options = [
    { label: 'All events', value: '' },
    ...eventTypes.map((t) => ({ label: t || 'Unknown', value: t || '' })),
  ];

  return (
    <Card>
      <div style={{ padding: '1rem' }}>
        <Text variant="headingMd" as="h2">
          Webhooks (live)
        </Text>
        <Stack vertical spacing="tight">
          <Select
            label="Filter by event type"
            options={options}
            value={filter}
            onChange={setFilter}
          />
          <div style={{ maxHeight: '400px', overflow: 'auto' }}>
            {filtered.length === 0 ? (
              <EmptyState heading="No webhook events">
                <p>Webhook events will appear here when they are received.</p>
              </EmptyState>
            ) : (
              <Stack vertical spacing="tight">
                {filtered.map((ev, i) => {
                  const d = ev.data as {
                    event?: string;
                    timestamp?: string;
                    instanceId?: string;
                    payload?: unknown;
                    signatureValid?: boolean | null;
                    summary?: string;
                  };
                  const isOpen = openItems.has(i);
                  return (
                    <div
                      key={i}
                      style={{
                        border: '1px solid var(--p-color-border-subdued)',
                        borderRadius: '0.5rem',
                        backgroundColor: 'var(--p-color-bg-surface-secondary)',
                        padding: '0.75rem',
                      }}
                    >
                      <button
                        onClick={() => toggleItem(i)}
                        style={{
                          width: '100%',
                          textAlign: 'left',
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                        }}
                      >
                        <Stack spacing="tight">
                          <Text as="span" variant="bodyMd" fontWeight="semibold">
                            {d.event}
                          </Text>
                          <Text as="span" variant="bodySm" color="subdued">
                            @ {d.timestamp}
                          </Text>
                          {d.signatureValid === true && (
                            <Badge status="success">✓ sig</Badge>
                          )}
                          {d.signatureValid === false && (
                            <Badge status="critical">✗ sig invalid</Badge>
                          )}
                        </Stack>
                        <Text as="span" variant="bodySm" color="subdued">
                          {isOpen ? '▼' : '▶'}
                        </Text>
                      </button>
                      <Collapsible
                        open={isOpen}
                        id={`webhook-${i}`}
                        transition={{ duration: '200ms', timingFunction: 'ease-in-out' }}
                      >
                        <div style={{ marginTop: '0.5rem', padding: '0.5rem', backgroundColor: 'var(--p-color-bg-surface)', borderRadius: '0.25rem' }}>
                          <InlineCode>
                            <pre style={{ fontSize: '0.75rem', overflow: 'auto', margin: 0 }}>
                              {JSON.stringify(d.payload ?? d, null, 2)}
                            </pre>
                          </InlineCode>
                        </div>
                      </Collapsible>
                    </div>
                  );
                })}
              </Stack>
            )}
          </div>
        </Stack>
      </div>
    </Card>
  );
}

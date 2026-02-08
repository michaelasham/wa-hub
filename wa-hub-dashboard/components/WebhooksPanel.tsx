'use client';

import { useState } from 'react';
import { Card, Text, Select, BlockStack, InlineStack, Collapsible, Badge, InlineCode, EmptyState } from '@shopify/polaris';
import { SseEvent, SseScope } from '@/hooks/useSSE';

export function WebhooksPanel({
  instanceId,
  events,
  scope,
  onScopeChange,
}: {
  instanceId: string;
  events: SseEvent[];
  scope: SseScope;
  onScopeChange: (scope: SseScope) => void;
}) {
  const [filter, setFilter] = useState<string>('');
  const [openItems, setOpenItems] = useState<Set<number>>(new Set());

  const fromStream = events.filter((e) => e.type === 'webhook');
  const fromInitial = events.flatMap((e) => {
    if (e.type !== 'initial') return [];
    const list = (e.data as { webhookEvents?: Array<Record<string, unknown>> })?.webhookEvents ?? [];
    return list.map((w) => ({ type: 'webhook' as const, data: w }));
  });
  const allWebhooks = [...fromStream];
  for (const ev of fromInitial) {
    if (!allWebhooks.some((x) => (x.data as { id?: string }).id === (ev.data as { id?: string }).id)) {
      allWebhooks.push(ev);
    }
  }
  allWebhooks.sort((a, b) => {
    const ta = (a.data as { timestamp?: string }).timestamp ?? '';
    const tb = (b.data as { timestamp?: string }).timestamp ?? '';
    return tb.localeCompare(ta);
  });
  const webhooks =
    scope === 'global'
      ? allWebhooks
      : allWebhooks.filter((e) => (e.data as { instanceId?: string }).instanceId === instanceId);

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

  const scopeOptions = [
    { label: 'This instance only', value: 'instance' },
    { label: 'Global (all instances)', value: 'global' },
  ];

  const typeOptions = [
    { label: 'All event types', value: '' },
    ...eventTypes.map((t) => ({ label: t || 'Unknown', value: t || '' })),
  ];

  return (
    <Card>
      <div style={{ padding: '1rem' }}>
        <Text variant="headingMd" as="h2">
          Webhooks (live)
        </Text>
        <BlockStack gap="200">
          <InlineStack gap="400" wrap={false}>
            <div style={{ minWidth: '180px' }}>
              <Select
                label="Scope"
                options={scopeOptions}
                value={scope}
                onChange={(v) => onScopeChange(v as SseScope)}
              />
            </div>
            <div style={{ minWidth: '160px' }}>
              <Select
                label="Filter by event type"
                options={typeOptions}
                value={filter}
                onChange={setFilter}
              />
            </div>
          </InlineStack>
          <div style={{ maxHeight: '400px', overflow: 'auto' }}>
            {filtered.length === 0 ? (
              <EmptyState image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png" heading="No webhook events">
                <p>Webhook events will appear here when they are received.</p>
              </EmptyState>
            ) : (
              <BlockStack gap="200">
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
                        <InlineStack gap="200">
                          <Text as="span" variant="bodyMd" fontWeight="semibold">
                            {d.event}
                          </Text>
                          {scope === 'global' && d.instanceId && (
                            <Badge tone="info">{d.instanceId}</Badge>
                          )}
                          <Text as="span" variant="bodySm" tone="subdued">
                            @ {d.timestamp}
                          </Text>
                          {d.signatureValid === true && (
                            <Badge tone="success">✓ sig</Badge>
                          )}
                          {d.signatureValid === false && (
                            <Badge tone="critical">✗ sig invalid</Badge>
                          )}
                        </InlineStack>
                        <Text as="span" variant="bodySm" tone="subdued">
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
              </BlockStack>
            )}
          </div>
        </BlockStack>
      </div>
    </Card>
  );
}

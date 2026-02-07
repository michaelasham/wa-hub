'use client';

import { Card, Text, BlockStack, InlineStack, Collapsible, Badge, InlineCode, EmptyState } from '@shopify/polaris';
import { SseEvent } from '@/hooks/useSSE';
import { useState } from 'react';

export function LogsPanel({
  instanceId,
  events,
}: {
  instanceId: string;
  events: SseEvent[];
}) {
  const [openItems, setOpenItems] = useState<Set<number>>(new Set());
  const logs = events.filter(
    (e) =>
      e.type === 'apiLog' &&
      (e.data as { instanceId?: string }).instanceId === instanceId
  );

  const toggleItem = (index: number) => {
    const newOpen = new Set(openItems);
    if (newOpen.has(index)) {
      newOpen.delete(index);
    } else {
      newOpen.add(index);
    }
    setOpenItems(newOpen);
  };

  return (
    <Card>
      <div style={{ padding: '1rem' }}>
        <Text variant="headingMd" as="h2">
          API Logs (live)
        </Text>
        <div style={{ maxHeight: '400px', overflow: 'auto', marginTop: '1rem' }}>
          {logs.length === 0 ? (
            <EmptyState image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png" heading="No API logs">
              <p>API request logs will appear here.</p>
            </EmptyState>
          ) : (
            <BlockStack gap="200">
              {logs.map((ev, i) => {
                const d = ev.data as {
                  method?: string;
                  path?: string;
                  statusCode?: number;
                  latencyMs?: number;
                  timestamp?: string;
                  requestBody?: unknown;
                  responseBody?: unknown;
                  error?: string;
                };
                const isError = (d.statusCode ?? 0) >= 400 || d.error;
                const isOpen = openItems.has(i);
                return (
                  <div
                    key={i}
                    style={{
                      border: `1px solid ${isError ? 'var(--p-color-border-critical)' : 'var(--p-color-border-subdued)'}`,
                      borderRadius: '0.5rem',
                      backgroundColor: isError ? 'var(--p-color-bg-surface-critical-subdued)' : 'var(--p-color-bg-surface-secondary)',
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
                        <InlineCode>{d.method}</InlineCode>
                        <Text as="span" variant="bodySm" tone="subdued">
                          {d.path}
                        </Text>
                        <Badge tone={isError ? 'critical' : 'success'}>
                          {String(d.statusCode ?? '—')}
                        </Badge>
                        <Text as="span" variant="bodySm" tone="subdued">
                          {d.latencyMs}ms
                        </Text>
                      </InlineStack>
                      <Text as="span" variant="bodySm" tone="subdued">
                        {isOpen ? '▼' : '▶'}
                      </Text>
                    </button>
                    <Collapsible
                      open={isOpen}
                      id={`log-${i}`}
                      transition={{ duration: '200ms', timingFunction: 'ease-in-out' }}
                    >
                      <div style={{ marginTop: '0.5rem' }}>
                        <BlockStack gap="200">
                        <div>
                          <Text as="p" variant="bodySm" fontWeight="semibold">
                            Request:
                          </Text>
                          <div style={{ marginTop: '0.25rem', padding: '0.5rem', backgroundColor: 'var(--p-color-bg-surface)', borderRadius: '0.25rem' }}>
                            <InlineCode>
                              <pre style={{ fontSize: '0.75rem', overflow: 'auto', margin: 0 }}>
                                {JSON.stringify(d.requestBody, null, 2) || '—'}
                              </pre>
                            </InlineCode>
                          </div>
                        </div>
                        <div>
                          <Text as="p" variant="bodySm" fontWeight="semibold">
                            Response:
                          </Text>
                          <div style={{ marginTop: '0.25rem', padding: '0.5rem', backgroundColor: 'var(--p-color-bg-surface)', borderRadius: '0.25rem', maxHeight: '200px', overflow: 'auto' }}>
                            <InlineCode>
                              <pre style={{ fontSize: '0.75rem', overflow: 'auto', margin: 0 }}>
                                {JSON.stringify(d.responseBody, null, 2) || '—'}
                              </pre>
                            </InlineCode>
                          </div>
                        </div>
                        </BlockStack>
                      </div>
                    </Collapsible>
                  </div>
                );
              })}
            </BlockStack>
          )}
        </div>
      </div>
    </Card>
  );
}

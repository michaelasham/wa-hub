'use client';

import { useState } from 'react';
import { SseEvent } from '@/hooks/useSSE';

export function WebhooksPanel({
  instanceId,
  events,
}: {
  instanceId: string;
  events: SseEvent[];
}) {
  const [filter, setFilter] = useState<string>('');
  const webhooks = events.filter(
    (e) =>
      e.type === 'webhook' &&
      (e.data as { instanceId?: string }).instanceId === instanceId
  );
  const filtered = filter
    ? webhooks.filter((e) => (e.data as { event?: string }).event === filter)
    : webhooks;

  const eventTypes = [...new Set(webhooks.map((e) => (e.data as { event?: string }).event).filter(Boolean))];

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow lg:col-span-2">
      <h2 className="mb-4 text-lg font-semibold">Webhooks (live)</h2>
      <div className="mb-2 flex gap-2">
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="rounded border px-2 py-1 text-sm"
        >
          <option value="">All events</option>
          {eventTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      <div className="max-h-96 space-y-2 overflow-auto">
        {filtered.length === 0 ? (
          <p className="text-sm text-gray-500">No webhook events yet</p>
        ) : (
          filtered.map((ev, i) => {
            const d = ev.data as {
              event?: string;
              timestamp?: string;
              instanceId?: string;
              payload?: unknown;
              signatureValid?: boolean | null;
              summary?: string;
            };
            return (
              <details key={i} className="rounded border bg-gray-50">
                <summary className="cursor-pointer p-2 text-sm">
                  <span className="font-medium">{d.event}</span> @ {d.timestamp}
                  {d.signatureValid === true && (
                    <span className="ml-2 text-green-600">✓ sig</span>
                  )}
                  {d.signatureValid === false && (
                    <span className="ml-2 text-red-600">✗ sig invalid</span>
                  )}
                </summary>
                <pre className="overflow-auto p-2 text-xs">{JSON.stringify(d.payload ?? d, null, 2)}</pre>
              </details>
            );
          })
        )}
      </div>
    </div>
  );
}

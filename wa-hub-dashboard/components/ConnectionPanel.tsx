'use client';

import { SseEvent } from '@/hooks/useSSE';

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

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow">
      <h2 className="mb-4 text-lg font-semibold">Connection</h2>
      {loading ? (
        <p className="text-gray-500">Loading...</p>
      ) : (
        <div className="space-y-3 text-sm">
          <div>
            <span className="font-medium text-gray-600">wa-hub status:</span>{' '}
            <code className="rounded bg-gray-100 px-1">
              {String(status?.instanceStatus ?? status?.state ?? 'unknown')}
            </code>
          </div>
          <div>
            <span className="font-medium text-gray-600">Lifecycle:</span>{' '}
            <span
              className={`rounded px-2 py-0.5 ${
                rank === 3 ? 'bg-green-100' : rank === 2 ? 'bg-yellow-100' : 'bg-gray-100'
              }`}
            >
              {RANK_LABELS[rank]}
            </span>
            <span className="ml-2 text-gray-500">
              needs_qr → syncing → active
            </span>
          </div>
          {lastWebhook && (
            <div>
              <span className="font-medium text-gray-600">Last webhook:</span>{' '}
              {lastWebhook.event} at {lastWebhook.timestamp}
            </div>
          )}
          {status && (
            <details className="mt-2">
              <summary className="cursor-pointer text-gray-600">Raw status</summary>
              <pre className="mt-2 overflow-auto rounded bg-gray-50 p-2 text-xs">
                {JSON.stringify(status, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

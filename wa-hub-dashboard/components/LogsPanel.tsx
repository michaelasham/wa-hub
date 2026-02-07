'use client';

import { SseEvent } from '@/hooks/useSSE';

export function LogsPanel({
  instanceId,
  events,
}: {
  instanceId: string;
  events: SseEvent[];
}) {
  const logs = events.filter(
    (e) =>
      e.type === 'apiLog' &&
      (e.data as { instanceId?: string }).instanceId === instanceId
  );

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow lg:col-span-2">
      <h2 className="mb-4 text-lg font-semibold">API Logs (live)</h2>
      <div className="max-h-96 space-y-2 overflow-auto">
        {logs.length === 0 ? (
          <p className="text-sm text-gray-500">No API logs yet</p>
        ) : (
          logs.map((ev, i) => {
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
            return (
              <details key={i} className={`rounded border ${isError ? 'border-red-200 bg-red-50' : 'bg-gray-50'}`}>
                <summary className="cursor-pointer p-2 text-sm">
                  <span className="font-mono">{d.method}</span>{' '}
                  <span className="text-gray-600">{d.path}</span>{' '}
                  <span
                    className={
                      isError ? 'text-red-600' : 'text-green-600'
                    }
                  >
                    {d.statusCode ?? '—'}
                  </span>{' '}
                  <span className="text-gray-500">{d.latencyMs}ms</span>
                </summary>
                <div className="space-y-2 p-2 text-xs">
                  <div>
                    <strong>Request:</strong>
                    <pre className="mt-1 overflow-auto rounded bg-white p-2">
                      {JSON.stringify(d.requestBody, null, 2) || '—'}
                    </pre>
                  </div>
                  <div>
                    <strong>Response:</strong>
                    <pre className="mt-1 max-h-40 overflow-auto rounded bg-white p-2">
                      {JSON.stringify(d.responseBody, null, 2) || '—'}
                    </pre>
                  </div>
                </div>
              </details>
            );
          })
        )}
      </div>
    </div>
  );
}

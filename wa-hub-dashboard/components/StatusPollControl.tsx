'use client';

import { useState, useEffect } from 'react';

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
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow">
      <h2 className="mb-4 text-lg font-semibold">Status Polling</h2>
      <div className="flex gap-2">
        <button
          onClick={start}
          disabled={polling}
          className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
        >
          Start status poll
        </button>
        <button
          onClick={stop}
          disabled={!polling}
          className="rounded bg-gray-200 px-4 py-2 text-sm hover:bg-gray-300 disabled:opacity-50"
        >
          Stop
        </button>
      </div>
      <p className="mt-2 text-sm text-gray-500">
        {polling ? 'Polling /client/status every 3s' : 'Stopped'}
      </p>
    </div>
  );
}

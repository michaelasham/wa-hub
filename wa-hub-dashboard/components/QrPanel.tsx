'use client';

import { useState, useEffect } from 'react';
import { SseEvent } from '@/hooks/useSSE';

export function QrPanel({
  instanceId,
  events,
}: {
  instanceId: string;
  events: SseEvent[];
}) {
  const [polling, setPolling] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [classification, setClassification] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(0);

  useEffect(() => {
    const ev = events.find(
      (e) => e.type === 'qr' && (e.data as { instanceId?: string }).instanceId === instanceId
    );
    if (ev) {
      const d = ev.data as { qr?: string; classification?: string; error?: string };
      setQr(d.qr ?? null);
      setClassification(d.classification ?? null);
      setError(d.error ?? null);
    }
  }, [events, instanceId]);

  useEffect(() => {
    const ev = events.find(
      (e) =>
        e.type === 'polling' &&
        (e.data as { instanceId?: string; type?: string }).instanceId === instanceId &&
        (e.data as { type?: string }).type === 'qr'
    );
    if (ev) {
      const d = ev.data as { state?: string };
      setPolling(d.state === 'started');
    }
  }, [events, instanceId]);

  const startPolling = async () => {
    setPolling(true);
    setQr(null);
    setError(null);
    setAttempts(0);
    await fetch(`/api/instances/${encodeURIComponent(instanceId)}/poll/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'qr' }),
    });
  };

  const stopPolling = async () => {
    setPolling(false);
    await fetch(`/api/instances/${encodeURIComponent(instanceId)}/poll/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'qr' }),
    });
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow">
      <h2 className="mb-4 text-lg font-semibold">QR Code</h2>
      <div className="space-y-4">
        <div className="flex gap-2">
          <button
            onClick={startPolling}
            disabled={polling}
            className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Start QR polling
          </button>
          <button
            onClick={stopPolling}
            disabled={!polling}
            className="rounded bg-gray-200 px-4 py-2 text-sm hover:bg-gray-300 disabled:opacity-50"
          >
            Stop polling
          </button>
        </div>
        {classification && (
          <p className="text-sm">
            Classification:{' '}
            <span
              className={
                classification === 'READY'
                  ? 'text-green-600'
                  : classification === 'INSTANCE_NOT_FOUND'
                  ? 'text-red-600'
                  : 'text-yellow-600'
              }
            >
              {classification}
            </span>
          </p>
        )}
        {error && (
          <p className="text-sm text-red-600">{error}</p>
        )}
        {qr && (
          <div>
            <img
              src={qr.startsWith('data:') ? qr : `data:image/png;base64,${qr}`}
              alt="QR"
              className="mx-auto max-h-64 rounded border"
            />
          </div>
        )}
        {polling && !qr && (
          <p className="text-sm text-gray-500">Polling... (wait for QR or max attempts)</p>
        )}
      </div>
    </div>
  );
}

'use client';

import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useSSE } from '@/hooks/useSSE';
import { waHubRequest } from '@/lib/wahubClient';
import { ConnectionPanel } from '@/components/ConnectionPanel';
import { StatusPollControl } from '@/components/StatusPollControl';
import { QrPanel } from '@/components/QrPanel';
import { ActionsPanel } from '@/components/ActionsPanel';
import { WebhooksPanel } from '@/components/WebhooksPanel';
import { LogsPanel } from '@/components/LogsPanel';

export default function InstanceDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;
  const { events, connected } = useSSE(id);
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await waHubRequest<{ clientStatus?: unknown }>({
        method: 'GET',
        path: `/instances/${id}/client/status`,
      });
      if (!cancelled && res.ok && res.data) {
        const data = res.data as { clientStatus?: unknown };
        setStatus((data.clientStatus as Record<string, unknown>) ?? data as Record<string, unknown>);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [id]);

  // Update status from SSE
  useEffect(() => {
    const ev = events.find((e) => e.type === 'status' && (e.data as { instanceId?: string }).instanceId === id);
    if (ev) {
      setStatus((ev.data as { status: Record<string, unknown> }).status as Record<string, unknown>);
    }
  }, [events, id]);

  const handleDelete = async () => {
    if (!confirm('Delete this instance?')) return;
    const res = await waHubRequest({ method: 'DELETE', path: `/instances/${id}` });
    if (res.ok) {
      router.push('/');
    }
  };

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    router.push('/login');
  };

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="mx-auto max-w-7xl">
        <header className="mb-6 flex items-center justify-between">
          <div>
            <Link href="/" className="text-blue-600 hover:underline">
              ← Instances
            </Link>
            <h1 className="mt-2 text-2xl font-bold">{id}</h1>
          </div>
          <div className="flex items-center gap-4">
            <span
              className={`text-sm ${connected ? 'text-green-600' : 'text-gray-400'}`}
            >
              SSE {connected ? '●' : '○'}
            </span>
            <button
              onClick={handleLogout}
              className="rounded bg-gray-200 px-4 py-2 text-sm text-gray-700 hover:bg-gray-300"
            >
              Logout
            </button>
            <button
              onClick={handleDelete}
              className="rounded bg-red-100 px-4 py-2 text-sm text-red-700 hover:bg-red-200"
            >
              Delete Instance
            </button>
          </div>
        </header>

        <div className="grid gap-6 lg:grid-cols-2">
          <ConnectionPanel instanceId={id} status={status} loading={loading} events={events} />
          <StatusPollControl instanceId={id} />
          <QrPanel instanceId={id} events={events} />
          <ActionsPanel instanceId={id} />
          <WebhooksPanel instanceId={id} events={events} />
          <LogsPanel instanceId={id} events={events} />
        </div>
      </div>
    </div>
  );
}

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { waHubRequest } from '@/lib/wahubClient';

function shopDomainToInstanceName(domain: string): string {
  const s = domain.trim().toLowerCase().replace(/\./g, '_');
  return s ? `WASP-${s}` : '';
}

export function CreateInstanceButton({ onCreated }: { onCreated?: () => void }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [shopDomain, setShopDomain] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const instanceName = shopDomain ? shopDomainToInstanceName(shopDomain) : '';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!instanceName) {
      setError('Enter a shop domain (e.g. blesscurls.myshopify.com)');
      return;
    }
    setLoading(true);
    setError(null);
    let webhookUrl = typeof window !== 'undefined' ? `${window.location.origin}/api/wahub/webhook` : '';
    try {
      const r = await fetch('/api/config');
      const c = await r.json();
      if (c.webhookUrl) webhookUrl = c.webhookUrl;
    } catch {}
    const res = await waHubRequest<{ instance?: { id: string } }>({
      method: 'POST',
      path: '/instances',
      body: {
        name: instanceName,
        webhook: {
          url: webhookUrl,
          events: [
            'vote_update',
            'qr',
            'ready',
            'authenticated',
            'disconnected',
            'change_state',
            'auth_failure',
            'message',
          ],
        },
      },
    });
    setLoading(false);
    if (res.ok && res.data?.instance?.id) {
      setOpen(false);
      setShopDomain('');
      onCreated?.();
      router.push(`/instances/${encodeURIComponent(res.data.instance.id)}`);
    } else {
      setError(
        (res.data as { error?: string })?.error ?? res.error ?? 'Failed to create instance'
      );
    }
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
      >
        Create Instance
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
            <h2 className="mb-4 text-lg font-semibold">Create Instance</h2>
            <form onSubmit={handleSubmit}>
              <label className="mb-2 block text-sm font-medium text-gray-700">
                Shop domain or instance name
              </label>
              <input
                type="text"
                value={shopDomain}
                onChange={(e) => setShopDomain(e.target.value)}
                placeholder="blesscurls.myshopify.com"
                className="mb-2 w-full rounded border border-gray-300 px-3 py-2"
              />
              {instanceName && (
                <p className="mb-4 text-xs text-gray-500">
                  Instance name: {instanceName}
                </p>
              )}
              {error && (
                <p className="mb-4 text-sm text-red-600">{error}</p>
              )}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded bg-gray-200 px-4 py-2 hover:bg-gray-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loading || !instanceName}
                  className="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {loading ? 'Creating...' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

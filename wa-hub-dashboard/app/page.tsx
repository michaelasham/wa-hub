'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useInstances, useWaHubReachable } from '@/hooks/useWaHub';
import { CreateInstanceButton } from '@/components/CreateInstanceButton';

export default function HomePage() {
  const router = useRouter();
  const reachable = useWaHubReachable();
  const { instances, loading, error, refresh } = useInstances();

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    router.push('/login');
  };

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="mx-auto max-w-6xl">
        <header className="mb-8 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-900">wa-hub Test Dashboard</h1>
          <div className="flex gap-4">
            <CreateInstanceButton onCreated={refresh} />
            <button
              onClick={refresh}
              className="rounded bg-gray-200 px-4 py-2 text-sm hover:bg-gray-300"
            >
              Refresh
            </button>
            <button
              onClick={handleLogout}
              className="rounded bg-gray-200 px-4 py-2 text-sm text-gray-700 hover:bg-gray-300"
            >
              Logout
            </button>
          </div>
        </header>

        {reachable === false && (
          <div className="mb-4 rounded-lg bg-red-100 p-4 text-red-800">
            wa-hub unreachable. Check WA_HUB_BASE_URL and that wa-hub is running.
          </div>
        )}

        {reachable === null && (
          <div className="mb-4 rounded-lg bg-yellow-100 p-4 text-yellow-800">
            Checking wa-hub connection...
          </div>
        )}

        {error && (
          <div className="mb-4 rounded-lg bg-red-100 p-4 text-red-800">
            {error} {reachable === false && '(401/403: check WA_HUB_TOKEN)'}
          </div>
        )}

        {loading ? (
          <p className="text-gray-500">Loading instances...</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-100">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-600">
                    Instance
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-600">
                    Status
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-600">
                    Phone
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-600">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {instances.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-gray-500">
                      No instances. Create one to get started.
                    </td>
                  </tr>
                ) : (
                  instances.map((inst) => (
                    <tr key={inst.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <Link
                          href={`/instances/${encodeURIComponent(inst.id)}`}
                          className="font-medium text-blue-600 hover:underline"
                        >
                          {inst.name || inst.id}
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${
                            inst.status === 'ready'
                              ? 'bg-green-100 text-green-800'
                              : inst.status === 'qr'
                              ? 'bg-yellow-100 text-yellow-800'
                              : 'bg-gray-100 text-gray-800'
                          }`}
                        >
                          {inst.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600">
                        {inst.phoneNumber ?? '—'}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={`/instances/${encodeURIComponent(inst.id)}`}
                          className="mr-2 text-blue-600 hover:underline"
                        >
                          View
                        </Link>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

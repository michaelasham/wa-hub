'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const from = searchParams.get('from') ?? '/';
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    fetch('/api/auth/check')
      .then((r) => r.json())
      .then((d) => {
        if (d.authenticated) {
          router.replace(from);
        }
      })
      .catch(() => {})
      .finally(() => setChecking(false));
  }, [from, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
      credentials: 'include',
    });
    setLoading(false);
    const data = await res.json();
    if (res.ok) {
      router.replace(from);
    } else {
      setError(data.error ?? 'Login failed');
    }
  };

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-100">
        <p className="text-gray-600">Checking...</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-100">
      <div className="w-full max-w-sm rounded-lg bg-white p-8 shadow">
        <h1 className="mb-6 text-xl font-semibold">wa-hub Dashboard</h1>
        <form onSubmit={handleSubmit}>
          <label className="mb-2 block text-sm font-medium text-gray-700">
            Password
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mb-4 w-full rounded border border-gray-300 px-3 py-2"
            placeholder="Enter password"
            autoFocus
          />
          {error && <p className="mb-4 text-sm text-red-600">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded bg-blue-600 py-2 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? 'Logging in...' : 'Log in'}
          </button>
        </form>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="flex min-h-screen items-center justify-center bg-gray-100">
        <p className="text-gray-600">Loading...</p>
      </div>
    }>
      <LoginForm />
    </Suspense>
  );
}

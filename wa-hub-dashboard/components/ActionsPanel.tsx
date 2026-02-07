'use client';

import { useState } from 'react';
import { waHubRequest } from '@/lib/wahubClient';

export function ActionsPanel({ instanceId }: { instanceId: string }) {
  const [chatId, setChatId] = useState('');
  const [message, setMessage] = useState('');
  const [pollCaption, setPollCaption] = useState('');
  const [pollOptions, setPollOptions] = useState('');
  const [result, setResult] = useState<{ ok: boolean; data: unknown; status: number } | null>(null);
  const [loading, setLoading] = useState(false);

  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setResult(null);
    const res = await waHubRequest({
      method: 'POST',
      path: `/instances/${instanceId}/client/action/send-message`,
      body: { chatId: chatId.includes('@') ? chatId : `${chatId}@c.us`, message },
    });
    setResult({ ok: res.ok, data: res.data, status: res.status });
    setLoading(false);
  };

  const createPoll = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setResult(null);
    const options = pollOptions.split(',').map((s) => s.trim()).filter(Boolean);
    const res = await waHubRequest({
      method: 'POST',
      path: `/instances/${instanceId}/client/action/create-poll`,
      body: {
        chatId: chatId.includes('@') ? chatId : `${chatId}@c.us`,
        caption: pollCaption,
        options,
        multipleAnswers: false,
      },
    });
    setResult({ ok: res.ok, data: res.data, status: res.status });
    setLoading(false);
  };

  const logout = async () => {
    if (!confirm('Logout this instance?')) return;
    setLoading(true);
    setResult(null);
    const res = await waHubRequest({
      method: 'POST',
      path: `/instances/${instanceId}/client/action/logout`,
    });
    setResult({ ok: res.ok, data: res.data, status: res.status });
    setLoading(false);
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow">
      <h2 className="mb-4 text-lg font-semibold">Actions</h2>
      <div className="space-y-6">
        <form onSubmit={sendMessage}>
          <h3 className="mb-2 text-sm font-medium">Send Message</h3>
          <input
            type="text"
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
            placeholder="Phone or chatId (e.g. 201224885551)"
            className="mb-2 w-full rounded border px-3 py-2 text-sm"
          />
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Message text"
            className="mb-2 w-full rounded border px-3 py-2 text-sm"
            rows={2}
          />
          <button
            type="submit"
            disabled={loading}
            className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Send
          </button>
        </form>

        <form onSubmit={createPoll}>
          <h3 className="mb-2 text-sm font-medium">Create Poll</h3>
          <input
            type="text"
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
            placeholder="chatId"
            className="mb-2 w-full rounded border px-3 py-2 text-sm"
          />
          <input
            type="text"
            value={pollCaption}
            onChange={(e) => setPollCaption(e.target.value)}
            placeholder="Question"
            className="mb-2 w-full rounded border px-3 py-2 text-sm"
          />
          <input
            type="text"
            value={pollOptions}
            onChange={(e) => setPollOptions(e.target.value)}
            placeholder="Options (comma-separated)"
            className="mb-2 w-full rounded border px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={loading}
            className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Create Poll
          </button>
        </form>

        <div>
          <button
            onClick={logout}
            disabled={loading}
            className="rounded bg-red-100 px-4 py-2 text-sm text-red-700 hover:bg-red-200 disabled:opacity-50"
          >
            Logout
          </button>
        </div>

        {result && (
          <div
            className={`rounded p-2 text-sm ${
              result.ok ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'
            }`}
          >
            <p>Status: {result.status}</p>
            <pre className="mt-1 overflow-auto text-xs">{JSON.stringify(result.data, null, 2)}</pre>
          </div>
        )}
      </div>
    </div>
  );
}

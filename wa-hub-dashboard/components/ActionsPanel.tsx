'use client';

import { useState } from 'react';
import {
  Card,
  Text,
  TextField,
  Button,
  BlockStack,
  Banner,
  Divider,
  InlineCode,
} from '@shopify/polaris';
import { waHubRequest } from '@/lib/wahubClient';

export function ActionsPanel({ instanceId }: { instanceId: string }) {
  const [chatId, setChatId] = useState('');
  const [message, setMessage] = useState('');
  const [pollCaption, setPollCaption] = useState('');
  const [pollOptions, setPollOptions] = useState('');
  const [result, setResult] = useState<{ ok: boolean; data: unknown; status: number } | null>(null);
  const [loading, setLoading] = useState(false);

  const sendMessage = async () => {
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

  const createPoll = async () => {
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

  const viewLiveSession = async () => {
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch('/api/view-session/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instanceId,
          dashboardBaseUrl: typeof window !== 'undefined' ? window.location.origin : '',
        }),
        credentials: 'include',
      });
      const data = (await res.json().catch(() => ({}))) as { data?: { viewUrl?: string }; error?: string };
      const payload = data.data ?? data;
      if (res.ok && typeof payload === 'object' && payload && 'viewUrl' in payload) {
        const viewUrl = (payload as { viewUrl?: string }).viewUrl;
        if (viewUrl) window.open(viewUrl, '_blank', 'noopener,noreferrer');
        setResult({ ok: true, data: { viewUrl, message: 'Opened in new tab' }, status: res.status });
      } else {
        setResult({ ok: false, data: data, status: res.status });
      }
    } catch (e) {
      setResult({ ok: false, data: { error: e instanceof Error ? e.message : 'Failed' }, status: 0 });
    }
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
    <Card>
      <div style={{ padding: '1rem' }}>
        <Text variant="headingMd" as="h2">
          Actions
        </Text>
        <BlockStack gap="400">
          <div>
            <Banner tone="info" title="Founder-only (testing/debugging)">
              View Live Session streams a screenshot of the WhatsApp Web UI. Requires VIEW_SESSION_ENABLED on wa-hub.
            </Banner>
            <div style={{ marginTop: '0.5rem' }}>
              <Button onClick={viewLiveSession} loading={loading}>
                View Live Session (Testing)
              </Button>
            </div>
          </div>

          <Divider />

          <div>
            <Text variant="headingSm" as="h3" fontWeight="semibold">
              Send Message
            </Text>
            <BlockStack gap="200">
              <TextField
                label="Phone or chatId"
                value={chatId}
                onChange={setChatId}
                placeholder="201224885551"
                autoComplete="off"
              />
              <TextField
                label="Message"
                value={message}
                onChange={setMessage}
                placeholder="Message text"
                multiline={2}
                autoComplete="off"
              />
              <Button onClick={sendMessage} loading={loading} variant="primary">
                Send Message
              </Button>
            </BlockStack>
          </div>

          <Divider />

          <div>
            <Text variant="headingSm" as="h3" fontWeight="semibold">
              Create Poll
            </Text>
            <BlockStack gap="200">
              <TextField
                label="Phone or chatId"
                value={chatId}
                onChange={setChatId}
                placeholder="201224885551"
                autoComplete="off"
              />
              <TextField
                label="Question"
                value={pollCaption}
                onChange={setPollCaption}
                placeholder="Poll question"
                autoComplete="off"
              />
              <TextField
                label="Options (comma-separated)"
                value={pollOptions}
                onChange={setPollOptions}
                placeholder="Option 1, Option 2, Option 3"
                helpText="Separate options with commas"
                autoComplete="off"
              />
              <Button onClick={createPoll} loading={loading} variant="primary">
                Create Poll
              </Button>
            </BlockStack>
          </div>

          <Divider />

          <div>
            <Button onClick={logout} loading={loading} tone="critical">
              Logout Instance
            </Button>
          </div>

          {result && (
            <Banner tone={result.ok ? 'success' : 'critical'} title={`Status: ${result.status}`}>
              <div style={{ marginTop: '0.5rem' }}>
                <InlineCode>
                  <pre style={{ fontSize: '0.75rem', overflow: 'auto' }}>
                    {JSON.stringify(result.data, null, 2)}
                  </pre>
                </InlineCode>
              </div>
            </Banner>
          )}
        </BlockStack>
      </div>
    </Card>
  );
}

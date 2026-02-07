'use client';

import { useState } from 'react';
import {
  Card,
  Text,
  TextField,
  Button,
  Stack,
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
        <Stack vertical spacing="loose">
          <div>
            <Text variant="headingSm" as="h3" fontWeight="semibold">
              Send Message
            </Text>
            <Stack vertical spacing="tight">
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
              <Button onClick={sendMessage} loading={loading} primary>
                Send Message
              </Button>
            </Stack>
          </div>

          <Divider />

          <div>
            <Text variant="headingSm" as="h3" fontWeight="semibold">
              Create Poll
            </Text>
            <Stack vertical spacing="tight">
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
              <Button onClick={createPoll} loading={loading} primary>
                Create Poll
              </Button>
            </Stack>
          </div>

          <Divider />

          <div>
            <Button onClick={logout} loading={loading} destructive>
              Logout Instance
            </Button>
          </div>

          {result && (
            <Banner status={result.ok ? 'success' : 'critical'} title={`Status: ${result.status}`}>
              <div style={{ marginTop: '0.5rem' }}>
                <InlineCode>
                  <pre style={{ fontSize: '0.75rem', overflow: 'auto' }}>
                    {JSON.stringify(result.data, null, 2)}
                  </pre>
                </InlineCode>
              </div>
            </Banner>
          )}
        </Stack>
      </div>
    </Card>
  );
}

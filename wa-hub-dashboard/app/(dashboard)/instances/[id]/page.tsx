'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState, useCallback } from 'react';
import {
  Page,
  Frame,
  TopBar,
  Navigation,
  Banner,
  Badge,
  Button,
  Layout,
  Card,
  Text,
  Stack,
} from '@shopify/polaris';
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
  const [userMenuActive, setUserMenuActive] = useState(false);
  const [navigationActive, setNavigationActive] = useState(false);

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

  const toggleUserMenu = useCallback(() => setUserMenuActive((userMenuActive) => !userMenuActive), []);
  const toggleNavigation = useCallback(() => setNavigationActive((navigationActive) => !navigationActive), []);

  const userMenuActions = [
    {
      items: [{ content: 'Logout', onAction: handleLogout }],
    },
  ];

  const navigationMarkup = (
    <Navigation location="/">
      <Navigation.Section
        items={[
          {
            label: 'All Instances',
            url: '/',
            exactMatch: true,
          },
        ]}
      />
    </Navigation>
  );

  const topBarMarkup = (
    <TopBar
      showNavigationToggle
      userMenu={
        <TopBar.UserMenu
          actions={userMenuActions}
          name="Admin"
          initials="A"
          open={userMenuActive}
          onToggle={toggleUserMenu}
        />
      }
      onNavigationToggle={toggleNavigation}
    />
  );

  return (
    <Frame
      topBar={topBarMarkup}
      navigation={navigationMarkup}
      showMobileNavigation={navigationActive}
      onNavigationDismiss={toggleNavigation}
    >
      <Page
        title={id}
        breadcrumbs={[{ content: 'Instances', url: '/' }]}
        primaryAction={{
          content: 'Delete Instance',
          destructive: true,
          onAction: handleDelete,
        }}
        secondaryActions={[
          {
            content: connected ? 'SSE Connected' : 'SSE Disconnected',
            disabled: true,
          },
        ]}
      >
        {!connected && (
          <Banner status="warning" title="SSE Connection">
            <p>Server-Sent Events connection is not active. Real-time updates may not work.</p>
          </Banner>
        )}

        <Layout>
          <Layout.Section>
            <Stack vertical spacing="loose">
              <ConnectionPanel instanceId={id} status={status} loading={loading} events={events} />
              <StatusPollControl instanceId={id} />
              <QrPanel instanceId={id} events={events} />
            </Stack>
          </Layout.Section>
          <Layout.Section>
            <Stack vertical spacing="loose">
              <ActionsPanel instanceId={id} />
            </Stack>
          </Layout.Section>
          <Layout.Section fullWidth>
            <Stack vertical spacing="loose">
              <WebhooksPanel instanceId={id} events={events} />
              <LogsPanel instanceId={id} events={events} />
            </Stack>
          </Layout.Section>
        </Layout>
      </Page>
    </Frame>
  );
}

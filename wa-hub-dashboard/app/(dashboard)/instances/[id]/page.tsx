'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState, useCallback } from 'react';
import {
  Page,
  Frame,
  TopBar,
  Navigation,
  Banner,
  Layout,
  BlockStack,
} from '@shopify/polaris';
import { useSSE, SseScope } from '@/hooks/useSSE';
import { waHubRequest } from '@/lib/wahubClient';
import { ConnectionPanel } from '@/components/ConnectionPanel';
import { QrPanel } from '@/components/QrPanel';
import { ActionsPanel } from '@/components/ActionsPanel';
import { WebhooksPanel } from '@/components/WebhooksPanel';
import { LogsPanel } from '@/components/LogsPanel';

export default function InstanceDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;
  const [webhookScope, setWebhookScope] = useState<SseScope>('instance');
  const { events, connected } = useSSE(id, webhookScope);
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [userMenuActive, setUserMenuActive] = useState(false);
  const [navigationActive, setNavigationActive] = useState(false);

  const fetchStatus = useCallback(async () => {
    const res = await waHubRequest<{ clientStatus?: unknown }>({
      method: 'GET',
      path: `/instances/${id}/client/status`,
    });
    if (res.ok && res.data) {
      const data = res.data as { clientStatus?: unknown };
      setStatus((data.clientStatus as Record<string, unknown>) ?? (data as Record<string, unknown>));
    }
    return res.ok;
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await fetchStatus();
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [fetchStatus]);

  // Poll status only when authenticated (syncing), waiting for ready - for countdown timer
  const lastWh = events.find((e) => e.type === 'webhook' && (e.data as { instanceId?: string }).instanceId === id)?.data as { event?: string } | undefined;
  const isWaiting = lastWh?.event === 'authenticated';
  useEffect(() => {
    if (!isWaiting) return;
    const interval = setInterval(fetchStatus, 3000);
    return () => clearInterval(interval);
  }, [isWaiting, fetchStatus]);

  const handleRefresh = useCallback(async () => {
    setLoading(true);
    await fetchStatus();
    setLoading(false);
  }, [fetchStatus]);

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
          <Banner tone="warning" title="SSE Connection">
            <p>Server-Sent Events connection is not active. Real-time updates may not work.</p>
          </Banner>
        )}

        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
              <ConnectionPanel instanceId={id} status={status} loading={loading} events={events} onRefresh={handleRefresh} />
              <QrPanel instanceId={id} events={events} status={status} />
            </BlockStack>
          </Layout.Section>
          <Layout.Section>
            <BlockStack gap="400">
              <ActionsPanel instanceId={id} />
            </BlockStack>
          </Layout.Section>
          <Layout.Section>
            <BlockStack gap="400">
              <WebhooksPanel instanceId={id} events={events} scope={webhookScope} onScopeChange={setWebhookScope} />
              <LogsPanel instanceId={id} events={events} />
            </BlockStack>
          </Layout.Section>
        </Layout>
      </Page>
    </Frame>
  );
}

'use client';

import { useSearchParams, useRouter } from 'next/navigation';
import { useEffect, useState, useCallback, useRef, Suspense } from 'react';
import { Page, Banner, BlockStack, Button } from '@shopify/polaris';

const POLL_INTERVAL_MS = 1500;

function ViewerContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get('token');
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const imageUrlRef = useRef<string | null>(null);

  const handleClose = useCallback(async () => {
    if (!token || closing) return;
    setClosing(true);
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    try {
      await fetch('/api/view-session/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
        credentials: 'include',
      });
    } catch {
      /* ignore */
    }
    if (typeof window !== 'undefined' && window.opener) {
      window.close();
    } else {
      router.push('/');
    }
  }, [token, closing, router]);

  const fetchScreenshot = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch(`/api/view-session/screenshot?token=${encodeURIComponent(token)}`, {
        credentials: 'include',
      });
      if (!res.ok) {
        if (res.status === 404) setError('View session expired or invalid');
        else setError('Failed to load screenshot');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
      imageUrlRef.current = url;
      setImageSrc(url);
      setError(null);
    } catch {
      setError('Request failed');
    }
  }, [token]);

  useEffect(() => {
    if (!token) {
      setError('No token provided');
      return;
    }
    fetchScreenshot();
    intervalRef.current = setInterval(fetchScreenshot, POLL_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = null;
      if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
      imageUrlRef.current = null;
    };
  }, [token, fetchScreenshot]);

  if (!token) {
    return (
      <Page title="View Live Session">
        <Banner tone="critical">Missing token. Use the View Live Session button from an instance page.</Banner>
      </Page>
    );
  }

  return (
    <Page
      title="View Live Session (Testing Only)"
      primaryAction={{
        content: 'Close',
        onAction: handleClose,
        loading: closing,
      }}
    >
      <BlockStack gap="400">
        <Banner tone="warning">
          <p>
            <strong>Testing/debugging only.</strong> Screenshots stream from the existing headless instance (no extra
            browser). Click Close to stop polling and revoke the session.
          </p>
        </Banner>
        {error && (
          <Banner tone="critical" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        )}
        {imageSrc && (
          <div style={{ textAlign: 'center' }}>
            <img
              src={imageSrc}
              alt="WhatsApp Web session"
              style={{
                maxWidth: '100%',
                border: '1px solid var(--p-color-border-subdued)',
                borderRadius: '0.5rem',
              }}
            />
          </div>
        )}
      </BlockStack>
    </Page>
  );
}

export default function ViewerPage() {
  return (
    <Suspense fallback={<Page title="View Live Session">Loading…</Page>}>
      <ViewerContent />
    </Suspense>
  );
}

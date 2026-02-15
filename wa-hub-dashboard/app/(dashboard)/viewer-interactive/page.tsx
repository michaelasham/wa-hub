'use client';

import { useSearchParams, useRouter } from 'next/navigation';
import { useEffect, useState, useCallback, useRef, Suspense } from 'react';
import { Page, Banner, BlockStack, Button } from '@shopify/polaris';

const POLL_INTERVAL_MS = 1200;
const REFETCH_DELAY_MS = 300;

function ViewerInteractiveContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get('token');
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [pending, setPending] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const imageUrlRef = useRef<string | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

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

  const displayToViewport = useCallback((clientX: number, clientY: number) => {
    const img = imgRef.current;
    if (!img || !imageSrc) return null;
    const rect = img.getBoundingClientRect();
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    if (!nw || !nh) return null;
    const scaleX = nw / rect.width;
    const scaleY = nh / rect.height;
    const x = Math.round((clientX - rect.left) * scaleX);
    const y = Math.round((clientY - rect.top) * scaleY);
    return { x, y };
  }, [imageSrc]);

  const handleClick = useCallback(
    async (e: React.MouseEvent<HTMLDivElement>) => {
      if (!token || pending) return;
      const coords = displayToViewport(e.clientX, e.clientY);
      if (!coords) return;
      setPending(true);
      try {
        const res = await fetch('/api/view-session/click', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ token, x: coords.x, y: coords.y }),
        });
        const data = (await res.json().catch(() => ({}))) as { data?: { success?: boolean }; error?: string };
        if (res.ok && (data.data?.success ?? (data as { success?: boolean }).success)) {
          setTimeout(fetchScreenshot, REFETCH_DELAY_MS);
        } else {
          setError((data as { error?: string }).error ?? 'Click failed');
        }
      } catch {
        setError('Click request failed');
      } finally {
        setPending(false);
      }
    },
    [token, pending, displayToViewport, fetchScreenshot]
  );

  const handleWheel = useCallback(
    async (e: WheelEvent) => {
      if (!token || pending) return;
      const coords = displayToViewport(e.clientX, e.clientY);
      if (!coords) return;
      e.preventDefault();
      setPending(true);
      try {
        const res = await fetch('/api/view-session/scroll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ token, x: coords.x, y: coords.y, deltaY: e.deltaY }),
        });
        const data = (await res.json().catch(() => ({}))) as { data?: { success?: boolean }; error?: string };
        if (res.ok && (data.data?.success ?? (data as { success?: boolean }).success)) {
          setTimeout(fetchScreenshot, REFETCH_DELAY_MS);
        } else {
          setError((data as { error?: string }).error ?? 'Scroll failed');
        }
      } catch {
        setError('Scroll request failed');
      } finally {
        setPending(false);
      }
    },
    [token, pending, displayToViewport, fetchScreenshot]
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

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
      <Page title="View Live Session (Interactive)">
        <Banner tone="critical">Missing token. Use the View Interactive button from an instance page.</Banner>
      </Page>
    );
  }

  return (
    <Page
      title="View Live Session (Interactive)"
      primaryAction={{
        content: 'Close',
        onAction: handleClose,
        loading: closing,
      }}
    >
      <BlockStack gap="400">
        <Banner tone="warning">
          <p>
            <strong>Interactive view.</strong> Click on the screenshot to interact with WhatsApp Web, scroll to move the
            chat list. Actions are injected into the live session. Close when done.
          </p>
        </Banner>
        {error && (
          <Banner tone="critical" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        )}
        {imageSrc && (
          <div
            ref={containerRef}
            style={{
              position: 'relative',
              display: 'inline-block',
              cursor: pending ? 'wait' : 'pointer',
              textAlign: 'center',
              maxWidth: '100%',
            }}
            onClick={handleClick}
          >
            <img
              ref={imgRef}
              src={imageSrc}
              alt="WhatsApp Web session"
              draggable={false}
              style={{
                maxWidth: '100%',
                border: '1px solid var(--p-color-border-subdued)',
                borderRadius: '0.5rem',
                userSelect: 'none',
                pointerEvents: 'none',
              }}
            />
          </div>
        )}
      </BlockStack>
    </Page>
  );
}

export default function ViewerInteractivePage() {
  return (
    <Suspense fallback={<Page title="View Live Session (Interactive)">Loading…</Page>}>
      <ViewerInteractiveContent />
    </Suspense>
  );
}

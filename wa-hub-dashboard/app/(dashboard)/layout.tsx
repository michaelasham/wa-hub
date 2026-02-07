import { redirect } from 'next/navigation';
import { validateSession, isAuthEnabled } from '@/lib/auth';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!isAuthEnabled()) {
    return <>{children}</>;
  }
  const valid = await validateSession();
  if (!valid) {
    redirect('/login');
  }
  return <>{children}</>;
}

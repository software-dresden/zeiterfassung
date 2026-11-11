'use client';

import { ReactNode, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { setDbUser } from '@/lib/db';
import { SYNC_REJECTED_EVENT } from '@/lib/sync';
import { TopNav } from '@/components/nav/TopNav';
import { useSync } from '@/hooks/useSync';
import { usePresence } from '@/hooks/usePresence';
import { ProfileProvider } from '@/hooks/useProfile';
import { MfaGate } from '@/components/auth/MfaGate';
import { ToastProvider, useToast } from '@/components/ui/Toast';

// Everything below this point may use the local database, the sync engine and
// the profile, so it only mounts once the signed-in user (and with it the
// per-user database) is known.
function AppShell({ children, userId }: { children: ReactNode; userId: string }) {
  const { syncStatus } = useSync();
  usePresence(userId);
  const { showToast } = useToast();

  useEffect(() => {
    const handleRejected = () => {
      showToast(
        'Eine Änderung wurde vom Server abgelehnt und zurückgesetzt (z. B. weil sie von anderen Benutzern verwendet wird).',
        'error'
      );
    };
    window.addEventListener(SYNC_REJECTED_EVENT, handleRejected);
    return () => window.removeEventListener(SYNC_REJECTED_EVENT, handleRejected);
  }, [showToast]);

  return (
    <div className="min-h-screen bg-bg">
      <TopNav syncStatus={syncStatus} />
      <main className="pb-[calc(2rem+env(safe-area-inset-bottom))]">
        <div className="mx-auto max-w-5xl px-4 py-6">{children}</div>
      </main>
    </div>
  );
}

export default function AppLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const knownUserId = useRef<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) {
        router.push('/login');
      } else {
        knownUserId.current = data.session.user.id;
        setDbUser(data.session.user.id);
        setUserId(data.session.user.id);
      }
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        knownUserId.current = null;
        router.push('/login');
      } else if (
        event === 'SIGNED_IN' &&
        session &&
        knownUserId.current &&
        session.user.id !== knownUserId.current
      ) {
        // Another tab signed in as a different user: start over with that user's data.
        window.location.reload();
      }
    });

    return () => subscription.unsubscribe();
  }, [router]);

  if (!userId) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg text-text-muted">
        Laden...
      </div>
    );
  }

  return (
    <MfaGate>
      <ProfileProvider userId={userId}>
        <ToastProvider>
          <AppShell userId={userId}>{children}</AppShell>
        </ToastProvider>
      </ProfileProvider>
    </MfaGate>
  );
}

'use client';

import { useEffect } from 'react';
import { sendHeartbeat, TIMERS_CHANGED_EVENT } from '@/lib/presence';

const INTERVAL_MS = 60_000;

// Reports "online" and the running timers while the app is open (see src/lib/presence.ts).
export const usePresence = (userId: string) => {
  useEffect(() => {
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const beat = () => {
      void sendHeartbeat(userId);
    };
    const soon = () => {
      clearTimeout(debounce);
      debounce = setTimeout(beat, 1500);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') beat();
    };

    beat();
    const interval = setInterval(beat, INTERVAL_MS);
    window.addEventListener(TIMERS_CHANGED_EVENT, soon);
    window.addEventListener('online', beat);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(interval);
      clearTimeout(debounce);
      window.removeEventListener(TIMERS_CHANGED_EVENT, soon);
      window.removeEventListener('online', beat);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [userId]);
};

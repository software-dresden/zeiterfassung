import { getDB } from '@/lib/db';
import { supabase } from '@/lib/supabase';

// "Who is signed in and what is running": the app reports once a minute (and when a timer
// changes). Best effort only: offline or on error nothing happens and nothing is queued, the
// next report simply replaces it. Timers themselves stay local; only customer, type, state and
// elapsed seconds are reported, no notes.

export const TIMERS_CHANGED_EVENT = 'zeiterfassung:timers-changed';

const DEVICE_KEY = 'zeiterfassung-device-id';

// A random id per browser install, so two devices of one user do not overwrite each other.
export const getDeviceId = (): string => {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return 'session-' + Math.random().toString(36).slice(2, 12);
  }
};

export interface ReportedTimer {
  customer_id: string;
  session_type_id: string;
  status: 'running' | 'paused';
  /** Elapsed seconds at the moment of the report (the admin adds the time since then). */
  elapsed_seconds: number;
}

const readTimers = async (): Promise<ReportedTimer[]> => {
  const db = await getDB();
  const now = Date.now();
  const timers: ReportedTimer[] = [];
  for (const t of await db.getAll('timer_state')) {
    if (t.status === 'stopped') continue;
    const running = t.status === 'running';
    const extra = running ? Math.max(0, Math.floor((now - new Date(t.started_at).getTime()) / 1000)) : 0;
    timers.push({
      customer_id: t.customer_id,
      session_type_id: t.session_type_id,
      status: t.status,
      elapsed_seconds: t.accumulated_seconds + extra,
    });
  }
  return timers.slice(0, 20);
};

export const sendHeartbeat = async (userId: string): Promise<void> => {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;
  try {
    await supabase.from('user_presence').upsert({
      user_id: userId,
      device_id: getDeviceId(),
      last_seen_at: new Date().toISOString(),
      timers: await readTimers(),
    });
  } catch {
    // presence is optional
  }
};

// On sign-out: this device is no longer "online".
export const clearPresence = async (): Promise<void> => {
  try {
    await supabase.from('user_presence').delete().eq('device_id', getDeviceId());
  } catch {
    // ignore
  }
};

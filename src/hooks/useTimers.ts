'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getDB } from '@/lib/db';
import { MaterialItem, TimeEntry, TimerState } from '@/types';

// Optional on-site extras entered on the finish card (no prices).
export interface SessionExtras {
  materials?: MaterialItem[];
  travel_km?: number | null;
}
import { useTimeEntries } from './useTimeEntries';
import { TIMERS_CHANGED_EVENT } from '@/lib/presence';

const localDateString = (d: Date): string => {
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const computeElapsedSeconds = (state: TimerState, now: number): number => {
  if (state.status !== 'running') return state.accumulated_seconds;
  const started = new Date(state.started_at).getTime();
  return state.accumulated_seconds + Math.max(0, Math.floor((now - started) / 1000));
};

const sortTimers = (timers: TimerState[]): TimerState[] =>
  [...timers].sort((a, b) =>
    (a.created_at ?? a.started_at).localeCompare(b.created_at ?? b.started_at)
  );

export interface TimerView extends TimerState {
  elapsedSeconds: number;
}

export const useTimers = () => {
  const [timers, setTimers] = useState<TimerState[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const timersRef = useRef<TimerState[]>([]);
  const { addEntry } = useTimeEntries();

  const commit = useCallback((next: TimerState[]) => {
    timersRef.current = next;
    setTimers(next);
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(TIMERS_CHANGED_EVENT));
  }, []);

  useEffect(() => {
    const load = async () => {
      const db = await getDB();
      commit(sortTimers(await db.getAll('timer_state')));
    };
    load();
  }, [commit]);

  const anyRunning = timers.some((t) => t.status === 'running');

  // One shared tick for all timers; elapsed time is derived from the clock, so
  // a throttled background tab catches up as soon as it ticks again.
  useEffect(() => {
    if (!anyRunning) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [anyRunning]);

  const persist = useCallback(
    async (state: TimerState) => {
      const db = await getDB();
      await db.put('timer_state', state);
      const others = timersRef.current.filter((t) => t.key !== state.key);
      commit(sortTimers([...others, state]));
    },
    [commit]
  );

  const remove = useCallback(
    async (key: string) => {
      const db = await getDB();
      await db.delete('timer_state', key);
      commit(timersRef.current.filter((t) => t.key !== key));
    },
    [commit]
  );

  const startTimer = useCallback(
    async (customer_id: string, session_type_id: string) => {
      const stamp = new Date().toISOString();
      await persist({
        key: crypto.randomUUID(),
        customer_id,
        session_type_id,
        started_at: stamp,
        created_at: stamp,
        status: 'running',
        accumulated_seconds: 0,
      });
    },
    [persist]
  );

  const pauseTimer = useCallback(
    async (key: string) => {
      const timer = timersRef.current.find((t) => t.key === key);
      if (!timer || timer.status !== 'running') return;
      await persist({
        ...timer,
        status: 'paused',
        accumulated_seconds: computeElapsedSeconds(timer, Date.now()),
      });
    },
    [persist]
  );

  const resumeTimer = useCallback(
    async (key: string) => {
      const timer = timersRef.current.find((t) => t.key === key);
      if (!timer || timer.status !== 'paused') return;
      await persist({ ...timer, status: 'running', started_at: new Date().toISOString() });
    },
    [persist]
  );

  // Freezes the timer at its rounded minutes. The stopped state is persisted,
  // so a reload before saving no longer turns it back into a running timer.
  const stopTimer = useCallback(
    async (key: string): Promise<number> => {
      const timer = timersRef.current.find((t) => t.key === key);
      if (!timer) return 0;
      if (timer.status === 'stopped') return timer.frozen_minutes ?? 0;
      const totalSeconds = computeElapsedSeconds(timer, Date.now());
      const duration = Math.max(1, Math.round(totalSeconds / 60));
      await persist({
        ...timer,
        status: 'stopped',
        accumulated_seconds: totalSeconds,
        frozen_minutes: duration,
      });
      return duration;
    },
    [persist]
  );

  const saveSession = useCallback(
    // Returns the saved entry so the caller can continue with it (signatures).
    async (
      key: string,
      duration_minutes: number,
      notes: string,
      extras: SessionExtras = {}
    ): Promise<TimeEntry | null> => {
      const timer = timersRef.current.find((t) => t.key === key);
      if (!timer) return null;
      const entry = await addEntry({
        customer_id: timer.customer_id,
        session_type_id: timer.session_type_id,
        duration_minutes,
        notes: notes || null,
        entry_date: localDateString(new Date()),
        started_at: timer.created_at ?? timer.started_at,
        ended_at: new Date().toISOString(),
        materials: extras.materials,
        travel_km: extras.travel_km,
      });
      await remove(key);
      return entry;
    },
    [addEntry, remove]
  );

  const discardSession = useCallback((key: string) => remove(key), [remove]);

  const views = useMemo<TimerView[]>(
    () => timers.map((t) => ({ ...t, elapsedSeconds: computeElapsedSeconds(t, now) })),
    [timers, now]
  );

  return {
    timers: views,
    startTimer,
    pauseTimer,
    resumeTimer,
    stopTimer,
    saveSession,
    discardSession,
  };
};

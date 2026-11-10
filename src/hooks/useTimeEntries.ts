'use client';

import { useCallback, useEffect, useState } from 'react';
import { getDB } from '@/lib/db';
import { writeWithSync, DATA_CHANGED_EVENT } from '@/lib/sync';
import { MaterialItem, TimeEntry } from '@/types';

const localDateString = (d: Date): string => {
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
};

export const useTimeEntries = () => {
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const db = await getDB();
    const all = await db.getAll('time_entries');
    all.sort((a, b) => b.entry_date.localeCompare(a.entry_date) || b.created_at.localeCompare(a.created_at));
    setEntries(all);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
    window.addEventListener(DATA_CHANGED_EVENT, reload);
    return () => window.removeEventListener(DATA_CHANGED_EVENT, reload);
  }, [reload]);

  const addEntry = useCallback(
    async (data: {
      customer_id: string;
      session_type_id: string;
      duration_minutes: number;
      notes: string | null;
      entry_date: string;
      end_date?: string | null;
      started_at?: string | null;
      ended_at?: string | null;
      materials?: MaterialItem[];
      travel_km?: number | null;
    }) => {
      const now = new Date().toISOString();
      const entry: TimeEntry = {
        id: crypto.randomUUID(),
        customer_id: data.customer_id,
        session_type_id: data.session_type_id,
        duration_minutes: data.duration_minutes,
        notes: data.notes,
        entry_date: data.entry_date,
        ...(data.end_date ? { end_date: data.end_date } : {}),
        started_at: data.started_at ?? null,
        ended_at: data.ended_at ?? null,
        created_at: now,
        updated_at: now,
        materials: data.materials ?? [],
        travel_km: data.travel_km ?? null,
      };
      await writeWithSync('time_entries', 'insert', entry as unknown as Record<string, unknown>);
      await reload();
      return entry;
    },
    [reload]
  );

  const updateEntry = useCallback(
    async (id: string, changes: Partial<Omit<TimeEntry, 'id' | 'created_at'>>) => {
      const db = await getDB();
      const existing = await db.get('time_entries', id);
      if (!existing) return;
      const updated: TimeEntry = {
        ...existing,
        ...changes,
        updated_at: new Date().toISOString(),
      };
      await writeWithSync(
        'time_entries',
        'update',
        updated as unknown as Record<string, unknown>
      );
      await reload();
    },
    [reload]
  );

  const deleteEntry = useCallback(
    async (id: string) => {
      await writeWithSync('time_entries', 'delete', { id });
      await reload();
    },
    [reload]
  );

  const getEntriesForMonth = useCallback(
    (year: number, month: number) => {
      const prefix = `${year}-${(month + 1).toString().padStart(2, '0')}`;
      return entries.filter((e) => e.entry_date.startsWith(prefix));
    },
    [entries]
  );

  const getEntriesToday = useCallback(() => {
    const today = localDateString(new Date());
    return entries.filter((e) => e.entry_date === today);
  }, [entries]);

  return {
    entries,
    loading,
    addEntry,
    updateEntry,
    deleteEntry,
    getEntriesForMonth,
    getEntriesToday,
  };
};

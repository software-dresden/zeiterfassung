'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { TimerWidget } from '@/components/timer/TimerWidget';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { BriefcaseIcon, MailIcon } from '@/components/nav/icons';
import { IconButton } from '@/components/ui/IconButton';
import { useToast } from '@/components/ui/Toast';
import { EntryForm, EntryFormValues } from '@/components/entry/EntryForm';
import { useCustomers } from '@/hooks/useCustomers';
import { useSessionTypes } from '@/hooks/useSessionTypes';
import { useTimeEntries } from '@/hooks/useTimeEntries';
import { formatAE, minutesToHHMM, minutesToAE } from '@/lib/ae';
import { sendSessionByMail } from '@/lib/mail';
import { materialAndTravelLines } from '@/lib/materials';
import { TimeEntry } from '@/types';

const formatEUR = (value: number): string =>
  value.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });

export default function DashboardPage() {
  const { customers } = useCustomers();
  const { sessionTypes } = useSessionTypes();
  const { entries, getEntriesToday, updateEntry, deleteEntry } = useTimeEntries();
  const { showToast } = useToast();

  const [editingEntry, setEditingEntry] = useState<TimeEntry | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const todaysEntries = getEntriesToday();
  const totalTodayMinutes = todaysEntries.reduce((sum, e) => sum + e.duration_minutes, 0);

  const monthEntries = useMemo(() => {
    const now = new Date();
    return entries.filter((e) => {
      const d = new Date(e.entry_date);
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    });
  }, [entries]);

  const monthByCustomer = useMemo(() => {
    const map = new Map<string, { count: number; minutes: number }>();
    for (const e of monthEntries) {
      const existing = map.get(e.customer_id) ?? { count: 0, minutes: 0 };
      existing.count += 1;
      existing.minutes += e.duration_minutes;
      map.set(e.customer_id, existing);
    }
    return map;
  }, [monthEntries]);

  const monthTotals = useMemo(() => {
    const totalMinutes = monthEntries.reduce((sum, e) => sum + e.duration_minutes, 0);
    const totalValue = monthEntries.reduce((sum, e) => {
      const customer = customers.find((c) => c.id === e.customer_id);
      return sum + minutesToAE(e.duration_minutes) * (customer?.ae_rate ?? 0);
    }, 0);
    return { totalMinutes, totalValue, count: monthEntries.length };
  }, [monthEntries, customers]);

  const customerName = (id: string) => customers.find((c) => c.id === id)?.name ?? '—';
  const sessionTypeLabel = (id: string) => sessionTypes.find((s) => s.id === id)?.label ?? '—';

  const sendByMail = async (entry: TimeEntry) => {
    const outcome = await sendSessionByMail(
      entry,
      customerName(entry.customer_id),
      sessionTypeLabel(entry.session_type_id)
    );
    if (outcome === 'opened-mail-app') {
      showToast('TXT-Datei heruntergeladen – bitte an die E-Mail anhängen.', 'success');
    }
  };

  const handleUpdate = async (values: EntryFormValues) => {
    if (!editingEntry) return;
    await updateEntry(editingEntry.id, values);
    setEditingEntry(null);
    showToast('Eintrag aktualisiert', 'success');
  };

  const handleDelete = async (id: string) => {
    await deleteEntry(id);
    setConfirmDeleteId(null);
    showToast('Eintrag gelöscht', 'success');
  };

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-muted">
            Ihre Arbeit, erfasst
          </p>
          <h1 className="text-3xl font-bold tracking-tight text-text">Zeit gut erfasst.</h1>
        </div>
        <Link href="/new-entry">
          <Button variant="secondary" size="sm">
            + Manuell erfassen
          </Button>
        </Link>
      </div>

      <TimerWidget />

      <div className="rounded-3xl border border-border bg-surface p-6">
        <p className="mb-4 text-sm font-semibold text-text-muted">Dieser Monat</p>
        <div className="grid grid-cols-2 gap-6">
          <div>
            <p className="text-3xl font-bold text-text">
              {minutesToAE(monthTotals.totalMinutes).toFixed(1)}
              <span className="ml-1 text-lg font-semibold text-text-muted">AE</span>
            </p>
            <p className="mt-1 text-xs text-text-muted">
              {minutesToHHMM(monthTotals.totalMinutes)} · {monthTotals.count} Sessionen
            </p>
          </div>
          <div>
            <p className="text-3xl font-bold text-text">{formatEUR(monthTotals.totalValue)}</p>
            <p className="mt-1 text-xs text-text-muted">Basierend auf Kunden-AE-Sätzen</p>
          </div>
        </div>
        <div className="my-4 border-t border-border" />
        <Link
          href="/report"
          className="flex items-center justify-between text-sm font-semibold text-accent hover:underline"
        >
          Reports öffnen
          <span aria-hidden>→</span>
        </Link>
      </div>

      {monthByCustomer.size > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold text-text-muted">Nach Kunde</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
            {Array.from(monthByCustomer.entries()).map(([customerId, stats]) => (
              <div
                key={customerId}
                className="flex min-h-[84px] flex-col justify-center rounded-2xl border border-border bg-surface p-4"
              >
                <p className="truncate text-sm font-medium text-text" title={customerName(customerId)}>
                  {customerName(customerId)}
                </p>
                <p className="text-xs text-text-muted">{stats.count} Sessionen</p>
                <p className="mt-1 text-sm font-bold text-text">
                  {minutesToAE(stats.minutes).toFixed(1)} AE
                </p>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-lg font-bold text-text">Heutige Sessions</h2>
          <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-semibold text-text-muted">
            {todaysEntries.length}
          </span>
        </div>
        {todaysEntries.length === 0 ? (
          <EmptyState
            icon={<BriefcaseIcon className="h-5 w-5" />}
            title="Noch nichts erfasst"
            description="Starten Sie den Timer oder erfassen Sie Arbeit manuell. Ihre Sessions erscheinen hier."
          />
        ) : (
          <div className="overflow-hidden rounded-3xl border border-border">
            {todaysEntries.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center justify-between gap-3 border-b border-border bg-surface px-4 py-3 last:border-b-0 hover:bg-surface-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-text" title={`${customerName(entry.customer_id)} · ${sessionTypeLabel(entry.session_type_id)}`}>
                    {customerName(entry.customer_id)} · {sessionTypeLabel(entry.session_type_id)}
                  </p>
                  {entry.notes && (
                    <p className="truncate text-xs text-text-muted" title={entry.notes}>
                      {entry.notes.slice(0, 60)}
                    </p>
                  )}
                  {materialAndTravelLines(entry).map((line) => (
                    <p key={line} className="truncate text-xs text-text-muted" title={line}>
                      {line}
                    </p>
                  ))}
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm font-bold text-text">
                    {minutesToAE(entry.duration_minutes).toFixed(1)} AE
                  </p>
                  <p className="text-xs text-text-muted">
                    {minutesToHHMM(entry.duration_minutes)}
                  </p>
                </div>
                {confirmDeleteId === entry.id ? (
                  <div className="flex shrink-0 items-center gap-2 text-xs">
                    <span className="hidden text-text-muted sm:inline">Wirklich löschen?</span>
                    <Button size="sm" variant="danger" onClick={() => handleDelete(entry.id)}>
                      Ja
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setConfirmDeleteId(null)}>
                      Abbrechen
                    </Button>
                  </div>
                ) : (
                  <div className="flex shrink-0 items-center gap-2">
                    <IconButton
                      label="Per E-Mail senden"
                      onClick={() => sendByMail(entry)}
                    >
                      <MailIcon className="h-4 w-4" />
                    </IconButton>
                    <Button size="sm" variant="secondary" onClick={() => setEditingEntry(entry)}>
                      Bearbeiten
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => setConfirmDeleteId(entry.id)}>
                      Löschen
                    </Button>
                  </div>
                )}
              </div>
            ))}
            <div className="flex justify-end bg-surface-2 px-4 py-2 text-sm font-medium text-text">
              Gesamt heute: {formatAE(totalTodayMinutes)} ({minutesToHHMM(totalTodayMinutes)})
            </div>
          </div>
        )}
      </section>

      <Modal open={!!editingEntry} onClose={() => setEditingEntry(null)} title="Eintrag bearbeiten">
        {editingEntry && (
          <EntryForm
            initialValues={{
              customer_id: editingEntry.customer_id,
              session_type_id: editingEntry.session_type_id,
              entry_date: editingEntry.entry_date,
              end_date: editingEntry.end_date,
              duration_minutes: editingEntry.duration_minutes,
              notes: editingEntry.notes ?? '',
            }}
            onSubmit={handleUpdate}
            onCancel={() => setEditingEntry(null)}
            submitLabel="Speichern"
            allowRange
          />
        )}
      </Modal>
    </div>
  );
}

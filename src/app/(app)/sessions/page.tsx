'use client';

import { useMemo, useState } from 'react';
import { useCustomers } from '@/hooks/useCustomers';
import { useSessionTypes } from '@/hooks/useSessionTypes';
import { useTimeEntries } from '@/hooks/useTimeEntries';
import { useToast } from '@/components/ui/Toast';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { IconButton } from '@/components/ui/IconButton';
import { MonthYearPicker } from '@/components/ui/MonthYearPicker';
import { EmptyState } from '@/components/ui/EmptyState';
import { ListIcon, MailIcon } from '@/components/nav/icons';
import { formatEntryDate } from '@/lib/export';
import { EntryForm, EntryFormValues } from '@/components/entry/EntryForm';
import { minutesToAE, minutesToHHMM, formatAE } from '@/lib/ae';
import { sendSessionByMail } from '@/lib/mail';
import { materialAndTravelLines } from '@/lib/materials';
import { TimeEntry } from '@/types';

const PAGE_SIZE = 50;

const currentMonthValue = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}`;
};

export default function SessionsPage() {
  const { customers, activeCustomers } = useCustomers();
  const { sessionTypes } = useSessionTypes();
  const { entries, updateEntry, deleteEntry } = useTimeEntries();
  const { showToast } = useToast();

  const [customerFilter, setCustomerFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [monthFilter, setMonthFilter] = useState(currentMonthValue());
  const [page, setPage] = useState(1);
  const [editingEntry, setEditingEntry] = useState<TimeEntry | null>(null);
  const [expandedNotesId, setExpandedNotesId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TimeEntry | null>(null);

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

  const filtered = useMemo(() => {
    return entries.filter((e) => {
      if (customerFilter && e.customer_id !== customerFilter) return false;
      if (typeFilter && e.session_type_id !== typeFilter) return false;
      if (monthFilter && !e.entry_date.startsWith(monthFilter)) return false;
      return true;
    });
  }, [entries, customerFilter, typeFilter, monthFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageEntries = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const totalMinutes = filtered.reduce((sum, e) => sum + e.duration_minutes, 0);

  const handleUpdate = async (values: EntryFormValues) => {
    if (!editingEntry) return;
    await updateEntry(editingEntry.id, values);
    setEditingEntry(null);
    showToast('Eintrag aktualisiert', 'success');
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    await deleteEntry(deleteTarget.id);
    setDeleteTarget(null);
    showToast('Eintrag gelöscht', 'success');
  };

  return (
    <div>
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-muted">
        Ihre Sessions
      </p>
      <h1 className="mb-4 text-3xl font-bold tracking-tight text-text">Sessions</h1>

      <div className="sticky top-[calc(6.5rem+env(safe-area-inset-top))] z-10 mb-4 flex flex-wrap gap-3 bg-bg py-2">
        <Select
          value={customerFilter}
          onChange={(e) => {
            setCustomerFilter(e.target.value);
            setPage(1);
          }}
        >
          <option value="">Alle Kunden</option>
          {activeCustomers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select
          value={typeFilter}
          onChange={(e) => {
            setTypeFilter(e.target.value);
            setPage(1);
          }}
        >
          <option value="">Alle Typen</option>
          {sessionTypes.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </Select>
        <MonthYearPicker
          value={monthFilter}
          onChange={(value) => {
            setMonthFilter(value);
            setPage(1);
          }}
        />
      </div>

      {pageEntries.length === 0 ? (
        <EmptyState
          icon={<ListIcon className="h-5 w-5" />}
          title="Keine Einträge"
          description="Für den gewählten Zeitraum wurden noch keine Sessions erfasst."
        />
      ) : (
        <div className="overflow-x-auto rounded-3xl border border-border bg-surface">
          <table className="w-full min-w-[700px] text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-2 text-left text-text-muted">
                <th className="px-4 py-3 font-medium">Datum</th>
                <th className="px-4 py-3 font-medium">Kunde</th>
                <th className="px-4 py-3 font-medium">Typ</th>
                <th className="px-4 py-3 font-medium">Dauer</th>
                <th className="px-4 py-3 font-medium">Notizen</th>
                <th className="px-4 py-3 font-medium">Aktionen</th>
              </tr>
            </thead>
            <tbody>
              {pageEntries.map((entry) => (
                <tr key={entry.id} className="border-b border-border last:border-b-0 hover:bg-surface-2">
                  <td className="whitespace-nowrap px-3 py-2 text-text">
                    {formatEntryDate(entry)}
                  </td>
                  <td
                    className="max-w-[180px] truncate px-3 py-2 text-text"
                    title={customerName(entry.customer_id)}
                  >
                    {customerName(entry.customer_id)}
                  </td>
                  <td
                    className="max-w-[140px] truncate px-3 py-2 text-text"
                    title={sessionTypeLabel(entry.session_type_id)}
                  >
                    {sessionTypeLabel(entry.session_type_id)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <div className="font-semibold text-text">
                      {minutesToAE(entry.duration_minutes).toFixed(1)} AE
                    </div>
                    <div className="text-xs text-text-muted">
                      {minutesToHHMM(entry.duration_minutes)}
                    </div>
                  </td>
                  <td
                    className={[
                      'max-w-[220px] cursor-pointer px-3 py-2 text-text-muted',
                      expandedNotesId === entry.id ? '' : 'truncate',
                    ].join(' ')}
                    onClick={() =>
                      setExpandedNotesId(expandedNotesId === entry.id ? null : entry.id)
                    }
                  >
                    {entry.notes
                      ? expandedNotesId === entry.id
                        ? entry.notes
                        : entry.notes.length > 60
                        ? entry.notes.slice(0, 60) + '…'
                        : entry.notes
                      : '—'}
                    {materialAndTravelLines(entry).map((line) => (
                      <div
                        key={line}
                        className={expandedNotesId === entry.id ? 'text-xs' : 'truncate text-xs'}
                        title={line}
                      >
                        {line}
                      </div>
                    ))}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <div className="flex items-center gap-2">
                      <IconButton
                        label="Per E-Mail senden"
                        onClick={() => sendByMail(entry)}
                      >
                        <MailIcon className="h-4 w-4" />
                      </IconButton>
                      <Button size="sm" variant="secondary" onClick={() => setEditingEntry(entry)}>
                        Bearbeiten
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => setDeleteTarget(entry)}>
                        Löschen
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex justify-end bg-surface-2 px-4 py-2 text-sm text-text">
            Gesamt: {filtered.length} Einträge · {formatAE(totalMinutes)} ·{' '}
            {minutesToHHMM(totalMinutes)}
          </div>
        </div>
      )}

      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-center gap-3 text-sm text-text">
          <Button
            size="sm"
            variant="secondary"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Zurück
          </Button>
          <span>
            Seite {page} von {totalPages}
          </span>
          <Button
            size="sm"
            variant="secondary"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            Weiter
          </Button>
        </div>
      )}

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

      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Eintrag löschen">
        <p className="mb-4 text-sm text-text">Eintrag wirklich löschen?</p>
        <div className="flex gap-2">
          <Button variant="danger" onClick={confirmDelete}>
            Löschen
          </Button>
          <Button variant="secondary" onClick={() => setDeleteTarget(null)}>
            Abbrechen
          </Button>
        </div>
      </Modal>
    </div>
  );
}

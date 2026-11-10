'use client';

import { useMemo, useState } from 'react';
import { useCustomers } from '@/hooks/useCustomers';
import { useSessionTypes } from '@/hooks/useSessionTypes';
import { useTimeEntries } from '@/hooks/useTimeEntries';
import { useProfile } from '@/hooks/useProfile';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { MonthYearPicker } from '@/components/ui/MonthYearPicker';
import { ExportButtons } from '@/components/report/ExportButtons';
import { SessionExportButtons } from '@/components/report/SessionExportButtons';
import { ListIcon, PeopleIcon } from '@/components/nav/icons';
import { minutesToAE, minutesToHHMM } from '@/lib/ae';
import { formatEntryDate, formatEUR, safeFilePart } from '@/lib/export';
import { buildMonthlyRows } from '@/lib/reportRows';
import { formatKm, materialAndTravelLines, sumKm } from '@/lib/materials';
import { Customer, TimeEntry } from '@/types';

const currentMonthValue = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}`;
};

const NOTE_PREVIEW_LENGTH = 120;

const SignatureBadge = ({ entry }: { entry: TimeEntry }) => {
  if (entry.technician_signature && entry.customer_signature) {
    return <Badge variant="success">Unterschrieben</Badge>;
  }
  if (entry.technician_signature || entry.customer_signature) {
    return <Badge variant="warning">Teils unterschrieben</Badge>;
  }
  return null;
};

// Reports per customer: pick a customer, pick a month, then see every session of
// that customer in that month, each with its own export, plus an export of the
// whole customer-month.
export const CustomerReports = () => {
  const { customers } = useCustomers();
  const { sessionTypes } = useSessionTypes();
  const { getEntriesForMonth } = useTimeEntries();
  const { username, email } = useProfile();

  const [customerId, setCustomerId] = useState<string | null>(null);
  const [monthValue, setMonthValue] = useState(currentMonthValue());

  const customer: Customer | undefined = customers.find((c) => c.id === customerId);
  const sessionTypeLabel = (id: string) => sessionTypes.find((s) => s.id === id)?.label ?? '—';
  const technicianName = username ?? email ?? 'Techniker';

  const [yearStr, monthStr] = monthValue.split('-');
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10) - 1;

  // Newest first (the hook already sorts that way); only this customer's sessions.
  const entries = useMemo(
    () => (customer ? getEntriesForMonth(year, month).filter((e) => e.customer_id === customer.id) : []),
    [customer, getEntriesForMonth, year, month]
  );
  const rows = useMemo(() => buildMonthlyRows(entries, customers), [entries, customers]);
  const row = rows[0];

  if (!customer) {
    return customers.length === 0 ? (
      <EmptyState
        icon={<PeopleIcon className="h-5 w-5" />}
        title="Noch keine Kunden"
        description="Legen Sie in den Einstellungen einen Kunden an."
      />
    ) : (
      <div>
        <p className="mb-3 text-sm text-text-muted">Kunde wählen, um dessen Reports zu sehen.</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {customers.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setCustomerId(c.id)}
              className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-surface p-4 text-left transition-colors duration-150 ease-out hover:bg-surface-2"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-text" title={c.name}>
                  {c.name}
                </span>
                <span className="text-xs text-text-muted">
                  {c.ae_rate.toLocaleString('de-DE', { minimumFractionDigits: 2 })} €/AE
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {!c.active && <Badge>Inaktiv</Badge>}
                <span aria-hidden className="text-text-muted">→</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <Button size="sm" variant="secondary" onClick={() => setCustomerId(null)}>
            ← Alle Kunden
          </Button>
          <h2 className="mt-3 truncate text-2xl font-bold tracking-tight text-text" title={customer.name}>
            {customer.name}
          </h2>
        </div>
        <div>
          <label className="mb-1 block text-sm text-text-muted">Monat</label>
          <MonthYearPicker value={monthValue} onChange={setMonthValue} />
        </div>
      </div>

      {entries.length === 0 || !row ? (
        <EmptyState
          icon={<ListIcon className="h-5 w-5" />}
          title="Keine Sessions"
          description="Für diesen Kunden wurden im gewählten Monat keine Sessions erfasst."
        />
      ) : (
        <>
          <div className="rounded-3xl border border-border bg-surface p-6">
            <p className="mb-4 text-sm font-semibold text-text-muted">Alle Sessions des Monats</p>
            <div className="mb-5 grid grid-cols-2 gap-6">
              <div>
                <p className="text-3xl font-bold text-text">
                  {minutesToAE(row.total_minutes).toFixed(1)}
                  <span className="ml-1 text-lg font-semibold text-text-muted">AE</span>
                </p>
                <p className="mt-1 text-xs text-text-muted">
                  {minutesToHHMM(row.total_minutes)} · {row.entries.length} Sessionen
                </p>
                {sumKm(entries) > 0 && (
                  <p className="mt-0.5 text-xs text-text-muted">
                    Gefahrene Kilometer: {formatKm(sumKm(entries))}
                  </p>
                )}
              </div>
              <div>
                <p className="text-3xl font-bold text-text">{formatEUR(row.total_value)}</p>
                <p className="mt-1 text-xs text-text-muted">Basierend auf dem AE-Satz des Kunden</p>
              </div>
            </div>
            <ExportButtons
              rows={rows}
              year={year}
              month={month}
              sessionTypeLabel={sessionTypeLabel}
              fileBaseName={`Abrechnung_${safeFilePart(customer.name)}_${year}-${(month + 1)
                .toString()
                .padStart(2, '0')}`}
            />
          </div>

          <section>
            <h3 className="mb-3 text-lg font-bold text-text">Einzelne Reports</h3>
            <div className="overflow-hidden rounded-3xl border border-border bg-surface">
              {entries.map((entry) => (
                <div
                  key={entry.id}
                  className="flex flex-col gap-3 border-b border-border px-4 py-3.5 last:border-b-0 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold text-text">
                        {formatEntryDate(entry)} · {sessionTypeLabel(entry.session_type_id)}
                      </p>
                      <SignatureBadge entry={entry} />
                    </div>
                    <p className="mt-0.5 text-sm text-text">
                      <span className="font-bold">{minutesToAE(entry.duration_minutes).toFixed(1)} AE</span>{' '}
                      <span className="text-xs text-text-muted">{minutesToHHMM(entry.duration_minutes)}</span>
                    </p>
                    {entry.notes && (
                      <p className="mt-1 break-words text-xs text-text-muted" title={entry.notes}>
                        {entry.notes.length > NOTE_PREVIEW_LENGTH
                          ? `${entry.notes.slice(0, NOTE_PREVIEW_LENGTH)}…`
                          : entry.notes}
                      </p>
                    )}
                    {materialAndTravelLines(entry).map((line) => (
                      <p key={line} className="mt-0.5 break-words text-xs text-text-muted">
                        {line}
                      </p>
                    ))}
                  </div>
                  <SessionExportButtons
                    entry={entry}
                    customer={customer}
                    sessionTypeLabel={sessionTypeLabel(entry.session_type_id)}
                    technicianName={technicianName}
                  />
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
};

'use client';

import { useState } from 'react';
import { MonthlyReportRow } from '@/types';
import { minutesToAE, minutesToHHMM } from '@/lib/ae';
import { formatEntryDate } from '@/lib/export';

const formatEUR = (value: number): string =>
  value.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });

interface ReportTableProps {
  rows: MonthlyReportRow[];
  sessionTypeLabel: (id: string) => string;
}

export const ReportTable = ({ rows, sessionTypeLabel }: ReportTableProps) => {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (customerId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(customerId)) next.delete(customerId);
      else next.add(customerId);
      return next;
    });
  };

  const totalSessions = rows.reduce((sum, r) => sum + r.entries.length, 0);
  const totalMinutes = rows.reduce((sum, r) => sum + r.total_minutes, 0);
  const totalValue = rows.reduce((sum, r) => sum + r.total_value, 0);

  return (
    <div className="flex flex-col gap-6">
      <div className="overflow-x-auto rounded-3xl border border-border bg-surface">
        <table className="w-full min-w-[600px] text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-2 text-left text-text-muted">
              <th className="px-3 py-2 font-medium">Kunde</th>
              <th className="px-3 py-2 font-medium">Sessionen</th>
              <th className="px-3 py-2 font-medium">AE gesamt</th>
              <th className="px-3 py-2 font-medium">Stunden</th>
              <th className="px-3 py-2 font-medium">Satz (€/AE)</th>
              <th className="px-3 py-2 font-medium">Gesamt (€)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.customer.id} className="border-b border-border last:border-b-0 hover:bg-surface-2">
                <td className="max-w-[220px] truncate px-3 py-2 text-text" title={row.customer.name}>
                  {row.customer.name}
                </td>
                <td className="px-3 py-2 text-text">{row.entries.length}</td>
                <td className="px-3 py-2 font-semibold text-text">{row.total_ae.toFixed(1)}</td>
                <td className="px-3 py-2 text-text-muted">{minutesToHHMM(row.total_minutes)}</td>
                <td className="px-3 py-2 text-text-muted">{formatEUR(row.customer.ae_rate)}</td>
                <td className="px-3 py-2 font-semibold text-text">{formatEUR(row.total_value)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-surface-2 font-semibold text-text">
              <td className="px-3 py-2">Summe</td>
              <td className="px-3 py-2">{totalSessions}</td>
              <td className="px-3 py-2">{minutesToAE(totalMinutes).toFixed(1)}</td>
              <td className="px-3 py-2">{minutesToHHMM(totalMinutes)}</td>
              <td className="px-3 py-2">—</td>
              <td className="px-3 py-2">{formatEUR(totalValue)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="flex flex-col gap-2">
        {rows.map((row) => {
          const isOpen = expanded.has(row.customer.id);
          return (
            <div key={row.customer.id} className="rounded-2xl border border-border bg-surface overflow-hidden">
              <button
                onClick={() => toggle(row.customer.id)}
                className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm text-text hover:bg-surface-2"
              >
                <span className="min-w-0 truncate" title={row.customer.name}>
                  {row.customer.name}
                </span>
                <span className="shrink-0 font-semibold">{row.total_ae.toFixed(1)} AE</span>
              </button>
              {isOpen && (
                <div className="overflow-x-auto border-t border-border">
                  <table className="w-full min-w-[500px] text-sm">
                    <thead>
                      <tr className="border-b border-border bg-surface-2 text-left text-text-muted">
                        <th className="px-3 py-2 font-medium">Datum</th>
                        <th className="px-3 py-2 font-medium">Typ</th>
                        <th className="px-3 py-2 font-medium">AE</th>
                        <th className="px-3 py-2 font-medium">hh:mm</th>
                        <th className="px-3 py-2 font-medium">Notizen</th>
                      </tr>
                    </thead>
                    <tbody>
                      {row.entries.map((entry) => (
                        <tr key={entry.id} className="border-b border-border last:border-b-0">
                          <td className="whitespace-nowrap px-3 py-2 text-text">
                            {formatEntryDate(entry)}
                          </td>
                          <td
                            className="max-w-[140px] truncate px-3 py-2 text-text"
                            title={sessionTypeLabel(entry.session_type_id)}
                          >
                            {sessionTypeLabel(entry.session_type_id)}
                          </td>
                          <td className="px-3 py-2 text-text">
                            {minutesToAE(entry.duration_minutes).toFixed(1)}
                          </td>
                          <td className="px-3 py-2 text-text-muted">
                            {minutesToHHMM(entry.duration_minutes)}
                          </td>
                          <td
                            className="max-w-[240px] truncate px-3 py-2 text-text-muted"
                            title={entry.notes ?? undefined}
                          >
                            {entry.notes ?? '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

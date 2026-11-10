import { MonthlyReportRow, TimeEntry } from '@/types';
import { minutesToAE, minutesToHHMM } from '@/lib/ae';
import { GERMAN_MONTHS } from '@/lib/germanMonths';
import { notesToPlain } from '@/lib/notes';
import {
  formatKm,
  formatMaterialLine,
  hasMaterials,
  hasTravel,
  materialAndTravelLines,
  sumKm,
} from '@/lib/materials';

export const formatEUR = (value: number): string =>
  value.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });

export const formatDateDDMMYYYY = (isoDate: string): string => {
  const [y, m, d] = isoDate.split('-');
  return `${d}.${m}.${y}`;
};

/** "14.01.2027", or "01.01.2027 – 10.01.2027" when the entry spans several days. */
export const formatEntryDate = (entry: { entry_date: string; end_date?: string | null }): string =>
  entry.end_date && entry.end_date > entry.entry_date
    ? `${formatDateDDMMYYYY(entry.entry_date)} – ${formatDateDDMMYYYY(entry.end_date)}`
    : formatDateDDMMYYYY(entry.entry_date);

const formatAEComma = (minutes: number): string => minutesToAE(minutes).toFixed(1).replace('.', ',');

// Keeps a customer name usable as part of a file name.
export const safeFilePart = (value: string): string =>
  value.replace(/[^A-Za-z0-9äöüÄÖÜß._-]+/g, '_').replace(/^_+|_+$/g, '') || 'Kunde';

// Base name (without extension) of a single-session export. The start time keeps
// two sessions of the same customer on the same day from sharing a file name.
export const sessionFileBaseName = (entry: TimeEntry, customerName: string): string => {
  const started = new Date(entry.started_at ?? entry.created_at);
  const time = Number.isNaN(started.getTime())
    ? ''
    : `_${started.getHours().toString().padStart(2, '0')}${started.getMinutes().toString().padStart(2, '0')}`;
  return `Session_${safeFilePart(customerName)}_${entry.entry_date}${time}`;
};

// Notes are tidied up (uniform bullets, no stray blank lines) but never rewritten, and
// they never leave the app for translation.
export const noteText = (notes: string | null): string => notesToPlain(notes);

// Semicolon-separated (German Excel standard). A single session is just a report
// with one row and one entry, so all CSV exports share this builder.
export const buildReportCsv = (
  rows: MonthlyReportRow[],
  sessionTypeLabel: (id: string) => string,
  noteFor: (notes: string | null) => string
): string => {
  // Fahrt_km and Material are appended at the end, so anything reading the first
  // eight columns keeps working.
  const lines: string[] = ['Datum;Kunde;Typ;AE;Minuten;Notizen;Satz_EUR_pro_AE;Wert_EUR;Fahrt_km;Material'];

  for (const row of rows) {
    for (const entry of row.entries) {
      const ae = minutesToAE(entry.duration_minutes);
      const value = ae * row.customer.ae_rate;
      const notes = noteFor(entry.notes).replace(/;/g, ',').replace(/\r?\n/g, ' ');
      const km = hasTravel(entry) ? (entry.travel_km as number).toFixed(1).replace('.', ',') : '';
      const material = (entry.materials ?? [])
        .map(formatMaterialLine)
        .join(' | ')
        .replace(/;/g, ',')
        .replace(/\r?\n/g, ' ');
      lines.push(
        [
          formatEntryDate(entry),
          row.customer.name,
          sessionTypeLabel(entry.session_type_id),
          ae.toFixed(1).replace('.', ','),
          entry.duration_minutes.toString(),
          notes,
          row.customer.ae_rate.toFixed(2).replace('.', ','),
          value.toFixed(2).replace('.', ','),
          km,
          material,
        ].join(';')
      );
    }
  }

  return lines.join('\r\n');
};

const RULE_WIDTH = 64;
const HEAVY_RULE = '='.repeat(RULE_WIDTH);
const LIGHT_RULE = '-'.repeat(RULE_WIDTH);

// Plain-text version of the monthly report: same numbers as the PDF and CSV
// (AE with one decimal, German separators), readable in any editor or mail body.
export const buildReportTxt = (
  rows: MonthlyReportRow[],
  year: number,
  month: number,
  sessionTypeLabel: (id: string) => string,
  noteFor: (notes: string | null) => string,
  createdAt: Date = new Date()
): string => {
  const totalMinutes = rows.reduce((sum, r) => sum + r.total_minutes, 0);
  const totalValue = rows.reduce((sum, r) => sum + r.total_value, 0);
  const totalSessions = rows.reduce((sum, r) => sum + r.entries.length, 0);

  const lines: string[] = [
    'ZEITERFASSUNG',
    `Abrechnung ${GERMAN_MONTHS[month]} ${year}`,
    `Erstellt am ${createdAt.toLocaleDateString('de-DE')}`,
    '',
    `AE gesamt:   ${formatAEComma(totalMinutes)}`,
    `Stunden:     ${minutesToHHMM(totalMinutes)}`,
    `Sessionen:   ${totalSessions}`,
    `Gesamtwert:  ${formatEUR(totalValue)}`,
  ];
  const totalKm = sumKm(rows.flatMap((r) => r.entries));
  if (totalKm > 0) lines.push(`Kilometer:   ${formatKm(totalKm)}`);

  for (const row of rows) {
    lines.push(
      '',
      HEAVY_RULE,
      row.customer.name,
      `Satz: ${formatEUR(row.customer.ae_rate)} pro AE`,
      LIGHT_RULE
    );

    for (const entry of row.entries) {
      const note = noteFor(entry.notes).replace(/\s*\r?\n\s*/g, ' ').trim();
      const parts = [
        formatEntryDate(entry),
        sessionTypeLabel(entry.session_type_id),
        `${formatAEComma(entry.duration_minutes)} AE`,
        minutesToHHMM(entry.duration_minutes),
      ];
      if (note) parts.push(note);
      lines.push(parts.join(' | '));
      for (const extra of materialAndTravelLines(entry)) lines.push(`    ${extra}`);
    }

    lines.push(
      LIGHT_RULE,
      `Summe ${row.customer.name}: ${formatAEComma(row.total_minutes)} AE | ${minutesToHHMM(
        row.total_minutes
      )} | ${formatEUR(row.total_value)}`
    );
    if (sumKm(row.entries) > 0) lines.push(`Gefahrene Kilometer: ${formatKm(sumKm(row.entries))}`);
  }

  lines.push('', HEAVY_RULE, `GESAMT: ${formatAEComma(totalMinutes)} AE | ${minutesToHHMM(totalMinutes)} | ${formatEUR(totalValue)}`);

  return lines.join('\r\n') + '\r\n';
};

// Plain-text version of a single session with the complete, untouched notes
// (original line breaks kept). Attached to the "per E-Mail senden" mail.
export const buildSessionTxt = (
  entry: TimeEntry,
  customerName: string,
  sessionTypeLabel: string,
  technicianName?: string
): string => {
  const lines = [
    'ZEITERFASSUNG',
    '',
    `Kunde: ${customerName}`,
    `Datum: ${formatEntryDate(entry)}`,
    `Typ: ${sessionTypeLabel}`,
    `Dauer: ${formatAEComma(entry.duration_minutes)} AE (${minutesToHHMM(entry.duration_minutes)})`,
  ];
  if (technicianName) lines.push(`Techniker: ${technicianName}`);
  if (hasTravel(entry)) lines.push(`Fahrt: ${formatKm(entry.travel_km as number)}`);
  if (hasMaterials(entry)) {
    lines.push('', 'Material:', ...(entry.materials ?? []).map((item) => `- ${formatMaterialLine(item)}`));
  }
  const notes = entry.notes?.trim();
  if (notes) lines.push('', 'Notizen:', notes.replace(/\r?\n/g, '\r\n'));
  return lines.join('\r\n') + '\r\n';
};

// File object for the Web Share API. Plain 'text/plain' (no charset parameter)
// because canShare() only accepts bare MIME types; the BOM carries the encoding.
export const createTextFile = (content: string, filename: string): File =>
  new File(['﻿' + content], filename, { type: 'text/plain' });

export const downloadBlob = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

// Starts a browser download of a text file; the BOM makes Excel and Notepad
// read it as UTF-8 (umlauts).
export const downloadTextFile = (content: string, filename: string, mimeType: string): void => {
  const blob = new Blob(['﻿' + content], { type: `${mimeType};charset=utf-8;` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

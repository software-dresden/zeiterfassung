import { Customer, MonthlyReportRow, ReportTemplateKind, TimeEntry } from '@/types';
import { minutesToAE, minutesToHHMM } from '@/lib/ae';
import { GERMAN_MONTHS } from '@/lib/germanMonths';
import { formatEntryDate } from '@/lib/export';
import { formatKm, formatMaterialLine, hasMaterials, hasTravel, sumKm } from '@/lib/materials';
import { notesToPlain, notesToTemplateLines } from '@/lib/notes';

// Everything a Word template can read. All values are ready-formatted strings (German
// style, like the PDFs), so a template only places them. TEMPLATE_ROOTS is the
// complete list of top-level field names; the template validator rejects any
// other name, so keep it in sync with the builders below (the sample data used for
// the upload dry-run is built by the same functions).
//
// NO PRICES: a Word export is a Technikerbericht, not a bill, so no price, rate or
// amount of money is ever put into this data. Because the validator only accepts
// the names below, even a custom template cannot print one. (The portal and the
// standard PDF/CSV exports do show prices; they never go through here.)
export const TEMPLATE_ROOTS: Record<ReportTemplateKind, readonly string[]> = {
  monthly: [
    'nummer',
    'zeitraum',
    'monat',
    'jahr',
    'erstellt_am',
    'techniker',
    'ae_gesamt',
    'stunden_gesamt',
    'km_gesamt',
    'sessionen_gesamt',
    'kunden',
    'kunde',
  ],
  session: [
    'nummer',
    'kunde',
    'kunde_adresse',
    'datum',
    'beginn',
    'ende',
    'typ',
    'dauer_ae',
    'dauer_stunden',
    'fahrt',
    'hat_fahrt',
    'material',
    'hat_material',
    'materialien',
    'techniker',
    'notizen',
    'notizen_zeilen',
    'unterschrieben_am',
    'status_techniker',
    'status_kunde',
    'hat_signatur_techniker',
    'hat_signatur_kunde',
    'signatur_techniker',
    'signatur_kunde',
  ],
};

const formatClock = (iso: string | null): string =>
  iso
    ? new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
    : '';

const formatAE = (minutes: number): string => minutesToAE(minutes).toFixed(1);

// The app has no running invoice counter, so a report number is derived from the
// period (and the customer / start time), like TB-2026-10-IFG or TB-20261028-1757.
const customerCode = (name: string): string =>
  name.normalize('NFD').replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase() || 'KND';

const sessionNumber = (entry: TimeEntry): string => {
  const started = new Date(entry.started_at ?? entry.created_at);
  const time = Number.isNaN(started.getTime())
    ? '0000'
    : `${started.getHours().toString().padStart(2, '0')}${started.getMinutes().toString().padStart(2, '0')}`;
  return `TB-${entry.entry_date.replace(/-/g, '')}-${time}`;
};

// --- images -----------------------------------------------------------------

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const adler32 = (bytes: Uint8Array): number => {
  let a = 1;
  let b = 0;
  for (const x of bytes) {
    a = (a + x) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
};

const u32 = (value: number): number[] => [
  (value >>> 24) & 255,
  (value >>> 16) & 255,
  (value >>> 8) & 255,
  value & 255,
];

const pngChunk = (type: string, data: number[]): number[] => {
  const typeAndData = new Uint8Array([...Array.from(type).map((ch) => ch.charCodeAt(0)), ...data]);
  return [...u32(data.length), ...typeAndData, ...u32(crc32(typeAndData))];
};

// A valid 1x1 fully transparent PNG, built by hand so it works in the browser and
// in Node alike. Used where a party has not signed, so {IMAGE ...} never fails.
const transparentPngBase64 = (): string => {
  const raw = [0, 0, 0, 0, 0]; // filter byte + one RGBA pixel
  const deflate = [0x78, 0x01, 0x01, raw.length, 0x00, ~raw.length & 255, 0xff, ...raw, ...u32(adler32(new Uint8Array(raw)))];
  const png = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...pngChunk('IHDR', [...u32(1), ...u32(1), 8, 6, 0, 0, 0]),
    ...pngChunk('IDAT', deflate),
    ...pngChunk('IEND', []),
  ];
  return btoa(String.fromCharCode(...png));
};

const PLACEHOLDER_PNG = transparentPngBase64();

// 3:1 like the signature pad. width/height are in cm (docx-templates convention).
const signatureImage = (dataUrl: string | null | undefined) => ({
  width: 6,
  height: 2,
  data: dataUrl ? dataUrl.replace(/^data:image\/png;base64,/, '') : PLACEHOLDER_PNG,
  extension: '.png',
});

// --- monthly report ---------------------------------------------------------

export interface MonthlyTemplateInput {
  rows: MonthlyReportRow[];
  year: number;
  month: number;
  sessionTypeLabel: (id: string) => string;
  noteFor: (notes: string | null) => string;
  technicianName: string;
  createdAt?: Date;
}

// Used by "Alle Arbeit" and by the per-customer month export. `kunden` is the list
// grouped by customer; `kunde` is the single customer, or for several customers an
// aggregate "Alle Kunden" whose `sessions` lists everything (each session carries
// its `kunde`), so one template can serve both exports.
export const buildMonthlyTemplateData = (input: MonthlyTemplateInput) => {
  const { rows, year, month, sessionTypeLabel, noteFor, technicianName } = input;

  const kunden = rows.map((row) => ({
    name: row.customer.name,
    adresse: row.customer.address ?? '',
    sessionen: String(row.entries.length),
    ae: formatAE(row.total_minutes),
    stunden: minutesToHHMM(row.total_minutes),
    km: formatKm(sumKm(row.entries)),
    // `pos` restarts at 1 for every customer, like the position numbers on an invoice.
    sessions: row.entries.map((e, index) => ({
      pos: String(index + 1),
      datum: formatEntryDate(e),
      kunde: row.customer.name,
      typ: sessionTypeLabel(e.session_type_id),
      ae: formatAE(e.duration_minutes),
      stunden: minutesToHHMM(e.duration_minutes),
      beginn: formatClock(e.started_at),
      ende: formatClock(e.ended_at),
      notizen: noteFor(e.notes),
      // The same notes as one entry per paragraph (headings, text, bullets, sub-points).
      notizen_zeilen: notesToTemplateLines(e.notes),
      // One material per line (the engine turns line breaks into Word line breaks).
      material: (e.materials ?? []).map(formatMaterialLine).join('\n'),
      fahrt: hasTravel(e) ? formatKm(e.travel_km as number) : '',
    })),
  }));

  const allEntries = rows.flatMap((r) => r.entries);
  const totalMinutes = rows.reduce((sum, r) => sum + r.total_minutes, 0);
  const totalSessions = allEntries.length;

  const kunde =
    kunden.length === 1
      ? kunden[0]
      : {
          name: 'Alle Kunden',
          adresse: '',
          sessionen: String(totalSessions),
          ae: formatAE(totalMinutes),
          stunden: minutesToHHMM(totalMinutes),
          km: formatKm(sumKm(allEntries)),
          sessions: kunden.flatMap((k) => k.sessions).map((s, index) => ({ ...s, pos: String(index + 1) })),
        };

  const monthNumber = (month + 1).toString().padStart(2, '0');

  return {
    nummer:
      rows.length === 1
        ? `TB-${year}-${monthNumber}-${customerCode(rows[0].customer.name)}`
        : `TB-${year}-${monthNumber}`,
    zeitraum: `${GERMAN_MONTHS[month]} ${year}`,
    monat: GERMAN_MONTHS[month],
    jahr: String(year),
    erstellt_am: (input.createdAt ?? new Date()).toLocaleDateString('de-DE'),
    techniker: technicianName,
    ae_gesamt: formatAE(totalMinutes),
    stunden_gesamt: minutesToHHMM(totalMinutes),
    km_gesamt: formatKm(sumKm(allEntries)),
    sessionen_gesamt: String(totalSessions),
    kunden,
    kunde,
  };
};

// --- single session ---------------------------------------------------------

export interface SessionTemplateInput {
  entry: TimeEntry;
  customer: Customer;
  sessionTypeLabel: string;
  technicianName: string;
  noteText: string;
}

export const buildSessionTemplateData = (input: SessionTemplateInput) => {
  const { entry, customer, sessionTypeLabel, technicianName, noteText } = input;
  const signedAt = entry.signed_at ? new Date(entry.signed_at).toLocaleDateString('de-DE') : '';
  const status = (hasSignature: boolean) =>
    hasSignature ? `Unterschrieben${signedAt ? ` am ${signedAt}` : ''}` : 'Nicht unterschrieben';

  return {
    nummer: sessionNumber(entry),
    kunde: customer.name,
    kunde_adresse: customer.address ?? '',
    datum: formatEntryDate(entry),
    beginn: formatClock(entry.started_at),
    ende: formatClock(entry.ended_at),
    typ: sessionTypeLabel,
    dauer_ae: formatAE(entry.duration_minutes),
    dauer_stunden: minutesToHHMM(entry.duration_minutes),
    fahrt: hasTravel(entry) ? formatKm(entry.travel_km as number) : '',
    hat_fahrt: hasTravel(entry),
    // `material` is one text with a material per line; `materialien` is the list for a table loop.
    material: (entry.materials ?? []).map(formatMaterialLine).join('\n'),
    hat_material: hasMaterials(entry),
    materialien: (entry.materials ?? []).map((item) => ({ name: item.name, menge: item.menge })),
    techniker: technicianName,
    notizen: noteText,
    notizen_zeilen: notesToTemplateLines(entry.notes),
    unterschrieben_am: signedAt,
    status_techniker: status(!!entry.technician_signature),
    status_kunde: status(!!entry.customer_signature),
    hat_signatur_techniker: !!entry.technician_signature,
    hat_signatur_kunde: !!entry.customer_signature,
    signatur_techniker: signatureImage(entry.technician_signature),
    signatur_kunde: signatureImage(entry.customer_signature),
  };
};

// --- sample data (upload dry-run, sample templates) ---------------------------

const sampleCustomer = (name: string, rate: number): Customer => ({
  id: name,
  name,
  address: 'Musterstraße 1\n01234 Musterstadt',
  ae_rate: rate,
  active: true,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
});

const sampleEntry = (day: string, minutes: number, notes: string): TimeEntry => ({
  id: `${day}-${minutes}`,
  customer_id: 'c',
  session_type_id: 't',
  duration_minutes: minutes,
  notes,
  entry_date: day,
  started_at: `${day}T08:00:00.000Z`,
  ended_at: `${day}T09:00:00.000Z`,
  created_at: `${day}T08:00:00.000Z`,
  updated_at: `${day}T09:00:00.000Z`,
  technician_signature: `data:image/png;base64,${PLACEHOLDER_PNG}`,
  customer_signature: `data:image/png;base64,${PLACEHOLDER_PNG}`,
  signed_at: `${day}T09:05:00.000Z`,
  materials: [
    { name: 'Netzwerkkabel Cat6', menge: '2 Stück' },
    { name: 'HDMI-Kabel', menge: '1' },
  ],
  travel_km: 12.5,
});

const sampleRow = (customer: Customer, entries: TimeEntry[]): MonthlyReportRow => {
  const total_minutes = entries.reduce((sum, e) => sum + e.duration_minutes, 0);
  const total_ae = minutesToAE(total_minutes);
  return { customer, entries, total_minutes, total_ae, total_value: total_ae * customer.ae_rate };
};

// Complete data (no empty fields), so the upload dry-run can fail on a misspelled field.
export const sampleTemplateData = (kind: ReportTemplateKind): Record<string, unknown> => {
  const label = () => 'Beratung';
  const noteFor = notesToPlain;
  const sampleNotes = '1. Server migriert:\n- Backup geprüft\n* Zugänge eingerichtet\n  – Passwörter neu vergeben\nAbschluss mit dem Kunden besprochen.';

  if (kind === 'monthly') {
    const a = sampleCustomer('Beispiel GmbH', 80);
    const b = sampleCustomer('Muster AG', 65);
    return buildMonthlyTemplateData({
      rows: [
        sampleRow(a, [sampleEntry('2026-10-05', 45, 'Beratung vor Ort'), sampleEntry('2026-10-12', 90, sampleNotes)]),
        sampleRow(b, [sampleEntry('2026-10-08', 30, 'Fernwartung')]),
      ],
      year: 2026,
      month: 9,
      sessionTypeLabel: label,
      noteFor,
      technicianName: 'Max Mustermann',
      createdAt: new Date(2026, 9, 31),
    });
  }

  return buildSessionTemplateData({
    entry: sampleEntry('2026-10-05', 45, sampleNotes),
    customer: sampleCustomer('Beispiel GmbH', 80),
    sessionTypeLabel: 'Beratung',
    technicianName: 'Max Mustermann',
    noteText: notesToPlain(sampleNotes),
  });
};

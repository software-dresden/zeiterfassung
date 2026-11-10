import { TimeEntry } from '@/types';
import { minutesToAE, minutesToHHMM } from '@/lib/ae';
import { materialAndTravelLines } from '@/lib/materials';
import {
  buildSessionTxt,
  createTextFile,
  downloadTextFile,
  formatEntryDate,
  safeFilePart,
} from '@/lib/export';

// Mail clients and browsers cap mailto: URLs (roughly 2000 characters in
// practice, e.g. classic Outlook). Notes that do not fit are never dropped
// silently: the body says so and points to the TXT file, which always holds
// the complete text.
const MAX_MAILTO_LENGTH = 1800;

export interface SessionMail {
  subject: string;
  /** Header lines (Kunde, Datum, Typ, Dauer) without the notes. */
  details: string[];
  /** Complete notes, or null if the session has none. */
  notes: string | null;
  /** Complete mail body: details plus all notes. */
  body: string;
  fileName: string;
  /** Complete session as text, attached to the mail. */
  fileContent: string;
}

export const buildSessionMail = (
  entry: TimeEntry,
  customerName: string,
  sessionTypeLabel: string
): SessionMail => {
  const date = formatEntryDate(entry);
  const duration = `${minutesToAE(entry.duration_minutes).toFixed(1).replace('.', ',')} AE (${minutesToHHMM(
    entry.duration_minutes
  )})`;
  const details = [
    `Kunde: ${customerName}`,
    `Datum: ${date}`,
    `Typ: ${sessionTypeLabel}`,
    `Dauer: ${duration}`,
    ...materialAndTravelLines(entry),
  ];
  const notes = entry.notes?.trim() || null;

  return {
    subject: `Zeiterfassung: ${customerName} – ${date}`,
    details,
    notes,
    body: [...details, ...(notes ? ['', 'Notizen:', notes] : [])].join('\r\n'),
    fileName: `Session_${safeFilePart(customerName)}_${entry.entry_date}.txt`,
    fileContent: buildSessionTxt(entry, customerName, sessionTypeLabel),
  };
};

// mailto: link without a recipient. encodeURIComponent (not URLSearchParams) so
// spaces become %20, not '+'. Uses the complete notes whenever the link stays
// within the length cap; otherwise shortens them and says so in the body.
export const buildSessionMailto = (mail: SessionMail, maxLength = MAX_MAILTO_LENGTH): string => {
  const make = (notes: string | null, truncated: boolean): string => {
    const lines = [...mail.details];
    if (notes) lines.push('', 'Notizen:', notes);
    if (truncated) {
      lines.push('', `(Notizen gekürzt – der vollständige Text steht in der Datei ${mail.fileName})`);
    }
    return `mailto:?subject=${encodeURIComponent(mail.subject)}&body=${encodeURIComponent(lines.join('\r\n'))}`;
  };

  let url = make(mail.notes, false);
  const fullNotes = mail.notes;
  if (!fullNotes || url.length <= maxLength) return url;

  let keep = fullNotes.length;
  while (keep > 0 && url.length > maxLength) {
    keep = Math.max(0, Math.floor(keep * 0.9) - 1);
    url = make(keep > 0 ? fullNotes.slice(0, keep).trimEnd() + '…' : null, true);
  }
  return url;
};

export type MailOutcome =
  /** Share sheet used; the TXT file is attached by the chosen mail app. */
  | 'shared'
  /** Share sheet dismissed by the user. */
  | 'cancelled'
  /** Mail app opened and TXT downloaded; the file still has to be attached by hand. */
  | 'opened-mail-app';

// Phones and tablets: the share sheet is the only way to hand a file to a mail
// app. Desktops: the user asked for the default mail app, so use mailto instead.
const prefersShareSheet = (file: File): boolean =>
  typeof navigator !== 'undefined' &&
  typeof navigator.canShare === 'function' &&
  typeof navigator.share === 'function' &&
  window.matchMedia('(pointer: coarse)').matches &&
  navigator.canShare({ files: [file] });

// Must be called straight from a click handler: the share sheet needs the click
// to still count as a user gesture, so nothing may be awaited before navigator.share.
export const sendSessionByMail = async (
  entry: TimeEntry,
  customerName: string,
  sessionTypeLabel: string
): Promise<MailOutcome> => {
  const mail = buildSessionMail(entry, customerName, sessionTypeLabel);
  const file = createTextFile(mail.fileContent, mail.fileName);

  if (prefersShareSheet(file)) {
    try {
      await navigator.share({ files: [file], title: mail.subject, text: mail.body });
      return 'shared';
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
      // Share sheet unavailable after all: fall back to download + mailto.
    }
  }

  downloadTextFile(mail.fileContent, mail.fileName, 'text/plain');
  window.location.href = buildSessionMailto(mail);
  return 'opened-mail-app';
};

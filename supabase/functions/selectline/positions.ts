// Turns one time entry into the positions it becomes in a SelectLine Auftrag. Pure functions,
// no I/O: the same code runs in the edge function (Deno) and in the local tests (Node).
//
// Every entry yields one "time" position (the article the technician picked). Material with an
// article number and kilometers (when a KM article is configured) become positions of their own;
// everything else is written into the position text so nothing gets lost. No prices: SelectLine
// takes them from its own article data.

export class TransferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransferError';
  }
}

export interface EntryMaterial {
  name: string;
  menge?: string;
  /** SelectLine article number, when the material was picked from the article list. */
  artikel?: string | null;
}

export interface EntryForTransfer {
  id: string;
  entry_date: string; // YYYY-MM-DD
  end_date?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  duration_minutes: number;
  notes?: string | null;
  materials?: EntryMaterial[] | null;
  travel_km?: number | string | null;
  sl_article_number?: string | null;
  signed_by_technician?: boolean;
  signed_by_customer?: boolean;
  signed_at?: string | null;
}

export interface ArticleInfo {
  unit: string | null;
}

export interface PositionContext {
  employeeNumber: string;
  articles: Map<string, ArticleInfo>;
  kmArticleNumber?: string | null;
}

/** Body of POST /Documents/{key}/ArticleItem and PUT /Documents/{key}/Positions/{id}. */
export interface PositionPayload {
  ArticleNumber: string;
  CalculatedQuantityValue: number;
  QuantityUnit?: string;
  Memo: string;
  EmployeeNumber: string;
  DeliveryDate: string;
}

const pad = (n: number) => n.toString().padStart(2, '0');

export const formatDate = (iso: string): string => {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
};

const berlinTime = (iso: string): string =>
  new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));

const formatDuration = (minutes: number): string => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} Std. ${pad(m)} Min.` : `${m} Min.`;
};

const formatNumber = (n: number): string => n.toLocaleString('de-DE', { maximumFractionDigits: 2 });

const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;

/**
 * Quantity of a time position in the unit of its article. Unknown units are refused instead of
 * guessed: a wrong unit would bill a wrong amount.
 */
export const quantityForMinutes = (minutes: number, unit: string | null): number => {
  const u = (unit ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (['std', 'h', 'stunde', 'stunden', 'stde', 'stdn'].includes(u)) return round(minutes / 60, 2);
  if (['min', 'minute', 'minuten'].includes(u)) return minutes;
  if (['ae', 'arbeitseinheit', 'arbeitseinheiten'].includes(u)) return round(minutes / 10, 1);
  throw new TransferError(
    `Die Mengeneinheit „${unit ?? ''}“ des Zeit-Artikels ist nicht bekannt (erlaubt: Std, Min, AE).`,
  );
};

/** "2", "2,5", "3 Stück" -> number; anything else -> null. */
export const parseMenge = (menge?: string | null): number | null => {
  const m = (menge ?? '').trim().match(/^(\d+(?:[.,]\d+)?)/);
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
};

const toNumber = (v: number | string | null | undefined): number => {
  const n = typeof v === 'string' ? Number(v) : (v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const article = (ctx: PositionContext, number: string, what: string): ArticleInfo => {
  const info = ctx.articles.get(number);
  if (!info) throw new TransferError(`${what}: Artikel ${number} ist in SelectLine nicht (mehr) vorhanden.`);
  return info;
};

/** Position text of the time position: date, time, duration, notes and everything not booked separately. */
export const buildTimeMemo = (entry: EntryForTransfer, ctx: PositionContext): string => {
  const lines: string[] = [];
  const range =
    entry.end_date && entry.end_date > entry.entry_date
      ? `${formatDate(entry.entry_date)} – ${formatDate(entry.end_date)}`
      : formatDate(entry.entry_date);
  lines.push(`Datum: ${range}`);
  if (entry.started_at && entry.ended_at) {
    lines.push(`Zeit: ${berlinTime(entry.started_at)} – ${berlinTime(entry.ended_at)} Uhr`);
  }
  lines.push(`Dauer: ${formatDuration(entry.duration_minutes)}`);

  const notes = (entry.notes ?? '').replace(/\r\n?/g, '\n').trim();
  if (notes) lines.push('', notes);

  const freeMaterial = (entry.materials ?? []).filter((m) => !m.artikel && m.name?.trim());
  if (freeMaterial.length > 0) {
    lines.push('', 'Material:');
    for (const m of freeMaterial) {
      lines.push(`- ${m.name.trim()}${m.menge?.trim() ? ` (${m.menge.trim()})` : ''}`);
    }
  }

  const km = toNumber(entry.travel_km);
  if (km > 0 && !ctx.kmArticleNumber) lines.push('', `Fahrt: ${formatNumber(km)} km`);

  const signers = [
    entry.signed_by_technician ? 'Techniker' : null,
    entry.signed_by_customer ? 'Kunde' : null,
  ].filter(Boolean);
  if (signers.length > 0) {
    const when = entry.signed_at ? ` am ${formatDate(entry.signed_at)}` : '';
    lines.push('', `Unterschrieben${when} (${signers.join(', ')}), liegt in der Zeiterfassung vor.`);
  }
  return lines.join('\n');
};

/**
 * All positions of an entry, keyed by a stable part name ("time", "km", "material:<index>"), so
 * an edit later updates the same SelectLine position.
 */
export const buildParts = (
  entry: EntryForTransfer,
  ctx: PositionContext,
): Record<string, PositionPayload> => {
  if (!entry.sl_article_number) throw new TransferError('Kein Artikel für die Arbeitszeit gewählt.');
  if (!ctx.employeeNumber) {
    throw new TransferError('Für diesen Benutzer ist keine SelectLine-Mitarbeiternummer hinterlegt.');
  }
  if (!(entry.duration_minutes > 0)) throw new TransferError('Die Session hat keine Dauer.');

  const base = { EmployeeNumber: ctx.employeeNumber, DeliveryDate: entry.entry_date };
  const parts: Record<string, PositionPayload> = {};

  const timeArticle = article(ctx, entry.sl_article_number, 'Arbeitszeit');
  parts.time = {
    ...base,
    ArticleNumber: entry.sl_article_number,
    CalculatedQuantityValue: quantityForMinutes(entry.duration_minutes, timeArticle.unit),
    ...(timeArticle.unit ? { QuantityUnit: timeArticle.unit } : {}),
    Memo: buildTimeMemo(entry, ctx),
  };

  (entry.materials ?? []).forEach((m, i) => {
    if (!m.artikel) return;
    const info = article(ctx, m.artikel, 'Material');
    const qty = parseMenge(m.menge);
    parts[`material:${i}`] = {
      ...base,
      ArticleNumber: m.artikel,
      CalculatedQuantityValue: qty ?? 1,
      ...(info.unit ? { QuantityUnit: info.unit } : {}),
      Memo: [`Material zur Session vom ${formatDate(entry.entry_date)}`, qty === null && m.menge ? `Menge: ${m.menge}` : '']
        .filter(Boolean)
        .join('\n'),
    };
  });

  const km = toNumber(entry.travel_km);
  if (km > 0 && ctx.kmArticleNumber) {
    const info = article(ctx, ctx.kmArticleNumber, 'Fahrt');
    parts.km = {
      ...base,
      ArticleNumber: ctx.kmArticleNumber,
      CalculatedQuantityValue: round(km, 1),
      ...(info.unit ? { QuantityUnit: info.unit } : {}),
      Memo: `Fahrt zur Session vom ${formatDate(entry.entry_date)}`,
    };
  }
  return parts;
};

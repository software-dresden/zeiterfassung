// Small client for the SelectLine API (SL.mobile REST API, "…/slmobileApi"). Only the calls the
// Zeiterfassung needs. Runtime-neutral (fetch only): used by the edge function and the tests.
//
// Field names follow the API help of SelectLine (demo.slmobile.de/demoApi/Help, Nov. 2026).
// To verify against the Swagger of our own installation (marked "VERIFY"):
//  - format of a documentKey (assumed: KindFlag + Number, e.g. "F250001")
//  - where the customer number sits in BusinessPartner of a read document
//  - the Authorization header (assumed: "<TokenType> <AccessToken>" from /Login)

export interface SlConfig {
  /** e.g. https://selectline.example.de/slmobileApi (no trailing slash needed). */
  baseUrl: string;
  username: string;
  password: string;
  appKey: string;
  /** Extra headers on every request, e.g. the Cloudflare Access service token. */
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
}

export class SlError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'SlError';
  }
}

export interface SlCustomer {
  Number: string;
  IsInactive?: boolean;
  Company?: string | null;
  FirstName?: string | null;
  LastName?: string | null;
  Address?: {
    Street?: string | null;
    ZipCode?: string | null;
    City?: string | null;
    CountryId?: string | null;
    AdditionalInformation1?: string | null;
  } | null;
}

export interface SlArticle {
  Number: string;
  Name?: string | null;
  QuantityUnit?: string | null;
  IsEffortArticle?: boolean;
  IsWarehouseArtikel?: boolean;
  IsInactive?: boolean;
}

export interface SlEmployee {
  Number: string;
  Name?: string | null;
  FirstName?: string | null;
  LastName?: string | null;
}

export interface SlDocument {
  DocumentKey?: string;
  Number: string;
  KindFlag: string;
  Date?: string | null;
  StatusFlag?: number | null;
  HeaderText?: string | null;
  BusinessPartner?: Record<string, unknown> | null;
}

/** StatusFlag 2 = erledigt, 3 = manuell erledigt, 4 = storniert. Everything else counts as open. */
export const isOpenDocument = (doc: SlDocument): boolean => ![2, 3, 4].includes(Number(doc.StatusFlag ?? 0));

// VERIFY: key format of our installation.
export const documentKeyOf = (doc: SlDocument): string => doc.DocumentKey ?? `${doc.KindFlag}${doc.Number}`;

// VERIFY: field name of the customer number in a read document.
export const partnerNumberOf = (doc: SlDocument): string | null => {
  const bp = doc.BusinessPartner ?? {};
  for (const k of ['BusinessPartnerReferenceNumber', 'Number', 'CustomerNumber', 'ReferenceNumber']) {
    const v = bp[k];
    if (typeof v === 'string' && v) return v;
  }
  return null;
};

const PAGE_SIZE = 500;
const MAX_PAGES = 200;

const describe = (status: number, text: string): string => {
  let msg = '';
  try {
    const body = JSON.parse(text);
    msg = String(body?.Message ?? body?.message ?? body?.error ?? body?.title ?? '');
  } catch {
    msg = text;
  }
  msg = msg.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (status === 401) return 'SelectLine: Anmeldung abgelehnt (Benutzer, Passwort oder AppKey prüfen).';
  if (status === 403) return `SelectLine: keine Berechtigung${msg ? ` (${msg})` : ''}.`;
  if (status === 404) return `SelectLine: nicht gefunden${msg ? ` (${msg})` : ''}.`;
  return `SelectLine-Fehler ${status}${msg ? `: ${msg}` : ''}`;
};

export class SelectLineClient {
  private auth: string | null = null;

  constructor(private readonly cfg: SlConfig) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    const url = new URL(this.cfg.baseUrl.replace(/\/+$/, '') + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = { Accept: 'application/json', ...(this.cfg.extraHeaders ?? {}) };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.auth) headers.Authorization = this.auth;

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 20_000),
        // Never follow redirects: a redirect (e.g. to a login page) must not receive our token.
        redirect: 'manual',
      });
    } catch {
      throw new SlError('SelectLine ist nicht erreichbar (Server, Tunnel oder Zeitüberschreitung).', 0);
    }
    if (res.status >= 300 && res.status < 400) {
      throw new SlError('SelectLine: unerwartete Weiterleitung (Tunnel-Zugang prüfen).', res.status);
    }
    const text = await res.text();
    if (!res.ok) throw new SlError(describe(res.status, text), res.status);
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new SlError('SelectLine: unerwartete Antwort.', res.status);
    }
  }

  async login(): Promise<void> {
    const res = await this.request<{ AccessToken?: string; TokenType?: string }>('POST', '/Login', {
      UserName: this.cfg.username,
      Password: this.cfg.password,
      AppKey: this.cfg.appKey,
    });
    if (!res?.AccessToken) throw new SlError('SelectLine: Anmeldung ohne Token.', 500);
    // VERIFY: header format.
    this.auth = `${res.TokenType || 'LoginId'} ${res.AccessToken}`;
  }

  /** Logged-in API users occupy a licence until they log out, so always log out. */
  async logout(): Promise<void> {
    if (!this.auth) return;
    try {
      await this.request('POST', '/Logout');
    } catch {
      // the token expires on its own
    } finally {
      this.auth = null;
    }
  }

  async session<T>(fn: (client: SelectLineClient) => Promise<T>): Promise<T> {
    await this.login();
    try {
      return await fn(this);
    } finally {
      await this.logout();
    }
  }

  private async all<T>(path: string, query: Record<string, string | number | boolean>): Promise<T[]> {
    const rows: T[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const batch = await this.request<T[]>('GET', path, undefined, { ...query, Page: page, Items: PAGE_SIZE });
      if (!Array.isArray(batch)) throw new SlError('SelectLine: unerwartete Antwort (keine Liste).', 500);
      rows.push(...batch);
      if (batch.length < PAGE_SIZE) return rows;
    }
    throw new SlError('SelectLine: zu viele Datensätze.', 500);
  }

  listCustomers(): Promise<SlCustomer[]> {
    return this.all<SlCustomer>('/Customers', { IncludeInactive: true });
  }

  listArticles(): Promise<SlArticle[]> {
    return this.all<SlArticle>('/Articles', { IncludeInactiveArticles: false });
  }

  listEmployees(): Promise<SlEmployee[]> {
    return this.all<SlEmployee>('/Employees', {});
  }

  /** Open Aufträge (KindFlag F) of one customer, newest first. */
  async listOpenOrders(customerNumber: string): Promise<SlDocument[]> {
    const docs = await this.request<SlDocument[]>('GET', '/Documents', undefined, {
      SelectDocumentKindFlag: 'F',
      SelectBusinessPartnerNumber: customerNumber,
      OrderBy: 'Date!',
      Page: 0,
      Items: 100,
    });
    if (!Array.isArray(docs)) throw new SlError('SelectLine: unerwartete Antwort (keine Liste).', 500);
    // Double-check what the filter returned: only Aufträge of exactly this customer.
    return docs.filter(
      (d) => d.KindFlag === 'F' && isOpenDocument(d) && (partnerNumberOf(d) ?? customerNumber) === customerNumber,
    );
  }

  getDocument(key: string): Promise<SlDocument> {
    return this.request<SlDocument>('GET', `/Documents/${encodeURIComponent(key)}`);
  }

  async createOrder(input: {
    customerNumber: string;
    employeeNumber: string;
    date: string;
    headerText: string;
  }): Promise<{ key: string; number: string }> {
    const res = await this.request<{ DocumentKey?: string; DocumentNumber?: string }>('POST', '/Documents', {
      KindFlag: 'F',
      Date: input.date,
      BusinessPartner: { BusinessPartnerReferenceNumber: input.customerNumber },
      EmployeeNumber: input.employeeNumber,
      HeaderText: input.headerText,
    });
    if (!res?.DocumentNumber) throw new SlError('SelectLine: Auftrag ohne Nummer angelegt.', 500);
    return { key: res.DocumentKey ?? `F${res.DocumentNumber}`, number: res.DocumentNumber };
  }

  async addArticlePosition(key: string, payload: object): Promise<string> {
    const res = await this.request<{ PositionIdentifier?: string | number }>(
      'POST',
      `/Documents/${encodeURIComponent(key)}/ArticleItem`,
      payload,
    );
    if (res?.PositionIdentifier === undefined || res.PositionIdentifier === null) {
      throw new SlError('SelectLine: Position ohne Kennung angelegt.', 500);
    }
    return String(res.PositionIdentifier);
  }

  async updatePosition(key: string, positionId: string, payload: object): Promise<void> {
    await this.request(
      'PUT',
      `/Documents/${encodeURIComponent(key)}/Positions/${encodeURIComponent(positionId)}`,
      payload,
    );
  }
}

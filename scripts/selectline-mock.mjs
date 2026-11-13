// Fake SelectLine API for local tests (node scripts/test-selectline.mjs). Implements only the
// routes the Zeiterfassung uses, with the field names from the SelectLine API help. In memory.
import http from 'node:http';
import { randomUUID } from 'node:crypto';

export const startMock = async ({ appKey = 'APPKEY', user = 'API', password = 'secret' } = {}) => {
  const state = {
    tokens: new Set(),
    logins: 0,
    logouts: 0,
    customers: [],
    articles: [],
    employees: [],
    documents: new Map(), // key -> {Number, KindFlag, StatusFlag, Date, BusinessPartner, positions: Map}
    nextOrder: 250001,
    failNext: null, // e.g. 'ArticleItem' -> next such call returns 500
    requests: [],
  };

  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : undefined;
    const url = new URL(req.url, 'http://x');
    const path = url.pathname.replace(/^\/slmobileApi/, '');
    const q = url.searchParams;
    state.requests.push({ method: req.method, path, headers: req.headers, body });

    if (path === '/redirect') {
      res.writeHead(302, { Location: 'http://evil.example/' });
      return res.end();
    }

    if (req.method === 'POST' && path === '/Login') {
      if (body?.UserName !== user || body?.Password !== password || body?.AppKey !== appKey) {
        return send(res, 401, { Message: 'Anmeldung fehlgeschlagen' });
      }
      const token = randomUUID();
      state.tokens.add(token);
      state.logins++;
      return send(res, 200, { AccessToken: token, TokenType: 'LoginId' });
    }

    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('LoginId ') ? auth.slice(8) : '';
    if (!state.tokens.has(token)) return send(res, 401, { Message: 'Nicht angemeldet' });

    if (req.method === 'POST' && path === '/Logout') {
      state.tokens.delete(token);
      state.logouts++;
      return send(res, 204);
    }

    const page = (rows) => {
      const p = Number(q.get('Page') ?? 0);
      const n = Number(q.get('Items') ?? 10);
      return n === 0 ? rows : rows.slice(p * n, p * n + n);
    };
    if (req.method === 'GET' && path === '/Customers') {
      const rows = q.get('IncludeInactive') === 'true' ? state.customers : state.customers.filter((c) => !c.IsInactive);
      return send(res, 200, page(rows));
    }
    if (req.method === 'GET' && path === '/Articles') return send(res, 200, page(state.articles));
    if (req.method === 'GET' && path === '/Employees') return send(res, 200, page(state.employees));

    const view = (key, d) => ({
      Number: d.Number,
      KindFlag: d.KindFlag,
      StatusFlag: d.StatusFlag,
      Date: d.Date,
      HeaderText: d.HeaderText,
      BusinessPartner: d.BusinessPartner,
      EmployeeNumber: d.EmployeeNumber,
    });

    if (req.method === 'GET' && path === '/Documents') {
      const kind = q.get('SelectDocumentKindFlag');
      const partner = q.get('SelectBusinessPartnerNumber');
      const rows = [...state.documents.entries()]
        .filter(([, d]) => (!kind || d.KindFlag === kind) && (!partner || d.BusinessPartner.BusinessPartnerReferenceNumber === partner))
        .map(([k, d]) => view(k, d));
      return send(res, 200, page(rows));
    }
    if (req.method === 'POST' && path === '/Documents') {
      const number = String(state.nextOrder++);
      const key = `${body.KindFlag}${number}`;
      state.documents.set(key, {
        Number: number,
        KindFlag: body.KindFlag,
        StatusFlag: 0,
        Date: body.Date,
        HeaderText: body.HeaderText,
        EmployeeNumber: body.EmployeeNumber,
        BusinessPartner: { BusinessPartnerReferenceNumber: body.BusinessPartner?.BusinessPartnerReferenceNumber },
        positions: new Map(),
      });
      return send(res, 201, { DocumentKey: key, DocumentKind: body.KindFlag, DocumentNumber: number });
    }
    let m = path.match(/^\/Documents\/([^/]+)$/);
    if (req.method === 'GET' && m) {
      const key = decodeURIComponent(m[1]);
      const d = state.documents.get(key);
      return d ? send(res, 200, view(key, d)) : send(res, 404, { Message: 'Beleg nicht gefunden' });
    }
    m = path.match(/^\/Documents\/([^/]+)\/ArticleItem$/);
    if (req.method === 'POST' && m) {
      if (state.failNext === 'ArticleItem') {
        state.failNext = null;
        return send(res, 500, { Message: 'Simulierter Fehler' });
      }
      const d = state.documents.get(decodeURIComponent(m[1]));
      if (!d) return send(res, 404, { Message: 'Beleg nicht gefunden' });
      if (!state.articles.some((a) => a.Number === body.ArticleNumber)) return send(res, 400, { Message: 'Artikel unbekannt' });
      const id = String(d.positions.size + 1);
      d.positions.set(id, { ...body });
      return send(res, 201, { DocumentKey: m[1], PositionIdentifier: id });
    }
    m = path.match(/^\/Documents\/([^/]+)\/Positions\/([^/]+)$/);
    if (req.method === 'PUT' && m) {
      const d = state.documents.get(decodeURIComponent(m[1]));
      const id = decodeURIComponent(m[2]);
      if (!d || !d.positions.has(id)) return send(res, 404, { Message: 'Position nicht gefunden' });
      d.positions.set(id, { ...d.positions.get(id), ...body });
      return send(res, 204);
    }
    return send(res, 404, { Message: `Route ${req.method} ${path} gibt es im Mock nicht` });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    state,
    baseUrl: `http://127.0.0.1:${port}/slmobileApi`,
    close: () => new Promise((r) => server.close(r)),
  };
};

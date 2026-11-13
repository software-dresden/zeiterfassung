import { createClient } from 'jsr:@supabase/supabase-js@2';
import { SelectLineClient, SlError, documentKeyOf, type SlConfig, type SlCustomer } from './client.ts';
import { TransferError, type ArticleInfo, type EntryMaterial } from './positions.ts';
import { runTransfer, type TransferState } from './transfer.ts';

// SelectLine connection. Runs with the service-role key and the SelectLine credentials, which
// never reach the browser. Every request is authenticated with the caller's JWT (aal2 required),
// every action checks who may do it, everything that touches SelectLine is written to the audit log.
//
// Actions:
//   transfer   {entry_id}     user: send/update own session (admin: any session = retry)
//   openOrders {customer_id}  user: open Aufträge of a SelectLine customer (for the picker)
//   overview                  admin: settings, transfers, employees, audit log
//   settings   {enabled?, km_article_number?}   admin: kill switch and KM article
//   setEmployee {user_id, employee_number}      admin: link app user -> SelectLine Mitarbeiter
//   import                    admin: customers, articles, employees from SelectLine
//   test                      admin: login/logout once
//
// Secrets (Supabase -> Edge Functions -> Secrets, entered by the owner, never in code or chat):
//   SL_BASE_URL (https only), SL_USERNAME, SL_PASSWORD, SL_APPKEY,
//   CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET (Cloudflare Access service token, optional)

const REQUIRE_AAL2 = Deno.env.get('REQUIRE_AAL2') !== 'false';
const RATE_LIMIT_PER_10_MIN = 60;
const LOCK_SECONDS = 90;
const AUDIT_MONTHS = 12;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
const fail = (error: string, status = 400): Response => json({ error }, status);

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SL_NUMBER = /^[A-Za-z0-9._\-/ ]{1,40}$/;

const aalOf = (authHeader: string): string | null => {
  try {
    const token = authHeader.replace(/^Bearer\s+/i, '');
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.aal === 'string' ? payload.aal : null;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------- configuration

const slConfig = (): SlConfig | null => {
  const baseUrl = Deno.env.get('SL_BASE_URL') ?? '';
  const username = Deno.env.get('SL_USERNAME') ?? '';
  const password = Deno.env.get('SL_PASSWORD') ?? '';
  const appKey = Deno.env.get('SL_APPKEY') ?? '';
  if (!baseUrl || !username || !password || !appKey) return null;
  if (!baseUrl.startsWith('https://')) return null; // never send credentials unencrypted
  const extraHeaders: Record<string, string> = {};
  const cfId = Deno.env.get('CF_ACCESS_CLIENT_ID');
  const cfSecret = Deno.env.get('CF_ACCESS_CLIENT_SECRET');
  if (cfId && cfSecret) {
    extraHeaders['CF-Access-Client-Id'] = cfId;
    extraHeaders['CF-Access-Client-Secret'] = cfSecret;
  }
  return { baseUrl, username, password, appKey, extraHeaders };
};

interface Settings {
  enabled: boolean;
  km_article_number: string | null;
}

const loadSettings = async (): Promise<Settings> => {
  const { data } = await db.from('sl_settings').select('enabled, km_article_number').eq('id', true).maybeSingle();
  return { enabled: !!data?.enabled, km_article_number: data?.km_article_number ?? null };
};

// ---------------------------------------------------------------- audit log and limits

const audit = async (
  actor: string,
  action: string,
  ok: boolean,
  detail: string,
  extra: { entry_id?: string; order_key?: string | null } = {},
) => {
  await db.from('sl_audit_log').insert({
    actor,
    action,
    ok,
    detail: detail.slice(0, 500),
    entry_id: extra.entry_id ?? null,
    order_key: extra.order_key ?? null,
  });
};

const overRateLimit = async (actor: string): Promise<boolean> => {
  const { count } = await db
    .from('sl_audit_log')
    .select('id', { count: 'exact', head: true })
    .eq('actor', actor)
    .gte('at', new Date(Date.now() - 10 * 60 * 1000).toISOString());
  return (count ?? 0) >= RATE_LIMIT_PER_10_MIN;
};

const errorText = (e: unknown): string =>
  e instanceof TransferError || e instanceof SlError ? e.message : 'Interner Fehler bei der Übertragung.';

// ---------------------------------------------------------------- transfer

const loadArticles = async (numbers: string[]): Promise<Map<string, ArticleInfo>> => {
  const map = new Map<string, ArticleInfo>();
  if (numbers.length === 0) return map;
  const { data } = await db.from('sl_articles').select('number, unit').in('number', numbers);
  for (const a of data ?? []) map.set(a.number, { unit: a.unit });
  return map;
};

const transfer = async (actorId: string, entryId: string, actorIsAdmin: boolean): Promise<Response> => {
  const { data: entry } = await db
    .from('time_entries')
    .select(
      'id, user_id, customer_id, entry_date, end_date, started_at, ended_at, duration_minutes, notes, materials, travel_km, sl_article_number, sl_order_key, technician_signature, customer_signature, signed_at',
    )
    .eq('id', entryId)
    .maybeSingle();
  // Same answer for "does not exist" and "not yours".
  if (!entry || (entry.user_id !== actorId && !actorIsAdmin)) return fail('Session nicht gefunden.', 404);

  const { data: customer } = await db.from('customers').select('sl_number').eq('id', entry.customer_id).maybeSingle();
  if (!customer?.sl_number || !entry.sl_article_number) {
    return json({ status: 'skipped', reason: 'Keine SelectLine-Session (Kunde oder Artikel nicht aus SelectLine).' });
  }

  const settings = await loadSettings();
  const config = slConfig();
  const now = new Date().toISOString();

  // Make sure a row exists, then take the lock (only one transfer per session at a time).
  await db
    .from('sl_transfers')
    .upsert({ entry_id: entry.id, user_id: entry.user_id }, { onConflict: 'entry_id', ignoreDuplicates: true });

  if (!settings.enabled || !config) {
    const reason = !settings.enabled ? 'Übertragung ist vom Administrator pausiert.' : 'SelectLine ist noch nicht eingerichtet.';
    await db.from('sl_transfers').update({ status: 'pending', last_error: reason, updated_at: now }).eq('entry_id', entry.id);
    return json({ status: 'pending', reason });
  }

  const { data: locked } = await db
    .from('sl_transfers')
    .update({ locked_until: new Date(Date.now() + LOCK_SECONDS * 1000).toISOString() })
    .eq('entry_id', entry.id)
    .or(`locked_until.is.null,locked_until.lt.${now}`)
    .select('order_key, order_number, parts, attempts')
    .maybeSingle();
  if (!locked) return json({ status: 'busy', reason: 'Die Session wird gerade übertragen.' });

  const previous: TransferState = {
    order_key: locked.order_key,
    order_number: locked.order_number,
    parts: (locked.parts ?? {}) as TransferState['parts'],
  };

  const { data: owner } = await db.from('profiles').select('sl_employee_number').eq('id', entry.user_id).maybeSingle();
  const materials = (Array.isArray(entry.materials) ? entry.materials : []) as EntryMaterial[];
  const articleNumbers = [
    entry.sl_article_number,
    ...materials.map((m) => m.artikel).filter((a): a is string => !!a),
    ...(settings.km_article_number ? [settings.km_article_number] : []),
  ];

  const save = async (state: TransferState) => {
    await db
      .from('sl_transfers')
      .update({ order_key: state.order_key, order_number: state.order_number, parts: state.parts, updated_at: new Date().toISOString() })
      .eq('entry_id', entry.id);
  };

  try {
    const result = await new SelectLineClient(config).session(async (client) =>
      runTransfer(
        client,
        {
          entry: {
            ...entry,
            materials,
            signed_by_technician: !!entry.technician_signature,
            signed_by_customer: !!entry.customer_signature,
          },
          customerNumber: customer.sl_number,
          chosenOrderKey: entry.sl_order_key,
          context: {
            employeeNumber: owner?.sl_employee_number ?? '',
            articles: await loadArticles(articleNumbers),
            kmArticleNumber: settings.km_article_number,
          },
        },
        previous,
        save,
      ),
    );
    const sentAt = new Date().toISOString();
    await db
      .from('sl_transfers')
      .update({
        status: 'sent',
        last_error: null,
        attempts: (locked.attempts ?? 0) + 1,
        locked_until: null,
        last_sent_at: sentAt,
        updated_at: sentAt,
      })
      .eq('entry_id', entry.id);
    const detail = `Auftrag ${result.state.order_number}${result.orderCreated ? ' (neu angelegt)' : ''}: ${result.added} neu, ${result.updated} geändert, ${result.removed} entfernt`;
    await audit(actorId, actorIsAdmin && actorId !== entry.user_id ? 'retry' : 'transfer', true, detail, {
      entry_id: entry.id,
      order_key: result.state.order_key,
    });
    return json({ status: 'sent', order_number: result.state.order_number, order_key: result.state.order_key });
  } catch (e) {
    const message = errorText(e);
    if (!(e instanceof TransferError || e instanceof SlError)) console.error('transfer failed', e);
    await db
      .from('sl_transfers')
      .update({
        status: 'error',
        last_error: message.slice(0, 500),
        attempts: (locked.attempts ?? 0) + 1,
        locked_until: null,
        updated_at: new Date().toISOString(),
      })
      .eq('entry_id', entry.id);
    await audit(actorId, 'transfer', false, message, { entry_id: entry.id, order_key: previous.order_key });
    return json({ status: 'error', error: message });
  }
};

// ---------------------------------------------------------------- import

const customerName = (c: SlCustomer): string => {
  const person = [c.FirstName, c.LastName].filter(Boolean).join(' ').trim();
  return (c.Company?.trim() || person || `Kunde ${c.Number}`).slice(0, 200);
};

const customerAddress = (c: SlCustomer): string | null => {
  const a = c.Address ?? {};
  const lines = [
    a.AdditionalInformation1,
    a.Street,
    [a.ZipCode, a.City].filter(Boolean).join(' '),
    a.CountryId && !['D', 'DE', 'DEU'].includes(a.CountryId.toUpperCase()) ? a.CountryId : null,
  ]
    .map((l) => (l ?? '').trim())
    .filter(Boolean)
    .slice(0, 4);
  const text = lines.join('\n').slice(0, 300);
  return text || null;
};

const chunks = <T>(rows: T[], size = 500): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
};

const runImport = async (config: SlConfig) => {
  const { customers, articles, employees } = await new SelectLineClient(config).session(async (c) => ({
    customers: await c.listCustomers(),
    articles: await c.listArticles(),
    employees: await c.listEmployees(),
  }));
  const syncedAt = new Date().toISOString();

  // Customers: insert new ones, update name/address/active of known ones. App customers without a
  // SelectLine number stay untouched ("Alt"). Customers gone from SelectLine are deactivated.
  const { data: known } = await db.from('customers').select('id, sl_number').not('sl_number', 'is', null);
  const idByNumber = new Map((known ?? []).map((k) => [k.sl_number as string, k.id as string]));
  const seen = new Set<string>();
  const updates: Record<string, unknown>[] = [];
  const inserts: Record<string, unknown>[] = [];
  for (const c of customers) {
    if (!c.Number || !SL_NUMBER.test(c.Number) || seen.has(c.Number)) continue;
    seen.add(c.Number);
    const row = {
      name: customerName(c),
      address: customerAddress(c),
      active: !c.IsInactive,
      sl_number: c.Number,
      sl_synced_at: syncedAt,
      updated_at: syncedAt,
    };
    const id = idByNumber.get(c.Number);
    if (id) updates.push({ id, ...row });
    else inserts.push(row);
  }
  for (const batch of chunks(inserts)) {
    const { error } = await db.from('customers').insert(batch);
    if (error) throw new Error(`Kunden anlegen: ${error.message}`);
  }
  for (const batch of chunks(updates)) {
    const { error } = await db.from('customers').upsert(batch, { onConflict: 'id' });
    if (error) throw new Error(`Kunden aktualisieren: ${error.message}`);
  }
  const gone = [...idByNumber.entries()].filter(([n]) => !seen.has(n)).map(([, id]) => id);
  for (const batch of chunks(gone)) {
    await db.from('customers').update({ active: false, updated_at: syncedAt }).in('id', batch);
  }

  // Articles and employees: mirror tables, replaced as a whole.
  const articleRows = articles
    .filter((a) => a.Number && SL_NUMBER.test(a.Number) && !a.IsInactive)
    .map((a) => ({
      number: a.Number,
      name: (a.Name ?? '').slice(0, 200),
      unit: a.QuantityUnit?.slice(0, 20) ?? null,
      is_effort: !!a.IsEffortArticle,
      is_warehouse: !!a.IsWarehouseArtikel,
      synced_at: syncedAt,
    }));
  for (const batch of chunks(articleRows)) {
    const { error } = await db.from('sl_articles').upsert(batch, { onConflict: 'number' });
    if (error) throw new Error(`Artikel: ${error.message}`);
  }
  await db.from('sl_articles').delete().lt('synced_at', syncedAt);

  const employeeRows = employees
    .filter((e) => e.Number && SL_NUMBER.test(e.Number))
    .map((e) => ({
      number: e.Number,
      name: (e.Name || [e.FirstName, e.LastName].filter(Boolean).join(' ') || e.Number).slice(0, 200),
      synced_at: syncedAt,
    }));
  for (const batch of chunks(employeeRows)) {
    const { error } = await db.from('sl_employees').upsert(batch, { onConflict: 'number' });
    if (error) throw new Error(`Mitarbeiter: ${error.message}`);
  }
  await db.from('sl_employees').delete().lt('synced_at', syncedAt);

  return {
    customers_new: inserts.length,
    customers_updated: updates.length,
    customers_deactivated: gone.length,
    articles: articleRows.length,
    employees: employeeRows.length,
  };
};

// ---------------------------------------------------------------- handler

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== 'POST') return fail('Methode nicht erlaubt.', 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return fail('Nicht angemeldet.', 401);
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const {
    data: { user: caller },
  } = await callerClient.auth.getUser();
  if (!caller) return fail('Nicht angemeldet.', 401);
  if (REQUIRE_AAL2 && aalOf(authHeader) !== 'aal2') return fail('Bitte zuerst mit dem Authenticator bestätigen.', 403);

  const { data: profile } = await db.from('profiles').select('role, disabled').eq('id', caller.id).maybeSingle();
  if (!profile || profile.disabled) return fail('Keine Berechtigung.', 403);
  const isAdmin = profile.role === 'admin';

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return fail('Ungültige Anfrage.');
  }
  const action = body.action;

  // ---- actions for every active user
  if (action === 'transfer') {
    const entryId = String(body.entry_id ?? '');
    if (!UUID.test(entryId)) return fail('Ungültige Session.');
    if (await overRateLimit(caller.id)) return fail('Zu viele Übertragungen, bitte später erneut versuchen.', 429);
    return transfer(caller.id, entryId, isAdmin);
  }

  if (action === 'openOrders') {
    const customerId = String(body.customer_id ?? '');
    if (!UUID.test(customerId)) return fail('Ungültiger Kunde.');
    const { data: customer } = await db.from('customers').select('sl_number').eq('id', customerId).maybeSingle();
    if (!customer?.sl_number) return json({ orders: [] });
    const [settings, config] = [await loadSettings(), slConfig()];
    if (!settings.enabled || !config) return fail('SelectLine-Übertragung ist nicht aktiv.', 409);
    if (await overRateLimit(caller.id)) return fail('Zu viele Anfragen, bitte später erneut versuchen.', 429);
    try {
      const docs = await new SelectLineClient(config).session((c) => c.listOpenOrders(customer.sl_number));
      await audit(caller.id, 'openOrders', true, `Kunde ${customer.sl_number}: ${docs.length} offene Aufträge`);
      return json({
        orders: docs.slice(0, 50).map((d) => ({
          key: documentKeyOf(d),
          number: d.Number,
          date: d.Date ?? null,
          text: (d.HeaderText ?? '').slice(0, 120),
        })),
      });
    } catch (e) {
      await audit(caller.id, 'openOrders', false, errorText(e));
      return fail(errorText(e), 502);
    }
  }

  // ---- admin only
  if (!isAdmin) return fail('Keine Berechtigung.', 403);

  if (action === 'overview') {
    await db
      .from('sl_audit_log')
      .delete()
      .lt('at', new Date(Date.now() - AUDIT_MONTHS * 31 * 24 * 3600 * 1000).toISOString());
    const [settings, transfers, employees, profiles, log] = await Promise.all([
      loadSettings(),
      db
        .from('sl_transfers')
        .select('entry_id, user_id, status, order_number, last_error, attempts, last_sent_at, updated_at')
        .order('updated_at', { ascending: false })
        .limit(300),
      db.from('sl_employees').select('number, name').order('name'),
      db.from('profiles').select('id, username, sl_employee_number'),
      db.from('sl_audit_log').select('at, actor, action, ok, detail, entry_id').order('at', { ascending: false }).limit(200),
    ]);
    return json({
      settings,
      configured: slConfig() !== null,
      transfers: transfers.data ?? [],
      employees: employees.data ?? [],
      users: profiles.data ?? [],
      log: log.data ?? [],
    });
  }

  if (action === 'settings') {
    const update: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by: caller.id };
    if (typeof body.enabled === 'boolean') update.enabled = body.enabled;
    if ('km_article_number' in body) {
      const km = body.km_article_number === null || body.km_article_number === '' ? null : String(body.km_article_number);
      if (km !== null) {
        const { data } = await db.from('sl_articles').select('number').eq('number', km).maybeSingle();
        if (!data) return fail('Diesen Artikel gibt es nicht (erst Daten aus SelectLine holen).');
      }
      update.km_article_number = km;
    }
    const { error } = await db.from('sl_settings').update(update).eq('id', true);
    if (error) return fail('Einstellungen konnten nicht gespeichert werden.', 500);
    const detail = Object.entries(update)
      .filter(([k]) => k === 'enabled' || k === 'km_article_number')
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    await audit(caller.id, 'settings', true, detail);
    return json({ ok: true });
  }

  if (action === 'setEmployee') {
    const userId = String(body.user_id ?? '');
    if (!UUID.test(userId)) return fail('Ungültiger Benutzer.');
    const number = body.employee_number === null || body.employee_number === '' ? null : String(body.employee_number);
    if (number !== null) {
      const { data } = await db.from('sl_employees').select('number').eq('number', number).maybeSingle();
      if (!data) return fail('Diese Mitarbeiternummer gibt es in SelectLine nicht (erst Daten holen).');
    }
    const { error } = await db.from('profiles').update({ sl_employee_number: number }).eq('id', userId);
    if (error) return fail('Mitarbeiternummer konnte nicht gespeichert werden.', 500);
    await audit(caller.id, 'setEmployee', true, `Benutzer ${userId}: ${number ?? 'entfernt'}`);
    return json({ ok: true });
  }

  if (action === 'import' || action === 'test') {
    const config = slConfig();
    if (!config) return fail('SelectLine ist noch nicht eingerichtet (Secrets fehlen oder keine https-Adresse).', 409);
    try {
      if (action === 'test') {
        const started = Date.now();
        await new SelectLineClient(config).session(async () => undefined);
        await audit(caller.id, 'test', true, `Anmeldung ok (${Date.now() - started} ms)`);
        return json({ ok: true, ms: Date.now() - started });
      }
      const counts = await runImport(config);
      await audit(caller.id, 'import', true, JSON.stringify(counts));
      return json({ ok: true, ...counts });
    } catch (e) {
      const message = e instanceof SlError ? e.message : `Import fehlgeschlagen: ${e instanceof Error ? e.message : ''}`;
      await audit(caller.id, String(action), false, message);
      return fail(message, 502);
    }
  }

  return fail('Unbekannte Aktion.');
});

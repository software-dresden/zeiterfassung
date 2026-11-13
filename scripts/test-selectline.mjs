// Tests of the SelectLine transfer logic against the fake SelectLine (scripts/selectline-mock.mjs).
// Run: node scripts/test-selectline.mjs
// Compiles supabase/functions/selectline/{client,positions,transfer}.ts with TypeScript (no Deno needed).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { startMock } from './selectline-mock.mjs';

const src = path.resolve('supabase/functions/selectline');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-test-'));
for (const name of ['client', 'positions', 'transfer']) {
  const code = fs.readFileSync(path.join(src, `${name}.ts`), 'utf8');
  const js = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace(/from '\.\/(\w+)\.ts'/g, "from './$1.mjs'");
  fs.writeFileSync(path.join(out, `${name}.mjs`), js);
}
const { SelectLineClient, SlError } = await import(pathToFileURL(path.join(out, 'client.mjs')));
const { TransferError, quantityForMinutes, buildParts } = await import(pathToFileURL(path.join(out, 'positions.mjs')));
const { runTransfer } = await import(pathToFileURL(path.join(out, 'transfer.mjs')));

const mock = await startMock();
const cfg = { baseUrl: mock.baseUrl, username: 'API', password: 'secret', appKey: 'APPKEY' };
const client = () => new SelectLineClient(cfg);

mock.state.articles = [
  { Number: 'AE', Name: 'Arbeitseinheit', QuantityUnit: 'AE', IsEffortArticle: true },
  { Number: 'STD', Name: 'Arbeitsstunde', QuantityUnit: 'Std', IsEffortArticle: true },
  { Number: 'KM', Name: 'Kilometer', QuantityUnit: 'km', IsEffortArticle: true },
  { Number: 'HDD1', Name: 'SSD 1 TB', QuantityUnit: 'Stk', IsWarehouseArtikel: true },
  { Number: 'ODD', Name: 'Seltsam', QuantityUnit: 'Pauschal', IsEffortArticle: true },
];
const articles = new Map(mock.state.articles.map((a) => [a.Number, { unit: a.QuantityUnit }]));

let passed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.log(`  FAIL ${name}\n       ${e?.stack ?? e}`);
    process.exitCode = 1;
  }
};

const baseEntry = {
  id: 'e1',
  entry_date: '2026-11-13',
  started_at: '2026-11-13T08:00:00Z',
  ended_at: '2026-11-13T09:30:00Z',
  duration_minutes: 90,
  notes: 'Server neu gestartet\n- Backup geprüft',
  materials: [
    { name: 'SSD', menge: '2', artikel: 'HDD1' },
    { name: 'Kabel', menge: '3 m' },
  ],
  travel_km: 25,
  sl_article_number: 'STD',
  signed_by_customer: true,
  signed_at: '2026-11-13T09:31:00Z',
};
const ctx = { employeeNumber: '7', articles, kmArticleNumber: 'KM' };
const empty = () => ({ order_key: null, order_number: null, parts: {} });

const transfer = async (entry, customerNumber, chosen, previous, saves = []) =>
  client().session((c) =>
    runTransfer(c, { entry, customerNumber, chosenOrderKey: chosen, context: ctx }, previous, async (s) => {
      saves.push(JSON.parse(JSON.stringify(s)));
    }),
  );

console.log('SelectLine tests');

await test('units: Std, Min, AE; unknown unit refused', () => {
  assert.equal(quantityForMinutes(90, 'Std'), 1.5);
  assert.equal(quantityForMinutes(50, 'h'), 0.83);
  assert.equal(quantityForMinutes(45, 'Min.'), 45);
  assert.equal(quantityForMinutes(45, 'AE'), 4.5);
  assert.throws(() => quantityForMinutes(45, 'Pauschal'), TransferError);
});

await test('wrong AppKey -> clear error, no token', async () => {
  const c = new SelectLineClient({ ...cfg, appKey: 'falsch' });
  await assert.rejects(c.login(), (e) => e instanceof SlError && e.status === 401 && /AppKey/.test(e.message));
});

await test('paging reads all 1203 customers', async () => {
  mock.state.customers = Array.from({ length: 1203 }, (_, i) => ({ Number: `K${i}`, Company: `Firma ${i}`, IsInactive: i % 100 === 0 }));
  const rows = await client().session((c) => c.listCustomers());
  assert.equal(rows.length, 1203);
});

let first;
await test('new session: Auftrag created, time + material + km positions', async () => {
  const saves = [];
  first = await transfer(baseEntry, 'K1', null, empty(), saves);
  assert.equal(first.orderCreated, true);
  assert.equal(first.added, 3);
  const doc = mock.state.documents.get(first.state.order_key);
  assert.equal(doc.BusinessPartner.BusinessPartnerReferenceNumber, 'K1');
  assert.equal(doc.EmployeeNumber, '7');
  const [time, mat, km] = [...doc.positions.values()];
  assert.equal(time.ArticleNumber, 'STD');
  assert.equal(time.CalculatedQuantityValue, 1.5);
  assert.equal(time.QuantityUnit, 'Std');
  assert.equal(time.EmployeeNumber, '7');
  assert.match(time.Memo, /Datum: 13\.11\.2026/);
  assert.match(time.Memo, /Zeit: 09:00 – 10:30 Uhr/); // Berlin time
  assert.match(time.Memo, /Backup geprüft/);
  assert.match(time.Memo, /- Kabel \(3 m\)/); // material without article stays in the text
  assert.doesNotMatch(time.Memo, /Fahrt:/); // km is its own position
  assert.match(time.Memo, /Unterschrieben am 13\.11\.2026 \(Kunde\)/);
  assert.equal(mat.ArticleNumber, 'HDD1');
  assert.equal(mat.CalculatedQuantityValue, 2);
  assert.equal(km.ArticleNumber, 'KM');
  assert.equal(km.CalculatedQuantityValue, 25);
  assert.ok(!('UnitPrice' in time) && !('TotalPrice' in time), 'no prices sent');
  assert.equal(saves[0].order_key, first.state.order_key, 'order saved before positions');
  assert.equal(saves.length, 4);
});

await test('same session again: nothing changes', async () => {
  const again = await transfer(baseEntry, 'K1', null, first.state);
  assert.deepEqual([again.orderCreated, again.added, again.updated, again.removed], [false, 0, 0, 0]);
});

let edited;
await test('edit duration: exactly the time position is updated', async () => {
  edited = await transfer({ ...baseEntry, duration_minutes: 120 }, 'K1', null, first.state);
  assert.deepEqual([edited.added, edited.updated, edited.removed], [0, 1, 0]);
  const doc = mock.state.documents.get(first.state.order_key);
  assert.equal(doc.positions.get(first.state.parts.time.id).CalculatedQuantityValue, 2);
});

await test('km removed: position set to 0 and marked, not deleted', async () => {
  const r = await transfer({ ...baseEntry, duration_minutes: 120, travel_km: 0 }, 'K1', null, edited.state);
  assert.equal(r.removed, 1);
  const pos = mock.state.documents.get(first.state.order_key).positions.get(first.state.parts.km.id);
  assert.equal(pos.CalculatedQuantityValue, 0);
  assert.match(pos.Memo, /Entfernt/);
  const again = await transfer({ ...baseEntry, duration_minutes: 120, travel_km: 0 }, 'K1', null, r.state);
  assert.equal(again.removed, 0, 'only once');
});

await test('customer has open Aufträge and none chosen -> asks to choose, creates nothing', async () => {
  const before = mock.state.documents.size;
  await assert.rejects(transfer(baseEntry, 'K1', null, empty()), (e) => e instanceof TransferError && /Auftrag wählen/.test(e.message));
  assert.equal(mock.state.documents.size, before);
});

await test('chosen open Auftrag is used', async () => {
  const r = await transfer({ ...baseEntry, id: 'e2' }, 'K1', first.state.order_key, empty());
  assert.equal(r.orderCreated, false);
  assert.equal(r.state.order_key, first.state.order_key);
});

await test('chosen Auftrag already done (invoiced) -> new Auftrag', async () => {
  mock.state.documents.get(first.state.order_key).StatusFlag = 2;
  const r = await transfer({ ...baseEntry, id: 'e3' }, 'K1', first.state.order_key, empty());
  assert.equal(r.orderCreated, true);
  assert.notEqual(r.state.order_key, first.state.order_key);
});

await test('chosen Auftrag of another customer -> refused', async () => {
  await assert.rejects(transfer({ ...baseEntry, id: 'e4' }, 'K2', first.state.order_key, empty()), /anderen Kunden/);
});

await test('Auftrag cannot be switched after transfer', async () => {
  await assert.rejects(transfer(baseEntry, 'K1', 'F999', first.state), /nicht mehr gewechselt/);
});

await test('invalid data is refused before anything is sent', async () => {
  const before = mock.state.requests.length;
  assert.throws(() => buildParts({ ...baseEntry, sl_article_number: 'ODD' }, ctx), /Mengeneinheit/);
  assert.throws(() => buildParts(baseEntry, { ...ctx, employeeNumber: '' }), /Mitarbeiternummer/);
  assert.throws(() => buildParts({ ...baseEntry, sl_article_number: null }, ctx), /Kein Artikel/);
  assert.throws(() => buildParts({ ...baseEntry, sl_article_number: 'GONE' }, ctx), /nicht \(mehr\) vorhanden/);
  await assert.rejects(transfer({ ...baseEntry, sl_article_number: 'ODD' }, 'K5', null, empty()), /Mengeneinheit/);
  const sent = mock.state.requests.slice(before).filter((r) => !['/Login', '/Logout'].includes(r.path));
  assert.equal(sent.length, 0);
});

await test('failure after Auftrag creation: retry reuses the Auftrag (no duplicate)', async () => {
  const saves = [];
  mock.state.failNext = 'ArticleItem';
  await assert.rejects(transfer({ ...baseEntry, id: 'e5' }, 'K9', null, empty(), saves), SlError);
  const stored = saves.at(-1);
  assert.ok(stored.order_key, 'order key was saved');
  const docsBefore = mock.state.documents.size;
  const r = await transfer({ ...baseEntry, id: 'e5' }, 'K9', null, stored);
  assert.equal(r.orderCreated, false);
  assert.equal(mock.state.documents.size, docsBefore);
  assert.equal(r.added, 3);
});

await test('redirects are not followed (token never leaves)', async () => {
  const c = new SelectLineClient({ ...cfg, baseUrl: mock.baseUrl.replace('/slmobileApi', '') });
  await assert.rejects(c.request('GET', '/redirect'), /Weiterleitung/);
});

await test('every login was logged out again (no licence left occupied)', () => {
  assert.equal(mock.state.tokens.size, 0);
  assert.equal(mock.state.logins, mock.state.logouts);
});

await test('Cloudflare Access headers are sent on every request', async () => {
  const c = new SelectLineClient({ ...cfg, extraHeaders: { 'CF-Access-Client-Id': 'id1', 'CF-Access-Client-Secret': 's1' } });
  const before = mock.state.requests.length;
  await c.session((x) => x.listEmployees());
  const reqs = mock.state.requests.slice(before);
  assert.ok(reqs.length >= 3);
  assert.ok(reqs.every((r) => r.headers['cf-access-client-id'] === 'id1' && r.headers['cf-access-client-secret'] === 's1'));
});

await mock.close();
fs.rmSync(out, { recursive: true, force: true });
console.log(`${passed} passed${process.exitCode ? ', some FAILED' : ''}`);

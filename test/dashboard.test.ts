import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { Agent, request } from 'node:http';
import type { IncomingHttpHeaders, RequestOptions } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { getDocument, VerbosityLevel } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createBusinessStore } from '../src/business-store.ts';
import type { ActionResult, BusinessAction, BusinessSnapshot, ClientInput } from '../src/business-contract.ts';
import { startDashboard } from '../src/dashboard.ts';
import type { DashboardServer } from '../src/dashboard.ts';

const PRIVATE_VALUE = 'SYNTHETIC-CREDENTIAL-NOT-FOR-THE-BROWSER';
const customer: ClientInput = { name: 'João da Conceição', phone: '11999999999', email: 'joao@example.test', address: 'Rua das Acácias, 12', notes: '', active: true };
const createClient: BusinessAction = { type: 'client.save', id: null, version: null, data: customer };
type HttpResult = { status: number; headers: IncomingHttpHeaders; body: Buffer };

function http(url: string, path: string, options: RequestOptions = {}, body?: string | Buffer): Promise<HttpResult> {
  const { promise, resolve, reject } = Promise.withResolvers<HttpResult>();
  const outgoing = request(url, { ...options, path }, response => {
    const chunks: Buffer[] = [];
    response.on('data', chunk => chunks.push(chunk));
    response.once('error', reject);
    response.once('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks) }));
  });
  outgoing.once('error', reject);
  outgoing.end(body);
  return promise;
}

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'sofia-dashboard-'));
  const assetsDir = join(root, 'dist');
  const databasePath = join(root, 'private.sqlite');
  let db: DatabaseSync | undefined;
  let dashboard: DashboardServer | undefined;
  t.after(async () => { await dashboard?.close(); db?.close(); rmSync(root, { recursive: true, force: true }); });
  mkdirSync(join(assetsDir, 'assets'), { recursive: true });
  writeFileSync(join(assetsDir, 'index.html'), '<!doctype html><html lang="pt-BR"><head><title>Painel</title><script type="module" src="/assets/app-12345678.js"></script></head><body><div id="root">Painel local</div></body></html>');
  writeFileSync(join(assetsDir, 'assets', 'app-12345678.js'), 'document.querySelector("#root").textContent = "Aplicativo local";');
  writeFileSync(join(assetsDir, '.env'), PRIVATE_VALUE);
  writeFileSync(join(root, '.env'), PRIVATE_VALUE);
  writeFileSync(join(assetsDir, 'source.ts'), PRIVATE_VALUE);
  symlinkSync(join(root, '.env'), join(assetsDir, 'assets', 'leak.js'));
  db = new DatabaseSync(databasePath);
  db.exec('CREATE TABLE synthetic_auth (secret TEXT NOT NULL)');
  db.prepare('INSERT INTO synthetic_auth VALUES (?)').run(PRIVATE_VALUE);
  let business = createBusinessStore(db, { timeZone: 'America/Sao_Paulo', now: () => new Date('2026-09-12T02:00:00.000Z') });
  dashboard = await startDashboard({ business, port: 0, assetsDir });
  return {
    root, assetsDir,
    get url() { return dashboard!.url; },
    get business() { return business; },
    get server() { return dashboard!; },
    headers(key: string = randomUUID()) { return { origin: dashboard!.url, 'content-type': 'application/json', 'x-idempotency-key': key }; },
    async save(action: BusinessAction, key: string = randomUUID()): Promise<ActionResult> {
      const response = await http(dashboard!.url, '/api/actions', { method: 'POST', headers: this.headers(key) }, JSON.stringify(action));
      assert.equal(response.status, 200, response.body.toString());
      return JSON.parse(response.body.toString());
    },
    async snapshot(): Promise<BusinessSnapshot> {
      const response = await http(dashboard!.url, '/api/state?month=2026-09');
      assert.equal(response.status, 200, response.body.toString());
      return JSON.parse(response.body.toString());
    },
    async restart() {
      await dashboard!.close();
      db!.close();
      db = new DatabaseSync(databasePath);
      business = createBusinessStore(db, { timeZone: 'America/Sao_Paulo', now: () => new Date('2026-09-12T02:00:00.000Z') });
      dashboard = await startDashboard({ business, port: 0, assetsDir });
    },
    closeDatabase() { db!.close(); db = undefined; },
  };
}

test('HTTP business edits persist across restart, link records, and replay without duplicate stock or quotes', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.snapshot()).clients, []);
  const client = await f.save(createClient);
  const service = await f.save({ type: 'service.save', id: null, version: null, data: { clientId: client.id, title: 'Reforma elétrica', description: '', address: customer.address, stage: 'quoting' } });
  await f.save({ type: 'visit.save', id: null, version: null, data: { clientId: client.id, serviceId: service.id, title: 'Visita técnica', startLocal: '2026-09-15T10:00', endLocal: '2026-09-15T11:00', location: customer.address, notes: '', status: 'scheduled' } });
  const material = await f.save({ type: 'material.save', id: null, version: null, data: { name: 'Cabo elétrico', sku: 'CABO', unit: 'm', costCents: 101, minimumMilli: 1000, notes: '', active: true } });
  const move: BusinessAction = { type: 'stock.move', data: { materialId: material.id, serviceId: service.id, kind: 'in', quantityMilli: 2500, unitCostCents: 101, occurredOn: '2026-09-15', note: 'Compra' } };
  const moveKey = randomUUID();
  assert.deepEqual(await f.save(move, moveKey), await f.save(move, moveKey.toUpperCase()));
  await f.save({ type: 'stock.move', data: { ...move.data, kind: 'out', quantityMilli: 500, unitCostCents: null, note: 'Consumo' } });
  const quoteAction: BusinessAction = { type: 'quote.save', id: null, version: null, data: { clientId: client.id, serviceId: service.id, title: 'Instalação', validUntil: '2026-09-30', status: 'draft', notes: 'Pagamento após conclusão.', discountCents: 7, items: [
    { materialId: material.id, description: 'Cabo', unit: 'm', quantityMilli: 500, unitPriceCents: 101 },
    { materialId: null, description: 'Instalação', unit: 'h', quantityMilli: 1250, unitPriceCents: 199 },
  ] } };
  const quoteKey = randomUUID();
  const quote = await f.save(quoteAction, quoteKey);
  await f.save({ type: 'cash.save', id: null, version: null, data: { kind: 'income', description: 'Pagamento da instalação', category: 'Serviços', amountCents: 293, date: '2026-09-15', status: 'paid', clientId: client.id, serviceId: service.id } });
  await f.save({ type: 'client.save', id: client.id, version: 1, data: { ...customer, name: 'João atualizado', active: false } });
  await f.restart();
  assert.deepEqual(await f.save(quoteAction, quoteKey), quote);
  const snapshot = await f.snapshot();
  assert.equal(snapshot.clients[0].name, 'João atualizado');
  assert.equal(snapshot.clients[0].active, false);
  assert.equal(snapshot.services[0].clientId, client.id);
  assert.equal(snapshot.visits[0].serviceId, service.id);
  assert.equal(Date.parse(snapshot.visits[0].startAt), Date.UTC(2026, 8, 15, 13));
  assert.equal(snapshot.materials[0].stockMilli, 2000);
  assert.equal(snapshot.movements.length, 2);
  assert.equal(snapshot.quotes.length, 1);
  assert.equal(snapshot.quotes[0].customer.name, customer.name);
  assert.deepEqual(snapshot.quotes[0].items.map(item => item.totalCents), [51, 249]);
  assert.equal(snapshot.quotes[0].totalCents, 293);
  assert.equal(snapshot.summary.cash.balanceCents, 293);
  const stale = await http(f.url, '/api/actions', { method: 'POST', headers: f.headers() }, JSON.stringify({ type: 'client.save', id: client.id, version: 1, data: customer }));
  assert.equal(stale.status, 409);
  const conflict = await http(f.url, '/api/actions', { method: 'POST', headers: f.headers(quoteKey) }, JSON.stringify(createClient));
  assert.equal(conflict.status, 409);
  assert.equal((await f.snapshot()).clients.length, 1);
});

test('rejects cross-origin and malformed writes without mutation or private data exposure', async t => {
  const f = await fixture(t);
  const body = JSON.stringify(createClient);
  const valid = f.headers();
  const rejected: Array<{ headers: Record<string, string>; body: string | Buffer; status: number }> = [
    { headers: { ...valid, origin: 'https://attacker.example' }, body, status: 403 },
    { headers: { 'content-type': 'application/json', 'x-idempotency-key': randomUUID() }, body, status: 403 },
    { headers: { ...valid, host: `localhost:${new URL(f.url).port}` }, body, status: 403 },
    { headers: { ...valid, 'content-type': 'text/plain' }, body, status: 415 },
    { headers: { origin: f.url, 'content-type': 'application/json' }, body, status: 400 },
    { headers: { ...valid, 'x-idempotency-key': 'not-a-uuid' }, body, status: 400 },
    { headers: valid, body: '{"type":', status: 400 },
    { headers: valid, body: '{"type":"credentials.export"}', status: 400 },
    { headers: valid, body: Buffer.from([0xff, 0xfe]), status: 400 },
    { headers: valid, body: ' '.repeat(256 * 1024 + 1), status: 413 },
    { headers: { ...valid, 'transfer-encoding': 'chunked' }, body: ' '.repeat(256 * 1024 + 1), status: 413 },
  ];
  for (const attempt of rejected) {
    const response = await http(f.url, '/api/actions', { method: 'POST', headers: attempt.headers }, attempt.body);
    assert.equal(response.status, attempt.status, response.body.toString());
    assert.deepEqual(Object.keys(JSON.parse(response.body.toString())), ['error']);
    assert.equal(response.body.includes(PRIVATE_VALUE), false);
  }
  for (const path of ['/', '/api/state', '/api/actions']) {
    const response = await http(f.url, path, { method: path.endsWith('actions') ? 'POST' : 'GET', headers: { ...valid, host: `127.0.0.1.attacker.example:${new URL(f.url).port}` } }, path.endsWith('actions') ? body : undefined);
    assert.equal(response.status, 403);
  }
  const state = await http(f.url, '/api/state?month=2026-09');
  assert.equal(state.body.includes(PRIVATE_VALUE), false);
  assert.deepEqual(JSON.parse(state.body.toString()).clients, []);
  assert.equal(state.headers['access-control-allow-origin'], undefined);
  assert.equal(state.headers['x-frame-options'], 'DENY');
  assert.equal(state.headers['x-content-type-options'], 'nosniff');
  assert.match(String(state.headers['content-security-policy']), /frame-ancestors 'none'/);
  const localhost = `http://localhost:${new URL(f.url).port}`;
  const accepted = await http(f.url, '/api/actions', { method: 'POST', headers: { ...f.headers(), host: new URL(localhost).host, origin: localhost } }, body);
  assert.equal(accepted.status, 200);
  f.closeDatabase();
  const failure = await http(f.url, '/api/state');
  assert.equal(failure.status, 500);
  assert.deepEqual(Object.keys(JSON.parse(failure.body.toString())), ['error']);
  assert.doesNotMatch(failure.body.toString(), /sqlite|database|secret|closed|SYNTHETIC/i);
});

test('serves local assets and navigation only; denies traversal, symlinks, source and unknown API paths', async t => {
  const f = await fixture(t);
  for (const path of ['/../.env', '/%2e%2e/%2eenv', '/..%5c.env', '/.env', '/source.ts', '/assets/leak.js', '/assets/missing.js', '/api/unknown']) {
    const response = await http(f.url, path, { headers: { accept: 'text/html' } });
    assert.ok(response.status === 400 || response.status === 404, `${path}: ${response.status}`);
    assert.equal(response.body.includes(PRIVATE_VALUE), false);
    assert.match(String(response.headers['content-type']), /^application\/json/);
  }
  assert.equal((await http(f.url, '/clientes')).status, 404);
  const navigation = await http(f.url, '/clientes', { headers: { accept: 'text/html' } });
  assert.equal(navigation.status, 200);
  assert.match(navigation.body.toString(), /<html/);
  const script = await http(f.url, '/assets/app-12345678.js');
  assert.equal(script.status, 200);
  assert.match(String(script.headers['content-type']), /^text\/javascript/);
  assert.match(String(script.headers['cache-control']), /immutable/);
  const head = await http(f.url, '/assets/app-12345678.js', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers['content-length'], String(script.body.length));
  assert.equal((await http(f.url, '/', { method: 'POST' }, '{}')).status, 405);
  assert.equal((await http(f.url, '/api/state?month=2026-13')).status, 400);
  assert.equal((await http(f.url, `/api/quotes/${randomUUID()}/pdf`)).status, 404);
  await assert.rejects(startDashboard({ business: f.business, port: 0, assetsDir: join(f.root, 'not-built') }));
});

test('quote PDF preserves customer snapshot, fractional-money totals and all pages after restart', async t => {
  const f = await fixture(t);
  const client = await f.save(createClient);
  const quote = await f.save({ type: 'quote.save', id: null, version: null, data: {
    clientId: client.id, serviceId: null, title: 'Instalação elétrica', validUntil: '2026-10-12', status: 'sent', notes: 'Pagamento após conclusão. Última observação.', discountCents: 7,
    items: Array.from({ length: 70 }, (_, index) => ({ materialId: null, description: `Serviço elétrico ${index + 1}`, unit: 'h', quantityMilli: 500, unitPriceCents: 101 })),
  } });
  await f.save({ type: 'client.save', id: client.id, version: 1, data: { ...customer, name: 'Cadastro atualizado' } });
  await f.restart();
  const response = await http(f.url, `/api/quotes/${quote.id}/pdf`);
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], 'application/pdf');
  assert.match(String(response.headers['content-disposition']), /^attachment; filename="ORC-[A-Za-z0-9_-]+\.pdf"$/);
  const loading = getDocument({ data: new Uint8Array(response.body), useSystemFonts: true, verbosity: VerbosityLevel.ERRORS });
  try {
    const pdf = await loading.promise;
    const pages: string[] = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const text = (await page.getTextContent()).items.map(item => 'str' in item ? item.str : '').join(' ');
      assert.match(text, new RegExp(`Página ${number}(?: |$)`));
      assert.match(text, /Descrição|Observações|Subtotal/);
      pages.push(text);
      page.cleanup();
    }
    assert.ok(pdf.numPages > 1);
    const text = pages.join(' ');
    assert.match(text, /João da Conceição/);
    assert.doesNotMatch(text, /Cadastro atualizado/);
    assert.match(text, /11\/09\/2026/);
    assert.match(text, /Serviço elétrico 70/);
    assert.equal((text.match(/R\$ 0,51/g) ?? []).length, 70);
    assert.match(text, /R\$ 35,70/);
    assert.match(text, /R\$ 0,07/);
    assert.match(text, /R\$ 35,63/);
    assert.match(text, /Última observação\./);
  } finally { await loading.destroy(); }
});

test('shutdown drains an in-flight write, closes idle connections and is repeatable', { timeout: 3000 }, async t => {
  const f = await fixture(t);
  const agent = new Agent({ keepAlive: true });
  t.after(() => agent.destroy());
  await http(f.url, '/api/state', { agent });
  const body = JSON.stringify(createClient);
  const accepted = Promise.withResolvers<void>();
  const result = Promise.withResolvers<number>();
  const outgoing = request(f.url, { method: 'POST', path: '/api/actions', agent, headers: { ...f.headers(), expect: '100-continue', 'content-length': Buffer.byteLength(body) } }, response => {
    response.resume();
    response.once('end', () => result.resolve(response.statusCode!));
    response.once('error', result.reject);
  });
  outgoing.once('continue', accepted.resolve);
  outgoing.once('error', error => { accepted.reject(error); result.reject(error); });
  outgoing.flushHeaders();
  await accepted.promise;
  const closed = f.server.close();
  outgoing.end(body);
  assert.equal(await result.promise, 200);
  await closed;
  await f.server.close();
  assert.equal(f.business.snapshot('2026-09').clients[0].name, customer.name);
});

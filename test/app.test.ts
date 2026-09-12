import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from '../src/app.ts';
import { createAgent } from '../src/agent.ts';
import { openStore } from '../src/store.ts';
import { selectCommands } from '../src/policy.ts';
import type { createWhatsApp } from '../src/whatsapp.ts';
import type { Config, PreparedInput } from '../src/types.ts';
import type { WAMessage } from '@whiskeysockets/baileys';

const account = '5511000000000@s.whatsapp.net';
const other = '5522000000000@s.whatsapp.net';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function config(path: string, allowed: string[] = []): Config {
  return { apiKey: 'synthetic-test-key', model: 'test', transcriptionModel: 'test', databasePath: path, allowedJids: new Set(allowed), pairOnly: false };
}
function voice(id: string, chat = account): WAMessage {
  return { key: { id, remoteJid: chat, fromMe: chat === account }, message: { audioMessage: { mimetype: 'audio/ogg', ptt: true } } };
}
function harness(settings: Config, counts: { model: number; sends: number }, uncertainSend = false) {
  let events!: Parameters<typeof createWhatsApp>[2];
  const input: PreparedInput = { audio: { bytes: Buffer.from('synthetic audio'), kind: 'audio', mimeType: 'audio/ogg', filename: 'audio.ogg' } };
  const app = startApp(settings, {
    openStore,
    createAgent: () => ({ reply: async () => { counts.model++; return { userText: 'Transcrição de teste', replyText: 'Resposta de teste' }; } }),
    createWhatsApp: (_settings, _store, callbacks) => {
      events = callbacks;
      return { download: async () => input, send: async () => {
        counts.sends++;
        if (uncertainSend) throw new Error('connection lost after submission');
      }, close() {} };
    },
    info() {}, error() {}, qr() {},
  });
  return { app, events, connect: () => events.onConnection(true, { id: account }), receive: (message: WAMessage) => {
    for (const command of selectCommands({ type: 'notify', messages: [message] }, { id: account }, settings)) events.onCommand(command);
  } };
}

test('an audio arriving as the worker goes idle is answered once despite duplicate events', { timeout: 4000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sofia-app-'));
  const settings = config(join(dir, 'state.sqlite'));
  const counts = { model: 0, sends: 0 };
  const running = harness(settings, counts);
  t.after(async () => { await running.app.stop(); rmSync(dir, { recursive: true, force: true }); });
  running.connect();
  running.receive(voice('voice-duplicate'));
  running.receive(voice('voice-duplicate'));
  await tick();
  await running.app.stop();
  assert.equal(await running.app.done, 0);
  assert.equal(counts.model, 1);
  assert.equal(counts.sends, 1);
});

test('an uncertain send is not retried or billed again on redelivery after restart', { timeout: 4000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sofia-send-'));
  const settings = config(join(dir, 'state.sqlite'));
  const counts = { model: 0, sends: 0 };
  const first = harness(settings, counts, true);
  t.after(async () => { await first.app.stop(); rmSync(dir, { recursive: true, force: true }); });
  first.connect();
  first.receive(voice('uncertain-delivery'));
  await tick();
  await first.app.stop();
  const second = harness(settings, counts);
  t.after(() => second.app.stop());
  second.connect();
  second.receive(voice('uncertain-delivery'));
  await tick();
  await second.app.stop();
  assert.equal(counts.model, 1);
  assert.equal(counts.sends, 1);
});

test('queued audio loses permission when the chat allowlist is revoked', { timeout: 4000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sofia-permission-'));
  const permitted = config(join(dir, 'state.sqlite'), [other]);
  const store = openStore(permitted.databasePath);
  const [command] = selectCommands({ type: 'notify', messages: [voice('old-permission', other)] }, { id: account }, permitted);
  assert.ok(command);
  store.enqueue(command);
  store.close();
  const counts = { model: 0, sends: 0 };
  const running = harness(config(permitted.databasePath), counts);
  t.after(async () => { await running.app.stop(); rmSync(dir, { recursive: true, force: true }); });
  running.connect();
  await tick();
  await running.app.stop();
  assert.equal(counts.model, 0);
  assert.equal(counts.sends, 0);
  const reopened = openStore(permitted.databasePath);
  try { assert.equal(reopened.next(account), undefined); }
  finally { reopened.close(); }
});

test('Groq quota failures reach the user with a safe diagnosis instead of a generic API hint', { timeout: 10000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sofia-groq-error-'));
  const settings = config(join(dir, 'state.sqlite'));
  let events!: Parameters<typeof createWhatsApp>[2];
  let deliver!: (text: string) => void;
  const delivered = new Promise<string>(resolve => { deliver = resolve; });
  const logs: string[] = [];
  let requests = 0;
  let notices = 0;
  t.mock.method(globalThis, 'fetch', async (resource: RequestInfo | URL) => {
    const url = typeof resource === 'string' ? resource : resource instanceof URL ? resource.href : resource.url;
    if (url.startsWith('data:')) return new Response('');
    assert.equal(url, 'https://api.groq.com/openai/v1/audio/transcriptions');
    requests++;
    return new Response(JSON.stringify({ error: { message: 'PRIVATE_PROVIDER_PAYLOAD synthetic-secret', type: 'tokens', code: 'rate_limit_exceeded' } }), {
      status: 429, headers: { 'content-type': 'application/json' },
    });
  });
  const app = startApp(settings, {
    openStore, createAgent,
    createWhatsApp: (_settings, _store, callbacks) => {
      events = callbacks;
      return {
        download: async () => ({ audio: { kind: 'audio', bytes: Buffer.from('OggS'), mimeType: 'audio/ogg', filename: 'audio.ogg' } }),
        send: async (_command, text) => { notices++; deliver(text); },
        close() {},
      };
    },
    info() {}, error: text => { logs.push(text); }, qr() {},
  });
  t.after(async () => { await app.stop(); rmSync(dir, { recursive: true, force: true }); });
  events.onConnection(true, { id: account });
  for (const command of selectCommands({ type: 'notify', messages: [voice('groq-quota')] }, { id: account }, settings)) events.onCommand(command);
  const notice = await delivered;
  await app.stop();
  assert.match(notice, /Groq/);
  assert.match(notice, /429/);
  assert.match(notice, /rate_limit_exceeded/);
  assert.doesNotMatch([notice, ...logs].join('\n'), /PRIVATE_PROVIDER_PAYLOAD|synthetic-secret/);
  assert.equal(requests, 1);
  assert.equal(notices, 1);
});

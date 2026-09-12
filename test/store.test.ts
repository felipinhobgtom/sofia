import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { proto } from '@whiskeysockets/baileys';
import type { SignalDataSet, SignalDataTypeMap, WAMessage } from '@whiskeysockets/baileys';
import { openStore } from '../src/store.ts';
import type { Store } from '../src/store.ts';
import type { Command, HistoryItem } from '../src/types.ts';

const account = '100@s.whatsapp.net';
const chat = '200@s.whatsapp.net';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'sofia-store-'));
  const path = join(root, 'private', 'session.sqlite');
  const stores = new Set<Store>();
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    path,
    open() {
      const store = openStore(path);
      stores.add(store);
      return store;
    },
    close(store: Store) {
      store.close();
      stores.delete(store);
    },
  };
}

function command(id: string, accountId = account, chatId = chat): Command {
  const message: WAMessage = {
    key: { remoteJid: chatId, id },
    message: { audioMessage: { mimetype: 'audio/ogg', ptt: true } },
  };
  return {
    id, accountId, chatId, replyJid: chatId, message,
    attachment: { kind: 'audio', message, mimeType: 'audio/ogg' },
  };
}

test('credentials and every Signal key category survive restart without changing device identity', async t => {
  const f = fixture(t);
  let store = f.open();
  assert.equal(statSync(join(f.root, 'private')).mode & 0o777, 0o700);
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
  assert.equal(statSync(`${f.path}-wal`).mode & 0o777, 0o600);
  assert.equal(statSync(`${f.path}-shm`).mode & 0o777, 0o600);
  const identity = Buffer.from(store.auth.state.creds.signedIdentityKey.private);
  const boundCreds = store.auth.state.creds;
  const bytes = Buffer.from([0, 255, 13, 42]);
  const deviceIdentity = proto.ADVSignedDeviceIdentity.fromObject({ details: bytes, accountSignature: bytes });
  await store.auth.saveCreds({ registered: true, routingInfo: bytes, account: deviceIdentity });
  boundCreds.accountSyncCounter = 9;

  const appState = proto.Message.AppStateSyncKeyData.fromObject({
    keyData: bytes,
    fingerprint: { rawId: 7, currentIndex: 2, deviceIndexes: [1, 2] },
    timestamp: '1726000000000',
  });
  const keys: SignalDataSet = {
    'pre-key': { shared: { public: bytes, private: bytes } },
    session: { shared: bytes },
    'sender-key': { shared: bytes },
    'sender-key-memory': { shared: { [chat]: true } },
    'app-state-sync-key': { shared: appState },
    'app-state-sync-version': { shared: { version: 4, hash: bytes, indexValueMap: { entry: { valueMac: bytes } } } },
    'lid-mapping': { shared: '300@lid' },
    'device-list': { shared: ['1', '2'] },
    tctoken: { shared: { token: bytes, timestamp: '1726000000', senderTimestamp: 1726000001 } },
    'identity-key': { shared: bytes },
  };
  await store.auth.state.keys.set(keys);
  const saved = store.auth.saveCreds();
  // Baileys can close its socket before awaiting this Promise: the write is already durable.
  f.close(store);
  await saved;
  store = f.open();
  assert.deepEqual(store.auth.state.creds.signedIdentityKey.private, identity);
  assert.equal(store.auth.state.creds.registered, true);
  assert.equal(store.auth.state.creds.accountSyncCounter, 9);
  assert.deepEqual(store.auth.state.creds.routingInfo, bytes);
  assert.deepEqual(store.auth.state.creds.account?.details, bytes);
  for (const category of Object.keys(keys) as (keyof SignalDataTypeMap)[]) {
    const values = await store.auth.state.keys.get(category, ['shared', 'missing']);
    assert.deepEqual(values.shared, keys[category]!.shared);
    assert.equal(values.missing, undefined);
  }
  const restored = (await store.auth.state.keys.get('app-state-sync-key', ['shared'])).shared;
  assert.ok(restored instanceof proto.Message.AppStateSyncKeyData);
  assert.deepEqual(restored.keyData, bytes);
  await store.auth.state.keys.set({ session: { shared: null } });
  f.close(store);
  store = f.open();
  assert.equal((await store.auth.state.keys.get('session', ['shared'])).shared, undefined);
  assert.deepEqual((await store.auth.state.keys.get('identity-key', ['shared'])).shared, bytes);
});

test('a failed Signal key batch rolls back both deletions and writes', async t => {
  const f = fixture(t);
  let store = f.open();
  const original = Buffer.from([1, 2, 3]);
  await store.auth.state.keys.set({ session: { original } });
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  await assert.rejects(async () => store.auth.state.keys.set({
    session: { original: null, added: Buffer.from([4]) },
    tctoken: { invalid: circular },
  } as unknown as SignalDataSet));
  f.close(store);
  store = f.open();
  const sessions = await store.auth.state.keys.get('session', ['original', 'added']);
  assert.deepEqual(sessions.original, original);
  assert.equal(sessions.added, undefined);
  assert.equal((await store.auth.state.keys.get('tctoken', ['invalid'])).invalid, undefined);
});

test('queued voice and quoted PDF round-trip and failed inbound IDs stay deduplicated after restart', t => {
  const f = fixture(t);
  let store = f.open();
  const c = command('voice-request');
  const mediaKey = Buffer.from([0, 255, 1, 2]);
  const referenceKey = Buffer.from([77, 8, 9, 254]);
  const quoted: WAMessage = {
    key: { remoteJid: '300@lid', remoteJidAlt: chat, id: 'pdf-reference' },
    message: proto.Message.fromObject({
      documentMessage: { mediaKey: referenceKey, fileSha256: referenceKey, mimetype: 'application/pdf', fileName: 'invoice.pdf' },
    }),
  };
  c.message = {
    key: { ...c.message.key, remoteJid: '300@lid', remoteJidAlt: chat, addressingMode: 'lid' },
    message: proto.Message.fromObject({
      audioMessage: {
        mediaKey, fileSha256: mediaKey, mimetype: 'audio/ogg', ptt: true,
        contextInfo: { quotedMessage: quoted.message },
      },
    }),
  };
  c.attachment = { kind: 'audio', message: c.message, mimeType: 'audio/ogg' };
  c.reference = { kind: 'pdf', message: quoted, mimeType: 'application/pdf', filename: 'invoice.pdf' };
  assert.equal(store.enqueue(c), true);
  f.close(store);
  store = f.open();
  assert.equal(store.enqueue(c), false);
  const claimed = store.next(account)!;
  assert.equal(claimed.id, c.id);
  assert.equal(claimed.message.key.remoteJidAlt, chat);
  assert.equal(claimed.message.key.addressingMode, 'lid');
  assert.equal(claimed.attachment.message.key.remoteJidAlt, chat);
  assert.deepEqual(claimed.attachment.message.message?.audioMessage?.mediaKey, mediaKey);
  assert.deepEqual(claimed.message.message?.audioMessage?.contextInfo?.quotedMessage?.documentMessage?.fileSha256, referenceKey);
  assert.equal(claimed.reference?.message.key.remoteJidAlt, chat);
  assert.deepEqual(claimed.reference?.message.message?.documentMessage?.mediaKey, referenceKey);
  assert.equal(store.next(account), undefined);
  store.fail(claimed);
  f.close(store);
  store = f.open();
  assert.equal(store.enqueue(c), false);
  assert.equal(store.next(account), undefined);
  assert.deepEqual(store.history(c), []);
});

test('FIFO claims and completed-turn history are isolated by account and chat, bounded and chronological', t => {
  const f = fixture(t);
  const store = f.open();
  const own = command('same');
  const otherAccount = command('same', '999@s.whatsapp.net');
  const otherChat = command('same', account, '200@lid');
  for (const c of [own, otherAccount, otherChat]) assert.equal(store.enqueue(c), true);
  assert.equal(store.next('unknown@s.whatsapp.net'), undefined);
  assert.equal(store.next(otherAccount.accountId)?.accountId, otherAccount.accountId);
  store.complete(otherAccount, { userText: 'other account question', replyText: 'other account answer' });
  assert.equal(store.next(account)?.chatId, own.chatId);
  store.complete(own, { userText: 'own question', replyText: 'own answer' });
  assert.equal(store.next(account)?.chatId, otherChat.chatId);
  store.complete(otherChat, { userText: 'other chat question', replyText: 'other chat answer' });
  assert.deepEqual(store.history(own), [
    { role: 'user', content: 'own question' }, { role: 'assistant', content: 'own answer' },
  ]);
  assert.deepEqual(store.history(otherAccount), [
    { role: 'user', content: 'other account question' }, { role: 'assistant', content: 'other account answer' },
  ]);
  assert.deepEqual(store.history(otherChat), [
    { role: 'user', content: 'other chat question' }, { role: 'assistant', content: 'other chat answer' },
  ]);
  const turns: HistoryItem[] = [];
  for (let n = 0; n < 12; n++) {
    const c = command(`turn-${n}`);
    store.enqueue(c);
    assert.equal(store.next(account)?.id, c.id);
    store.complete(c, { userText: `transcribed ${n}`, replyText: `answer ${n}` });
    turns.push({ role: 'user', content: `transcribed ${n}` }, { role: 'assistant', content: `answer ${n}` });
  }
  assert.deepEqual(store.history(own), turns.slice(-20));
  assert.deepEqual(store.history(own, 100), turns.slice(-20));
  assert.deepEqual(store.history(own, 2), turns.slice(-4));
  assert.deepEqual(store.history(own, 0), []);
  assert.throws(() => store.history(own, -1), RangeError);

  const processing = command('processing');
  const pending = command('pending');
  store.enqueue(processing);
  store.enqueue(pending);
  assert.throws(() => store.complete(pending, { userText: 'unsent', replyText: 'unsent' }));
  assert.equal(store.next(account)?.id, processing.id);
  assert.deepEqual(store.history(own), turns.slice(-20));
  store.fail(processing);
  assert.throws(() => store.complete(processing, { userText: 'failed', replyText: 'failed' }));
  assert.throws(() => store.complete(command('turn-11'), { userText: 'rewrite', replyText: 'rewrite' }));
  assert.deepEqual(store.history(own), turns.slice(-20));
});

test('restart recovery fails uncertain processing without requeueing and preserves pending work', t => {
  const f = fixture(t);
  let store = f.open();
  const completed = command('completed');
  const failed = command('failed');
  const interrupted = command('interrupted');
  const pending = command('pending');
  const otherInterrupted = command('interrupted', '999@s.whatsapp.net');
  const otherPending = command('pending', otherInterrupted.accountId);
  store.enqueue(completed);
  store.next(account);
  store.complete(completed, { userText: 'question', replyText: 'answer' });
  store.enqueue(failed);
  store.next(account);
  store.fail(failed);
  for (const c of [interrupted, otherInterrupted]) {
    store.enqueue(c);
    store.next(c.accountId);
  }
  store.enqueue(pending);
  store.enqueue(otherPending);
  f.close(store);
  store = f.open();
  assert.equal(store.recoverInterrupted(), 2);
  assert.equal(store.recoverInterrupted(), 0);
  for (const c of [completed, failed, interrupted, pending, otherInterrupted, otherPending]) {
    assert.equal(store.enqueue(c), false);
  }
  assert.deepEqual(store.history(completed), [
    { role: 'user', content: 'question' }, { role: 'assistant', content: 'answer' },
  ]);
  assert.equal(store.next(otherPending.accountId)?.id, otherPending.id);
  assert.equal(store.next(account)?.id, pending.id);
  assert.equal(store.next(account), undefined);
  assert.equal(store.next(otherPending.accountId), undefined);
});

test('retry cache normalizes device JIDs but never mixes PN, LID, accounts or incomplete keys', t => {
  const f = fixture(t);
  let store = f.open();
  const mediaKey = Buffer.from([5, 0, 255, 12]);
  const message = proto.WebMessageInfo.fromObject({
    key: { remoteJid: '200:7@c.us', id: 'cached' },
    message: { imageMessage: { mediaKey, fileSha256: mediaKey, mimetype: 'image/jpeg' } },
  }) as WAMessage;
  store.cacheMessage(account, message);
  store.cacheMessage(account, { key: { remoteJid: '200@lid', id: 'cached' }, message: { conversation: 'LID reply' } });
  store.cacheMessage('999@s.whatsapp.net', { key: message.key, message: { conversation: 'other account reply' } });
  store.cacheMessage(account, { key: message.key });
  store.cacheMessage(account, { key: {}, message: { conversation: 'no key' } });
  store.cacheMessage(account, { message: { conversation: 'absent key object' } } as WAMessage);
  f.close(store);
  store = f.open();
  assert.deepEqual(store.getMessage(account, { remoteJid: chat, id: 'cached' })?.imageMessage?.mediaKey, mediaKey);
  assert.equal(store.getMessage(account, { remoteJid: '200:4@lid', id: 'cached' })?.conversation, 'LID reply');
  assert.equal(store.getMessage('999@s.whatsapp.net', { remoteJid: chat, id: 'cached' })?.conversation, 'other account reply');
  assert.equal(store.getMessage(account, { remoteJid: '300@s.whatsapp.net', id: 'cached' }), undefined);
  assert.equal(store.getMessage(account, { remoteJidAlt: chat, id: 'cached' }), undefined);
  assert.equal(store.getMessage(account, { remoteJid: chat }), undefined);
  assert.equal(store.getMessage(account, { remoteJid: 'invalid', id: 'cached' }), undefined);
  assert.equal(store.getMessage('', { remoteJid: chat, id: 'cached' }), undefined);
});

test('existing corrupt or uninitialized databases fail closed instead of replacing auth', t => {
  const f = fixture(t);
  const corruptPath = join(f.root, 'corrupt.sqlite');
  const corrupt = Buffer.from('not a sqlite database');
  writeFileSync(corruptPath, corrupt, { mode: 0o600 });
  assert.throws(() => openStore(corruptPath));
  assert.deepEqual(readFileSync(corruptPath), corrupt);
  const emptyPath = join(f.root, 'empty.sqlite');
  new DatabaseSync(emptyPath).close();
  assert.throws(() => openStore(emptyPath));
  const publicDirectory = join(f.root, 'public');
  mkdirSync(publicDirectory);
  chmodSync(publicDirectory, 0o755);
  assert.throws(() => openStore(join(publicDirectory, 'session.sqlite')));
  assert.equal(statSync(publicDirectory).mode & 0o777, 0o755);
});

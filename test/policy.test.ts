import assert from 'node:assert/strict';
import test from 'node:test';
import type { proto, WAMessage } from '@whiskeysockets/baileys';
import { selectCommands } from '../src/policy.ts';
import type { Config, Identity } from '../src/types.ts';

const identity: Identity = { id: '551100000001:7@s.whatsapp.net', lid: '901:2@lid' };
const selfPn = '551100000001@s.whatsapp.net';
const peerPn = '551100000002@s.whatsapp.net';
const config: Config = {
  apiKey: '', model: '', transcriptionModel: '', databasePath: '', allowedJids: new Set(), pairOnly: false,
};
function message(id: string, content: proto.IMessage, key: Partial<WAMessage['key']> = {}): WAMessage {
  return { key: { id, remoteJid: selfPn, fromMe: true, ...key }, message: content };
}
function voice(context?: proto.IContextInfo): proto.IMessage {
  return { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true, contextInfo: context } };
}
function select(messages: WAMessage[], overrides: Partial<Config> = {}, type = 'notify') {
  return selectCommands({ type, messages }, identity, { ...config, ...overrides });
}
function quote(content: proto.IMessage, context: Partial<proto.IContextInfo> = {}): proto.IMessage {
  return voice({ stanzaId: 'original', participant: selfPn, quotedMessage: content, ...context });
}

test('direct voice from self PN and own LID resolves to one account/chat without cross-domain numeric matching', () => {
  const commands = select([
    message('pn', voice(), { remoteJid: '551100000001:9@s.whatsapp.net' }),
    message('lid', voice(), { remoteJid: '901:4@lid' }),
    message('pn-as-lid', voice(), { remoteJid: '551100000001@lid' }),
    message('lid-as-pn', voice(), { remoteJid: '901@s.whatsapp.net' }),
  ]);
  assert.deepEqual(commands.map(c => [c.id, c.accountId, c.chatId, c.attachment.kind]), [
    ['pn', selfPn, selfPn, 'audio'], ['lid', selfPn, selfPn, 'audio'],
  ]);
});

test('self voice requires fromMe, while opted-in private peers require received messages', () => {
  const commands = select([
    message('received-self', voice(), { fromMe: false }),
    message('sent-peer', voice(), { remoteJid: peerPn }),
    message('received-peer', voice(), { remoteJid: peerPn, fromMe: false }),
    message('unknown-direction', voice(), { remoteJid: peerPn, fromMe: undefined }),
  ], { allowedJids: new Set([peerPn]) });
  assert.deepEqual(commands.map(c => c.id), ['received-peer']);
});

test('only trusted PN alias metadata opts a LID peer in and provides its canonical chat ID', () => {
  const commands = select([
    message('alias', voice(), { remoteJid: '902@lid', remoteJidAlt: peerPn, fromMe: false }),
    message('no-alias', voice(), { remoteJid: '902@lid', fromMe: false }),
    message('numeric-only', voice(), { remoteJid: '551100000002@lid', fromMe: false }),
    message('self-alias', voice(), { remoteJid: '999@lid', remoteJidAlt: selfPn }),
  ], { allowedJids: new Set([peerPn]) });
  assert.deepEqual(commands.map(c => [c.id, c.chatId, c.replyJid]), [
    ['alias', peerPn, '902@lid'], ['self-alias', selfPn, '999@lid'],
  ]);
  assert.equal(select([
    message('explicit-lid', voice(), { remoteJid: '902@lid', fromMe: false }),
  ], { allowedJids: new Set(['902@lid']) })[0]?.chatId, '902@lid');
});

test('foreign chats, groups, status and newsletters cannot enter through alternate IDs or an allowlist', () => {
  const excluded = [peerPn, '123@g.us', 'status@broadcast', '123@newsletter', '123@broadcast'];
  const messages = excluded.map((jid, i) => message(String(i), voice(), {
    remoteJid: jid, fromMe: false, remoteJidAlt: selfPn,
  }));
  assert.deepEqual(select(messages), []);
  assert.deepEqual(select(messages.slice(1), { allowedJids: new Set(excluded) }), []);
});

test('all new voices in a notify batch are selected, never history append or pairing traffic', () => {
  const messages = [message('one', voice()), message('text', { conversation: 'hello' }), message('two', voice())];
  assert.deepEqual(select(messages).map(c => c.id), ['one', 'two']);
  assert.deepEqual(select(messages, {}, 'append'), []);
  assert.deepEqual(select(messages, { pairOnly: true }), []);
});

test('text, bot replies, former trigger words and photo/PDF captions never activate, even when quoting audio', () => {
  assert.deepEqual(select([
    message('text', { conversation: 'process this' }),
    message('former-trigger', { conversation: '!sofia summarize' }),
    message('bot', { conversation: 'SofIA: summary' }),
    message('image', { imageMessage: { mimetype: 'image/jpeg', caption: '!sofia inspect' } }),
    message('pdf', { documentMessage: { mimetype: 'application/pdf', caption: 'explain' } }),
    message('video', { videoMessage: { mimetype: 'video/mp4' } }),
    message('text-quotes-audio', { extendedTextMessage: {
      text: 'summarize', contextInfo: { stanzaId: 'audio', participant: selfPn, quotedMessage: voice() },
    } }),
  ]), []);
});

test('normal and ephemeral voice notes directly provide the audio to transcribe without a text command', () => {
  const commands = select([
    message('normal', voice()), message('ephemeral', { ephemeralMessage: { message: voice() } }),
  ]);
  assert.deepEqual(commands.map(c => [c.attachment.kind, c.attachment.message.key.id, c.attachment.mimeType]), [
    ['audio', 'normal', 'audio/ogg'], ['audio', 'ephemeral', 'audio/ogg'],
  ]);
});

test('voice quoting an image/PDF keeps the voice instruction and a valid independent reference download key', () => {
  const image: proto.IMessage = { imageMessage: { mimetype: 'image/jpeg' } };
  const pdf: proto.IMessage = { documentWithCaptionMessage: { message: { documentMessage: { mimetype: 'application/pdf' } } } };
  const commands = select([
    message('voice-image', quote(image)),
    message('voice-pdf', { ephemeralMessage: { message: quote(pdf) } }),
  ]);
  assert.deepEqual(commands.map(c => [c.attachment.kind, c.attachment.message.key.id, c.reference?.kind, c.reference?.message.key.id]), [
    ['audio', 'voice-image', 'image', 'original'], ['audio', 'voice-pdf', 'pdf', 'original'],
  ]);
  const incoming = select([message('peer-voice', quote(image, { participant: peerPn }), {
    remoteJid: '902@lid', remoteJidAlt: peerPn, fromMe: false,
  })], { allowedJids: new Set([peerPn]) })[0]!;
  assert.equal(incoming.reference?.message.key.remoteJid, '902@lid');
  assert.equal(incoming.reference?.message.key.fromMe, false);
});

test('view-once voice wrappers get an unsupported notice without exposing their quote context', () => {
  const privateVoice = voice({ stanzaId: 'private-reference', quotedMessage: { imageMessage: { mimetype: 'image/jpeg' } } });
  const wrappers: proto.IMessage[] = [
    { viewOnceMessage: { message: privateVoice } },
    { viewOnceMessageV2: { message: privateVoice } },
    { ephemeralMessage: { message: { viewOnceMessageV2Extension: { message: privateVoice } } } },
  ];
  const commands = select(wrappers.map((body, i) => message(String(i), body)));
  assert.deepEqual(commands.map(c => c.attachment.kind), ['unsupported', 'unsupported', 'unsupported']);
  assert.ok(commands.every(c => c.reference === undefined));
  assert.deepEqual(select([message('private-photo-alone', { viewOnceMessageV2: { message: { imageMessage: { mimetype: 'image/jpeg' } } } })]), []);
});

test('view-once flags on audio/keys and quoted image wrappers also block forwarding', () => {
  const commands = select([
    message('private-key', voice(), { isViewOnce: true }),
    message('private-voice', { audioMessage: { viewOnce: true, mimetype: 'audio/ogg' } }),
    message('private-reference', quote({ ephemeralMessage: { message: {
      viewOnceMessageV2: { message: { imageMessage: { mimetype: 'image/jpeg' } } },
    } } })),
    message('private-image-flag', quote({ imageMessage: { viewOnce: true, mimetype: 'image/jpeg' } })),
  ]);
  assert.deepEqual(commands.slice(0, 2).map(c => c.attachment.kind), ['unsupported', 'unsupported']);
  assert.deepEqual(commands.slice(2).map(c => c.reference?.kind), ['unsupported', 'unsupported']);
});

test('voice rejects unsupported quoted media rather than silently passing it', () => {
  const commands = select([
    message('video', quote({ videoMessage: { mimetype: 'video/mp4' } })),
    message('document', quote({ documentMessage: { mimetype: 'application/zip' } })),
    message('audio', quote(voice())),
  ]);
  assert.deepEqual(commands.map(c => c.reference?.kind), ['unsupported', 'unsupported', 'unsupported']);
});

test('voice replying to normal text stays an audio followup without a binary reference', () => {
  const commands = select([
    message('answer-followup', quote({ conversation: 'SofIA: previous answer' })),
    message('ephemeral-text-followup', quote({ ephemeralMessage: { message: { extendedTextMessage: { text: 'prior answer' } } } })),
  ]);
  assert.deepEqual(commands.map(c => [c.id, c.attachment.kind, c.reference]), [
    ['answer-followup', 'audio', undefined], ['ephemeral-text-followup', 'audio', undefined],
  ]);
});

test('missing IDs, foreign quote chats and foreign authors cannot become reference reupload requests', () => {
  const image: proto.IMessage = { imageMessage: { mimetype: 'image/jpeg' } };
  const commands = select([
    message('missing-id', quote(image, { stanzaId: null })),
    message('foreign-chat', quote(image, { remoteJid: peerPn })),
    message('group-quote', quote(image, { remoteJid: '123@g.us' })),
    message('foreign-author', quote(image, { participant: peerPn })),
  ]);
  assert.deepEqual(commands.map(c => c.reference?.kind), ['unsupported', 'unsupported', 'unsupported', 'unsupported']);
});

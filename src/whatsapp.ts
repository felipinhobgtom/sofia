import type { Transform } from 'node:stream';
import makeWASocket, { DisconnectReason, downloadMediaMessage } from '@whiskeysockets/baileys';
import type { AuthenticationCreds, BaileysEventMap, WASocket } from '@whiskeysockets/baileys';
import pino from 'pino';
import { getAttachment, normalizePrivateJid, selectCommands } from './policy.ts';
import type { Store } from './store.ts';
import { UserInputError } from './types.ts';
import type { Attachment, Command, Config, Identity, Media, PreparedInput } from './types.ts';

const logger = pino({ level: 'silent' });
const maxMediaBytes = 20 * 1024 * 1024;
const downloadTimeoutMs = 60_000;
const maxReconnects = 6;
const formats: Record<string, { kind: Media['kind']; mimeType: string; extension: string }> = {
  'audio/ogg': { kind: 'audio', mimeType: 'audio/ogg', extension: 'ogg' },
  'audio/mpeg': { kind: 'audio', mimeType: 'audio/mpeg', extension: 'mp3' },
  'audio/mp3': { kind: 'audio', mimeType: 'audio/mpeg', extension: 'mp3' },
  'audio/mp4': { kind: 'audio', mimeType: 'audio/mp4', extension: 'm4a' },
  'audio/x-m4a': { kind: 'audio', mimeType: 'audio/mp4', extension: 'm4a' },
  'audio/wav': { kind: 'audio', mimeType: 'audio/wav', extension: 'wav' },
  'audio/x-wav': { kind: 'audio', mimeType: 'audio/wav', extension: 'wav' },
  'audio/webm': { kind: 'audio', mimeType: 'audio/webm', extension: 'webm' },
  'audio/flac': { kind: 'audio', mimeType: 'audio/flac', extension: 'flac' },
  'audio/x-flac': { kind: 'audio', mimeType: 'audio/flac', extension: 'flac' },
  'image/jpeg': { kind: 'image', mimeType: 'image/jpeg', extension: 'jpg' },
  'image/png': { kind: 'image', mimeType: 'image/png', extension: 'png' },
  'image/webp': { kind: 'image', mimeType: 'image/webp', extension: 'webp' },
  'application/pdf': { kind: 'pdf', mimeType: 'application/pdf', extension: 'pdf' },
};

function matchesType(bytes: Buffer, mimeType: string): boolean {
  const header = (value: string, offset = 0) => bytes.toString('latin1', offset, offset + value.length) === value;
  switch (mimeType) {
    case 'audio/ogg': return header('OggS');
    case 'audio/flac': return header('fLaC');
    case 'audio/mpeg': return header('ID3') || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0);
    case 'audio/mp4': return header('ftyp', 4);
    case 'audio/wav': return (header('RIFF') || header('RF64')) && header('WAVE', 8);
    case 'audio/webm': return header('\x1a\x45\xdf\xa3');
    case 'image/jpeg': return header('\xff\xd8\xff');
    case 'image/png': return header('\x89PNG\r\n\x1a\n');
    case 'image/webp': return header('RIFF') && header('WEBP', 8);
    case 'application/pdf': return bytes.subarray(0, 1024).includes('%PDF-');
    default: return false;
  }
}

interface Connection {
  socket: WASocket;
  accountId?: string;
  identity?: Identity;
  connected: boolean;
  detach(): void;
}
interface Callbacks {
  onCommand(command: Command): void;
  onConnection(connected: boolean, identity?: Identity): void;
  onQr(qr: string): void;
  onFatal(error: Error): void;
}

export interface WhatsApp {
  send(command: Command, text: string): Promise<void>;
  download(command: Command): Promise<PreparedInput>;
  close(): void;
}

export function createWhatsApp(config: Config, store: Store, callbacks: Callbacks): WhatsApp {
  let current: Connection | undefined;
  let stopped = false;
  let fatalReported = false;
  let reconnects = 0;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let stableTimer: NodeJS.Timeout | undefined;
  let pendingCreds = Promise.resolve();
  let disposal = Promise.resolve();

  function fatal(message: string): void {
    if (fatalReported) return;
    fatalReported = true;
    close();
    callbacks.onFatal(new Error(message));
  }

  function saveCreds(update?: Partial<AuthenticationCreds>): void {
    // Store writes SQLite synchronously before returning its Promise, including at close().
    const saved = store.auth.saveCreds(update).catch(() => fatal('Unable to save the local WhatsApp device session.'));
    pendingCreds = Promise.all([pendingCreds, saved]).then(() => undefined);
  }

  function dispose(connection: Connection): void {
    connection.connected = false;
    connection.detach();
    if (current === connection) current = undefined;
    clearTimeout(stableTimer);
    stableTimer = undefined;
    disposal = pendingCreds.then(() => connection.socket.end(undefined)).catch(() => {
      fatal('Unable to close the WhatsApp connection safely.');
    });
  }

  function close(): void {
    if (stopped) return;
    stopped = true;
    clearTimeout(reconnectTimer);
    clearTimeout(stableTimer);
    reconnectTimer = undefined;
    stableTimer = undefined;
    saveCreds();
    if (current) {
      dispose(current);
      callbacks.onConnection(false);
    }
  }

  function reconnect(): void {
    if (stopped) return;
    if (reconnects >= maxReconnects) {
      fatal('WhatsApp reconnect limit reached. Check the connection and restart SofIA.');
      return;
    }
    const delay = Math.min(1_000 * 2 ** reconnects++, 30_000);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void disposal.then(() => { if (!stopped) connect(); });
    }, delay);
  }

  function connect(): void {
    if (stopped || current) return;
    let connection: Connection | undefined;
    let socket: WASocket;
    try {
      socket = makeWASocket({
        auth: store.auth.state,
        logger,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        shouldIgnoreJid: jid => jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter'),
        maxMsgRetryCount: 0,
        enableAutoSessionRecreation: false,
        enableRecentMessageCache: false,
        connectTimeoutMs: 30_000,
        defaultQueryTimeoutMs: 30_000,
        getMessage: async key => {
          if (stopped || !connection || current !== connection || !connection.accountId) return undefined;
          try { return store.getMessage(connection.accountId, key); }
          catch {
            fatal('Unable to read the local WhatsApp message cache.');
            return undefined;
          }
        },
      });
    } catch {
      fatal('Unable to start the WhatsApp connection.');
      return;
    }
    const active = () => !stopped && current === connection;
    const onCreds = (update: Partial<AuthenticationCreds>) => { if (active()) saveCreds(update); };
    const onMessages = (upsert: BaileysEventMap['messages.upsert']) => {
      if (!active() || !connection?.connected || !connection.identity || config.pairOnly) return;
      try {
        for (const command of selectCommands(upsert, connection.identity, config)) {
          if (!active()) break;
          callbacks.onCommand(command);
        }
      } catch { fatal('Unable to queue the WhatsApp command locally.'); }
    };
    const onUpdate = (update: BaileysEventMap['connection.update']) => {
      if (!active() || !connection) return;
      if (update.qr) callbacks.onQr(update.qr);
      if (!active()) return;
      if (update.connection === 'open') {
        const id = normalizePrivateJid(socket.user?.id);
        if (!id) { fatal('WhatsApp connected without a valid private account identity.'); return; }
        connection.identity = { id, lid: normalizePrivateJid(socket.user?.lid) };
        connection.accountId = id;
        connection.connected = true;
        clearTimeout(stableTimer);
        // A rapid open/close loop must not reset the bounded reconnect budget.
        stableTimer = setTimeout(() => { if (active()) reconnects = 0; }, 60_000);
        stableTimer.unref();
        callbacks.onConnection(true, connection.identity);
      } else if (update.connection === 'close') {
        const error = update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined;
        const reason = error?.output?.statusCode;
        dispose(connection);
        callbacks.onConnection(false);
        if (reason === DisconnectReason.loggedOut || reason === DisconnectReason.connectionReplaced
          || reason === DisconnectReason.badSession || reason === DisconnectReason.multideviceMismatch
          || reason === DisconnectReason.forbidden) {
          fatal('WhatsApp device session ended or was rejected. Check Linked devices before pairing again.');
        } else {
          // Includes restartRequired after QR pairing; always wait for disposal before a new socket.
          reconnect();
        }
      }
    };
    connection = {
      socket, connected: false, accountId: normalizePrivateJid(store.auth.state.creds.me?.id),
      detach: () => {
        socket.ev.off('creds.update', onCreds);
        socket.ev.off('messages.upsert', onMessages);
        socket.ev.off('connection.update', onUpdate);
      },
    };
    current = connection;
    socket.ev.on('creds.update', onCreds);
    socket.ev.on('messages.upsert', onMessages);
    socket.ev.on('connection.update', onUpdate);
  }

  function ready(command: Command): Connection {
    if (stopped || config.pairOnly || !current?.connected || current.accountId !== command.accountId
      || normalizePrivateJid(current.socket.user?.id) !== command.accountId) {
      throw new Error('WhatsApp is not connected to the account for this command.');
    }
    return current;
  }

  async function send(command: Command, text: string): Promise<void> {
    const connection = ready(command);
    try {
      const sent = await connection.socket.sendMessage(command.replyJid, { text: `SofIA: ${text}`, linkPreview: null });
      if (!sent) throw new Error('No sent message.');
      store.cacheMessage(command.accountId, sent);
    } catch {
      // The send may already have succeeded. Never retry an ambiguous delivery.
      throw new Error('WhatsApp reply delivery or local caching failed; it will not be retried automatically.');
    }
  }

  async function download(command: Command): Promise<PreparedInput> {
    if (command.attachment.kind !== 'audio') {
      throw new UserInputError('Unsupported or view-once voice message. Send a normal audio message to SofIA.');
    }
    if (command.reference && command.reference.kind !== 'image' && command.reference.kind !== 'pdf') {
      throw new UserInputError('Unsupported or view-once reference. Record your voice reply to a normal JPEG/PNG/WebP image or PDF.');
    }
    const audio = await downloadAttachment(command, command.attachment);
    const reference = command.reference ? await downloadAttachment(command, command.reference) : undefined;
    return reference ? { audio, reference } : { audio };
  }

  async function downloadAttachment(command: Command, source: Attachment): Promise<Media> {
    const attachment = getAttachment(source.message);
    if (source.kind === 'unsupported' || !attachment || attachment.kind === 'unsupported' || attachment.kind !== source.kind) {
      throw new UserInputError('Unsupported or view-once attachment. Send normal audio, optionally replying to a normal image or PDF.');
    }
    const format = formats[attachment.mimeType];
    if (!format || format.kind !== attachment.kind) {
      throw new UserInputError('Unsupported file format. Use OGG/MP3/MP4/WAV/WebM/FLAC audio, JPEG/PNG/WebP, or PDF; AAC and AMR are not converted.');
    }
    const content = attachment.message.message!;
    const metadata = content.audioMessage ?? content.imageMessage ?? content.documentMessage;
    if (metadata?.fileLength != null) {
      let length: bigint;
      try { length = BigInt(metadata.fileLength.toString()); }
      catch { throw new UserInputError('The attachment has invalid file-size metadata.'); }
      if (length < 0n || length > BigInt(maxMediaBytes)) throw new UserInputError('Attachments must be at most 20 MiB.');
    }
    const connection = ready(command);
    const controller = new AbortController();
    let stream: Transform | undefined;
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(new UserInputError('Attachment download timed out or was interrupted.'));
        stream?.destroy();
      }, { once: true });
    });
    const timer = setTimeout(() => controller.abort(), downloadTimeoutMs);
    async function load(): Promise<Media> {
      stream = await downloadMediaMessage(attachment!.message, 'stream', { options: { signal: controller.signal } }, {
        logger,
        reuploadRequest: async message => {
          if (controller.signal.aborted || ready(command) !== connection) throw new Error('Download interrupted.');
          const updated = await connection.socket.updateMediaMessage(message);
          if (controller.signal.aborted) throw new Error('Download interrupted.');
          return updated;
        },
      });
      if (controller.signal.aborted) { stream.destroy(); throw new Error('Download interrupted.'); }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream) {
        if (!(chunk instanceof Uint8Array)) throw new Error('Invalid media stream.');
        size += chunk.byteLength;
        if (size > maxMediaBytes) throw new UserInputError('Attachments must be at most 20 MiB.');
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks, size);
      if (!matchesType(bytes, format.mimeType)) throw new UserInputError('The attachment is empty or does not match a supported file format.');
      return { bytes, kind: format.kind, mimeType: format.mimeType, filename: `media.${format.extension}` };
    }
    try {
      return await Promise.race([load(), aborted]);
    } catch (error) {
      if (error instanceof UserInputError) throw error;
      throw new UserInputError('Unable to download the attachment. Send the audio again; for a photo or PDF, record your voice as a reply to that file.');
    } finally {
      clearTimeout(timer);
      controller.abort();
      stream?.destroy();
    }
  }

  queueMicrotask(connect);
  return { send, download, close };
}

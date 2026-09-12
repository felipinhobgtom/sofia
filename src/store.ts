import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLOutputValue } from 'node:sqlite';
import { BufferJSON, initAuthCreds, jidNormalizedUser, proto } from '@whiskeysockets/baileys';
import type {
  AuthenticationCreds, AuthenticationState, SignalDataTypeMap, WAMessage, WAMessageKey,
} from '@whiskeysockets/baileys';
import type { AgentReply, Command, HistoryItem } from './types.ts';

export interface Store {
  auth: {
    state: AuthenticationState;
    saveCreds(update?: Partial<AuthenticationCreds>): Promise<void>;
  };
  enqueue(c: Command): boolean;
  next(accountId: string): Command | undefined;
  complete(c: Command, result: AgentReply): void;
  fail(c: Command): void;
  recoverInterrupted(): number;
  history(c: Command, limit?: number): HistoryItem[];
  cacheMessage(accountId: string, m: WAMessage): void;
  getMessage(accountId: string, key: WAMessageKey): proto.IMessage | undefined;
  close(): void;
}

function encode(value: unknown): string {
  try {
    const text = JSON.stringify(value, BufferJSON.replacer);
    if (text === undefined) throw new Error();
    return text;
  } catch {
    // Serialization errors can otherwise include private payload excerpts.
    throw new Error('Unable to encode local state.');
  }
}

function decode<T>(value: SQLOutputValue): T {
  try {
    if (typeof value !== 'string') throw new Error();
    return JSON.parse(value, BufferJSON.reviver) as T;
  } catch {
    throw new Error('Unable to decode local state.');
  }
}

function restoreMessage(message: WAMessage): void {
  // Baileys key extensions (notably remoteJidAlt) are absent from the protobuf schema.
  const key = message.key;
  Object.assign(message, proto.WebMessageInfo.fromObject(message));
  message.key = key;
}

function decodeCommand(value: SQLOutputValue): Command {
  const command = decode<Command>(value);
  // Protobuf instances serialize bytes as base64 before BufferJSON runs.
  restoreMessage(command.message);
  if (command.attachment) restoreMessage(command.attachment.message);
  if (command.reference) restoreMessage(command.reference.message);
  return command;
}

function cacheChat(key: WAMessageKey | null | undefined): string | undefined {
  if (!key?.id || !key.remoteJid) return;
  const jid = jidNormalizedUser(key.remoteJid);
  return jid && !jid.startsWith('@') ? jid : undefined;
}

export function openStore(databasePath: string): Store {
  let fresh = databasePath === ':memory:';
  if (!fresh) {
    databasePath = resolve(databasePath);
    const directory = dirname(databasePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const directoryInfo = lstatSync(directory);
    if (!directoryInfo.isDirectory() || (directoryInfo.mode & 0o077) !== 0) {
      throw new Error('The database directory must be private (0700).');
    }
    try {
      const descriptor = openSync(databasePath, 'wx', 0o600);
      closeSync(descriptor);
      fresh = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!lstatSync(databasePath).isFile()) {
        throw new Error('The database must be a regular file, not a symbolic link.');
      }
    }
    chmodSync(databasePath, 0o600);
  }

  const db = new DatabaseSync(databasePath);
  try {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    if (fresh) {
      db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE credentials (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL);
        CREATE TABLE signal_keys (
          category TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL,
          PRIMARY KEY (category, id)
        ) WITHOUT ROWID;
        CREATE TABLE inbox (
          sequence INTEGER PRIMARY KEY,
          account_id TEXT NOT NULL, chat_id TEXT NOT NULL, id TEXT NOT NULL,
          command TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'complete', 'failed')),
          user_text TEXT, reply_text TEXT,
          UNIQUE (account_id, chat_id, id)
        );
        CREATE INDEX inbox_pending ON inbox (account_id, sequence) WHERE status = 'pending';
        CREATE INDEX inbox_history ON inbox (account_id, chat_id, sequence DESC) WHERE status = 'complete';
        CREATE TABLE message_cache (
          account_id TEXT NOT NULL, chat_id TEXT NOT NULL, id TEXT NOT NULL, message TEXT NOT NULL,
          PRIMARY KEY (account_id, chat_id, id)
        ) WITHOUT ROWID;
      `);
    }
    const writeCreds = db.prepare(`
      INSERT INTO credentials (id, value) VALUES (1, ?)
      ON CONFLICT (id) DO UPDATE SET value = excluded.value
    `);
    let creds: AuthenticationCreds;
    if (fresh) {
      creds = initAuthCreds();
      writeCreds.run(encode(creds));
      db.exec('COMMIT;');
    } else {
      const row = db.prepare('SELECT value FROM credentials WHERE id = 1').get();
      if (!row) throw new Error('Stored authentication credentials are missing.');
      creds = decode<AuthenticationCreds>(row.value);
      if (!creds || !Buffer.isBuffer(creds.noiseKey?.private)
        || !Buffer.isBuffer(creds.signedIdentityKey?.private) || typeof creds.registered !== 'boolean') {
        throw new Error('Stored authentication credentials are invalid.');
      }
      if (creds.account) creds.account = proto.ADVSignedDeviceIdentity.fromObject(creds.account);
    }

    const readKey = db.prepare('SELECT value FROM signal_keys WHERE category = ? AND id = ?');
    const writeKey = db.prepare(`
      INSERT INTO signal_keys (category, id, value) VALUES (?, ?, ?)
      ON CONFLICT (category, id) DO UPDATE SET value = excluded.value
    `);
    const deleteKey = db.prepare('DELETE FROM signal_keys WHERE category = ? AND id = ?');
    const begin = db.prepare('BEGIN IMMEDIATE');
    const commit = db.prepare('COMMIT');
    const rollback = db.prepare('ROLLBACK');
    const insertCommand = db.prepare(`
      INSERT INTO inbox (account_id, chat_id, id, command, status) VALUES (?, ?, ?, ?, 'pending')
      ON CONFLICT (account_id, chat_id, id) DO NOTHING
    `);
    const claim = db.prepare(`
      UPDATE inbox SET status = 'processing'
      WHERE sequence = (
        SELECT sequence FROM inbox WHERE account_id = ? AND status = 'pending' ORDER BY sequence LIMIT 1
      ) RETURNING command
    `);
    const finish = db.prepare(`
      UPDATE inbox SET status = 'complete', user_text = ?, reply_text = ?
      WHERE account_id = ? AND chat_id = ? AND id = ? AND status = 'processing'
    `);
    const fail = db.prepare(`
      UPDATE inbox SET status = 'failed'
      WHERE account_id = ? AND chat_id = ? AND id = ? AND status = 'processing'
    `);
    const recover = db.prepare("UPDATE inbox SET status = 'failed' WHERE status = 'processing'");
    const readHistory = db.prepare(`
      SELECT user_text, reply_text FROM (
        SELECT sequence, user_text, reply_text FROM inbox
        WHERE account_id = ? AND chat_id = ? AND status = 'complete'
        ORDER BY sequence DESC LIMIT ?
      ) ORDER BY sequence
    `);
    const cache = db.prepare(`
      INSERT INTO message_cache (account_id, chat_id, id, message) VALUES (?, ?, ?, ?)
      ON CONFLICT (account_id, chat_id, id) DO UPDATE SET message = excluded.message
    `);
    const readMessage = db.prepare(`
      SELECT message FROM message_cache WHERE account_id = ? AND chat_id = ? AND id = ?
    `);

    const state: AuthenticationState = {
      creds,
      keys: {
        async get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
          const values: { [id: string]: SignalDataTypeMap[T] } = Object.create(null);
          for (const id of ids) {
            const row = readKey.get(type, id);
            if (!row) continue;
            let value = decode<unknown>(row.value);
            if (type === 'app-state-sync-key') {
              value = proto.Message.AppStateSyncKeyData.fromObject(value as object);
            }
            values[id] = value as SignalDataTypeMap[T];
          }
          return values;
        },
        async set(data) {
          begin.run();
          try {
            for (const [category, values] of Object.entries(data)) {
              if (!values) continue;
              for (const [id, value] of Object.entries(values)) {
                if (value === null) deleteKey.run(category, id);
                else writeKey.run(category, id, encode(value));
              }
            }
            commit.run();
          } catch (error) {
            rollback.run();
            throw error;
          }
        },
      },
    };
    return {
      auth: {
        state,
        async saveCreds(update) {
          if (update) Object.assign(creds, update);
          writeCreds.run(encode(creds));
        },
      },
      enqueue(c) {
        return insertCommand.run(c.accountId, c.chatId, c.id, encode(c)).changes === 1;
      },
      next(accountId) {
        const row = claim.get(accountId);
        return row ? decodeCommand(row.command) : undefined;
      },
      complete(c, result) {
        if (finish.run(result.userText, result.replyText, c.accountId, c.chatId, c.id).changes !== 1) {
          throw new Error('Only a processing command can be completed.');
        }
      },
      fail(c) {
        fail.run(c.accountId, c.chatId, c.id);
      },
      recoverInterrupted() {
        return Number(recover.run().changes);
      },
      history(c, limit = 10) {
        if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('Invalid history limit.');
        const rows = readHistory.all(c.accountId, c.chatId, Math.min(limit, 10));
        const items: HistoryItem[] = [];
        for (const row of rows) {
          items.push({ role: 'user', content: row.user_text as string });
          items.push({ role: 'assistant', content: row.reply_text as string });
        }
        return items;
      },
      cacheMessage(accountId, message) {
        const chatId = cacheChat(message.key);
        if (!accountId || !chatId || !message.message) return;
        cache.run(accountId, chatId, message.key.id!, encode(message));
      },
      getMessage(accountId, key) {
        const chatId = cacheChat(key);
        if (!accountId || !chatId) return;
        const row = readMessage.get(accountId, chatId, key.id!);
        if (!row) return;
        const message = decode<WAMessage>(row.message);
        return message.message ? proto.Message.fromObject(message.message) : undefined;
      },
      close() {
        db.close();
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

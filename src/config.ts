import { resolve } from 'node:path';
import type { Config } from './types.ts';

export function loadConfig(env: NodeJS.ProcessEnv, args: string[]): Config {
  if (args.some(arg => arg !== '--pair')) throw new Error('Argumento desconhecido. Use --help ou --pair.');
  const pairOnly = args.includes('--pair');
  const apiKey = env.GROQ_KEY?.trim() ?? '';
  if (!pairOnly && !apiKey) throw new Error('Defina GROQ_KEY no arquivo .env. Para apenas vincular a conta, use npm run pair.');
  const allowedJids = new Set<string>();
  for (const entry of (env.WHATSAPP_ALLOWED_JIDS ?? '').split(',')) {
    const jid = entry.trim();
    if (!jid) continue;
    const match = /^(\d+)(?::\d+)?@(s\.whatsapp\.net|lid)$/.exec(jid);
    if (!match) throw new Error('WHATSAPP_ALLOWED_JIDS aceita somente JIDs privados: numero@s.whatsapp.net ou identificador@lid.');
    allowedJids.add(match[1] + '@' + match[2]);
  }
  const databasePath = env.DATABASE_PATH?.trim() || './data/sofia.sqlite';
  if (databasePath === ':memory:') throw new Error('DATABASE_PATH precisa ser um arquivo persistente para proteger a sessão vinculada.');
  return { apiKey, allowedJids, pairOnly,
    model: env.GROQ_MODEL?.trim() || 'qwen/qwen3.6-27b',
    transcriptionModel: env.GROQ_TRANSCRIPTION_MODEL?.trim() || 'whisper-large-v3-turbo',
    databasePath: resolve(databasePath),
  };
}

import { resolve } from 'node:path';
import type { Config } from './types.ts';

export function loadConfig(env: NodeJS.ProcessEnv, args: string[]): Config {
  if (args.some(arg => arg !== '--pair' && arg !== '--dashboard')) throw new Error('Argumento desconhecido. Use --help, --pair ou --dashboard.');
  const pairOnly = args.includes('--pair');
  const dashboardOnly = args.includes('--dashboard');
  if (pairOnly && dashboardOnly) throw new Error('Escolha apenas um modo: --pair ou --dashboard.');
  const apiKey = env.GROQ_KEY?.trim() ?? '';
  if (!pairOnly && !dashboardOnly && !apiKey) throw new Error('Defina GROQ_KEY no arquivo .env. Sem IA, use npm run pair ou npm run dashboard.');
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
  const port = env.DASHBOARD_PORT?.trim() || '3000';
  if (!/^\d{1,5}$/.test(port) || Number(port) > 65535) throw new Error('DASHBOARD_PORT deve ser um número entre 0 e 65535.');
  const timeZone = env.TIME_ZONE?.trim() || 'America/Sao_Paulo';
  try { new Intl.DateTimeFormat('pt-BR', { timeZone }); }
  catch { throw new Error('TIME_ZONE deve ser um fuso IANA válido, como America/Sao_Paulo.'); }
  return { apiKey, allowedJids, pairOnly, dashboardOnly, dashboardPort: Number(port), timeZone,
    model: env.GROQ_MODEL?.trim() || 'qwen/qwen3.6-27b',
    transcriptionModel: env.GROQ_TRANSCRIPTION_MODEL?.trim() || 'whisper-large-v3-turbo',
    databasePath: resolve(databasePath),
  };
}

import { loadConfig } from './config.ts';
import { startApp } from './app.ts';

const help = `SofIA — WhatsApp pessoal via Baileys + Groq

Uso:
  npm run pair       Vincula a conta por QR; não exige chave Groq.
  npm start          Inicia o agente com GROQ_KEY configurada.
  npm start -- --help Mostra esta ajuda.

Envie um áudio diretamente na conversa consigo mesmo; não há prefixo ou palavra-chave.
Para analisar uma imagem ou PDF, responda ao arquivo com um áudio.
Textos comuns não disparam o bot. Outros chats privados exigem WHATSAPP_ALLOWED_JIDS.
Grupos, status e mídias de visualização única não são processados.

Baileys não é oficial: há risco de restrição da conta e incompatibilidades.
Proteja .env e data/. Encerre com Ctrl+C; não é necessário desvincular a conta.
`;

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { console.log(help); return; }
  process.umask(0o077);
  const config = loadConfig(process.env, args);
  const app = startApp(config);
  const stop = () => { void app.stop(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try { process.exitCode = await app.done; }
  finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Falha ao iniciar a SofIA.');
  process.exitCode = 1;
});

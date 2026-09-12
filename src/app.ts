import qrcode from 'qrcode-terminal';
import { createAgent } from './agent.ts';
import { openStore } from './store.ts';
import { createWhatsApp } from './whatsapp.ts';
import { selectCommands } from './policy.ts';
import { ProviderError, UserInputError } from './types.ts';
import type { Command, Config, Identity } from './types.ts';
import { startDashboard } from './dashboard.ts';

export async function startApp(config: Config, dependencies = {
  openStore, createAgent, createWhatsApp, startDashboard,
  info: (text: string) => console.log(text),
  error: (text: string) => console.error(text),
  qr: (value: string) => qrcode.generate(value, { small: true }),
}) {
  const store = dependencies.openStore(config.databasePath, config.timeZone);
  let dashboard: Awaited<ReturnType<typeof startDashboard>> | undefined;
  let transport: ReturnType<typeof createWhatsApp> | undefined;
  let agent: ReturnType<typeof createAgent> | undefined;
  let identity: Identity | undefined;
  let connected = false;
  let stopped = false;
  let requested = false;
  let work: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let exitCode = 0;
  let resolveDone!: (code: number) => void;
  const done = new Promise<number>(resolve => { resolveDone = resolve; });

  function stop(): Promise<void> {
    if (stopping) return stopping;
    stopped = true;
    connected = false;
    transport?.close();
    stopping = (async () => {
      const closing = dashboard?.close().catch(() => { exitCode = 1; dependencies.error('[Dashboard] Falha ao encerrar o servidor.'); });
      try { await work; }
      finally { await closing; store.close(); resolveDone(exitCode); }
    })();
    return stopping;
  }

  function fatal(error: unknown) {
    if (stopped) return;
    exitCode = 1;
    dependencies.error(error instanceof Error ? error.message : 'Falha interna no serviço.');
    void stop();
  }

  function authorized(command: Command): boolean {
    if (!identity) return false;
    return selectCommands({ type: 'notify', messages: [command.message] }, identity, config)
      .some(candidate => candidate.accountId === command.accountId && candidate.chatId === command.chatId && candidate.id === command.id);
  }

  async function drain() {
    while (connected && !stopped && identity) {
      requested = false;
      const command = store.next(identity.id);
      if (!command) break;
      if (!authorized(command)) {
        store.fail(command);
        dependencies.info('[SofIA] Comando pendente descartado: conversa não autorizada.');
        continue;
      }
      let stage: 'processing' | 'sending' | 'persisting' = 'processing';
      try {
        const media = await transport!.download(command);
        const result = await agent!.reply(command, store.history(command), media);
        if (stopped || !connected || !authorized(command)) throw new Error('Conexão ou autorização mudou durante o processamento.');
        stage = 'sending';
        await transport!.send(command, result.replyText, result.document);
        stage = 'persisting';
        store.complete(command, result);
        dependencies.info('[SofIA] Comando respondido.');
      } catch (error) {
        store.fail(command);
        const safeNotice = error instanceof UserInputError || error instanceof ProviderError ? error.message : undefined;
        dependencies.error(stage === 'processing'
          ? `[SofIA] ${safeNotice ?? 'Não foi possível processar o comando.'}`
          : '[SofIA] Envio ou gravação sem confirmação; não haverá reenvio automático.');
        if (stage === 'processing' && !stopped && connected && authorized(command)) {
          const notice = safeNotice
            ?? 'Não consegui processar este pedido. Tente enviar um novo áudio depois; se persistir, verifique o serviço da SofIA.';
          try { await transport!.send(command, notice); }
          catch { dependencies.error('[SofIA] Não foi possível enviar o aviso de erro.'); }
        }
      }
    }
  }

  function kick() {
    if (stopped || !connected || config.pairOnly) return;
    requested = true;
    if (work) return;
    work = drain().catch(fatal).finally(() => {
      work = undefined;
      if (requested && connected && !stopped) kick();
    });
  }

  try {
    if (!config.pairOnly) {
      dashboard = await dependencies.startDashboard({ business: store.business, port: config.dashboardPort });
      dependencies.info('[Dashboard] ' + dashboard.url + ' (acesso local)');
    }
    if (config.dashboardOnly) return { done, stop };
    if (!config.pairOnly) {
      const interrupted = store.recoverInterrupted();
      if (interrupted) dependencies.info('[SofIA] Execuções interrompidas foram marcadas como falhas, sem reenvio automático.');
      agent = dependencies.createAgent(config, store.business);
    }
    transport = dependencies.createWhatsApp(config, store, {
      onQr(value) {
        if (stopped) return;
        dependencies.info('[WhatsApp] No celular: Configurações > Dispositivos conectados > Conectar dispositivo. Não compartilhe este QR.');
        dependencies.qr(value);
      },
      onConnection(isConnected, currentIdentity) {
        if (stopped) return;
        connected = isConnected;
        identity = currentIdentity;
        if (!connected) return;
        dependencies.info('[WhatsApp] Conta vinculada e conectada.');
        if (config.pairOnly) {
          dependencies.info('[SofIA] Sessão salva. Configure GROQ_KEY e execute npm start.');
          queueMicrotask(() => { void stop(); });
        } else {
          dependencies.info('[SofIA] Envie um áudio diretamente na conversa consigo mesmo.');
          kick();
        }
      },
      onCommand(command) {
        if (stopped || config.pairOnly) return;
        try { if (store.enqueue(command)) kick(); }
        catch (error) { fatal(error); }
      },
      onFatal: fatal,
    });
  } catch (error) {
    transport?.close();
    await dashboard?.close();
    store.close();
    throw error;
  }
  return { done, stop };
}

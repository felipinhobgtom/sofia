import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import PDFDocument from 'pdfkit';
import { getGlobalTraceProvider } from '@openai/agents';
import { createAgent } from '../src/agent.ts';
import type { Command, Config, PreparedInput } from '../src/types.ts';
import { ProviderError, UserInputError } from '../src/types.ts';
import type { BusinessAction, Client, Visit } from '../src/business-contract.ts';
import { createBusinessStore } from '../src/business-store.ts';
import { renderPdfPages } from '../src/pdf.ts';

const config: Config = {
  apiKey: 'gsk-test-not-a-real-key',
  model: 'qwen/qwen3.6-27b',
  transcriptionModel: 'whisper-large-v3-turbo',
  databasePath: ':memory:',
  allowedJids: new Set(),
  pairOnly: false,
  dashboardOnly: false,
  dashboardPort: 3333,
  timeZone: 'America/Sao_Paulo',
};
const message: Command['message'] = {
  key: { id: 'message-1', fromMe: true },
  message: { audioMessage: { mimetype: 'audio/ogg', ptt: true } },
};
const command: Command = {
  id: 'message-1',
  accountId: '5511999999999@s.whatsapp.net',
  chatId: '5511999999999@s.whatsapp.net',
  replyJid: '5511999999999@s.whatsapp.net',
  message,
  attachment: { kind: 'audio', message, mimeType: 'audio/ogg' },
};
const actor = { accountId: command.accountId, chatId: command.chatId };
const input: PreparedInput = {
  audio: { kind: 'audio', mimeType: 'audio/ogg', filename: 'media.ogg', bytes: Buffer.from('OggS') },
};
const transcriptionUrl = 'https://api.groq.com/openai/v1/audio/transcriptions';
const chatUrl = 'https://api.groq.com/openai/v1/chat/completions';
const transcript = 'Resuma o pedido do cliente.';

type ChatPart = { type: string; text?: string; image_url?: { url: string } };
type ChatRequest = {
  messages: { role: string; content: string | ChatPart[] }[];
  tools?: { type: string; function: { name: string } }[];
};

function businessFixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  return createBusinessStore(db, { timeZone: 'America/Sao_Paulo' });
}

function selfCommand(id: string): Command {
  return { ...command, id, message: { ...message, key: { ...message.key, id } } };
}

const clientAction = {
  type: 'client.save', id: null, version: null,
  data: { name: 'Cliente Particular', phone: '', email: '', address: 'Rua Particular 27', notes: '', active: true },
} satisfies BusinessAction;

function functionCall(name: string, args: object, id = 'call-1') {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function toolCompletion(name: string, args: object, finish = 'tool_calls'): Response {
  return completion('', finish, { tool_calls: [functionCall(name, args)] });
}

function queryResult<T>(body: ChatRequest): { items: T[]; total: number } {
  const content = body.messages.filter(message => message.role === 'tool').at(-1)?.content;
  assert.equal(typeof content, 'string');
  return JSON.parse(content as string) as { items: T[]; total: number };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function completion(content = 'Resumo completo.', finishReason: string | null = 'stop', fields: object = {}): Response {
  return jsonResponse({
    id: 'chat-test',
    object: 'chat.completion',
    created: 1,
    model: config.model,
    choices: [{ index: 0, finish_reason: finishReason, message: { role: 'assistant', content, refusal: null, ...fields } }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  });
}

function intercept(t: TestContext, chat: (body: ChatRequest) => Response, text: string | (() => string) = transcript): string[] {
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const target = url instanceof Request ? url.url : String(url);
    if (target === 'data:,') return new Response('');
    requests.push(target);
    if (target === transcriptionUrl) return jsonResponse({ text: typeof text === 'function' ? text() : text });
    assert.equal(target, chatUrl);
    return chat(await new Request(url, init).json() as ChatRequest);
  });
  return requests;
}

function userParts(body: ChatRequest): ChatPart[] {
  return body.messages.filter(message => message.role === 'user').flatMap(message =>
    typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content);
}

// Small valid PDFs exercise the real local renderer, not a substitute generator.
function pdf(pages: string[]): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (const [index, text] of pages.entries()) {
    const stream = `BT /F1 12 Tf 20 100 Td (${text.replace(/[\\()]/g, '\\$&')}) Tj ET\n`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 150] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    );
  }
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

function withPdf(bytes: Buffer): PreparedInput {
  return { ...input, reference: { kind: 'pdf', mimeType: 'application/pdf', filename: 'referencia.pdf', bytes } };
}

test('rejects partial, filtered, refused, foreign-tool and empty chat output', async t => {
  const cases = [
    { name: 'length', finish: 'length', text: 'Texto privado pela metade' },
    { name: 'content filter', finish: 'content_filter', text: 'Texto privado filtrado' },
    { name: 'missing terminal reason', finish: null, text: 'Texto privado sem fim' },
    { name: 'refusal alongside text', finish: 'stop', text: 'Texto privado', fields: { refusal: 'Recusa privada' } },
    { name: 'foreign tool alongside text', finish: 'stop', text: 'Texto privado', fields: { tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'erp', arguments: '{}' } }] } },
    { name: 'legacy function alongside text', finish: 'stop', text: 'Texto privado', fields: { function_call: { name: 'erp', arguments: '{}' } } },
    { name: 'blank text', finish: 'stop', text: ' \n ' },
  ];
  for (const item of cases) {
    await t.test(item.name, async child => {
      const requests = intercept(child, () => completion(item.text, item.finish, item.fields));
      await assert.rejects(createAgent(config, businessFixture(child)).reply(command, [], input), error => {
        assert.ok(error instanceof ProviderError);
        assert.match(error.message, /Groq/);
        assert.match(error.message, /resposta/);
        assert.doesNotMatch(error.message, /Texto privado|Recusa privada|erp/);
        return true;
      });
      assert.deepEqual(requests, [transcriptionUrl, chatUrl]);
    });
  }
});

test('an empty transcription stops before the conversational model is invoked', async t => {
  const requests = intercept(t, () => { throw new Error('Unexpected chat request'); }, ' \n ');
  await assert.rejects(createAgent(config, businessFixture(t)).reply(command, [], input), UserInputError);
  assert.deepEqual(requests, [transcriptionUrl]);
});

test('response rate limits are not retried and expose only provider phase, status and code', async t => {
  const privateMessage = 'Private customer message and gsk-private-credential';
  const requests = intercept(t, () => jsonResponse({
    error: { message: privateMessage, type: 'rate_limit_error', code: 'rate_limit_exceeded', param: privateMessage },
  }, 429));
  await assert.rejects(createAgent(config, businessFixture(t)).reply(command, [], input), error => {
    assert.ok(error instanceof ProviderError);
    assert.match(error.message, /Groq/);
    assert.match(error.message, /resposta/);
    assert.match(error.message, /429/);
    assert.match(error.message, /rate_limit_exceeded/);
    assert.ok(!error.message.includes(privateMessage));
    assert.equal(error.cause, undefined);
    assert.equal(Object.hasOwn(error, 'error'), false);
    return true;
  });
  assert.deepEqual(requests, [transcriptionUrl, chatUrl]);
});

test('provider diagnostics do not expose a credential smuggled into an API error code', async t => {
  const privateKey = 'gsk_customer_secret';
  const requests = intercept(t, () => jsonResponse({ error: { code: privateKey, message: 'Private request' } }, 400));
  await assert.rejects(createAgent({ ...config, apiKey: privateKey }, businessFixture(t)).reply(command, [], input), error => {
    assert.ok(error instanceof ProviderError);
    assert.match(error.message, /Groq/);
    assert.match(error.message, /resposta/);
    assert.match(error.message, /400/);
    assert.doesNotMatch(error.message, /gsk_customer_secret|Private request/);
    return true;
  });
  assert.deepEqual(requests, [transcriptionUrl, chatUrl]);
});

test('transcription failures identify the phase without exposing the audio or raw API error', async t => {
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    if (String(url) === 'data:,') return new Response('');
    requests.push(String(url));
    return jsonResponse({ error: { message: 'PRIVATE AUDIO gsk-private-key', code: 'invalid_api_key' } }, 401);
  });
  await assert.rejects(createAgent(config, businessFixture(t)).reply(command, [], input), error => {
    assert.ok(error instanceof ProviderError);
    assert.match(error.message, /Groq/);
    assert.match(error.message, /transcrição/);
    assert.match(error.message, /401/);
    assert.match(error.message, /invalid_api_key/);
    assert.doesNotMatch(error.message, /PRIVATE|gsk-private-key/);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.deepEqual(requests, [transcriptionUrl]);
});

test('malformed provider JSON is a sanitized visible failure, never partial success', async t => {
  const requests = intercept(t, () => new Response('{PRIVATE BODY', { headers: { 'content-type': 'application/json' } }));
  await assert.rejects(createAgent(config, businessFixture(t)).reply(command, [], input), error => {
    assert.ok(error instanceof ProviderError);
    assert.match(error.message, /Groq/);
    assert.match(error.message, /resposta/);
    assert.doesNotMatch(error.message, /PRIVATE BODY/);
    return true;
  });
  assert.deepEqual(requests, [transcriptionUrl, chatUrl]);
});

test('an unsupported quoted reference rejects the request instead of ignoring the attachment', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected provider request');
  });
  await assert.rejects(createAgent(config, businessFixture(t)).reply({
    ...command,
    reference: { kind: 'unsupported', message, mimeType: 'video/mp4' },
  }, [], input), UserInputError);
  assert.equal(fetch.mock.callCount(), 0);
});

test('only Groq receives requests and Config credentials despite ambient OpenAI settings', async t => {
  const ambient = {
    OPENAI_API_KEY: 'sk-ambient-secret',
    OPENAI_ADMIN_KEY: 'sk-ambient-admin',
    OPENAI_BASE_URL: 'https://openai-ambient.invalid/v1',
    OPENAI_ORG_ID: 'ambient-org',
    OPENAI_PROJECT_ID: 'ambient-project',
    OPENAI_CUSTOM_HEADERS: 'Authorization: Bearer ambient-custom-secret\nOpenAI-Organization: ambient-org-header\nOpenAI-Project: ambient-project-header\nX-Private-Header: ambient-private-value\nContent-Type: ambient-content-type',
  };
  for (const [key, value] of Object.entries(ambient)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const requests: string[] = [];
  let body: ChatRequest | undefined;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const target = url instanceof Request ? url.url : String(url);
    if (target === 'data:,') return new Response('');
    requests.push(target);
    const request = new Request(url, init);
    assert.equal(request.headers.get('authorization'), `Bearer ${config.apiKey}`);
    assert.equal(request.headers.get('openai-organization'), null);
    assert.equal(request.headers.get('openai-project'), null);
    assert.equal(request.headers.get('x-private-header'), null);
    assert.doesNotMatch(JSON.stringify([...request.headers]), /ambient/);
    if (target === transcriptionUrl) {
      const form = await request.formData();
      assert.equal((form.get('file') as File).name, 'media.ogg');
      return jsonResponse({ text: ` ${transcript} ` });
    }
    assert.equal(target, chatUrl);
    body = await request.json() as ChatRequest;
    return completion();
  });
  const result = await createAgent(config, businessFixture(t)).reply(command, [
    { role: 'user', content: 'Histórico de voz.' },
    { role: 'assistant', content: 'Resposta anterior.' },
  ], {
    ...input,
    reference: { kind: 'image', mimeType: 'image/png', filename: 'foto.png', bytes: Buffer.from('PNG reference') },
  });
  await getGlobalTraceProvider().forceFlush();
  assert.deepEqual(requests, [transcriptionUrl, chatUrl]);
  for (const [key, value] of Object.entries(ambient)) assert.equal(process.env[key], value);
  assert.equal(result.userText, `[Áudio: media.ogg]\nPedido do usuário (transcrição): ${transcript}\n[Imagem de referência: foto.png]`);
  assert.deepEqual(body!.messages.map(message => message.role), ['system', 'user', 'assistant', 'user']);
  const parts = userParts(body!);
  assert.equal(parts.filter(part => part.type === 'image_url').length, 1);
  assert.match(parts.find(part => part.type === 'image_url')!.image_url!.url, /^data:image\/png;base64,/);
  assert.equal(parts.some(part => part.type === 'file'), false);
  assert.doesNotMatch(result.userText, /base64|PNG reference/);
});

test('a three-page PDF includes every labeled page image and native text in one final request', async t => {
  let chats = 0;
  const requests = intercept(t, body => {
    chats++;
    const parts = userParts(body);
    const text = parts.filter(part => part.type === 'text').map(part => part.text).join('\n');
    const images = parts.filter(part => part.type === 'image_url');
    assert.equal(images.length, 3);
    for (let page = 1; page <= 3; page++) {
      assert.ok(text.includes(`Página ${page} de 3`));
      assert.ok(text.includes(`PAGE ${page} NATIVE`));
    }
    for (const image of images) assert.match(image.image_url!.url, /^data:image\/jpeg;base64,/);
    assert.equal(parts.some(part => part.type === 'file'), false);
    return completion();
  });
  const result = await createAgent(config, businessFixture(t)).reply(command, [], withPdf(pdf(['PAGE 1 NATIVE', 'PAGE 2 NATIVE', 'PAGE 3 NATIVE'])));
  assert.equal(chats, 1);
  assert.deepEqual(requests, [transcriptionUrl, chatUrl]);
  assert.equal(result.userText, `[Áudio: media.ogg]\nPedido do usuário (transcrição): ${transcript}\n[PDF de referência: referencia.pdf]`);
});

test('later PDF pages reach synthesis without carrying old page images into new batches or history', async t => {
  const expectedBatches = [[1, 2, 3], [4, 5, 6], [7]];
  const seenBatches: number[][] = [];
  let synthesized = false;
  const requests = intercept(t, body => {
    const parts = userParts(body);
    const text = parts.filter(part => part.type === 'text').map(part => part.text).join('\n');
    const images = parts.filter(part => part.type === 'image_url');
    if (images.length) {
      assert.deepEqual(body.messages.map(message => message.role), ['system', 'user']);
      const pages = [...text.matchAll(/Página (\d+) de 7/g)].map(match => Number(match[1]));
      assert.deepEqual(pages, expectedBatches[seenBatches.length]);
      assert.equal(images.length, pages.length);
      assert.ok(text.includes('Qual é o saldo final?'));
      seenBatches.push(pages);
      return completion(pages.includes(7) && text.includes('FINAL BALANCE 777')
        ? 'Página 7: saldo final 777.' : `Páginas ${pages.join(', ')}: sem saldo final.`);
    }
    synthesized = true;
    assert.deepEqual(body.messages.map(message => message.role), ['system', 'user', 'assistant', 'user']);
    assert.equal(seenBatches.length, 3);
    assert.ok(text.includes('Páginas 1, 2, 3: sem saldo final.'));
    assert.ok(text.includes('Páginas 4, 5, 6: sem saldo final.'));
    assert.ok(text.includes('Página 7: saldo final 777.'));
    return completion('O saldo final é 777, conforme a página 7.');
  }, 'Qual é o saldo final?');
  const result = await createAgent(config, businessFixture(t)).reply(command, [
    { role: 'user', content: 'Contexto anterior.' },
    { role: 'assistant', content: 'Resposta anterior.' },
  ], withPdf(pdf(['PAGE 1', 'PAGE 2', 'PAGE 3', 'PAGE 4', 'PAGE 5', 'PAGE 6', 'FINAL BALANCE 777'])));
  assert.deepEqual(seenBatches, expectedBatches);
  assert.ok(synthesized);
  assert.match(result.replyText, /777.*página 7/);
  assert.doesNotMatch(result.userText, /FINAL BALANCE|saldo final 777|base64/);
  assert.deepEqual(requests, [transcriptionUrl, chatUrl, chatUrl, chatUrl, chatUrl]);
});

test('a truncated later PDF batch fails visibly instead of synthesizing an incomplete document', async t => {
  let chats = 0;
  const requests = intercept(t, () => {
    chats++;
    return chats === 1 ? completion('Páginas 1–3: dados completos.')
      : completion('Página 4: resultado privado pela metade', 'length');
  });
  await assert.rejects(createAgent(config, businessFixture(t)).reply(command, [], withPdf(pdf(['PAGE 1', 'PAGE 2', 'PAGE 3', 'PAGE 4']))), error => {
    assert.ok(error instanceof ProviderError);
    assert.match(error.message, /Groq/);
    assert.match(error.message, /resposta/);
    assert.match(error.message, /length/);
    assert.doesNotMatch(error.message, /resultado privado/);
    return true;
  });
  assert.equal(chats, 2);
  assert.deepEqual(requests, [transcriptionUrl, chatUrl, chatUrl]);
});

test('an unreadable PDF rejects the command instead of dropping its reference', async t => {
  const requests = intercept(t, () => { throw new Error('Unexpected chat request'); });
  await assert.rejects(createAgent(config, businessFixture(t)).reply(command, [], withPdf(Buffer.from('%PDF-private-invalid\n%%EOF\n'))), UserInputError);
  assert.deepEqual(requests, [transcriptionUrl]);
});


test('owner queries real client IDs, proposes a grounded visit, then saves only after a new audio', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2030-09-14T02:30:00Z') });
  const business = businessFixture(t);
  const client = business.apply(clientAction, 'seed-client');
  const agent = createAgent(config, business);
  let text = 'Agende uma visita ao Cliente Particular amanhã, das dez às onze.';
  let chats = 0;
  const requests = intercept(t, body => {
    chats++;
    if (chats === 1) {
      assert.deepEqual(body.tools?.map(tool => tool.function.name).sort(), ['consultar_negocio', 'propor_operacao']);
      const system = body.messages.find(message => message.role === 'system')?.content;
      assert.equal(typeof system, 'string');
      assert.match(system as string, /2030-09-13T23:30:00-03:00\[America\/Sao_Paulo\]/);
      return toolCompletion('consultar_negocio', { section: 'clients', search: 'Cliente Particular', month: null, offset: null, limit: null });
    }
    assert.equal(chats, 2, 'a successful proposal must stop without another paid chat');
    const found = queryResult<Client>(body);
    assert.equal(found.total, 1);
    assert.equal(found.items[0]!.id, client.id);
    return completion('Salvei a visita sem precisar confirmar.', 'tool_calls', {
      tool_calls: [functionCall('propor_operacao', { action: {
        type: 'visit.save', id: null, version: null,
        data: { clientId: found.items[0]!.id, serviceId: null, title: 'Visita técnica', startLocal: '2030-09-14T10:00', endLocal: '2030-09-14T11:00', location: found.items[0]!.address, notes: '', status: 'scheduled' },
      } }, 'call-proposal')],
    });
  }, () => text);
  const proposal = await agent.reply(selfCommand('visit-proposal'), [], input);
  const pending = business.pending(actor)!;
  assert.equal(pending.sourceCommandId, 'visit-proposal');
  assert.equal(pending.action.type, 'visit.save');
  assert.equal(business.snapshot('2030-09').visits.length, 0);
  assert.ok(proposal.replyText.includes(pending.summary));
  assert.match(proposal.replyText, /ainda não salva/);
  assert.doesNotMatch(proposal.replyText, /Salvei a visita sem precisar confirmar/);
  text = 'Confirmar.';
  await agent.reply(selfCommand('visit-confirmation'), [], input);
  const visits = business.snapshot('2030-09').visits;
  assert.equal(visits.length, 1);
  assert.equal(visits[0]!.title, 'Visita técnica');
  assert.equal(visits[0]!.clientId, client.id);
  assert.equal(Date.parse(visits[0]!.startAt), Date.parse('2030-09-14T13:00:00Z'));
  assert.equal(Date.parse(visits[0]!.endAt), Date.parse('2030-09-14T14:00:00Z'));
  assert.equal(business.pending(actor), undefined);
  assert.deepEqual(requests, [transcriptionUrl, chatUrl, chatUrl, transcriptionUrl]);
});

test('a scheduling answer consumes the real agenda query result rather than inventing a visit', async t => {
  const business = businessFixture(t);
  const saved = business.apply({
    type: 'visit.save', id: null, version: null,
    data: { clientId: null, serviceId: null, title: 'Inspeção do telhado', startLocal: '2030-09-20T09:15', endLocal: '2030-09-20T10:00', location: 'Rua 5', notes: '', status: 'scheduled' },
  }, 'seed-visit');
  let chats = 0;
  const requests = intercept(t, body => {
    if (++chats === 1) return toolCompletion('consultar_negocio', { section: 'visits', search: null, month: '2030-09', offset: null, limit: null });
    assert.equal(chats, 2);
    const result = queryResult<Visit>(body);
    assert.equal(result.items[0]!.id, saved.id);
    const visit = result.items[0]!;
    return completion(visit.title + ': ' + visit.startAt + '.');
  }, 'O que está marcado em setembro de 2030?');
  const result = await createAgent(config, business).reply(command, [], input);
  const stored = business.snapshot('2030-09').visits[0]!;
  assert.equal(result.replyText, stored.title + ': ' + stored.startAt + '.');
  assert.equal(business.pending(actor), undefined);
  assert.deepEqual(requests, [transcriptionUrl, chatUrl, chatUrl]);
});

test('confirmation is exact, action-bound, actor-bound, and cannot be replayed onto another proposal', async t => {
  const business = businessFixture(t);
  const first = business.propose(actor, 'original-audio', clientAction);
  const agent = createAgent(config, business);
  let text = '';
  let chats = 0;
  intercept(t, () => { chats++; return completion('Envie um novo áudio com seu pedido.'); }, () => text);
  const before = business.snapshot();
  for (const phrase of ['"confirmar"', 'não confirmar', 'pode confirmar e alterar o valor', 'confirmar?']) {
    text = phrase;
    await agent.reply(selfCommand('unapproved-' + chats), [{ role: 'user', content: 'confirmar' }], input);
    assert.deepEqual(business.snapshot(), before);
    assert.equal(business.pending(actor)!.id, first.id);
  }
  assert.equal(chats, 4);
  text = 'confirmar';
  await agent.reply(selfCommand('original-audio'), [], input);
  assert.deepEqual(business.snapshot(), before);
  const other = { ...selfCommand('other-account-confirmation'), accountId: 'other@s.whatsapp.net', chatId: 'other@s.whatsapp.net' };
  await agent.reply(other, [], input);
  assert.equal(business.pending(actor)!.id, first.id);
  assert.deepEqual(business.snapshot(), before);
  const saved = await agent.reply(selfCommand('confirmed-once'), [], input);
  assert.equal(business.snapshot().clients.length, 1);
  assert.equal(business.snapshot().clients[0]!.name, clientAction.data.name);
  const replay = await agent.reply(selfCommand('confirmed-once'), [], input);
  assert.equal(replay.replyText, saved.replyText);
  assert.equal(business.snapshot().clients.length, 1);
  const second = business.propose(actor, 'second-proposal', { ...clientAction, data: { ...clientAction.data, name: 'Segundo Cliente' } });
  await agent.reply(selfCommand('confirmed-once'), [], input);
  assert.equal(business.snapshot().clients.length, 1);
  assert.equal(business.pending(actor)!.id, second.id);
  text = 'pode confirmar!';
  await agent.reply(selfCommand('second-confirmation'), [], input);
  assert.deepEqual(business.snapshot().clients.map(client => client.name).sort(), ['Cliente Particular', 'Segundo Cliente']);
  const absent = await agent.reply(selfCommand('no-pending'), [], input);
  assert.match(absent.replyText, /pendente/i);
  assert.equal(chats, 4, 'all exact decisions bypass the LLM');
});

test('a quoted attachment cannot approve, and a new cancellation discards only the pending operation', async t => {
  const business = businessFixture(t);
  const pending = business.propose(actor, 'proposal-audio', clientAction);
  let text = 'confirmar';
  const requests = intercept(t, () => { throw new Error('A decision must not ask the model to authorize it'); }, () => text);
  const agent = createAgent(config, business);
  const result = await agent.reply(selfCommand('attachment-confirm'), [], {
    ...input, reference: { kind: 'image', filename: 'confirmar.png', mimeType: 'image/png', bytes: Buffer.from('confirmar') },
  });
  assert.match(result.replyText, /novo áudio/);
  assert.equal(business.pending(actor)!.id, pending.id);
  assert.equal(business.snapshot().clients.length, 0);
  text = 'cancelar';
  await agent.reply(selfCommand('proposal-audio'), [], input);
  assert.equal(business.pending(actor)!.id, pending.id);
  text = 'Cancelo.';
  await agent.reply(selfCommand('cancel-new-audio'), [], input);
  assert.equal(business.pending(actor), undefined);
  assert.equal(business.snapshot().clients.length, 0);
  text = 'confirmo';
  const absent = await agent.reply(selfCommand('after-cancellation'), [], input);
  assert.match(absent.replyText, /pendente/i);
  assert.equal(business.snapshot().clients.length, 0);
  assert.deepEqual(requests, [transcriptionUrl, transcriptionUrl, transcriptionUrl, transcriptionUrl]);
});

test('allowlisted peers and non-owner self-chat messages receive no management tools or records', async t => {
  const peerId = 'peer@s.whatsapp.net';
  const business = businessFixture(t);
  business.apply(clientAction, 'private-client');
  const pending = business.propose(actor, 'owner-proposal', { ...clientAction, data: { ...clientAction.data, name: 'Outra pessoa privada' } });
  const agent = createAgent({ ...config, allowedJids: new Set([peerId]) }, business);
  let malicious = false;
  const requests = intercept(t, body => {
    assert.equal(body.tools?.length ?? 0, 0);
    assert.doesNotMatch(JSON.stringify(body), /Cliente Particular|Rua Particular|Outra pessoa privada/);
    return malicious ? toolCompletion('consultar_negocio', { section: 'clients', search: null, month: null, offset: null, limit: null })
      : completion('Posso ajudar com sua mensagem.');
  }, 'confirmar');
  const foreign = [
    { ...selfCommand('peer-audio'), chatId: peerId, replyJid: peerId },
    { ...selfCommand('not-from-owner'), message: { ...message, key: { id: 'not-from-owner', fromMe: false } } },
  ];
  for (const untrusted of foreign) {
    await agent.reply(untrusted, [], input);
    malicious = true;
    await assert.rejects(agent.reply({ ...untrusted, id: untrusted.id + '-tool' }, [], input), ProviderError);
    malicious = false;
    assert.equal(business.pending(actor)!.id, pending.id);
    assert.equal(business.snapshot().clients.length, 1);
  }
  assert.deepEqual(requests, [transcriptionUrl, chatUrl, transcriptionUrl, chatUrl, transcriptionUrl, chatUrl, transcriptionUrl, chatUrl]);
});

test('partial, parallel, and unauthorized commit tool responses cannot create an approvable proposal', async t => {
  const cases = [
    { name: 'truncated proposal', finish: 'length', calls: [functionCall('propor_operacao', { action: clientAction })] },
    { name: 'two proposals in one response', finish: 'tool_calls', calls: [functionCall('propor_operacao', { action: clientAction }), functionCall('propor_operacao', { action: clientAction }, 'call-2')] },
    { name: 'model attempts to confirm', finish: 'tool_calls', calls: [functionCall('confirmar_operacao', { accountId: command.accountId, chatId: command.chatId })] },
  ];
  for (const item of cases) await t.test(item.name, async child => {
    const business = businessFixture(child);
    const requests = intercept(child, () => completion('', item.finish, { tool_calls: item.calls }));
    await assert.rejects(createAgent(config, business).reply(command, [], input), ProviderError);
    assert.equal(business.pending(actor), undefined);
    assert.equal(business.snapshot().clients.length, 0);
    assert.deepEqual(requests, [transcriptionUrl, chatUrl]);
  });
});

test('tool inputs cannot smuggle a different actor into an otherwise valid proposal', async t => {
  const business = businessFixture(t);
  intercept(t, () => toolCompletion('propor_operacao', { action: clientAction, actor: { accountId: 'other', chatId: 'other' } }));
  await assert.rejects(createAgent(config, business).reply(command, [], input), error => {
    assert.ok(error instanceof ProviderError);
    assert.doesNotMatch(error.message, /other|Cliente Particular|actor/);
    return true;
  });
  assert.equal(business.pending(actor), undefined);
  assert.equal(business.pending({ accountId: 'other', chatId: 'other' }), undefined);
  assert.equal(business.snapshot().clients.length, 0);
});

test('stale and expired proposals fail honestly without overwriting dashboard changes', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2030-09-12T12:00:00Z') });
  const business = businessFixture(t);
  const seed = business.apply(clientAction, 'seed');
  const original = business.snapshot().clients[0]!;
  const stalePending = business.propose(actor, 'old-update', { ...clientAction, id: seed.id, version: original.version, data: { ...clientAction.data, name: 'Mudança por voz' } });
  business.apply({ ...clientAction, id: seed.id, version: original.version, data: { ...clientAction.data, name: 'Mudança no dashboard' } }, 'dashboard-update');
  const requests = intercept(t, () => { throw new Error('Stale confirmation cannot invoke the LLM'); }, 'confirmar');
  const agent = createAgent(config, business);
  const stale = await agent.reply(selfCommand('stale-confirm'), [], input);
  assert.match(stale.replyText, /alterad|versão|desatualiz/i);
  assert.equal(business.snapshot().clients[0]!.name, 'Mudança no dashboard');
  assert.deepEqual(business.pending(actor), stalePending);
  business.cancel(actor);
  business.propose(actor, 'expires', clientAction);
  t.mock.timers.tick(16 * 60_000);
  const expired = await agent.reply(selfCommand('expired-confirm'), [], input);
  assert.match(expired.replyText, /expirad|pendente/i);
  assert.equal(business.snapshot().clients.length, 1);
  assert.equal(business.pending(actor), undefined);
  assert.deepEqual(requests, [transcriptionUrl, transcriptionUrl]);
});

test('confirmed quotes return the stored quote as a real PDF, and PDF failures do not deny the commit', async t => {
  for (const fails of [false, true]) await t.test(fails ? 'PDF rendering fails after saving' : 'PDF renders the saved record', async child => {
    const business = businessFixture(child);
    const client = business.apply(clientAction, 'quote-client');
    business.propose(actor, 'quote-proposal', {
      type: 'quote.save', id: null, version: null,
      data: { clientId: client.id, serviceId: null, title: 'Reparo de porta', validUntil: '2030-09-30', status: 'draft', notes: '', discountCents: 13,
        items: [{ materialId: null, description: 'Reparo completo', unit: 'h', quantityMilli: 2500, unitPriceCents: 1005 }] },
    });
    if (fails) child.mock.method(PDFDocument.prototype, 'text', () => { throw new Error('Synthetic PDF renderer failure'); });
    const requests = intercept(child, () => { throw new Error('Quote confirmation cannot invoke the LLM'); }, 'confirmo');
    const result = await createAgent(config, business).reply(selfCommand('quote-confirm'), [], input);
    const quotes = business.snapshot().quotes;
    assert.equal(quotes.length, 1);
    assert.equal(quotes[0]!.totalCents, 2500);
    assert.equal(business.pending(actor), undefined);
    if (fails) {
      assert.equal(result.document, undefined);
      assert.match(result.replyText, /salvo/);
      assert.match(result.replyText, /não consegui gerar o PDF/);
    } else {
      assert.equal(result.document?.mimeType, 'application/pdf');
      assert.match(result.document!.filename, /\.pdf$/);
      const pages: string[] = [];
      for await (const page of renderPdfPages(result.document!.bytes)) pages.push(page.text);
      const text = pages.join('\n');
      assert.ok(text.includes(quotes[0]!.number));
      assert.match(text, /Cliente Particular/);
      assert.match(text, /Reparo completo/);
      assert.match(text, /25,00/);
    }
    assert.deepEqual(requests, [transcriptionUrl]);
  });
});

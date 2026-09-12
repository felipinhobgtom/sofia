import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { getGlobalTraceProvider } from '@openai/agents';
import { createAgent } from '../src/agent.ts';
import type { Command, Config, PreparedInput } from '../src/types.ts';
import { ProviderError, UserInputError } from '../src/types.ts';

const config: Config = {
  apiKey: 'gsk-test-not-a-real-key',
  model: 'qwen/qwen3.6-27b',
  transcriptionModel: 'whisper-large-v3-turbo',
  databasePath: ':memory:',
  allowedJids: new Set(),
  pairOnly: false,
};
const message: Command['message'] = {
  key: { id: 'message-1' },
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
const input: PreparedInput = {
  audio: { kind: 'audio', mimeType: 'audio/ogg', filename: 'media.ogg', bytes: Buffer.from('OggS') },
};
const transcriptionUrl = 'https://api.groq.com/openai/v1/audio/transcriptions';
const chatUrl = 'https://api.groq.com/openai/v1/chat/completions';
const transcript = 'Resuma o pedido do cliente.';

type ChatPart = { type: string; text?: string; image_url?: { url: string } };
type ChatRequest = { messages: { role: string; content: string | ChatPart[] }[] };

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

function intercept(t: TestContext, chat: (body: ChatRequest) => Response, text = transcript): string[] {
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const target = url instanceof Request ? url.url : String(url);
    if (target === 'data:,') return new Response('');
    requests.push(target);
    if (target === transcriptionUrl) return jsonResponse({ text });
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

test('rejects partial, filtered, refused, tool-bearing and empty chat output', async t => {
  const cases = [
    { name: 'length', finish: 'length', text: 'Texto privado pela metade' },
    { name: 'content filter', finish: 'content_filter', text: 'Texto privado filtrado' },
    { name: 'missing terminal reason', finish: null, text: 'Texto privado sem fim' },
    { name: 'refusal alongside text', finish: 'stop', text: 'Texto privado', fields: { refusal: 'Recusa privada' } },
    { name: 'tool alongside text', finish: 'stop', text: 'Texto privado', fields: { tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'erp', arguments: '{}' } }] } },
    { name: 'legacy function alongside text', finish: 'stop', text: 'Texto privado', fields: { function_call: { name: 'erp', arguments: '{}' } } },
    { name: 'blank text', finish: 'stop', text: ' \n ' },
  ];
  for (const item of cases) {
    await t.test(item.name, async child => {
      const requests = intercept(child, () => completion(item.text, item.finish, item.fields));
      await assert.rejects(createAgent(config).reply(command, [], input), error => {
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
  await assert.rejects(createAgent(config).reply(command, [], input), UserInputError);
  assert.deepEqual(requests, [transcriptionUrl]);
});

test('response rate limits are not retried and expose only provider phase, status and code', async t => {
  const privateMessage = 'Private customer message and gsk-private-credential';
  const requests = intercept(t, () => jsonResponse({
    error: { message: privateMessage, type: 'rate_limit_error', code: 'rate_limit_exceeded', param: privateMessage },
  }, 429));
  await assert.rejects(createAgent(config).reply(command, [], input), error => {
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
  await assert.rejects(createAgent({ ...config, apiKey: privateKey }).reply(command, [], input), error => {
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
  await assert.rejects(createAgent(config).reply(command, [], input), error => {
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
  await assert.rejects(createAgent(config).reply(command, [], input), error => {
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
  await assert.rejects(createAgent(config).reply({
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
  const result = await createAgent(config).reply(command, [
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
  const result = await createAgent(config).reply(command, [], withPdf(pdf(['PAGE 1 NATIVE', 'PAGE 2 NATIVE', 'PAGE 3 NATIVE'])));
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
  const result = await createAgent(config).reply(command, [
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
  await assert.rejects(createAgent(config).reply(command, [], withPdf(pdf(['PAGE 1', 'PAGE 2', 'PAGE 3', 'PAGE 4']))), error => {
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
  await assert.rejects(createAgent(config).reply(command, [], withPdf(Buffer.from('%PDF-private-invalid\n%%EOF\n'))), UserInputError);
  assert.deepEqual(requests, [transcriptionUrl]);
});

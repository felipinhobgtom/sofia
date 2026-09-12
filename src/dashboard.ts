import { constants } from 'node:fs';
import { open, readFile, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, relative, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { BusinessError } from './business-contract.ts';
import type { BusinessStore } from './business-contract.ts';
import { parseBusinessAction } from './business-store.ts';
import { quotePdfFilename, renderQuotePdf } from './quote-pdf.ts';

const MAX_BODY_BYTES = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

class RequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function secureHeaders(response: ServerResponse): void {
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'");
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Cache-Control', 'no-store');
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
}

function rejectRequest(request: IncomingMessage, response: ServerResponse, error: unknown): void {
  request.resume();
  if (response.destroyed) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  if (error instanceof RequestError) json(response, error.status, { error: error.message });
  else if (error instanceof BusinessError && [400, 404, 409].includes(error.status)) json(response, error.status, { error: error.message });
  else json(response, 500, { error: 'Não foi possível concluir a solicitação.' });
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const values = request.headersDistinct[name];
  return values?.length === 1 ? values[0] : undefined;
}

function requestPath(request: IncomingMessage): { pathname: string; search: URLSearchParams } {
  const target = request.url ?? '';
  if (!target.startsWith('/') || target.startsWith('//') || target.includes('#')) throw new RequestError(400, 'Endereço inválido.');
  const queryStart = target.indexOf('?');
  const rawPath = queryStart < 0 ? target : target.slice(0, queryStart);
  let pathname: string;
  try { pathname = decodeURIComponent(rawPath); }
  catch { throw new RequestError(400, 'Endereço inválido.'); }
  if (/[\u0000-\u001f\u007f\\]/.test(pathname) || pathname.split('/').some(part => part.startsWith('.'))) {
    throw new RequestError(400, 'Endereço inválido.');
  }
  return { pathname, search: new URLSearchParams(queryStart < 0 ? '' : target.slice(queryStart + 1)) };
}

function readJson(request: IncomingMessage): Promise<unknown> {
  const length = request.headers['content-length'];
  if (length && Number(length) > MAX_BODY_BYTES) throw new RequestError(413, 'Solicitação muito grande.');
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const chunks: Buffer[] = [];
  let size = 0;
  const cleanup = () => {
    request.off('data', onData);
    request.off('end', onEnd);
    request.off('aborted', onAborted);
    request.off('error', onError);
  };
  const fail = (error: Error) => {
    cleanup();
    request.resume();
    reject(error);
  };
  const onAborted = () => fail(new RequestError(400, 'Solicitação interrompida.'));
  const onError = () => fail(new RequestError(400, 'Solicitação interrompida.'));
  const onData = (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) fail(new RequestError(413, 'Solicitação muito grande.'));
    else chunks.push(chunk);
  };
  const onEnd = () => {
    cleanup();
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
      resolve(JSON.parse(text));
    } catch { reject(new RequestError(400, 'JSON inválido.')); }
  };
  request.on('data', onData);
  request.once('end', onEnd);
  request.once('aborted', onAborted);
  request.once('error', onError);
  return promise;
}

function missingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(String(error.code));
}

async function assetPath(root: string, pathname: string): Promise<string | undefined> {
  const candidate = join(root, pathname);
  try {
    const actual = await realpath(candidate);
    const child = relative(root, actual);
    // Built assets are ordinary files. Do not follow links to source, private files, or another tree.
    if (!child || child === '..' || child.startsWith(`..${sep}`) || actual !== candidate) return undefined;
    return actual;
  } catch (error) {
    if (missingFile(error)) return undefined;
    throw error;
  }
}

async function serveAsset(root: string, pathname: string, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  const extension = extname(pathname).toLowerCase();
  const contentType = MIME[extension];
  if (!contentType || extension === '.html') return false;
  const path = await assetPath(root, pathname);
  if (!path) return false;
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if (missingFile(error)) return false;
    throw error;
  }
  try {
    const information = await file.stat();
    if (!information.isFile()) return false;
    response.setHeader('Content-Type', contentType);
    response.setHeader('Content-Length', information.size);
    response.setHeader('Cache-Control', pathname.startsWith('/assets/') && /-[a-zA-Z0-9_-]{8,}\.[^.]+$/.test(pathname) ? 'public, max-age=31536000, immutable' : 'no-cache');
    if (request.method === 'HEAD') response.end();
    else await pipeline(file.createReadStream(), response);
    return true;
  } finally { await file.close(); }
}

export interface DashboardServer { url: string; close(): Promise<void> }

export async function startDashboard(options: { business: BusinessStore; port: number; assetsDir?: string }): Promise<DashboardServer> {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('Porta do painel inválida.');
  let root: string;
  let index: Buffer;
  try {
    root = await realpath(options.assetsDir ?? fileURLToPath(new URL('../web/dist', import.meta.url)));
    const indexPath = await assetPath(root, '/index.html');
    if (!indexPath || !(await stat(indexPath)).isFile()) throw new Error('Missing index');
    index = await readFile(indexPath);
    if (index.length === 0) throw new Error('Empty index');
  } catch { throw new Error('Painel não compilado. Execute npm run build antes de iniciar.'); }

  const allowedHosts = new Set<string>();
  let closing: Promise<void> | undefined;
  const handle = (request: IncomingMessage, response: ServerResponse) => {
    secureHeaders(response);
    response.once('finish', () => { if (closing) server.closeIdleConnections(); });
    // Keep aborted uploads from emitting an unhandled error after their reader has detached.
    request.on('error', () => {});
    void (async () => {
      const host = singleHeader(request, 'host');
      if (!host || !allowedHosts.has(host)) throw new RequestError(403, 'Host não permitido.');
      const { pathname, search } = requestPath(request);
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        if (pathname === '/api/state') {
          if (request.method !== 'GET') throw new RequestError(405, 'Método não permitido.');
          if (search.getAll('month').length > 1) throw new RequestError(400, 'Mês inválido.');
          json(response, 200, options.business.snapshot(search.get('month') ?? undefined));
          return;
        }
        if (pathname === '/api/actions') {
          if (request.method !== 'POST') throw new RequestError(405, 'Método não permitido.');
          if (singleHeader(request, 'origin') !== `http://${host}`) throw new RequestError(403, 'Origem não permitida.');
          const contentType = singleHeader(request, 'content-type');
          if (!contentType || !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(contentType.trim()) || request.headers['content-encoding']) {
            throw new RequestError(415, 'Envie application/json em UTF-8.');
          }
          const key = singleHeader(request, 'x-idempotency-key');
          if (!key || !UUID.test(key)) throw new RequestError(400, 'Chave de idempotência inválida.');
          if (request.headers.expect?.toLowerCase() === '100-continue') {
            if (Number(request.headers['content-length']) > MAX_BODY_BYTES) throw new RequestError(413, 'Solicitação muito grande.');
            response.writeContinue();
          }
          const action = parseBusinessAction(await readJson(request));
          json(response, 200, options.business.apply(action, `web:${key.toLowerCase()}`));
          return;
        }
        const quoteMatch = /^\/api\/quotes\/([^/]+)\/pdf$/.exec(pathname);
        if (quoteMatch) {
          if (request.method !== 'GET') throw new RequestError(405, 'Método não permitido.');
          const document = options.business.quoteDocument(quoteMatch[1]);
          const bytes = await renderQuotePdf(document);
          response.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Length': bytes.length,
            'Content-Disposition': `attachment; filename="${quotePdfFilename(document.quote.number)}"`,
          });
          response.end(bytes);
          return;
        }
        throw new RequestError(404, 'Recurso não encontrado.');
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new RequestError(405, 'Método não permitido.');
      if (pathname !== '/' && pathname !== '/index.html' && await serveAsset(root, pathname, request, response)) return;
      const navigation = request.headers.accept?.split(',').some(part => /^text\/html(?:\s*;|\s*$)/i.test(part.trim()) && !/;\s*q=0(?:\.0*)?(?:\s*;|\s*$)/i.test(part));
      if (pathname !== '/' && pathname !== '/index.html' && (!navigation || extname(pathname) || pathname.startsWith('/assets/'))) {
        throw new RequestError(404, 'Recurso não encontrado.');
      }
      response.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': index.length, 'Cache-Control': 'no-cache' });
      response.end(request.method === 'HEAD' ? undefined : index);
    })().catch(error => rejectRequest(request, response, error));
  };
  const server = createServer(handle);
  server.on('checkContinue', handle);
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen(options.port, '127.0.0.1', () => {
    server.off('error', listening.reject);
    listening.resolve();
  });
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Não foi possível abrir o painel local.');
  allowedHosts.add(`127.0.0.1:${address.port}`);
  allowedHosts.add(`localhost:${address.port}`);
  if (address.port === 80) {
    allowedHosts.add('127.0.0.1');
    allowedHosts.add('localhost');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close() {
      if (closing) return closing;
      const completion = Promise.withResolvers<void>();
      closing = completion.promise;
      const timeout = setTimeout(() => server.closeAllConnections(), 5_000);
      timeout.unref();
      server.close(error => {
        clearTimeout(timeout);
        if (error) completion.reject(error);
        else completion.resolve();
      });
      server.closeIdleConnections();
      return closing;
    },
  };
}

import type { ActionResult, BusinessAction, BusinessSnapshot } from '../../src/business-contract.ts';
export interface PageProps {
  data: BusinessSnapshot; month: string; setMonth: (month: string) => void;
  refresh: () => Promise<void>; notify: (message: string, kind?: 'success' | 'error') => void;
}
async function request<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(path, { ...options, cache: 'no-store', credentials: 'same-origin' }); }
  catch { throw new Error('Não foi possível confirmar a comunicação com o servidor. Confira os dados antes de repetir uma operação.'); }
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : 'Não foi possível concluir a solicitação.');
  if (body === null) throw new Error('O servidor não confirmou a resposta. Atualize o painel antes de tentar novamente.');
  return body as T;
}
export function getState(month?: string): Promise<BusinessSnapshot> {
  return request('/api/state' + (month ? '?month=' + encodeURIComponent(month) : ''));
}
export function applyAction(action: BusinessAction, idempotencyKey: string): Promise<ActionResult> {
  return request('/api/actions', { method: 'POST', headers: { 'content-type': 'application/json', 'x-idempotency-key': idempotencyKey }, body: JSON.stringify(action) });
}
export function quotePdfUrl(id: string): string { return '/api/quotes/' + encodeURIComponent(id) + '/pdf'; }

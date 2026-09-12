import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { BusinessAction } from '../../src/business-contract.ts';
import { applyAction } from './api.ts';
import type { PageProps } from './api.ts';

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => { element?.close(); }; }, []);
  return <dialog ref={dialog} className="modal" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="modal-header"><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" aria-label="Fechar" onClick={onClose}>×</button></div>
    <div className="modal-body">{children}</div>
  </dialog>;
}
export function Field({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return <label className={'field' + (wide ? ' field-wide' : '')}><span>{label}</span>{children}</label>;
}
export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return <div className="empty-state"><h3>{title}</h3>{description && <p>{description}</p>}{action}</div>;
}
export function useAction(props: PageProps, onSuccess?: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const key = useRef(crypto.randomUUID());
  async function submit(input: BusinessAction | (() => BusinessAction)): Promise<boolean> {
    if (inFlight.current) return false;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const action = typeof input === 'function' ? input() : input;
      const result = await applyAction(action, key.current);
      key.current = crypto.randomUUID();
      props.notify(result.summary, 'success');
      onSuccess?.();
      try { await props.refresh(); }
      catch { props.notify('Operação salva. Não foi possível atualizar o painel; use Atualizar para consultar o resultado.', 'error'); }
      return true;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Não foi possível salvar os dados.';
      setError(message); props.notify(message, 'error');
      return false;
    } finally { inFlight.current = false; setBusy(false); }
  }
  return { submit, busy, error };
}
const moneyFormat = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const quantityFormat = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 });
export const money = (cents: number): string => moneyFormat.format(cents / 100);
export const quantity = (milli: number): string => quantityFormat.format(milli / 1000);
export const moneyInput = (cents: number): string => (cents / 100).toFixed(2).replace('.', ',');
export const quantityInput = (milli: number): string => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3, useGrouping: false }).format(milli / 1000);
function scaled(value: string, scale: number): number {
  let text = value.trim().replace(/^R\$\s*/, '').replace(/\s/g, '');
  if (text.includes(',')) text = text.replace(/\./g, '').replace(',', '.');
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error('Informe um número válido, como 12,50.');
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > scale) throw new Error('Use no máximo ' + scale + ' casas decimais.');
  const result = BigInt(whole!) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0'));
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('O valor informado é muito grande.');
  return Number(result);
}
export const parseMoney = (value: string): number => scaled(value, 2);
export const parseQuantity = (value: string): number => scaled(value, 3);
export function localDateTime(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? '';
  return get('year') + '-' + get('month') + '-' + get('day') + 'T' + get('hour') + ':' + get('minute');
}
export function dateTime(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat('pt-BR', { timeZone, dateStyle: 'short', timeStyle: 'short' }).format(new Date(instant));
}

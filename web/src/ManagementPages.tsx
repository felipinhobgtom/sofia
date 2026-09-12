import { useMemo, useState, type FormEvent } from 'react';
import { ArrowDownLeft, ArrowUpRight, Download, Package, Pencil, Plus, Search, Trash2, Wallet } from 'lucide-react'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { cashStatusLabels, quoteStatusLabels, stockKindLabels, type BusinessAction, type BusinessSnapshot, type CashEntry, type CashStatus, type Material, type Quote, type QuoteItemInput, type QuoteStatus, type StockKind } from '../../src/business-contract';
import { quotePdfUrl, type PageProps } from './api';
import { EmptyState, Field, Modal, money, moneyInput, parseMoney, parseQuantity, quantity, quantityInput, useAction } from './ui';
import './management.css';

function matches(search: string, ...values: Array<string | null | undefined>) {
  const normalize = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('pt-BR');
  return normalize(values.filter(Boolean).join(' ')).includes(normalize(search.trim()));
}

function dateLabel(value: string) {
  const [year, month, day] = value.slice(0, 10).split('-');
  return `${day}/${month}/${year}`;
}

function today(timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Não foi possível salvar. Confira os dados e tente novamente.';
}

function positiveMoney(value: string, label: string) {
  const amount = parseMoney(value);
  if (amount <= 0) throw new Error(`${label} deve ser maior que zero.`);
  return amount;
}

function nonnegativeMoney(value: string, label: string) {
  const amount = parseMoney(value);
  if (amount < 0) throw new Error(`${label} não pode ser negativo.`);
  return amount;
}

function positiveQuantity(value: string) {
  const amount = parseQuantity(value);
  if (amount <= 0) throw new Error('A quantidade deve ser maior que zero.');
  return amount;
}

function nonnegativeQuantity(value: string) {
  const amount = parseQuantity(value);
  if (amount < 0) throw new Error('A quantidade não pode ser negativa.');
  return amount;
}

function quoteLineTotal(item: QuoteItemInput) {
  const total = (BigInt(item.quantityMilli) * BigInt(item.unitPriceCents) + 500n) / 1000n;
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('O valor do item excede o limite permitido.');
  return Number(total);
}

function statusClass(status: string) {
  if (status === 'accepted' || status === 'paid' || status === 'in') return 'badge badge-success';
  if (status === 'pending' || status === 'sent' || status === 'adjust') return 'badge badge-warning';
  if (status === 'rejected' || status === 'out') return 'badge badge-danger';
  return 'badge badge-muted';
}

function FormError({ error }: { error: string | null | undefined }) {
  return error ? <p className="inline-error" role="alert">{error}</p> : null;
}

function SearchField({ value, onChange, label, placeholder }: { value: string; onChange: (value: string) => void; label: string; placeholder: string }) {
  return <label className="mp-search"><Search size={17} aria-hidden="true" /><span className="mp-sr-only">{label}</span><input type="search" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /></label>;
}

function ClientServiceFields({ data, clientId, serviceId, onChange, required = false }: { data: BusinessSnapshot; clientId: string; serviceId: string; onChange: (clientId: string, serviceId: string) => void; required?: boolean }) {
  const services = data.services.filter((service) => clientId ? service.clientId === clientId : !required || service.clientId !== null);
  return <>
    <Field label={required ? 'Cliente *' : 'Cliente'}><select required={required} value={clientId} onChange={(event) => {
      const next = event.target.value;
      const selected = data.services.find((service) => service.id === serviceId);
      onChange(next, selected && selected.clientId !== (next || null) ? '' : serviceId);
    }}><option value="">{required ? 'Selecione um cliente' : 'Sem cliente vinculado'}</option>{data.clients.filter((client) => client.active || client.id === clientId).map((client) => <option key={client.id} value={client.id}>{client.name}{!client.active ? ' (inativo)' : ''}</option>)}</select></Field>
    <Field label="Serviço"><select value={serviceId} onChange={(event) => {
      const next = event.target.value;
      const selected = data.services.find((service) => service.id === next);
      onChange(clientId || selected?.clientId || '', next);
    }}><option value="">Sem serviço vinculado</option>{services.map((service) => <option key={service.id} value={service.id}>{service.title}</option>)}</select></Field>
  </>;
}

type QuoteDraftItem = { key: string; materialId: string; description: string; unit: string; quantity: string; price: string };
function newQuoteItem(): QuoteDraftItem {
  return { key: crypto.randomUUID(), materialId: '', description: '', unit: 'un', quantity: '1', price: '' };
}

function QuoteEditor({ props, quote, onClose }: { props: PageProps; quote: Quote | null; onClose: () => void }) {
  const { data } = props;
  const { submit, busy, error } = useAction(props, onClose);
  const [validation, setValidation] = useState<string | null>(null);
  const [clientId, setClientId] = useState(quote?.clientId ?? '');
  const [serviceId, setServiceId] = useState(quote?.serviceId ?? '');
  const [title, setTitle] = useState(quote?.title ?? '');
  const [validUntil, setValidUntil] = useState(quote?.validUntil ?? '');
  const [status, setStatus] = useState<QuoteStatus>(quote?.status ?? 'draft');
  const [notes, setNotes] = useState(quote?.notes ?? '');
  const [discount, setDiscount] = useState(moneyInput(quote?.discountCents ?? 0));
  const [items, setItems] = useState<QuoteDraftItem[]>(() => quote ? quote.items.map((item) => ({ key: crypto.randomUUID(), materialId: item.materialId ?? '', description: item.description, unit: item.unit, quantity: quantityInput(item.quantityMilli), price: moneyInput(item.unitPriceCents) })) : [newQuoteItem()]);
  const updateItem = (key: string, patch: Partial<QuoteDraftItem>) => setItems((current) => current.map((item) => item.key === key ? { ...item, ...patch } : item));
  const parsedItem = (item: QuoteDraftItem): QuoteItemInput => ({ materialId: item.materialId || null, description: item.description.trim(), unit: item.unit.trim(), quantityMilli: positiveQuantity(item.quantity), unitPriceCents: nonnegativeMoney(item.price, 'O preço unitário') });
  const preview = useMemo(() => {
    try {
      const totals = items.map((item) => quoteLineTotal(parsedItem(item)));
      const subtotal = totals.reduce((sum, total) => sum + BigInt(total), 0n);
      const discountCents = nonnegativeMoney(discount, 'O desconto');
      if (subtotal > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('O total excede o limite permitido.');
      if (BigInt(discountCents) > subtotal) throw new Error('O desconto não pode superar o subtotal.');
      return { totals, subtotal: Number(subtotal), discount: discountCents, total: Number(subtotal - BigInt(discountCents)), error: null };
    } catch (issue) { return { totals: [], subtotal: null, discount: null, total: null, error: errorMessage(issue) }; }
  }, [items, discount]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setValidation(null);
    try {
      if (!clientId) throw new Error('Selecione o cliente do orçamento.');
      if (items.length === 0) throw new Error('Adicione pelo menos um item.');
      if (preview.error) throw new Error(preview.error);
      const inputItems = items.map(parsedItem);
      if (inputItems.some((item) => !item.description || !item.unit)) throw new Error('Informe a descrição e a unidade de todos os itens.');
      await submit({ type: 'quote.save', id: quote?.id ?? null, version: quote?.version ?? null, data: { clientId, serviceId: serviceId || null, title: title.trim(), validUntil: validUntil || null, status, notes: notes.trim(), discountCents: nonnegativeMoney(discount, 'O desconto'), items: inputItems } });
    } catch (issue) { setValidation(errorMessage(issue)); }
  }
  return <Modal title={quote ? `Editar orçamento ${quote.number}` : 'Novo orçamento'} onClose={onClose}>
    <form onSubmit={save} className="mp-editor">
      <fieldset disabled={busy} className="mp-fieldset">
        <div className="form-grid">
          <Field label="Título *" wide><input required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Ex.: Instalação elétrica da cozinha" /></Field>
          <ClientServiceFields data={data} clientId={clientId} serviceId={serviceId} required onChange={(client, service) => { setClientId(client); setServiceId(service); }} />
          <Field label="Válido até"><input type="date" value={validUntil} onChange={(event) => setValidUntil(event.target.value)} /></Field>
          <Field label="Situação"><select value={status} onChange={(event) => setStatus(event.target.value as QuoteStatus)}>{Object.entries(quoteStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
        </div>
        <div className="mp-section-title"><h3>Itens do orçamento</h3><button className="button button-secondary" type="button" onClick={() => setItems((current) => [...current, newQuoteItem()])}><Plus size={16} aria-hidden="true" />Adicionar item</button></div>
        <p className="muted mp-help">Use o catálogo ou descreva um item livre. O custo do material preenche o preço, que pode ser alterado.</p>
        <div className="mp-quote-items">{items.map((item, index) => <fieldset className="mp-quote-item" key={item.key}>
          <legend>Item {index + 1}</legend>
          <div className="form-grid">
            <Field label={`Material do item ${index + 1}`} wide><select value={item.materialId} onChange={(event) => {
              const material = data.materials.find((entry) => entry.id === event.target.value);
              updateItem(item.key, material ? { materialId: material.id, description: material.name, unit: material.unit, price: moneyInput(material.costCents) } : { materialId: '' });
            }}><option value="">Item livre / mão de obra</option>{data.materials.filter((material) => material.active || material.id === item.materialId).map((material) => <option key={material.id} value={material.id}>{material.name}{material.sku ? ` · ${material.sku}` : ''}{!material.active ? ' (inativo)' : ''}</option>)}</select></Field>
            <Field label={`Descrição do item ${index + 1} *`} wide><input required value={item.description} onChange={(event) => updateItem(item.key, { description: event.target.value })} /></Field>
          </div>
          <div className="mp-item-numbers">
            <Field label={`Quantidade do item ${index + 1} *`}><input required inputMode="decimal" value={item.quantity} onChange={(event) => updateItem(item.key, { quantity: event.target.value })} placeholder="1,000" /></Field>
            <Field label={`Unidade do item ${index + 1} *`}><input required maxLength={20} value={item.unit} onChange={(event) => updateItem(item.key, { unit: event.target.value })} placeholder="un, m, kg…" /></Field>
            <Field label={`Preço unitário do item ${index + 1} (R$) *`}><input required inputMode="decimal" value={item.price} onChange={(event) => updateItem(item.key, { price: event.target.value })} placeholder="0,00" /></Field>
            <div className="mp-item-total"><span>Total do item</span><strong>{preview.totals[index] === undefined ? '—' : money(preview.totals[index])}</strong></div>
          </div>
          <button type="button" className="button button-ghost mp-remove-item" aria-label={`Remover item ${index + 1}`} disabled={items.length === 1} onClick={() => setItems((current) => current.filter((entry) => entry.key !== item.key))}><Trash2 size={15} aria-hidden="true" />Remover item</button>
        </fieldset>)}</div>
        <div className="form-grid mp-quote-bottom">
          <Field label="Desconto (R$)"><input required inputMode="decimal" value={discount} onChange={(event) => setDiscount(event.target.value)} /></Field>
          <dl className="mp-totals" aria-live="polite"><div><dt>Subtotal</dt><dd>{preview.subtotal === null ? '—' : money(preview.subtotal)}</dd></div><div><dt>Desconto</dt><dd>{preview.discount === null ? '—' : money(preview.discount)}</dd></div><div className="mp-grand-total"><dt>Total</dt><dd>{preview.total === null ? '—' : money(preview.total)}</dd></div></dl>
          <Field label="Observações" wide><textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Condições, escopo e informações adicionais" /></Field>
        </div>
        <p className="muted mp-help">Valores arredondados por item ao centavo mais próximo. Orçamentos não geram receita nem movimentam estoque automaticamente.</p>
        <FormError error={validation || error} />
        <div className="form-actions"><button type="button" className="button button-secondary" onClick={onClose}>Cancelar</button><button className="button button-primary" type="submit">{busy ? 'Salvando…' : 'Salvar orçamento'}</button></div>
      </fieldset>
    </form>
  </Modal>;
}

export function QuotesPage(props: PageProps) {
  const { data } = props;
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [editing, setEditing] = useState<Quote | null | undefined>(undefined);
  const clients = useMemo(() => new Map(data.clients.map((client) => [client.id, client.name])), [data.clients]);
  const services = useMemo(() => new Map(data.services.map((service) => [service.id, service.title])), [data.services]);
  const quotes = data.quotes.filter((quote) => (status === 'all' || quote.status === status) && matches(search, quote.number, quote.title, quote.customer.name, clients.get(quote.clientId), quote.serviceId ? services.get(quote.serviceId) : ''));
  const canCreate = data.clients.some((client) => client.active);
  return <div className="page-stack">
    <div className="page-heading"><div><h1 className="page-title">Orçamentos</h1><p className="muted">Propostas, valores e documentos vinculados aos seus clientes.</p></div><div className="page-actions"><button className="button button-primary" onClick={() => setEditing(null)} disabled={!canCreate}><Plus size={18} aria-hidden="true" />Novo orçamento</button></div></div>
    <div className="stats-grid mp-quote-stats"><div className="stat-card"><span>Em aberto</span><strong>{money(data.summary.openQuoteCents)}</strong><small>Rascunhos e enviados</small></div>{(['accepted', 'sent', 'draft'] as const).map((value) => {
      const stage = data.summary.quoteStages.find((entry) => entry.status === value);
      return <div className="stat-card" key={value}><span>{quoteStatusLabels[value]}</span><strong>{stage?.count ?? 0}</strong><small>{money(stage?.totalCents ?? 0)}</small></div>;
    })}</div>
    {!canCreate && <div className="mp-notice">Cadastre um cliente ativo na página Clientes para criar um orçamento.</div>}
    <section className="card">
      <div className="card-header mp-filter-row"><SearchField value={search} onChange={setSearch} label="Buscar orçamentos" placeholder="Buscar número, título ou cliente…" /><Field label="Situação do orçamento"><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">Todas as situações</option>{Object.entries(quoteStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field></div>
      {quotes.length === 0 ? <EmptyState title={data.quotes.length ? 'Nenhum orçamento encontrado' : 'Seu primeiro orçamento começa aqui'} description={data.quotes.length ? 'Altere a busca ou a situação para encontrar a proposta.' : 'Crie uma proposta com itens, desconto e PDF para enviar ao cliente.'} action={canCreate && !data.quotes.length ? <button className="button button-primary" onClick={() => setEditing(null)}>Criar orçamento</button> : undefined} /> : <div className="table-wrap"><table className="data-table"><thead><tr><th>Orçamento</th><th>Cliente / serviço</th><th>Situação</th><th>Validade</th><th className="mp-numeric">Total</th><th><span className="mp-sr-only">Ações</span></th></tr></thead><tbody>{quotes.map((quote) => <tr key={quote.id}>
        <td><strong>{quote.number}</strong><span className="mp-cell-secondary">{quote.title}</span></td><td>{clients.get(quote.clientId) ?? quote.customer.name}<span className="mp-cell-secondary">{quote.serviceId ? services.get(quote.serviceId) ?? 'Serviço vinculado' : 'Sem serviço vinculado'}</span></td><td><span className={statusClass(quote.status)}>{quoteStatusLabels[quote.status]}</span></td><td>{quote.validUntil ? dateLabel(quote.validUntil) : 'Sem prazo'}</td><td className="mp-numeric"><strong>{money(quote.totalCents)}</strong></td><td><div className="mp-row-actions"><button className="button button-ghost" aria-label={`Editar orçamento ${quote.number}`} onClick={() => setEditing(quote)}><Pencil size={16} aria-hidden="true" />Editar</button><a className="button button-secondary" href={quotePdfUrl(quote.id)} target="_blank" rel="noreferrer" aria-label={`Abrir PDF do orçamento ${quote.number}`}><Download size={16} aria-hidden="true" />PDF</a></div></td>
      </tr>)}</tbody></table></div>}
    </section>
    {editing !== undefined && <QuoteEditor key={editing?.id ?? 'new'} props={props} quote={editing} onClose={() => setEditing(undefined)} />}
  </div>;
}

function MaterialEditor({ props, material, onClose }: { props: PageProps; material: Material | null; onClose: () => void }) {
  const { submit, busy, error } = useAction(props, onClose);
  const [validation, setValidation] = useState<string | null>(null);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setValidation(null);
    const values = new FormData(event.currentTarget);
    const text = (name: string) => String(values.get(name) ?? '').trim();
    try {
      await submit({ type: 'material.save', id: material?.id ?? null, version: material?.version ?? null, data: { name: text('name'), sku: text('sku'), unit: text('unit'), costCents: nonnegativeMoney(text('cost'), 'O custo'), minimumMilli: nonnegativeQuantity(text('minimum')), notes: text('notes'), active: values.get('active') === 'on' } });
    } catch (issue) { setValidation(errorMessage(issue)); }
  }
  return <Modal title={material ? 'Editar material' : 'Novo material'} onClose={onClose}><form className="mp-editor" onSubmit={save}><fieldset disabled={busy} className="mp-fieldset"><div className="form-grid">
    <Field label="Nome do material *" wide><input name="name" required defaultValue={material?.name ?? ''} placeholder="Ex.: Cabo flexível 2,5 mm²" /></Field>
    <Field label="Código / SKU"><input name="sku" defaultValue={material?.sku ?? ''} /></Field>
    <Field label="Unidade *"><input name="unit" required maxLength={20} defaultValue={material?.unit ?? 'un'} placeholder="un, m, kg, caixa…" /></Field>
    <Field label="Custo unitário (R$) *"><input name="cost" required inputMode="decimal" defaultValue={moneyInput(material?.costCents ?? 0)} /></Field>
    <Field label="Estoque mínimo *"><input name="minimum" required inputMode="decimal" defaultValue={quantityInput(material?.minimumMilli ?? 0)} /></Field>
    <Field label="Observações" wide><textarea name="notes" rows={3} defaultValue={material?.notes ?? ''} /></Field>
    <label className="mp-checkbox"><input name="active" type="checkbox" defaultChecked={material?.active ?? true} /><span>Material ativo no catálogo</span></label>
  </div><p className="muted mp-help">Para alterar o saldo, registre uma movimentação na página Estoque. Desativar retira o material de novas seleções sem apagar seu histórico.</p><FormError error={validation || error} /><div className="form-actions"><button type="button" className="button button-secondary" onClick={onClose}>Cancelar</button><button type="submit" className="button button-primary">{busy ? 'Salvando…' : 'Salvar material'}</button></div></fieldset></form></Modal>;
}

export function MaterialsPage(props: PageProps) {
  const { data } = props;
  const [search, setSearch] = useState('');
  const [active, setActive] = useState('active');
  const [editing, setEditing] = useState<Material | null | undefined>(undefined);
  const materials = data.materials.filter((material) => (active === 'all' || material.active === (active === 'active')) && matches(search, material.name, material.sku, material.unit, material.notes));
  return <div className="page-stack">
    <div className="page-heading"><div><h1 className="page-title">Catálogo de materiais</h1><p className="muted">Custos, unidades e referências para orçamentos e estoque.</p></div><div className="page-actions"><button className="button button-primary" onClick={() => setEditing(null)}><Plus size={18} aria-hidden="true" />Novo material</button></div></div>
    <section className="card"><div className="card-header mp-filter-row"><SearchField value={search} onChange={setSearch} label="Buscar materiais" placeholder="Buscar nome, SKU ou unidade…" /><Field label="Situação do material"><select value={active} onChange={(event) => setActive(event.target.value)}><option value="active">Ativos</option><option value="inactive">Inativos</option><option value="all">Todos os materiais</option></select></Field></div>
      {materials.length === 0 ? <EmptyState title={data.materials.length ? 'Nenhum material encontrado' : 'Um catálogo pronto para o seu trabalho'} description={data.materials.length ? 'Altere a busca ou inclua materiais inativos no filtro.' : 'Cadastre os materiais que usa. Os saldos são registrados separadamente no estoque.'} action={!data.materials.length ? <button className="button button-primary" onClick={() => setEditing(null)}>Cadastrar material</button> : undefined} /> : <div className="table-wrap"><table className="data-table"><thead><tr><th>Material</th><th>SKU</th><th>Unidade</th><th className="mp-numeric">Custo unitário</th><th className="mp-numeric">Estoque mínimo</th><th>Situação</th><th><span className="mp-sr-only">Ações</span></th></tr></thead><tbody>{materials.map((material) => <tr key={material.id}><td><strong>{material.name}</strong>{material.notes && <span className="mp-cell-secondary mp-truncate" title={material.notes}>{material.notes}</span>}</td><td>{material.sku || '—'}</td><td>{material.unit}</td><td className="mp-numeric">{money(material.costCents)}</td><td className="mp-numeric">{quantity(material.minimumMilli)} {material.unit}</td><td><span className={material.active ? 'badge badge-success' : 'badge badge-muted'}>{material.active ? 'Ativo' : 'Inativo'}</span></td><td><button className="button button-ghost" onClick={() => setEditing(material)} aria-label={`Editar material ${material.name}`}><Pencil size={16} aria-hidden="true" />Editar</button></td></tr>)}</tbody></table></div>}
    </section>
    {editing !== undefined && <MaterialEditor key={editing?.id ?? 'new'} props={props} material={editing} onClose={() => setEditing(undefined)} />}
  </div>;
}

function StockEditor({ props, initialMaterialId, onClose }: { props: PageProps; initialMaterialId: string; onClose: () => void }) {
  const { data } = props;
  const { submit, busy, error } = useAction(props, onClose);
  const [validation, setValidation] = useState<string | null>(null);
  const [materialId, setMaterialId] = useState(initialMaterialId);
  const [kind, setKind] = useState<StockKind>('in');
  const material = data.materials.find((entry) => entry.id === materialId);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setValidation(null);
    const values = new FormData(event.currentTarget);
    const text = (name: string) => String(values.get(name) ?? '').trim();
    try {
      if (!materialId || !material?.active) throw new Error('Selecione um material ativo.')
      await submit({ type: 'stock.move', data: { materialId, serviceId: text('serviceId') || null, kind, quantityMilli: kind === 'adjust' ? nonnegativeQuantity(text('quantity')) : positiveQuantity(text('quantity')), unitCostCents: kind === 'in' && text('cost') ? nonnegativeMoney(text('cost'), 'O custo') : null, occurredOn: text('date'), note: text('note') } });
    } catch (issue) { setValidation(errorMessage(issue)); }
  }
  return <Modal title="Registrar movimentação" onClose={onClose}><form className="mp-editor" onSubmit={save}><fieldset disabled={busy} className="mp-fieldset"><div className="form-grid">
    <Field label="Material *" wide><select required value={materialId} onChange={(event) => setMaterialId(event.target.value)}><option value="">Selecione um material</option>{data.materials.filter((entry) => entry.active).map((entry) => <option key={entry.id} value={entry.id}>{entry.name}{entry.sku ? ` · ${entry.sku}` : ''}{!entry.active ? ' (inativo)' : ''}</option>)}</select></Field>
    <Field label="Tipo de movimentação"><select value={kind} onChange={(event) => setKind(event.target.value as StockKind)}>{Object.entries(stockKindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
    <Field label="Data *"><input name="date" type="date" required defaultValue={today(data.timeZone)} /></Field>
    <Field label={`${kind === 'adjust' ? 'Saldo final contado' : 'Quantidade'}${material ? ` (${material.unit})` : ''} *`}><input name="quantity" inputMode="decimal" required placeholder={kind === 'adjust' ? 'Saldo físico após a contagem' : 'Quantidade da movimentação'} /></Field>
    {kind === 'in' && <Field label="Custo unitário da entrada (R$)"><input name="cost" inputMode="decimal" placeholder={material ? moneyInput(material.costCents) : 'Usar custo do catálogo'} /></Field>}
    <Field label="Serviço vinculado" wide><select name="serviceId" defaultValue=""><option value="">Sem serviço vinculado</option>{data.services.map((service) => <option key={service.id} value={service.id}>{service.title}</option>)}</select></Field>
    <Field label="Motivo / observação" wide><textarea name="note" rows={3} placeholder={kind === 'adjust' ? 'Ex.: Contagem física e conferência' : 'Ex.: Compra ou material utilizado no serviço'} /></Field>
  </div>
    {material && <div className="mp-notice">Saldo atual: <strong>{quantity(material.stockMilli)} {material.unit}</strong>{kind === 'adjust' ? '. Informe o saldo final contado, não a diferença. Zero zera o estoque.' : kind === 'out' ? '. A saída não pode superar o saldo disponível.' : '. O custo em branco usa o valor atual do catálogo.'}</div>}
    <p className="muted mp-help">Esta operação altera somente o estoque. Pagamentos e despesas devem ser registrados no Financeiro.</p><FormError error={validation || error} /><div className="form-actions"><button type="button" className="button button-secondary" onClick={onClose}>Cancelar</button><button type="submit" className="button button-primary">{busy ? 'Registrando…' : 'Registrar movimentação'}</button></div></fieldset></form></Modal>;
}

export function InventoryPage(props: PageProps) {
  const { data } = props;
  const [search, setSearch] = useState('');
  const [onlyLow, setOnlyLow] = useState(false);
  const [movementMaterial, setMovementMaterial] = useState('all');
  const [movementKind, setMovementKind] = useState('all');
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const materialMap = useMemo(() => new Map(data.materials.map((material) => [material.id, material])), [data.materials]);
  const serviceMap = useMemo(() => new Map(data.services.map((service) => [service.id, service.title])), [data.services]);
  const lowStock = data.materials.filter((material) => material.active && material.stockMilli < material.minimumMilli);
  const materials = data.materials.filter((material) => (material.active || material.stockMilli !== 0) && (!onlyLow || (material.active && material.stockMilli < material.minimumMilli)) && matches(search, material.name, material.sku));
  const movements = data.movements.filter((movement) => (movementMaterial === 'all' || movement.materialId === movementMaterial) && (movementKind === 'all' || movement.kind === movementKind)).toSorted((a, b) => b.occurredOn.localeCompare(a.occurredOn) || b.createdAt.localeCompare(a.createdAt));
  const chartData = useMemo(() => data.materials.filter((material) => material.stockValueCents > 0).toSorted((a, b) => b.stockValueCents - a.stockValueCents).slice(0, 8).map((material) => ({ name: material.name, valueCents: material.stockValueCents })), [data.materials]);
  return <div className="page-stack">
    <div className="page-heading"><div><h1 className="page-title">Estoque</h1><p className="muted">Saldo real, reposição e rastreabilidade de cada movimentação.</p></div><div className="page-actions"><button className="button button-primary" onClick={() => setEditing('')} disabled={!data.materials.some((material) => material.active)}><Plus size={18} aria-hidden="true" />Registrar movimentação</button></div></div>
    <div className="stats-grid mp-stock-stats"><div className="stat-card"><Package size={19} aria-hidden="true" /><span>Valor em estoque</span><strong>{money(data.summary.stockValueCents)}</strong><small>Saldo × custo unitário do catálogo</small></div><div className="stat-card"><span>Abaixo do mínimo</span><strong>{lowStock.length}</strong><small>Materiais ativos que precisam de reposição</small></div><div className="stat-card"><span>Materiais ativos</span><strong>{data.materials.filter((material) => material.active).length}</strong><small>Unidades mantidas separadamente por material</small></div></div>
    {lowStock.length > 0 && <div className="mp-notice mp-notice-warning"><strong>Reposição necessária</strong><p>{lowStock.map((material) => `${material.name}: ${quantity(material.stockMilli)} de ${quantity(material.minimumMilli)} ${material.unit}`).join(' · ')}</p><button className="button button-secondary" onClick={() => setOnlyLow(true)}>Ver materiais abaixo do mínimo</button></div>}
    {!data.materials.length && <div className="mp-notice">Cadastre um material no Catálogo de materiais antes de registrar a primeira entrada.</div>}
    <section className="card"><div className="card-header"><div><h2>Valor por material</h2><p className="muted">Até oito maiores valores em reais. Quantidades de unidades diferentes não são somadas.</p></div></div>{chartData.length ? <div className="mp-chart mp-stock-chart" role="img" aria-label="Gráfico do valor em reais dos materiais em estoque. Os saldos e valores completos estão na tabela abaixo."><ResponsiveContainer width="100%" height="100%"><BarChart data={chartData} layout="vertical" margin={{ top: 8, right: 32, left: 8, bottom: 8 }}><CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--border, #e5e7eb)" /><XAxis type="number" tickFormatter={(value: number) => money(value)} tick={{ fontSize: 11 }} /><YAxis type="category" dataKey="name" width={155} tick={{ fontSize: 12 }} /><Tooltip formatter={(value) => [money(Number(value)), 'Valor em estoque']} /><Bar dataKey="valueCents" fill="var(--accent, #2563eb)" radius={[0, 5, 5, 0]} maxBarSize={25} /></BarChart></ResponsiveContainer></div> : <EmptyState title="Sem valor em estoque" description="As entradas de materiais com custo cadastrado aparecerão neste gráfico." />}</section>
    <section className="card"><div className="card-header mp-filter-row"><div><h2>Saldos dos materiais</h2></div><SearchField value={search} onChange={setSearch} label="Buscar saldo de material" placeholder="Buscar material ou SKU…" /><label className="mp-checkbox"><input type="checkbox" checked={onlyLow} onChange={(event) => setOnlyLow(event.target.checked)} /><span>Abaixo do mínimo</span></label></div>{materials.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Material</th><th className="mp-numeric">Saldo atual</th><th className="mp-numeric">Mínimo</th><th className="mp-numeric">Valor em estoque</th><th>Situação</th><th><span className="mp-sr-only">Ações</span></th></tr></thead><tbody>{materials.map((material) => <tr key={material.id}><td><strong>{material.name}</strong><span className="mp-cell-secondary">{material.sku || 'Sem SKU'}{!material.active ? ' · Inativo' : ''}</span></td><td className="mp-numeric"><strong>{quantity(material.stockMilli)} {material.unit}</strong></td><td className="mp-numeric">{quantity(material.minimumMilli)} {material.unit}</td><td className="mp-numeric">{money(material.stockValueCents)}</td><td>{material.stockMilli < material.minimumMilli ? <span className="badge badge-warning">Repor</span> : <span className="badge badge-success">Em dia</span>}</td><td><button className="button button-ghost" disabled={!material.active} title={!material.active ? "Reative o material no catálogo para movimentar" : undefined} onClick={() => setEditing(material.id)} aria-label={`Movimentar ${material.name}`}>Movimentar</button></td></tr>)}</tbody></table></div> : <EmptyState title={data.materials.length ? 'Nenhum material neste filtro' : 'Estoque ainda vazio'} description={data.materials.length ? 'Altere a busca ou desmarque o filtro de estoque mínimo.' : 'Cadastre os materiais e registre entradas para acompanhar os saldos reais.'} />}</section>
    <section className="card"><div className="card-header mp-filter-row"><div><h2>Histórico de movimentações</h2><p className="muted">Somente movimentações do mês selecionado. Os saldos acima são atuais.</p></div><Field label="Mês do histórico de estoque"><input type="month" required value={props.month} onChange={(event) => { if (event.target.value) props.setMonth(event.target.value); }} /></Field><Field label="Material no histórico"><select value={movementMaterial} onChange={(event) => setMovementMaterial(event.target.value)}><option value="all">Todos os materiais</option>{data.materials.map((material) => <option key={material.id} value={material.id}>{material.name}</option>)}</select></Field><Field label="Tipo no histórico"><select value={movementKind} onChange={(event) => setMovementKind(event.target.value)}><option value="all">Todos os tipos</option>{Object.entries(stockKindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field></div>{movements.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Data</th><th>Material / observação</th><th>Tipo</th><th className="mp-numeric">Variação</th><th>Serviço</th></tr></thead><tbody>{movements.map((movement) => {
      const material = materialMap.get(movement.materialId);
      return <tr key={movement.id}><td>{dateLabel(movement.occurredOn)}</td><td><strong>{material?.name ?? 'Material vinculado'}</strong>{movement.note && <span className="mp-cell-secondary">{movement.note}</span>}</td><td><span className={statusClass(movement.kind)}>{stockKindLabels[movement.kind]}</span>{movement.kind === 'adjust' && <span className="mp-cell-secondary">Saldo final: {quantity(movement.quantityMilli)} {material?.unit}</span>}</td><td className={`mp-numeric ${movement.deltaMilli < 0 ? 'mp-negative' : 'mp-positive'}`}>{movement.deltaMilli > 0 ? '+' : ''}{quantity(movement.deltaMilli)} {material?.unit}</td><td>{movement.serviceId ? serviceMap.get(movement.serviceId) ?? 'Serviço vinculado' : '—'}</td></tr>;
    })}</tbody></table></div> : <EmptyState title="Nenhuma movimentação encontrada" description={data.movements.length ? 'Selecione outro material ou tipo de movimentação.' : 'Entradas, consumos e ajustes ficam registrados aqui com data e serviço.'} />}</section>
    {editing !== undefined && <StockEditor props={props} initialMaterialId={editing} onClose={() => setEditing(undefined)} />}
  </div>;
}

function CashEditor({ props, entry, onClose }: { props: PageProps; entry: CashEntry | null; onClose: () => void }) {
  const { data } = props;
  const { submit, busy, error } = useAction(props, onClose);
  const [validation, setValidation] = useState<string | null>(null);
  const [clientId, setClientId] = useState(entry?.clientId ?? '');
  const [serviceId, setServiceId] = useState(entry?.serviceId ?? '');
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setValidation(null);
    const values = new FormData(event.currentTarget);
    const text = (name: string) => String(values.get(name) ?? '').trim();
    try {
      await submit({ type: 'cash.save', id: entry?.id ?? null, version: entry?.version ?? null, data: { kind: text('kind') as 'income' | 'expense', description: text('description'), category: text('category'), amountCents: positiveMoney(text('amount'), 'O valor'), date: text('date'), status: text('status') as CashStatus, clientId: clientId || null, serviceId: serviceId || null } });
    } catch (issue) { setValidation(errorMessage(issue)); }
  }
  const defaultDate = today(data.timeZone).startsWith(props.month) ? today(data.timeZone) : `${props.month}-01`;
  return <Modal title={entry ? 'Editar lançamento' : 'Novo lançamento financeiro'} onClose={onClose}><form className="mp-editor" onSubmit={save}><fieldset disabled={busy} className="mp-fieldset"><div className="form-grid">
    <Field label="Descrição *" wide><input name="description" required defaultValue={entry?.description ?? ''} placeholder="Ex.: Pagamento de serviço ou compra de material" /></Field>
    <Field label="Tipo"><select name="kind" defaultValue={entry?.kind ?? 'income'}><option value="income">Receita</option><option value="expense">Despesa</option></select></Field>
    <Field label="Valor (R$) *"><input name="amount" required inputMode="decimal" defaultValue={entry ? moneyInput(entry.amountCents) : ''} placeholder="0,00" /></Field>
    <Field label="Data do recebimento / pagamento ou vencimento *"><input name="date" type="date" required defaultValue={entry?.date ?? defaultDate} /></Field>
    <Field label="Situação"><select name="status" defaultValue={entry?.status ?? 'pending'}><option value="pending">Pendente — a receber / a pagar</option><option value="paid">Realizado — recebido / pago</option>{entry?.status === 'void' && <option value="void">Anulado</option>}</select></Field>
    <Field label="Categoria *" wide><input name="category" required defaultValue={entry?.category ?? ''} placeholder="Ex.: Serviços, materiais, transporte" /></Field>
    <ClientServiceFields data={data} clientId={clientId} serviceId={serviceId} onChange={(client, service) => { setClientId(client); setServiceId(service); }} />
  </div><p className="muted mp-help">Somente lançamentos realizados entram no caixa. Pendentes aparecem em contas a receber / a pagar. Use a data efetiva ao marcar como recebido ou pago.</p><FormError error={validation || error} /><div className="form-actions"><button type="button" className="button button-secondary" onClick={onClose}>Cancelar</button><button type="submit" className="button button-primary">{busy ? 'Salvando…' : 'Salvar lançamento'}</button></div></fieldset></form></Modal>;
}

function VoidCashConfirmation({ props, entry, onClose }: { props: PageProps; entry: CashEntry; onClose: () => void }) {
  const { submit, busy, error } = useAction(props, onClose);
  const action: BusinessAction = { type: 'cash.save', id: entry.id, version: entry.version, data: { kind: entry.kind, description: entry.description, category: entry.category, amountCents: entry.amountCents, date: entry.date, status: 'void', clientId: entry.clientId, serviceId: entry.serviceId } };
  return <Modal title="Anular lançamento?" onClose={onClose}><div className="mp-editor"><p>O lançamento <strong>{entry.description}</strong>, de <strong>{money(entry.amountCents)}</strong>, será anulado.</p><p className="muted">Ele será retirado do caixa e das contas pendentes, mas permanecerá no histórico para consulta.</p><FormError error={error} /><div className="form-actions"><button className="button button-secondary" disabled={busy} onClick={onClose}>Manter lançamento</button><button className="button button-danger" disabled={busy} onClick={() => void submit(action)}>{busy ? 'Anulando…' : 'Confirmar anulação'}</button></div></div></Modal>;
}

export function FinancePage(props: PageProps) {
  const { data, month, setMonth } = props;
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [kind, setKind] = useState('all');
  const [editing, setEditing] = useState<CashEntry | null | undefined>(undefined);
  const [voiding, setVoiding] = useState<CashEntry | null>(null);
  const clients = useMemo(() => new Map(data.clients.map((client) => [client.id, client.name])), [data.clients]);
  const services = useMemo(() => new Map(data.services.map((service) => [service.id, service.title])), [data.services]);
  const cash = data.summary.cash;
  const entries = data.cashEntries.filter((entry) => entry.date.startsWith(`${month}-`) && (status === 'all' || entry.status === status) && (kind === 'all' || entry.kind === kind) && matches(search, entry.description, entry.category, entry.clientId ? clients.get(entry.clientId) : '', entry.serviceId ? services.get(entry.serviceId) : '')).toSorted((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  const hasCash = cash.series.some((day) => day.incomeCents !== 0 || day.expenseCents !== 0) || cash.openingCents !== 0;
  return <div className="page-stack">
    <div className="page-heading"><div><h1 className="page-title">Financeiro</h1><p className="muted">O que entrou, o que saiu e o que ainda precisa acontecer.</p></div><div className="page-actions"><Field label="Mês financeiro"><input type="month" value={month} required onChange={(event) => { if (event.target.value) setMonth(event.target.value); }} /></Field><button className="button button-primary" onClick={() => setEditing(null)}><Plus size={18} aria-hidden="true" />Novo lançamento</button></div></div>
    <div className="stats-grid mp-finance-stats"><div className="stat-card"><ArrowDownLeft size={19} className="mp-positive" aria-hidden="true" /><span>Recebido no mês</span><strong className="mp-positive">{money(cash.incomeCents)}</strong><small>Somente receitas realizadas</small></div><div className="stat-card"><ArrowUpRight size={19} className="mp-negative" aria-hidden="true" /><span>Pago no mês</span><strong className="mp-negative">{money(cash.expenseCents)}</strong><small>Somente despesas realizadas</small></div><div className="stat-card"><Wallet size={19} aria-hidden="true" /><span>Saldo de caixa</span><strong>{money(cash.balanceCents)}</strong><small>Inclui saldo anterior de {money(cash.openingCents)}</small></div><div className="stat-card"><span>Total a receber</span><strong>{money(cash.receivableCents)}</strong><small>Todos os meses · pendentes, fora do caixa</small></div><div className="stat-card"><span>Total a pagar</span><strong>{money(cash.payableCents)}</strong><small>Todos os meses · pendentes, fora do caixa</small></div></div>
    <section className="card"><div className="card-header"><div><h2>Fluxo de caixa realizado</h2><p className="muted">Recebimentos e pagamentos por dia, com saldo acumulado. Orçamentos e pendências não entram neste gráfico.</p></div></div>{hasCash ? <div className="mp-chart mp-cash-chart" role="img" aria-label="Fluxo de caixa em reais no mês selecionado, com receitas realizadas, despesas realizadas e saldo acumulado. Os lançamentos estão na tabela abaixo."><ResponsiveContainer width="100%" height="100%"><AreaChart data={cash.series} margin={{ top: 14, right: 24, left: 14, bottom: 5 }}><CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border, #e5e7eb)" /><XAxis dataKey="date" tickFormatter={(value: string) => value.slice(8, 10)} tick={{ fontSize: 12 }} minTickGap={14} /><YAxis tickFormatter={(value: number) => money(value)} width={112} tick={{ fontSize: 11 }} /><Tooltip labelFormatter={(value) => dateLabel(String(value))} formatter={(value) => money(Number(value))} /><Legend /><Area type="linear" dataKey="incomeCents" name="Recebido" stroke="#14845d" fill="#14845d" fillOpacity={0.07} strokeWidth={2} /><Area type="linear" dataKey="expenseCents" name="Pago" stroke="#d76b58" fill="#d76b58" fillOpacity={0.05} strokeWidth={2} /><Area type="linear" dataKey="balanceCents" name="Saldo acumulado" stroke="var(--accent, #2563eb)" fill="var(--accent, #2563eb)" fillOpacity={0.08} strokeWidth={2.5} /></AreaChart></ResponsiveContainer></div> : <EmptyState title="Nenhuma movimentação de caixa neste mês" description="Registre uma receita recebida ou uma despesa paga para visualizar o fluxo. Contas pendentes não alteram o saldo." />}</section>
    <section className="card"><div className="card-header mp-filter-row"><SearchField value={search} onChange={setSearch} label="Buscar lançamentos" placeholder="Buscar descrição, categoria ou cliente…" /><Field label="Situação do lançamento"><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">Todas as situações</option>{Object.entries(cashStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><Field label="Tipo de lançamento"><select value={kind} onChange={(event) => setKind(event.target.value)}><option value="all">Receitas e despesas</option><option value="income">Receitas</option><option value="expense">Despesas</option></select></Field></div>{entries.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Data</th><th>Descrição / categoria</th><th>Cliente / serviço</th><th>Tipo</th><th>Situação</th><th className="mp-numeric">Valor</th><th><span className="mp-sr-only">Ações</span></th></tr></thead><tbody>{entries.map((entry) => <tr key={entry.id} className={entry.status === 'void' ? 'mp-void-row' : undefined}><td>{dateLabel(entry.date)}</td><td><strong>{entry.description}</strong><span className="mp-cell-secondary">{entry.category}</span></td><td>{entry.clientId ? clients.get(entry.clientId) ?? 'Cliente vinculado' : '—'}{entry.serviceId && <span className="mp-cell-secondary">{services.get(entry.serviceId) ?? 'Serviço vinculado'}</span>}</td><td><span className={entry.kind === 'income' ? 'mp-positive' : 'mp-negative'}>{entry.kind === 'income' ? 'Receita' : 'Despesa'}</span></td><td><span className={statusClass(entry.status)}>{cashStatusLabels[entry.status]}</span></td><td className="mp-numeric"><strong>{money(entry.amountCents)}</strong></td><td><div className="mp-row-actions"><button className="button button-ghost" onClick={() => setEditing(entry)} aria-label={`Editar lançamento ${entry.description}`}><Pencil size={16} aria-hidden="true" />Editar</button>{entry.status !== 'void' && <button className="button button-ghost mp-destructive" onClick={() => setVoiding(entry)} aria-label={`Anular lançamento ${entry.description}`}><Trash2 size={16} aria-hidden="true" />Anular</button>}</div></td></tr>)}</tbody></table></div> : <EmptyState title="Nenhum lançamento neste filtro" description="Escolha outro mês ou filtro, ou registre uma receita ou despesa. Nenhum valor é criado automaticamente a partir de orçamentos ou estoque." action={<button className="button button-primary" onClick={() => setEditing(null)}><Plus size={16} aria-hidden="true" />Novo lançamento</button>} />}</section>
    {editing !== undefined && <CashEditor key={editing?.id ?? 'new'} props={props} entry={editing} onClose={() => setEditing(undefined)} />}
    {voiding && <VoidCashConfirmation props={props} entry={voiding} onClose={() => setVoiding(null)} />}
  </div>;
}

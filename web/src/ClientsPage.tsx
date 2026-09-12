import { useMemo, useState } from 'react';
import { Mail, MapPin, Pencil, Phone, Plus, Search, UserCheck, Users } from 'lucide-react';
import type { Client, ClientInput } from '../../src/business-contract.ts';
import type { PageProps } from './api';
import { EmptyState, Field, Modal, useAction } from './ui';

export function ClientsPage(props: PageProps) {
  const { data } = props;
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('active');
  const [editing, setEditing] = useState<Client | null | undefined>(undefined);
  const clients = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('pt-BR');
    return data.clients.filter((client) => (status === 'all' || client.active === (status === 'active')) && `${client.name} ${client.phone} ${client.email} ${client.address}`.toLocaleLowerCase('pt-BR').includes(term)).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  }, [data.clients, search, status]);
  const serviceCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const service of data.services) if (service.clientId) counts.set(service.clientId, (counts.get(service.clientId) ?? 0) + 1);
    return counts;
  }, [data.services]);
  const activeCount = data.clients.filter((client) => client.active).length;

  return <div className="page-stack">
    <div className="page-heading"><div><div className="eyebrow">RELACIONAMENTOS</div><h1>Clientes</h1><p>Contatos organizados, do primeiro atendimento ao próximo serviço.</p></div><button className="button button-primary" onClick={() => setEditing(null)}><Plus size={17} />Novo cliente</button></div>
    <div className="crm-summary"><span><span className="small-icon teal"><Users size={18} /></span><strong>{data.clients.length}</strong> clientes cadastrados</span><span><span className="small-icon blue"><UserCheck size={18} /></span><strong>{activeCount}</strong> ativos</span></div>
    <section className="card">
      <div className="table-toolbar"><label className="search-field"><Search size={18} /><span className="sr-only">Buscar clientes</span><input type="search" placeholder="Buscar nome, telefone ou endereço…" value={search} onChange={(event) => setSearch(event.target.value)} /></label><label className="filter-field"><span className="sr-only">Filtrar clientes por situação</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="active">Clientes ativos</option><option value="inactive">Clientes inativos</option><option value="all">Todos os clientes</option></select></label></div>
      {clients.length === 0 ? <EmptyState title={data.clients.length === 0 ? 'Seu próximo atendimento começa aqui' : 'Nenhum cliente encontrado'} description={data.clients.length === 0 ? 'Cadastre um cliente para vincular visitas, serviços, orçamentos e lançamentos.' : 'Experimente outro termo ou altere o filtro de situação.'} action={data.clients.length === 0 ? <button className="button button-primary" onClick={() => setEditing(null)}><Plus size={16} />Cadastrar primeiro cliente</button> : <button className="button button-secondary" onClick={() => { setSearch(''); setStatus('all'); }}>Limpar filtros</button>} /> : <div className="table-wrap"><table className="data-table clients-table"><thead><tr><th>Cliente</th><th>Contato</th><th>Endereço</th><th>Serviços</th><th>Situação</th><th><span className="sr-only">Ações</span></th></tr></thead><tbody>{clients.map((client) => <tr key={client.id}><td><div className="person-cell"><span className="person-avatar" aria-hidden="true">{client.name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join('').toLocaleUpperCase('pt-BR')}</span><strong>{client.name}</strong></div></td><td><div className="contact-cell">{client.phone && <span><Phone size={13} />{client.phone}</span>}{client.email && <span><Mail size={13} />{client.email}</span>}{!client.phone && !client.email && <span className="muted">Não informado</span>}</div></td><td><span className="address-cell">{client.address || 'Não informado'}</span></td><td>{serviceCounts.get(client.id) ?? 0}</td><td><span className={`badge ${client.active ? 'badge-success' : 'badge-muted'}`}>{client.active ? 'Ativo' : 'Inativo'}</span></td><td><button className="icon-button" aria-label={`Editar cliente ${client.name}`} title="Editar cliente" onClick={() => setEditing(client)}><Pencil size={16} /></button></td></tr>)}</tbody></table></div>}
      {clients.length > 0 && <div className="table-footer">{clients.length} {clients.length === 1 ? 'cliente nesta visualização' : 'clientes nesta visualização'}</div>}
    </section>
    <div className="helper-note"><MapPin size={16} /><span>Endereços e contatos ficam disponíveis ao agendar uma visita ou criar um serviço.</span></div>
    {editing !== undefined && <ClientEditor key={editing?.id ?? 'new'} {...props} client={editing} onClose={() => setEditing(undefined)} />}
  </div>;
}

function ClientEditor(props: PageProps & { client: Client | null; onClose: () => void }) {
  const { client, onClose } = props;
  const [draft, setDraft] = useState<ClientInput>(() => client ? { name: client.name, phone: client.phone, email: client.email, address: client.address, notes: client.notes, active: client.active } : { name: '', phone: '', email: '', address: '', notes: '', active: true });
  const { submit, busy, error } = useAction(props, onClose);
  return <Modal title={client ? 'Editar cliente' : 'Novo cliente'} onClose={() => { if (!busy) onClose(); }}><form onSubmit={(event) => { event.preventDefault(); void submit({ type: 'client.save', id: client?.id ?? null, version: client?.version ?? null, data: { ...draft, name: draft.name.trim(), email: draft.email.trim() } }); }}>
    <fieldset disabled={busy} className="form-grid">
      <Field label="Nome do cliente *" wide><input autoFocus required autoComplete="name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Nome completo ou razão social" /></Field>
      <Field label="Telefone"><input type="tel" autoComplete="tel" value={draft.phone} onChange={(event) => setDraft({ ...draft, phone: event.target.value })} placeholder="DDD + número" /></Field>
      <Field label="E-mail"><input type="email" autoComplete="email" value={draft.email} onChange={(event) => setDraft({ ...draft, email: event.target.value })} placeholder="cliente@exemplo.com" /></Field>
      <Field label="Endereço" wide><input autoComplete="street-address" value={draft.address} onChange={(event) => setDraft({ ...draft, address: event.target.value })} placeholder="Rua, número, bairro e cidade" /></Field>
      <Field label="Observações" wide><textarea rows={3} value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} placeholder="Informações úteis para os próximos atendimentos" /></Field>
      <label className="checkbox-field field-wide"><input type="checkbox" checked={draft.active} onChange={(event) => setDraft({ ...draft, active: event.target.checked })} /><span><strong>Cliente ativo</strong><small>Clientes inativos continuam no histórico e podem ser reativados.</small></span></label>
    </fieldset>
    {error && <div className="inline-error" role="alert">{error}</div>}
    <div className="form-actions"><button type="button" className="button button-secondary" disabled={busy} onClick={onClose}>Cancelar</button><button type="submit" className="button button-primary" disabled={busy}>{busy ? 'Salvando…' : client ? 'Salvar alterações' : 'Cadastrar cliente'}</button></div>
  </form></Modal>;
}

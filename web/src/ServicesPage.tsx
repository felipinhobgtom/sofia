import { useMemo, useState } from 'react';
import { BriefcaseBusiness, CalendarDays, FileText, MapPin, Pencil, Plus, Search, UserRound } from 'lucide-react';
import { serviceStageLabels, type Service, type ServiceInput, type ServiceStage } from '../../src/business-contract.ts';
import type { PageProps } from './api';
import { EmptyState, Field, Modal, money, useAction } from './ui';

const stages = Object.keys(serviceStageLabels) as ServiceStage[];

export function ServicesPage(props: PageProps) {
  const { data } = props;
  const [search, setSearch] = useState('');
  const [clientId, setClientId] = useState('');
  const [editing, setEditing] = useState<Service | null | undefined>(undefined);
  const [newStage, setNewStage] = useState<ServiceStage>('awaiting_visit');
  const clientNames = useMemo(() => new Map(data.clients.map((client) => [client.id, client.name])), [data.clients]);
  const services = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('pt-BR');
    return data.services.filter((service) => (!clientId || service.clientId === clientId) && `${service.title} ${service.description} ${service.address} ${clientNames.get(service.clientId ?? '') ?? ''}`.toLocaleLowerCase('pt-BR').includes(term)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [data.services, search, clientId, clientNames]);
  const newService = (stage: ServiceStage = 'awaiting_visit') => { setNewStage(stage); setEditing(null); };

  return <div className="page-stack">
    <div className="page-heading"><div><div className="eyebrow">DA VISITA À ENTREGA</div><h1>Serviços</h1><p>Saiba em que etapa está cada trabalho e mantenha tudo conectado.</p></div><button className="button button-primary" onClick={() => newService()}><Plus size={17} />Novo serviço</button></div>
    <div className="service-toolbar"><label className="search-field"><Search size={18} /><span className="sr-only">Buscar serviços</span><input type="search" placeholder="Buscar serviço, cliente ou endereço…" value={search} onChange={(event) => setSearch(event.target.value)} /></label><label className="filter-field"><span className="sr-only">Filtrar serviços por cliente</span><select value={clientId} onChange={(event) => setClientId(event.target.value)}><option value="">Todos os clientes</option>{data.clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label><span className="service-total">{services.length} {services.length === 1 ? 'serviço' : 'serviços'}</span></div>
    {data.services.length === 0 && <div className="onboarding-note"><BriefcaseBusiness size={21} /><div><strong>Seu fluxo de trabalho começa com um serviço.</strong><p>Cadastre o primeiro e acompanhe as cinco etapas abaixo. Você pode alterar a etapa a qualquer momento.</p></div></div>}
    {data.services.length > 0 && services.length === 0 && <div className="card"><EmptyState title="Nenhum serviço encontrado" description="Ajuste a busca ou o filtro de cliente para ver outros registros." action={<button className="button button-secondary" onClick={() => { setSearch(''); setClientId(''); }}>Limpar filtros</button>} /></div>}
    <div className="kanban-scroll" role="region" aria-label="Quadro de serviços em cinco etapas" tabIndex={0}>
      <div className="kanban-board">{stages.map((stage) => {
        const stageServices = services.filter((service) => service.stage === stage);
        return <section key={stage} className={`kanban-column stage-${stage}`} aria-label={serviceStageLabels[stage]}><header className="kanban-header"><span className="stage-dot" /><h2>{serviceStageLabels[stage]}</h2><span className="kanban-count">{stageServices.length}</span></header><div className="kanban-cards">{stageServices.map((service) => <ServiceCard key={service.id} {...props} service={service} clientName={clientNames.get(service.clientId ?? '')} onEdit={() => setEditing(service)} />)}{stageServices.length === 0 && <div className="kanban-empty">Nenhum serviço nesta etapa</div>}</div><button className="kanban-add" onClick={() => newService(stage)}><Plus size={15} />Adicionar serviço<span className="sr-only"> em {serviceStageLabels[stage]}</span></button></section>;
      })}</div>
    </div>
    <div className="helper-note"><BriefcaseBusiness size={16} /><span>Use o seletor de etapa em cada cartão para mover um serviço. O histórico de vínculos é preservado.</span></div>
    {editing !== undefined && <ServiceEditor key={editing?.id ?? `new-${newStage}`} {...props} service={editing} initialStage={newStage} onClose={() => setEditing(undefined)} />}
  </div>;
}

function ServiceCard(props: PageProps & { service: Service; clientName?: string; onEdit: () => void }) {
  const { service, clientName, onEdit, data } = props;
  const { submit, busy, error } = useAction(props);
  const quoteCount = data.quotes.filter((quote) => quote.serviceId === service.id).length;
  const visitCount = data.visits.filter((visit) => visit.serviceId === service.id && visit.status === 'scheduled').length;
  return <article className="service-card"><div className="service-card-top"><button className="service-title" onClick={onEdit}>{service.title}</button><button className="icon-button" aria-label={`Editar serviço ${service.title}`} onClick={onEdit}><Pencil size={14} /></button></div><div className="service-card-detail"><UserRound size={13} /><span>{clientName || 'Sem cliente vinculado'}</span></div>{service.address && <div className="service-card-detail"><MapPin size={13} /><span>{service.address}</span></div>}{service.description && <p className="service-description">{service.description}</p>}<div className="service-links"><span title="Orçamentos vinculados"><FileText size={13} />{quoteCount} {quoteCount === 1 ? 'orçamento' : 'orçamentos'}</span>{visitCount > 0 && <span title="Visitas agendadas no mês selecionado"><CalendarDays size={13} />{visitCount} no mês</span>}</div><label className="stage-select"><span className="sr-only">Etapa de {service.title}</span><select value={service.stage} disabled={busy} onChange={(event) => { void submit({ type: 'service.save', id: service.id, version: service.version, data: { title: service.title, clientId: service.clientId, address: service.address, description: service.description, stage: event.target.value as ServiceStage } }); }}>{stages.map((stage) => <option key={stage} value={stage}>{serviceStageLabels[stage]}</option>)}</select></label>{busy && <span className="muted service-saving" role="status">Atualizando etapa…</span>}{error && <div className="inline-error" role="alert">{error}</div>}</article>;
}

function ServiceEditor(props: PageProps & { service: Service | null; initialStage: ServiceStage; onClose: () => void }) {
  const { service, initialStage, onClose, data } = props;
  const [draft, setDraft] = useState<ServiceInput>(() => service ? { clientId: service.clientId, title: service.title, description: service.description, address: service.address, stage: service.stage } : { clientId: null, title: '', description: '', address: '', stage: initialStage });
  const { submit, busy, error } = useAction(props, onClose);
  const quotes = service ? data.quotes.filter((quote) => quote.serviceId === service.id) : [];
  return <Modal title={service ? 'Editar serviço' : 'Novo serviço'} onClose={() => { if (!busy) onClose(); }}><form onSubmit={(event) => { event.preventDefault(); void submit({ type: 'service.save', id: service?.id ?? null, version: service?.version ?? null, data: { ...draft, title: draft.title.trim() } }); }}>
    <fieldset disabled={busy} className="form-grid">
      <Field label="Título do serviço *" wide><input autoFocus required value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="Descreva o trabalho a realizar" /></Field>
      <Field label="Cliente"><select value={draft.clientId ?? ''} onChange={(event) => { const client = data.clients.find((item) => item.id === event.target.value); setDraft({ ...draft, clientId: event.target.value || null, address: draft.address || client?.address || '' }); }}><option value="">Sem cliente vinculado</option>{data.clients.filter((client) => client.active || client.id === draft.clientId).map((client) => <option key={client.id} value={client.id}>{client.name}{!client.active ? ' (inativo)' : ''}</option>)}</select></Field>
      <Field label="Etapa"><select value={draft.stage} onChange={(event) => setDraft({ ...draft, stage: event.target.value as ServiceStage })}>{stages.map((stage) => <option key={stage} value={stage}>{serviceStageLabels[stage]}</option>)}</select></Field>
      <Field label="Endereço do serviço" wide><input value={draft.address} onChange={(event) => setDraft({ ...draft, address: event.target.value })} placeholder="Local onde o trabalho será realizado" /></Field>
      <Field label="Descrição e observações" wide><textarea rows={4} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder="Escopo, detalhes e combinações com o cliente" /></Field>
    </fieldset>
    {quotes.length > 0 && <div className="linked-records"><h3>Orçamentos vinculados</h3>{quotes.map((quote) => <div key={quote.id}><span>{quote.number} · {quote.title}</span><strong>{money(quote.totalCents)}</strong></div>)}<a className="text-link" href="#quotes" onClick={onClose}>Ver orçamentos</a></div>}
    {error && <div className="inline-error" role="alert">{error}</div>}
    <div className="form-actions"><button type="button" className="button button-secondary" disabled={busy} onClick={onClose}>Cancelar</button><button type="submit" className="button button-primary" disabled={busy}>{busy ? 'Salvando…' : service ? 'Salvar alterações' : 'Criar serviço'}</button></div>
  </form></Modal>;
}

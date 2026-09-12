import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, Check, ChevronLeft, ChevronRight, Clock3, MapPin, Pencil, Plus, UserRound, X } from 'lucide-react';
import { visitStatusLabels, type Visit, type VisitInput, type VisitStatus } from '../../src/business-contract.ts';
import type { PageProps } from './api';
import { dateTime, EmptyState, Field, localDateTime, Modal, useAction } from './ui';

const statuses = Object.keys(visitStatusLabels) as VisitStatus[];
const weekdays = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const localDayLabel = (day: string) => new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', dateStyle: 'full' }).format(new Date(`${day}T12:00:00Z`));
function adjacentMonth(month: string, delta: number): string {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year!, number! - 1 + delta, 1, 12)).toISOString().slice(0, 7);
}

export function CalendarPage(props: PageProps) {
  const { data, month, setMonth } = props;
  const today = localDateTime(new Date().toISOString(), data.timeZone).slice(0, 10);
  const [editing, setEditing] = useState<Visit | null | undefined>(undefined);
  const [newDay, setNewDay] = useState(today);
  const [filter, setFilter] = useState('all');
  const [selectedDay, setSelectedDay] = useState('');
  useEffect(() => { setSelectedDay(''); }, [month]);
  const clientNames = useMemo(() => new Map(data.clients.map((client) => [client.id, client.name])), [data.clients]);
  const serviceNames = useMemo(() => new Map(data.services.map((service) => [service.id, service.title])), [data.services]);
  const visits = useMemo(() => data.visits.map((visit) => ({ visit, start: localDateTime(visit.startAt, data.timeZone), end: localDateTime(visit.endAt, data.timeZone) })).sort((a, b) => a.visit.startAt.localeCompare(b.visit.startAt)), [data.visits, data.timeZone]);
  const [year, number] = month.split('-').map(Number);
  const first = new Date(Date.UTC(year!, number! - 1, 1, 12));
  const daysInMonth = new Date(Date.UTC(year!, number!, 0, 12)).getUTCDate();
  const cells = Math.ceil((first.getUTCDay() + daysInMonth) / 7) * 7;
  const calendarDays = Array.from({ length: cells }, (_, index) => new Date(Date.UTC(year!, number! - 1, index - first.getUTCDay() + 1, 12)).toISOString().slice(0, 10));
  const monthLabel = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(first);
  const dayVisits = (day: string) => visits.filter(({ start, end }) => start.slice(0, 10) <= day && (end.slice(0, 10) > day || end.slice(0, 10) === day && end.slice(11) !== '00:00'));
  const visibleVisits = (selectedDay ? dayVisits(selectedDay) : visits).filter(({ visit }) => filter === 'all' || visit.status === filter);
  const createVisit = (day = today.slice(0, 7) === month ? today : `${month}-01`) => { setNewDay(day); setEditing(null); };

  return <div className="page-stack calendar-page">
    <div className="page-heading"><div><div className="eyebrow">TEMPO BEM ORGANIZADO</div><h1>Agenda de visitas</h1><p>Agende, reagende e acompanhe os atendimentos do seu negócio.</p></div><button className="button button-primary" onClick={() => createVisit()}><Plus size={17} />Nova visita</button></div>
    <section className="card calendar-card" aria-label="Calendário mensal">
      <div className="calendar-toolbar"><div className="calendar-month-navigation"><button className="icon-button" aria-label="Mês anterior" onClick={() => setMonth(adjacentMonth(month, -1))}><ChevronLeft size={19} /></button><h2>{monthLabel}</h2><button className="icon-button" aria-label="Próximo mês" onClick={() => setMonth(adjacentMonth(month, 1))}><ChevronRight size={19} /></button><button className="button button-secondary button-small" onClick={() => { setMonth(today.slice(0, 7)); setSelectedDay(today); }}>Hoje</button></div><div className="calendar-legend"><span><i className="status-dot scheduled" />Agendada</span><span><i className="status-dot completed" />Realizada</span><span><i className="status-dot cancelled" />Cancelada</span></div></div>
      <div className="calendar-grid"><div className="calendar-weekdays">{weekdays.map((day) => <div key={day}>{day}</div>)}</div><div className="calendar-days">{calendarDays.map((day) => {
        const entries = dayVisits(day);
        const outside = day.slice(0, 7) !== month;
        return <div key={day} className={`calendar-day ${outside ? 'outside-month' : ''} ${day === today ? 'is-today' : ''} ${selectedDay === day ? 'is-selected' : ''}`}><div className="calendar-day-top"><button className="day-number" aria-label={`Agendar visita em ${localDayLabel(day)}`} aria-current={day === today ? 'date' : undefined} onClick={() => createVisit(day)}>{Number(day.slice(-2))}</button><button className="day-add" aria-label={`Nova visita em ${day.split('-').reverse().join('/')}`} onClick={() => createVisit(day)}><Plus size={13} /></button></div><div className="calendar-day-events">{entries.slice(0, 2).map(({ visit, start }) => <button className={`calendar-event event-${visit.status}`} key={visit.id} title={`${visit.title} · ${dateTime(visit.startAt, data.timeZone)} · ${visitStatusLabels[visit.status]}`} aria-label={`${visit.title}, ${dateTime(visit.startAt, data.timeZone)}, ${visitStatusLabels[visit.status]}. Editar visita`} onClick={() => setEditing(visit)}><span className="event-time">{start.slice(0, 10) === day ? start.slice(11) : '↳'}</span><span className="event-title">{visit.title}</span></button>)}</div>{entries.length > 2 && <button className="more-events" onClick={() => setSelectedDay(day)}>+ {entries.length - 2} <span>visitas</span><span className="sr-only">em {localDayLabel(day)}</span></button>}</div>;
      })}</div></div>
      <div className="calendar-bottom-note"><CalendarDays size={14} /><span>Clique no dia para agendar ou em uma visita para editar.</span><span className="calendar-timezone">Horários em {data.timeZone}</span></div>
    </section>
    <section className="card"><div className="card-header visit-list-header"><div><h2>{selectedDay ? `Visitas em ${selectedDay.split('-').reverse().join('/')}` : 'Compromissos do mês'}</h2><p>{visibleVisits.length} {visibleVisits.length === 1 ? 'visita nesta visualização' : 'visitas nesta visualização'}</p></div><div className="page-actions">{selectedDay && <button className="button button-ghost button-small" onClick={() => setSelectedDay('')}>Ver mês inteiro<X size={14} /></button>}<label className="filter-field"><span className="sr-only">Filtrar visitas por situação</span><select value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">Todas as situações</option>{statuses.map((status) => <option key={status} value={status}>{visitStatusLabels[status]}</option>)}</select></label></div></div>
      {visibleVisits.length ? <div className="visit-list">{visibleVisits.map(({ visit, start, end }) => <article key={visit.id} className={`visit-list-item visit-${visit.status}`}><div className="visit-date-tile"><strong>{start.slice(8, 10)}</strong><span>{new Intl.DateTimeFormat('pt-BR', { month: 'short', timeZone: data.timeZone }).format(new Date(visit.startAt)).replace('.', '')}</span></div><div className="visit-list-main"><div className="visit-list-title"><button onClick={() => setEditing(visit)}>{visit.title}</button><span className={`badge ${visit.status === 'scheduled' ? 'badge-info' : visit.status === 'completed' ? 'badge-success' : 'badge-muted'}`}>{visitStatusLabels[visit.status]}</span></div><div className="visit-list-meta"><span><Clock3 size={13} />{start.slice(11)} – {start.slice(0, 10) === end.slice(0, 10) ? end.slice(11) : dateTime(visit.endAt, data.timeZone)}</span><span><UserRound size={13} />{clientNames.get(visit.clientId ?? '') || 'Sem cliente vinculado'}</span>{visit.location && <span><MapPin size={13} />{visit.location}</span>}</div>{visit.serviceId && <p className="visit-service">Serviço: {serviceNames.get(visit.serviceId) ?? 'Serviço vinculado'}</p>}</div><button className="button button-secondary button-small" aria-label={`Editar visita ${visit.title}`} onClick={() => setEditing(visit)}><Pencil size={14} /><span>Editar</span></button></article>)}</div> : <EmptyState title="Sua agenda tem espaço para o próximo atendimento" description={filter !== 'all' ? 'Nenhuma visita com esta situação no período selecionado.' : 'Nenhuma visita cadastrada para este período. Escolha um dia e adicione o primeiro compromisso.'} action={<button className="button button-secondary" onClick={() => createVisit(selectedDay || undefined)}><Plus size={15} />Agendar visita</button>} />}
    </section>
    {editing !== undefined && <VisitEditor key={editing?.id ?? `new-${newDay}`} {...props} visit={editing} day={newDay} onClose={() => setEditing(undefined)} />}
  </div>;
}

function VisitEditor(props: PageProps & { visit: Visit | null; day: string; onClose: () => void }) {
  const { visit, day, onClose, data } = props;
  const [draft, setDraft] = useState<VisitInput>(() => visit ? { clientId: visit.clientId, serviceId: visit.serviceId, title: visit.title, startLocal: localDateTime(visit.startAt, data.timeZone), endLocal: localDateTime(visit.endAt, data.timeZone), location: visit.location, notes: visit.notes, status: visit.status } : { clientId: null, serviceId: null, title: '', startLocal: `${day}T09:00`, endLocal: `${day}T10:00`, location: '', notes: '', status: 'scheduled' });
  const { submit, busy, error } = useAction(props, onClose);
  const matchingServices = data.services.filter((service) => !draft.clientId || service.clientId === draft.clientId);
  return <Modal title={visit ? 'Editar visita' : 'Nova visita'} onClose={() => { if (!busy) onClose(); }}><form onSubmit={(event) => { event.preventDefault(); const button = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null; const status = button?.name === 'visitStatus' ? button.value as VisitStatus : draft.status; void submit({ type: 'visit.save', id: visit?.id ?? null, version: visit?.version ?? null, data: { ...draft, title: draft.title.trim(), status } }); }}>
    <div className="form-info"><Clock3 size={16} /><span>Todos os horários estão no fuso <strong>{data.timeZone}</strong>.</span></div>
    <fieldset disabled={busy} className="form-grid">
      <Field label="Título da visita *" wide><input autoFocus required value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="Motivo do atendimento" /></Field>
      <Field label="Cliente"><select value={draft.clientId ?? ''} onChange={(event) => { const clientId = event.target.value || null; const client = data.clients.find((item) => item.id === clientId); const service = data.services.find((item) => item.id === draft.serviceId); setDraft({ ...draft, clientId, serviceId: service?.clientId === clientId ? service.id : null, location: draft.location || client?.address || '' }); }}><option value="">Sem cliente vinculado</option>{data.clients.filter((client) => client.active || client.id === draft.clientId).map((client) => <option key={client.id} value={client.id}>{client.name}{!client.active ? ' (inativo)' : ''}</option>)}</select></Field>
      <Field label="Serviço"><select value={draft.serviceId ?? ''} onChange={(event) => { const service = data.services.find((item) => item.id === event.target.value); setDraft({ ...draft, serviceId: service?.id ?? null, clientId: service ? service.clientId : draft.clientId, title: draft.title || service?.title || '', location: draft.location || service?.address || '' }); }}><option value="">Sem serviço vinculado</option>{matchingServices.map((service) => <option key={service.id} value={service.id}>{service.title}</option>)}</select></Field>
      <Field label="Início *"><input type="datetime-local" required step={60} value={draft.startLocal} onChange={(event) => setDraft({ ...draft, startLocal: event.target.value })} /></Field>
      <Field label="Término *"><input type="datetime-local" required step={60} min={draft.startLocal} value={draft.endLocal} onChange={(event) => setDraft({ ...draft, endLocal: event.target.value })} /></Field>
      <Field label="Endereço / local" wide><input value={draft.location} onChange={(event) => setDraft({ ...draft, location: event.target.value })} placeholder="Onde o atendimento será realizado" /></Field>
      <Field label="Situação" wide><select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as VisitStatus })}>{statuses.map((status) => <option key={status} value={status}>{visitStatusLabels[status]}</option>)}</select></Field>
      <Field label="Observações" wide><textarea rows={3} value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} placeholder="Detalhes e orientações para a visita" /></Field>
    </fieldset>
    <p className="form-hint">Para reagendar, altere o início e o término. Horários sobrepostos a outra visita agendada serão informados ao salvar.</p>
    {error && <div className="inline-error" role="alert">{error}</div>}
    <div className="form-actions"><button type="button" className="button button-secondary" disabled={busy} onClick={onClose}>Fechar</button><button type="submit" className="button button-primary" disabled={busy}>{busy ? 'Salvando…' : visit ? 'Salvar alterações' : 'Agendar visita'}</button></div>
    {visit?.status === 'scheduled' && <div className="visit-status-actions"><button type="submit" name="visitStatus" value="completed" className="button button-secondary button-small" disabled={busy}><Check size={15} />Marcar como realizada</button><button type="submit" name="visitStatus" value="cancelled" className="button button-ghost button-small text-danger" disabled={busy}><X size={15} />Cancelar visita</button></div>}
  </form></Modal>;
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, BriefcaseBusiness, CalendarDays, CheckCircle2, ChevronRight, FileText, Layers3, LayoutDashboard, Menu, Package, RefreshCw, Users, Wallet, X } from 'lucide-react';
import type { BusinessSnapshot } from '../../src/business-contract.ts';
import { getState, type PageProps } from './api';
import { OverviewPage } from './OverviewPage';
import { CalendarPage } from './CalendarPage';
import { ClientsPage } from './ClientsPage';
import { ServicesPage } from './ServicesPage';
import { FinancePage, InventoryPage, MaterialsPage, QuotesPage } from './ManagementPages';

const navigation = [
  { id: 'overview', label: 'Visão geral', icon: LayoutDashboard },
  { id: 'calendar', label: 'Agenda', icon: CalendarDays },
  { id: 'quotes', label: 'Orçamentos', icon: FileText },
  { id: 'inventory', label: 'Estoque', icon: Package },
  { id: 'materials', label: 'Materiais', icon: Layers3 },
  { id: 'finance', label: 'Financeiro', icon: Wallet },
  { id: 'clients', label: 'Clientes', icon: Users },
  { id: 'services', label: 'Serviços', icon: BriefcaseBusiness },
] as const;
type Page = typeof navigation[number]['id'];
type Toast = { id: number; message: string; kind: 'success' | 'error' };
function currentPage(): Page {
  const hash = window.location.hash.slice(1);
  return navigation.find((item) => item.id === hash)?.id ?? 'overview';
}

export function App() {
  const [page, setPage] = useState<Page>(currentPage);
  const [menuOpen, setMenuOpen] = useState(false);
  const [data, setData] = useState<BusinessSnapshot | null>(null);
  const [month, setMonthValue] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [fetchError, setFetchError] = useState('');
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const selectedMonth = useRef<string | undefined>(undefined);
  const request = useRef(0);
  const toastId = useRef(0);

  const refresh = useCallback(async () => {
    const sequence = ++request.current;
    setRefreshing(true);
    try {
      const snapshot = await getState(selectedMonth.current);
      if (sequence !== request.current) return;
      selectedMonth.current = snapshot.month;
      setMonthValue(snapshot.month);
      setData(snapshot);
      setFetchError('');
      setUpdatedAt(new Date());
    } catch (error) {
      if (sequence === request.current) setFetchError(error instanceof Error ? error.message : 'Não foi possível carregar os dados.');
      throw error;
    } finally {
      if (sequence === request.current) setRefreshing(false);
    }
  }, []);

  const setMonth = useCallback((value: string) => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value) || value === selectedMonth.current) return;
    selectedMonth.current = value;
    setMonthValue(value);
    void refresh().catch(() => undefined);
  }, [refresh]);

  const notify = useCallback((message: string, kind: 'success' | 'error' = 'success') => {
    const id = ++toastId.current;
    setToasts((current) => [...current.slice(-3), { id, message, kind }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), kind === 'error' ? 10000 : 6000);
  }, []);

  useEffect(() => {
    void refresh().catch(() => undefined);
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh().catch(() => undefined);
    }, 10000);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refresh().catch(() => undefined);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
      request.current += 1;
    };
  }, [refresh]);

  useEffect(() => {
    const onHash = () => { setPage(currentPage()); setMenuOpen(false); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  const activePage = navigation.find((item) => item.id === page)!;
  const props: PageProps | null = data ? { data, month, setMonth, refresh, notify } : null;
  const monthVisible = page === 'overview' || page === 'calendar' || page === 'finance';

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content" onClick={(event) => { event.preventDefault(); document.getElementById('main-content')?.focus(); }}>Pular para o conteúdo</a>
      {menuOpen && <button className="sidebar-scrim" aria-label="Fechar navegação" onClick={() => setMenuOpen(false)} />}
      <aside className={`sidebar ${menuOpen ? 'is-open' : ''}`} aria-label="Navegação principal">
        <a className="brand" href="#overview" onClick={() => setMenuOpen(false)} aria-label="SofIA, visão geral">
          <span className="brand-icon"><Layers3 size={23} strokeWidth={1.8} /></span>
          <span>Sof<span className="brand-accent">IA</span><small>GESTÃO DO SEU NEGÓCIO</small></span>
        </a>
        <button className="icon-button sidebar-close" aria-label="Fechar menu" onClick={() => setMenuOpen(false)}><X size={20} /></button>
        <div className="nav-label">ESPAÇO DE TRABALHO</div>
        <nav className="nav-list">
          {navigation.map(({ id, label, icon: Icon }) => (
            <a key={id} href={`#${id}`} className={`nav-item ${page === id ? 'is-active' : ''}`} aria-current={page === id ? 'page' : undefined} onClick={() => setMenuOpen(false)}>
              <Icon size={19} strokeWidth={1.7} /><span>{label}</span>{page === id && <ChevronRight size={16} className="nav-chevron" />}
            </a>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="workspace-avatar">S</span>
          <div><strong>Seu negócio</strong><span>Painel de gestão local</span></div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="topbar-location">
            <button className="icon-button mobile-menu" aria-label="Abrir menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}><Menu size={21} /></button>
            <span className="topbar-home">Meu negócio</span><ChevronRight size={15} className="muted" /><strong>{activePage.label}</strong>
          </div>
          <div className="topbar-actions">
            {monthVisible && data && <label className="month-control"><CalendarDays size={16} /><span className="sr-only">Mês de referência</span><input type="month" aria-label="Mês de referência" value={month} onChange={(event) => setMonth(event.target.value)} /></label>}
            <button className="icon-button refresh-button" aria-label="Atualizar dados" title="Atualizar dados" disabled={refreshing} onClick={() => { void refresh().catch(() => undefined); }}><RefreshCw size={18} className={refreshing ? 'spin' : ''} /></button>
            <span className="topbar-avatar" aria-hidden="true">S</span>
          </div>
        </header>
        <main id="main-content" className="main-content" tabIndex={-1}>
          {fetchError && data && <div className="error-banner" role="alert"><AlertCircle size={19} /><div><strong>Não foi possível atualizar os dados.</strong><span>{fetchError} Os registros abaixo são da última atualização.</span></div><button className="button button-secondary" disabled={refreshing} onClick={() => { void refresh().catch(() => undefined); }}>Tentar novamente</button></div>}
          {!data ? fetchError ? <div className="startup-state card" role="alert"><AlertCircle size={34} /><h1>Vamos tentar novamente?</h1><p>{fetchError}</p><button className="button button-primary" disabled={refreshing} onClick={() => { void refresh().catch(() => undefined); }}>{refreshing ? 'Carregando…' : 'Recarregar painel'}</button></div> : <div className="loading-panel" role="status" aria-label="Carregando painel"><div className="skeleton skeleton-title" /><div className="skeleton skeleton-subtitle" /><div className="stats-grid">{[0, 1, 2, 3].map((item) => <div key={item} className="skeleton skeleton-card" />)}</div><div className="skeleton skeleton-chart" /><span className="sr-only">Carregando seus registros…</span></div> : props && <>
            {page === 'overview' && <OverviewPage {...props} />}
            {page === 'calendar' && <CalendarPage {...props} />}
            {page === 'quotes' && <QuotesPage {...props} />}
            {page === 'inventory' && <InventoryPage {...props} />}
            {page === 'materials' && <MaterialsPage {...props} />}
            {page === 'finance' && <FinancePage {...props} />}
            {page === 'clients' && <ClientsPage {...props} />}
            {page === 'services' && <ServicesPage {...props} />}
          </>}
        </main>
        {data && <footer className="app-footer"><span>SofIA · Gestão que acompanha seu trabalho</span><span>{refreshing ? 'Atualizando dados…' : updatedAt ? `Atualizado às ${new Intl.DateTimeFormat('pt-BR', { timeZone: data.timeZone, hour: '2-digit', minute: '2-digit' }).format(updatedAt)}` : ''} · {data.timeZone}</span></footer>}
      </div>
      <div className="toast-stack" aria-label="Notificações">
        {toasts.map((toast) => <div key={toast.id} className={`toast toast-${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>{toast.kind === 'error' ? <AlertCircle size={20} /> : <CheckCircle2 size={20} />}<span>{toast.message}</span><button className="icon-button" aria-label="Fechar notificação" onClick={() => setToasts((current) => current.filter((item) => item.id !== toast.id))}><X size={16} /></button></div>)}
      </div>
    </div>
  );
}

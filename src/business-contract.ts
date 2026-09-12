export const serviceStageLabels = {
  awaiting_visit: 'Aguardando visita', quoting: 'Orçamento', awaiting_approval: 'Aguardando aprovação', in_progress: 'Em execução', completed: 'Concluído',
} as const;
export const visitStatusLabels = { scheduled: 'Agendada', completed: 'Realizada', cancelled: 'Cancelada' } as const;
export const quoteStatusLabels = { draft: 'Rascunho', sent: 'Enviado', accepted: 'Aprovado', rejected: 'Recusado', cancelled: 'Cancelado' } as const;
export const cashStatusLabels = { pending: 'Pendente', paid: 'Realizado', void: 'Anulado' } as const;
export const stockKindLabels = { in: 'Entrada', out: 'Consumo / saída', adjust: 'Ajuste de inventário' } as const;
export type ServiceStage = keyof typeof serviceStageLabels;
export type VisitStatus = keyof typeof visitStatusLabels;
export type QuoteStatus = keyof typeof quoteStatusLabels;
export type CashStatus = keyof typeof cashStatusLabels;
export type StockKind = keyof typeof stockKindLabels;

export interface Entity { id: string; version: number; createdAt: string; updatedAt: string }
export interface ClientInput { name: string; phone: string; email: string; address: string; notes: string; active: boolean }
export interface Client extends Entity, ClientInput {}
export interface ServiceInput { clientId: string | null; title: string; description: string; address: string; stage: ServiceStage }
export interface Service extends Entity, ServiceInput {}
export interface VisitInput {
  clientId: string | null; serviceId: string | null; title: string;
  startLocal: string; endLocal: string; location: string; notes: string; status: VisitStatus;
}
export interface Visit extends Entity, Omit<VisitInput, 'startLocal' | 'endLocal'> { startAt: string; endAt: string }
export interface QuoteItemInput { materialId: string | null; description: string; unit: string; quantityMilli: number; unitPriceCents: number }
export interface QuoteItem extends QuoteItemInput { totalCents: number }
export interface QuoteInput {
  clientId: string; serviceId: string | null; title: string; validUntil: string | null;
  status: QuoteStatus; notes: string; discountCents: number; items: QuoteItemInput[];
}
export interface Quote extends Entity, Omit<QuoteInput, 'items'> {
  number: string; items: QuoteItem[]; subtotalCents: number; totalCents: number;
  customer: Pick<ClientInput, 'name' | 'phone' | 'email' | 'address'>;
}
export interface MaterialInput { name: string; sku: string; unit: string; costCents: number; minimumMilli: number; notes: string; active: boolean }
export interface Material extends Entity, MaterialInput { stockMilli: number; stockValueCents: number }
export interface StockMovementInput {
  materialId: string; serviceId: string | null; kind: StockKind; quantityMilli: number;
  unitCostCents: number | null; occurredOn: string; note: string;
}
export interface StockMovement extends StockMovementInput { id: string; deltaMilli: number; createdAt: string }
export interface CashEntryInput {
  kind: 'income' | 'expense'; description: string; category: string; amountCents: number;
  date: string; status: CashStatus; clientId: string | null; serviceId: string | null;
}
export interface CashEntry extends Entity, CashEntryInput {}

type SaveAction<T extends string, D> = { type: T; id: string | null; version: number | null; data: D };
export type BusinessAction =
  | SaveAction<'client.save', ClientInput>
  | SaveAction<'service.save', ServiceInput>
  | SaveAction<'visit.save', VisitInput>
  | SaveAction<'quote.save', QuoteInput>
  | SaveAction<'material.save', MaterialInput>
  | SaveAction<'cash.save', CashEntryInput>
  | { type: 'stock.move'; data: StockMovementInput };
export interface ActionResult { type: BusinessAction['type']; id: string; summary: string }
export interface CashDay { date: string; incomeCents: number; expenseCents: number; balanceCents: number }
export interface BusinessSummary {
  scheduledVisits: number; openQuoteCents: number; stockValueCents: number; lowStockCount: number;
  cash: { openingCents: number; incomeCents: number; expenseCents: number; balanceCents: number; receivableCents: number; payableCents: number; series: CashDay[] };
  quoteStages: Array<{ status: QuoteStatus; count: number; totalCents: number }>;
  serviceStages: Array<{ stage: ServiceStage; count: number }>;
}
export interface BusinessSnapshot {
  timeZone: string; month: string; clients: Client[]; services: Service[]; visits: Visit[];
  quotes: Quote[]; materials: Material[]; movements: StockMovement[]; cashEntries: CashEntry[];
  summary: BusinessSummary;
}
export type BusinessSection = 'clients' | 'services' | 'visits' | 'quotes' | 'materials' | 'movements' | 'cash' | 'summary';
export interface BusinessQuery { section: BusinessSection; search?: string; month?: string; offset?: number; limit?: number }
export interface BusinessQueryResult { items: unknown[]; total: number }
export interface BusinessActor { accountId: string; chatId: string }
export interface PendingOperation {
  id: string; sourceCommandId: string; action: BusinessAction; summary: string; expiresAt: string;
}
export interface QuoteDocument { quote: Quote; timeZone: string }
export interface BusinessStore {
  readonly timeZone: string;
  snapshot(month?: string): BusinessSnapshot;
  query(query: BusinessQuery): BusinessQueryResult;
  apply(action: BusinessAction, idempotencyKey: string): ActionResult;
  propose(actor: BusinessActor, commandId: string, action: BusinessAction): PendingOperation;
  pending(actor: BusinessActor): PendingOperation | undefined;
  confirm(actor: BusinessActor, commandId: string): ActionResult;
  cancel(actor: BusinessActor): boolean;
  quoteDocument(id: string): QuoteDocument;
}
export class BusinessError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.name = 'BusinessError'; this.status = status; }
}

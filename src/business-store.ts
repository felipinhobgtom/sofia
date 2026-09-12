import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue, SQLOutputValue, StatementSync } from 'node:sqlite';
import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import {
  BusinessError, cashStatusLabels, quoteStatusLabels, serviceStageLabels, stockKindLabels, visitStatusLabels,
} from './business-contract.ts';
import type {
  ActionResult, BusinessAction, BusinessActor, BusinessQuery, BusinessQueryResult,
  BusinessSnapshot, BusinessStore, BusinessSummary, CashEntry, Client, Material,
  PendingOperation, Quote, QuoteItem, Service, StockMovement, Visit,
} from './business-contract.ts';

const text = (max: number, required = false) => z.string().trim().min(required ? 1 : 0).max(max)
  .refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value), 'Texto contém caracteres inválidos.');
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const money = integer.describe('Valor inteiro em centavos: R$ 12,34 = 1234.');
const quantity = integer.describe('Quantidade inteira em milésimos da unidade: 1,5 = 1500.');
const uuid = z.uuid();
const nullableId = uuid.nullable();
const dateOnly = z.string().regex(/^[1-9]\d{3}-\d{2}-\d{2}$/u).refine(value => {
  try { return Temporal.PlainDate.from(value).toString() === value; } catch { return false; }
}, 'Data inválida.');
const localDate = z.string().regex(/^[1-9]\d{3}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/u)
  .refine(value => {
    try { Temporal.PlainDateTime.from(value, { overflow: 'reject' }); return !/:60(?:\.|$)/u.test(value); } catch { return false; }
  }, 'Data e hora local inválidas.').describe('Data/hora local sem offset, no fuso da empresa: AAAA-MM-DDTHH:mm.');
const identity = { id: nullableId, version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable() };
const clientInput = z.strictObject({
  name: text(160, true), phone: text(60), email: z.union([z.literal(''), z.email().max(254)]),
  address: text(500), notes: text(4000), active: z.boolean(),
});
const serviceInput = z.strictObject({
  clientId: nullableId, title: text(200, true), description: text(4000), address: text(500),
  stage: z.enum(['awaiting_visit', 'quoting', 'awaiting_approval', 'in_progress', 'completed']),
});
const visitInput = z.strictObject({
  clientId: nullableId, serviceId: nullableId, title: text(200, true), startLocal: localDate, endLocal: localDate,
  location: text(500), notes: text(4000), status: z.enum(['scheduled', 'completed', 'cancelled']),
});
const quoteInput = z.strictObject({
  clientId: uuid, serviceId: nullableId, title: text(200, true), validUntil: dateOnly.nullable(),
  status: z.enum(['draft', 'sent', 'accepted', 'rejected', 'cancelled']), notes: text(4000), discountCents: money,
  items: z.array(z.strictObject({
    materialId: nullableId, description: text(500, true), unit: text(30, true),
    quantityMilli: quantity.refine(value => value > 0, 'Quantidade deve ser positiva.'), unitPriceCents: money,
  })).min(1).max(200),
});
const materialInput = z.strictObject({
  name: text(160, true), sku: text(80), unit: text(30, true), costCents: money,
  minimumMilli: quantity, notes: text(4000), active: z.boolean(),
});
const stockInput = z.strictObject({
  materialId: uuid, serviceId: nullableId, kind: z.enum(['in', 'out', 'adjust']),
  quantityMilli: quantity.describe('Milésimos: entrada/saída > 0; ajuste é o SALDO FINAL desejado, inclusive zero.'),
  unitCostCents: money.nullable(), occurredOn: dateOnly, note: text(4000),
});
const cashInput = z.strictObject({
  kind: z.enum(['income', 'expense']), description: text(500, true), category: text(120, true),
  amountCents: money.refine(value => value > 0, 'Valor deve ser positivo.'), date: dateOnly,
  status: z.enum(['pending', 'paid', 'void']), clientId: nullableId, serviceId: nullableId,
});

export const businessActionSchema: z.ZodType<BusinessAction> = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('client.save'), ...identity, data: clientInput }),
  z.strictObject({ type: z.literal('service.save'), ...identity, data: serviceInput }),
  z.strictObject({ type: z.literal('visit.save'), ...identity, data: visitInput }),
  z.strictObject({ type: z.literal('quote.save'), ...identity, data: quoteInput }),
  z.strictObject({ type: z.literal('material.save'), ...identity, data: materialInput }),
  z.strictObject({ type: z.literal('cash.save'), ...identity, data: cashInput }),
  z.strictObject({ type: z.literal('stock.move'), data: stockInput }),
]).superRefine((action, context) => {
  if (action.type === 'stock.move') {
    if (action.data.kind !== 'adjust' && action.data.quantityMilli === 0) {
      context.addIssue({ code: 'custom', message: 'Entrada e saída exigem quantidade positiva.', path: ['data', 'quantityMilli'] });
    }
  } else if ((action.id === null) !== (action.version === null)) {
    context.addIssue({ code: 'custom', message: 'Criação exige id e versão nulos; edição exige id e versão atual.', path: ['version'] });
  }
});

export function parseBusinessAction(input: unknown): BusinessAction {
  const result = businessActionSchema.safeParse(input);
  if (!result.success) {
    const field = result.error.issues[0]?.path.map(String).join('.');
    throw new BusinessError(`Operação inválida${field ? ` no campo ${field}` : ''}. Confira os dados e os campos obrigatórios.`);
  }
  return result.data;
}

const querySchema = z.strictObject({
  section: z.enum(['clients', 'services', 'visits', 'quotes', 'materials', 'movements', 'cash', 'summary']),
  search: text(200).optional(), month: z.string().regex(/^[1-9]\d{3}-(0[1-9]|1[0-2])$/u).optional(),
  offset: integer.optional(), limit: z.number().int().min(1).max(50).optional(),
});
const commandIdSchema = text(200, true);
const actorSchema = z.strictObject({ accountId: text(200, true), chatId: text(200, true) });
const tables = {
  clients: 'business_clients', services: 'business_services', visits: 'business_visits',
  quotes: 'business_quotes', materials: 'business_materials', movements: 'business_movements', cash: 'business_cash',
} as const;
const actionSections = {
  'client.save': 'clients', 'service.save': 'services', 'visit.save': 'visits',
  'quote.save': 'quotes', 'material.save': 'materials', 'cash.save': 'cash',
} as const;
type RecordSection = keyof typeof tables;
type StoredEntity = Client | Service | Visit | Quote | Material | CashEntry;
type Row = Record<string, SQLOutputValue>;
type PreparedAction = { existing?: StoredEntity; data: Record<string, unknown>; items?: QuoteItem[]; summary: string };
type MonthBounds = {
  month: string; start: Temporal.PlainDate; end: Temporal.PlainDate;
  startDate: string; endDate: string; startAt: string; endAt: string;
};

function safeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new BusinessError('O resultado excede o limite de valores suportado.');
  }
  return Number(value);
}
function lineTotal(quantityMilli: number, unitPriceCents: number): number {
  return safeNumber((BigInt(quantityMilli) * BigInt(unitPriceCents) + 500n) / 1000n);
}
function sum(values: Iterable<number>): number {
  let result = 0n;
  for (const value of values) result += BigInt(value);
  return safeNumber(result);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function currency(cents: number): string {
  const amount = BigInt(cents);
  const absolute = amount < 0n ? -amount : amount;
  const whole = (absolute / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/gu, '.');
  return `${amount < 0n ? '-' : ''}R$ ${whole},${(absolute % 100n).toString().padStart(2, '0')}`;
}
function units(milli: number, unit: string): string {
  const amount = BigInt(milli);
  const remainder = (amount % 1000n).toString().padStart(3, '0').replace(/0+$/u, '');
  return `${amount / 1000n}${remainder ? `,${remainder}` : ''} ${unit}`;
}
function calendarDate(value: string): string { return value.slice(0, 10).split('-').reverse().join('/'); }
function decode<T>(value: SQLOutputValue): T {
  if (typeof value !== 'string') throw new BusinessError('Não foi possível ler o registro local.', 500);
  try { return JSON.parse(value) as T; } catch { throw new BusinessError('Não foi possível ler o registro local.', 500); }
}

export function createBusinessStore(db: DatabaseSync, options: { timeZone: string; now?: () => Date }): BusinessStore {
  const timeZone = options.timeZone;
  try { Temporal.Now.instant().toZonedDateTimeISO(timeZone); } catch { throw new BusinessError('Fuso horário inválido.'); }
  const now = options.now ?? (() => new Date());
  const statements = new Map<string, StatementSync>();
  function sql(query: string): StatementSync {
    let statement = statements.get(query);
    if (!statement) { statement = db.prepare(query); statements.set(query, statement); }
    return statement;
  }
  function transaction<T>(run: () => T, mode: 'IMMEDIATE' | 'DEFERRED' = 'IMMEDIATE'): T {
    if (db.isTransaction) throw new BusinessError('Uma operação local já está em andamento.', 409);
    db.exec(`BEGIN ${mode}`);
    try {
      const result = run();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      if (error instanceof BusinessError) throw error;
      throw new BusinessError('Não foi possível concluir a operação local. Nenhum dado desta operação foi salvo.', 500);
    }
  }

  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  transaction(() => {
    db.exec('CREATE TABLE IF NOT EXISTS business_schema (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const version = Number(sql('SELECT COALESCE(MAX(version), 0) AS version FROM business_schema').get()!.version);
    if (version > 1) throw new BusinessError('O banco de gestão exige uma versão mais recente do aplicativo.', 500);
    if (version === 1) return;
    db.exec(`
      CREATE TABLE business_clients (
        id TEXT PRIMARY KEY, version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        data TEXT NOT NULL CHECK(json_valid(data)),
        name TEXT GENERATED ALWAYS AS (json_extract(data, '$.name')) VIRTUAL,
        active INTEGER GENERATED ALWAYS AS (json_extract(data, '$.active')) VIRTUAL
      );
      CREATE TABLE business_services (
        id TEXT PRIMARY KEY, version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        data TEXT NOT NULL CHECK(json_valid(data)),
        client_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.clientId')) VIRTUAL REFERENCES business_clients(id),
        stage TEXT GENERATED ALWAYS AS (json_extract(data, '$.stage')) VIRTUAL
      );
      CREATE TABLE business_visits (
        id TEXT PRIMARY KEY, version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        data TEXT NOT NULL CHECK(json_valid(data)),
        client_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.clientId')) VIRTUAL REFERENCES business_clients(id),
        service_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.serviceId')) VIRTUAL REFERENCES business_services(id),
        start_at TEXT GENERATED ALWAYS AS (json_extract(data, '$.startAt')) VIRTUAL,
        end_at TEXT GENERATED ALWAYS AS (json_extract(data, '$.endAt')) VIRTUAL,
        status TEXT GENERATED ALWAYS AS (json_extract(data, '$.status')) VIRTUAL
      );
      CREATE TABLE business_quotes (
        id TEXT PRIMARY KEY, version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        data TEXT NOT NULL CHECK(json_valid(data)),
        client_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.clientId')) VIRTUAL NOT NULL REFERENCES business_clients(id),
        service_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.serviceId')) VIRTUAL REFERENCES business_services(id),
        number TEXT GENERATED ALWAYS AS (json_extract(data, '$.number')) VIRTUAL NOT NULL UNIQUE,
        status TEXT GENERATED ALWAYS AS (json_extract(data, '$.status')) VIRTUAL
      );
      CREATE TABLE business_materials (
        id TEXT PRIMARY KEY, version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        data TEXT NOT NULL CHECK(json_valid(data)),
        name TEXT GENERATED ALWAYS AS (json_extract(data, '$.name')) VIRTUAL,
        active INTEGER GENERATED ALWAYS AS (json_extract(data, '$.active')) VIRTUAL
      );
      CREATE TABLE business_quote_items (
        quote_id TEXT NOT NULL REFERENCES business_quotes(id), position INTEGER NOT NULL,
        data TEXT NOT NULL CHECK(json_valid(data)),
        material_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.materialId')) VIRTUAL REFERENCES business_materials(id),
        PRIMARY KEY (quote_id, position)
      ) WITHOUT ROWID;
      CREATE TABLE business_movements (
        id TEXT PRIMARY KEY, created_at TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
        material_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.materialId')) VIRTUAL NOT NULL REFERENCES business_materials(id),
        service_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.serviceId')) VIRTUAL REFERENCES business_services(id),
        delta_milli INTEGER GENERATED ALWAYS AS (json_extract(data, '$.deltaMilli')) VIRTUAL NOT NULL,
        occurred_on TEXT GENERATED ALWAYS AS (json_extract(data, '$.occurredOn')) VIRTUAL NOT NULL
      );
      CREATE TABLE business_cash (
        id TEXT PRIMARY KEY, version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        data TEXT NOT NULL CHECK(json_valid(data)),
        client_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.clientId')) VIRTUAL REFERENCES business_clients(id),
        service_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.serviceId')) VIRTUAL REFERENCES business_services(id),
        date TEXT GENERATED ALWAYS AS (json_extract(data, '$.date')) VIRTUAL NOT NULL,
        status TEXT GENERATED ALWAYS AS (json_extract(data, '$.status')) VIRTUAL NOT NULL,
        kind TEXT GENERATED ALWAYS AS (json_extract(data, '$.kind')) VIRTUAL NOT NULL,
        amount_cents INTEGER GENERATED ALWAYS AS (json_extract(data, '$.amountCents')) VIRTUAL NOT NULL
      );
      CREATE TABLE business_sequences (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE business_applied (
        scope TEXT NOT NULL, key TEXT NOT NULL, action TEXT NOT NULL, result TEXT NOT NULL,
        PRIMARY KEY(scope, key)
      ) WITHOUT ROWID;
      CREATE TABLE business_pending (
        id TEXT PRIMARY KEY, actor TEXT NOT NULL, source_command_id TEXT NOT NULL,
        action TEXT NOT NULL, summary TEXT NOT NULL, expires_at TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('active', 'confirmed', 'cancelled', 'expired')),
        UNIQUE(actor, source_command_id)
      );
      CREATE UNIQUE INDEX business_one_pending ON business_pending(actor) WHERE state = 'active';
      CREATE INDEX business_visit_dates ON business_visits(start_at, end_at);
      CREATE INDEX business_visit_conflicts ON business_visits(start_at, end_at) WHERE status = 'scheduled';
      CREATE INDEX business_movements_material ON business_movements(material_id);
      CREATE INDEX business_movements_date ON business_movements(occurred_on);
      CREATE INDEX business_cash_date ON business_cash(date, status);
      CREATE INDEX business_service_client ON business_services(client_id);
      CREATE INDEX business_quote_client ON business_quotes(client_id);
    `);
    sql('INSERT INTO business_schema(version, applied_at) VALUES (1, ?)').run(now().toISOString());
  });

  function entity(section: Exclude<RecordSection, 'movements'>, row: Row): StoredEntity {
    const data = decode<Record<string, unknown>>(row.data);
    const result = {
      ...data, id: String(row.id), version: Number(row.version),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
    if (section === 'quotes') {
      return { ...result, items: sql('SELECT data FROM business_quote_items WHERE quote_id = ? ORDER BY position').all(String(row.id))
        .map(item => decode<QuoteItem>(item.data)) } as Quote;
    }
    if (section === 'materials') {
      const stockMilli = row.stock_milli === undefined ? balance(String(row.id)) : Number(row.stock_milli);
      return { ...result, stockMilli, stockValueCents: lineTotal(stockMilli, Number(data.costCents)) } as Material;
    }
    return result as StoredEntity;
  }
  function get<T extends StoredEntity>(section: Exclude<RecordSection, 'movements'>, id: string): T {
    const row = sql(`SELECT * FROM ${tables[section]} WHERE id = ?`).get(id);
    if (!row) throw new BusinessError('Registro não encontrado. Consulte os dados atuais antes de continuar.', 404);
    return entity(section, row) as T;
  }
  function balance(materialId: string): number {
    return Number(sql('SELECT COALESCE(SUM(delta_milli), 0) AS balance FROM business_movements WHERE material_id = ?').get(materialId)!.balance);
  }
  function activeClient(id: string | null): Client | undefined {
    if (!id) return;
    const client = get<Client>('clients', id);
    if (!client.active) throw new BusinessError('O cliente está arquivado. Reative-o antes de vincular novos dados.', 409);
    return client;
  }
  function linkedService(id: string | null, clientId?: string | null): Service | undefined {
    if (!id) return;
    const service = get<Service>('services', id);
    if (clientId !== undefined && service.clientId !== clientId) {
      throw new BusinessError('O serviço e o registro devem estar vinculados ao mesmo cliente.', 409);
    }
    return service;
  }
  function activeMaterial(id: string): Material {
    const material = get<Material>('materials', id);
    if (!material.active) throw new BusinessError('O material está arquivado. Reative-o antes de movimentar ou orçar.', 409);
    return material;
  }
  function utc(local: string): string {
    try {
      return Temporal.PlainDateTime.from(local).toZonedDateTime(timeZone, { disambiguation: 'reject' }).toInstant()
        .toString({ fractionalSecondDigits: 3 });
    } catch { throw new BusinessError('Data/hora inexistente ou ambígua no fuso da empresa. Escolha outro horário.'); }
  }
  function localLabel(instant: string): string {
    const value = Temporal.Instant.from(instant).toZonedDateTimeISO(timeZone).toPlainDateTime().toString({ smallestUnit: 'minute' });
    return `${calendarDate(value)} às ${value.slice(11)} (${timeZone})`;
  }
  function prepare(action: BusinessAction): PreparedAction {
    let existing: StoredEntity | undefined;
    if (action.type !== 'stock.move' && action.id !== null) {
      existing = get(actionSections[action.type], action.id);
      if (existing.version !== action.version) throw new BusinessError('Este registro foi alterado. Recarregue os dados antes de editar.', 409);
      if (existing.version === Number.MAX_SAFE_INTEGER) throw new BusinessError('Limite de versões do registro atingido.', 409);
    }
    const verb = existing ? 'Atualizar' : 'Criar';
    switch (action.type) {
      case 'client.save':
        return { existing, data: { ...action.data }, summary: `${verb} cliente ${action.data.name}${action.data.active ? '' : ' (arquivado)'}.` };
      case 'service.save': {
        const client = activeClient(action.data.clientId);
        if (existing && (existing as Service).clientId !== action.data.clientId) {
          for (const table of [tables.visits, tables.quotes, tables.cash]) {
            if (sql(`SELECT 1 FROM ${table} WHERE service_id = ? AND client_id IS NOT ? LIMIT 1`).get(existing.id, action.data.clientId)) {
              throw new BusinessError('O serviço possui registros de outro cliente. Ajuste os vínculos antes de trocar seu cliente.', 409);
            }
          }
        }
        return { existing, data: { ...action.data }, summary: `${verb} serviço ${action.data.title}${client ? ` para ${client.name}` : ' sem cliente'}: ${serviceStageLabels[action.data.stage]}.` };
      }
      case 'visit.save': {
        const client = activeClient(action.data.clientId);
        const service = linkedService(action.data.serviceId, action.data.clientId);
        const { startLocal, endLocal, ...data } = action.data;
        const startAt = utc(startLocal), endAt = utc(endLocal);
        if (endAt <= startAt) throw new BusinessError('O fim da visita deve ser posterior ao início.');
        if (data.status === 'scheduled' && sql(`SELECT id FROM business_visits
          WHERE status = 'scheduled' AND start_at < ? AND end_at > ? AND id != ? LIMIT 1`).get(endAt, startAt, action.id ?? '')) {
          throw new BusinessError('Já existe uma visita agendada nesse intervalo. Escolha um horário livre.', 409);
        }
        return { existing, data: { ...data, startAt, endAt }, summary: `${verb} visita ${data.title}${client ? ` para ${client.name}` : ''}${service ? `, serviço ${service.title}` : ''}, de ${localLabel(startAt)} até ${localLabel(endAt)}: ${visitStatusLabels[data.status]}.` };
      }
      case 'quote.save': {
        const client = activeClient(action.data.clientId)!;
        const service = linkedService(action.data.serviceId, action.data.clientId);
        const items = action.data.items.map(item => {
          if (item.materialId) activeMaterial(item.materialId);
          return { ...item, totalCents: lineTotal(item.quantityMilli, item.unitPriceCents) };
        });
        const subtotalCents = sum(items.map(item => item.totalCents));
        if (action.data.discountCents > subtotalCents) throw new BusinessError('O desconto não pode superar o subtotal do orçamento.');
        const { items: _items, ...data } = action.data;
        const totalCents = subtotalCents - data.discountCents;
        return {
          existing, items, data: { ...data, subtotalCents, totalCents,
            customer: { name: client.name, phone: client.phone, email: client.email, address: client.address },
            ...(existing ? { number: (existing as Quote).number } : {}),
          },
          summary: `${verb} orçamento ${data.title} para ${client.name}${service ? `, serviço ${service.title}` : ''}: ${items.map(item => `${item.description}, ${units(item.quantityMilli, item.unit)}, ${currency(item.unitPriceCents)}/unidade`).join('; ')}. Desconto ${currency(data.discountCents)}; total ${currency(totalCents)}. ${quoteStatusLabels[data.status]}${data.validUntil ? `; válido até ${calendarDate(data.validUntil)}` : ''}.`,
        };
      }
      case 'material.save': {
        const stockMilli = existing ? (existing as Material).stockMilli : 0;
        if (!action.data.active && stockMilli !== 0) throw new BusinessError('Não é possível arquivar um material com saldo em estoque.', 409);
        if (existing && (existing as Material).unit !== action.data.unit && sql('SELECT 1 FROM business_movements WHERE material_id = ? LIMIT 1').get(existing.id)) {
          throw new BusinessError('A unidade de um material com movimentações não pode mudar. Cadastre outro material para a nova unidade.', 409);
        }
        lineTotal(stockMilli, action.data.costCents);
        return { existing, data: { ...action.data }, summary: `${verb} material ${action.data.name}, unidade ${action.data.unit}, custo ${currency(action.data.costCents)}, mínimo ${units(action.data.minimumMilli, action.data.unit)}${action.data.active ? '' : ' (arquivado)'}.` };
      }
      case 'stock.move': {
        const material = activeMaterial(action.data.materialId);
        const service = linkedService(action.data.serviceId);
        const data = action.data;
        const deltaMilli = data.kind === 'adjust' ? data.quantityMilli - material.stockMilli : data.kind === 'out' ? -data.quantityMilli : data.quantityMilli;
        const newBalance = safeNumber(BigInt(material.stockMilli) + BigInt(deltaMilli));
        if (newBalance < 0) throw new BusinessError(`Estoque insuficiente de ${material.name}. Saldo atual: ${units(material.stockMilli, material.unit)}.`, 409);
        const unitCostCents = data.unitCostCents ?? material.costCents;
        lineTotal(newBalance, material.costCents);
        lineTotal(Math.abs(deltaMilli), unitCostCents);
        return { data: { ...data, unitCostCents, deltaMilli }, summary: `${stockKindLabels[data.kind]} de ${material.name}: ${data.kind === 'adjust' ? 'saldo final ' : ''}${units(data.quantityMilli, material.unit)} em ${calendarDate(data.occurredOn)}${service ? `, serviço ${service.title}` : ''}; custo unitário ${currency(unitCostCents)}. Saldo resultante ${units(newBalance, material.unit)}. Não cria lançamento no caixa.` };
      }
      case 'cash.save': {
        const client = activeClient(action.data.clientId);
        const service = linkedService(action.data.serviceId, action.data.clientId);
        const data = action.data;
        return { existing, data: { ...data }, summary: `${verb} ${data.kind === 'income' ? 'receita' : 'despesa'} ${data.description}, ${currency(data.amountCents)} em ${calendarDate(data.date)}: ${cashStatusLabels[data.status]}${client ? `, cliente ${client.name}` : ''}${service ? `, serviço ${service.title}` : ''}${data.status === 'paid' ? ' (movimenta o caixa)' : ' (não movimenta o caixa)'}.` };
      }
    }
  }

  function replay(scope: string, key: string): Row | undefined {
    return sql('SELECT action, result FROM business_applied WHERE scope = ? AND key = ?').get(scope, key);
  }
  function applyInternal(action: BusinessAction, key: string, scope: string): ActionResult {
    const encoded = canonical(action);
    const previous = replay(scope, key);
    if (previous) {
      if (previous.action !== encoded) throw new BusinessError('Esta chave de operação já foi usada com outros dados.', 409);
      return decode<ActionResult>(previous.result);
    }
    const prepared = prepare(action);
    const id = prepared.existing?.id ?? randomUUID();
    const timestamp = now().toISOString();
    if (action.type === 'stock.move') {
      sql('INSERT INTO business_movements(id, created_at, data) VALUES (?, ?, ?)').run(id, timestamp, JSON.stringify(prepared.data));
    } else {
      const table = tables[actionSections[action.type]];
      if (action.type === 'quote.save' && !prepared.existing) {
        const row = sql(`INSERT INTO business_sequences(name, value) VALUES ('quote', 1)
          ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value`).get()!;
        prepared.data.number = `ORC-${String(row.value).padStart(6, '0')}`;
      }
      if (prepared.existing) {
        sql(`UPDATE ${table} SET version = version + 1, updated_at = ?, data = ? WHERE id = ? AND version = ?`)
          .run(timestamp, JSON.stringify(prepared.data), id, prepared.existing.version);
      } else {
        sql(`INSERT INTO ${table}(id, version, created_at, updated_at, data) VALUES (?, 1, ?, ?, ?)`)
          .run(id, timestamp, timestamp, JSON.stringify(prepared.data));
      }
      if (prepared.items) {
        sql('DELETE FROM business_quote_items WHERE quote_id = ?').run(id);
        const insert = sql('INSERT INTO business_quote_items(quote_id, position, data) VALUES (?, ?, ?)');
        prepared.items.forEach((item, position) => insert.run(id, position, JSON.stringify(item)));
      }
    }
    const result: ActionResult = { type: action.type, id, summary: prepared.summary };
    sql('INSERT INTO business_applied(scope, key, action, result) VALUES (?, ?, ?, ?)').run(scope, key, encoded, JSON.stringify(result));
    return result;
  }
  function checkedCommandId(value: string): string {
    const parsed = commandIdSchema.safeParse(value);
    if (!parsed.success || parsed.data !== value) throw new BusinessError('Identificador de operação inválido.');
    return parsed.data;
  }
  function checkedActor(value: BusinessActor): string {
    const parsed = actorSchema.safeParse(value);
    if (!parsed.success || parsed.data.accountId !== value.accountId || parsed.data.chatId !== value.chatId || value.accountId !== value.chatId) {
      throw new BusinessError('A gestão por mensagem só é permitida na conversa da própria conta.', 403);
    }
    return value.accountId;
  }
  function pendingRecord(row: Row): PendingOperation {
    return { id: String(row.id), sourceCommandId: String(row.source_command_id), action: decode<BusinessAction>(row.action),
      summary: String(row.summary), expiresAt: String(row.expires_at) };
  }
  function currentPending(actor: string, timestamp: string): Row | undefined {
    sql("UPDATE business_pending SET state = 'expired' WHERE actor = ? AND state = 'active' AND expires_at <= ?").run(actor, timestamp);
    return sql("SELECT * FROM business_pending WHERE actor = ? AND state = 'active'").get(actor);
  }
  function monthBounds(input?: string): MonthBounds {
    const month = input ?? Temporal.Instant.from(now().toISOString()).toZonedDateTimeISO(timeZone).toPlainDate().toPlainYearMonth().toString();
    if (!/^[1-9]\d{3}-(0[1-9]|1[0-2])$/u.test(month)) throw new BusinessError('Mês inválido. Use AAAA-MM.');
    const start = Temporal.PlainDate.from(`${month}-01`);
    const end = start.add({ months: 1 });
    return { month, start, end, startDate: start.toString(), endDate: end.toString(),
      startAt: start.toZonedDateTime(timeZone).toInstant().toString({ fractionalSecondDigits: 3 }),
      endAt: end.toZonedDateTime(timeZone).toInstant().toString({ fractionalSecondDigits: 3 }) };
  }
  function records(section: RecordSection, month: MonthBounds | undefined, search = '', offset?: number, limit?: number): BusinessQueryResult {
    const table = tables[section];
    const clauses: string[] = [];
    const parameters: SQLInputValue[] = [];
    if (month && section === 'visits') { clauses.push('r.start_at < ? AND r.end_at > ?'); parameters.push(month.endAt, month.startAt); }
    if (month && section === 'cash') { clauses.push('r.date >= ? AND r.date < ?'); parameters.push(month.startDate, month.endDate); }
    if (month && section === 'movements') { clauses.push('r.occurred_on >= ? AND r.occurred_on < ?'); parameters.push(month.startDate, month.endDate); }
    if (search) {
      const searchFields: Record<RecordSection, string[]> = {
        clients: ['name', 'phone', 'email', 'address', 'notes'], services: ['title', 'description', 'address'],
        visits: ['title', 'location', 'notes'], quotes: ['title', 'number', 'customer.name', 'notes'],
        materials: ['name', 'sku', 'unit', 'notes'], movements: ['note', 'kind'], cash: ['description', 'category'],
      };
      const fields = searchFields[section].map(field => `COALESCE(json_extract(r.data, '$.${field}'), '')`);
      if (['services', 'visits', 'quotes', 'cash'].includes(section)) fields.push("COALESCE((SELECT c.name FROM business_clients c WHERE c.id = r.client_id), '')");
      if (['visits', 'quotes', 'cash', 'movements'].includes(section)) fields.push("COALESCE((SELECT json_extract(s.data, '$.title') FROM business_services s WHERE s.id = r.service_id), '')");
      if (section === 'movements') fields.push("COALESCE((SELECT m.name FROM business_materials m WHERE m.id = r.material_id), '')");
      clauses.push(`(${fields.map(field => `${field} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
      const term = `%${search.replace(/[\\%_]/gu, character => `\\${character}`)}%`;
      parameters.push(...fields.map(() => term));
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const total = Number(sql(`SELECT COUNT(*) AS total FROM ${table} r${where}`).get(...parameters)!.total);
    const order = section === 'visits' ? 'r.start_at, r.id' : section === 'cash' ? 'r.date DESC, r.created_at DESC, r.id'
      : section === 'movements' ? 'r.occurred_on DESC, r.created_at DESC, r.id' : section === 'clients' || section === 'materials'
        ? 'r.name COLLATE NOCASE, r.id' : 'r.created_at DESC, r.id';
    const extra = section === 'materials' ? ', COALESCE((SELECT SUM(delta_milli) FROM business_movements WHERE material_id = r.id), 0) AS stock_milli' : '';
    const pagination = limit === undefined ? '' : ' LIMIT ? OFFSET ?';
    const rows = sql(`SELECT r.*${extra} FROM ${table} r${where} ORDER BY ${order}${pagination}`)
      .all(...parameters, ...(limit === undefined ? [] : [limit, offset ?? 0]));
    return { total, items: rows.map(row => section === 'movements'
      ? { ...decode<Record<string, unknown>>(row.data), id: String(row.id), createdAt: String(row.created_at) } as unknown as StockMovement
      : entity(section, row)) };
  }
  function summary(month: MonthBounds): BusinessSummary {
    const cashStatement = sql(`SELECT date, kind, status, amount_cents FROM business_cash WHERE
      (status = 'paid' AND date < ?) OR status = 'pending' ORDER BY date, id`);
    const cashRows = cashStatement.all(month.endDate);
    let opening = 0n, income = 0n, expense = 0n, receivable = 0n, payable = 0n;
    const days = new Map<string, { income: bigint; expense: bigint }>();
    for (const row of cashRows) {
      const amount = BigInt(row.amount_cents as number);
      if (row.status === 'pending') { if (row.kind === 'income') receivable += amount; else payable += amount; continue; }
      if (String(row.date) < month.startDate) { opening += row.kind === 'income' ? amount : -amount; continue; }
      const day = days.get(String(row.date)) ?? { income: 0n, expense: 0n };
      if (row.kind === 'income') { income += amount; day.income += amount; } else { expense += amount; day.expense += amount; }
      days.set(String(row.date), day);
    }
    let closing = opening;
    const series: BusinessSummary['cash']['series'] = [];
    for (let date = month.start; Temporal.PlainDate.compare(date, month.end) < 0; date = date.add({ days: 1 })) {
      const key = date.toString(), day = days.get(key) ?? { income: 0n, expense: 0n };
      closing += day.income - day.expense;
      series.push({ date: key, incomeCents: safeNumber(day.income), expenseCents: safeNumber(day.expense), balanceCents: safeNumber(closing) });
    }
    const quoteStages: BusinessSummary['quoteStages'] = Object.keys(quoteStatusLabels).map(status => ({ status: status as Quote['status'], count: 0, totalCents: 0 }));
    const quoteTotals = new Map<string, bigint>();
    for (const row of sql("SELECT status, json_extract(data, '$.totalCents') AS total_cents FROM business_quotes").all()) {
      const stage = quoteStages.find(item => item.status === row.status)!;
      stage.count++;
      quoteTotals.set(stage.status, (quoteTotals.get(stage.status) ?? 0n) + BigInt(row.total_cents as number));
    }
    for (const stage of quoteStages) stage.totalCents = safeNumber(quoteTotals.get(stage.status) ?? 0n);
    const serviceCounts = new Map(sql('SELECT stage, COUNT(*) AS count FROM business_services GROUP BY stage').all().map(row => [String(row.stage), Number(row.count)]));
    const materialRows = sql(`SELECT json_extract(m.data, '$.costCents') AS cost_cents,
      json_extract(m.data, '$.minimumMilli') AS minimum_milli,
      COALESCE((SELECT SUM(delta_milli) FROM business_movements WHERE material_id = m.id), 0) AS stock_milli
      FROM business_materials m WHERE active = 1`).all();
    return {
      scheduledVisits: Number(sql("SELECT COUNT(*) AS count FROM business_visits WHERE status = 'scheduled' AND start_at < ? AND end_at > ?").get(month.endAt, month.startAt)!.count),
      openQuoteCents: sum(quoteStages.filter(stage => stage.status === 'draft' || stage.status === 'sent').map(stage => stage.totalCents)),
      stockValueCents: sum(materialRows.map(row => lineTotal(Number(row.stock_milli), Number(row.cost_cents)))),
      lowStockCount: materialRows.filter(row => Number(row.stock_milli) < Number(row.minimum_milli)).length,
      cash: { openingCents: safeNumber(opening), incomeCents: safeNumber(income), expenseCents: safeNumber(expense), balanceCents: safeNumber(closing),
        receivableCents: safeNumber(receivable), payableCents: safeNumber(payable), series },
      quoteStages, serviceStages: Object.keys(serviceStageLabels).map(stage => ({ stage: stage as Service['stage'], count: serviceCounts.get(stage) ?? 0 })),
    };
  }

  return {
    timeZone,
    snapshot(month) {
      const bounds = monthBounds(month);
      return transaction((): BusinessSnapshot => ({ timeZone, month: bounds.month,
        clients: records('clients', bounds).items as Client[], services: records('services', bounds).items as Service[],
        visits: records('visits', bounds).items as Visit[], quotes: records('quotes', bounds).items as Quote[],
        materials: records('materials', bounds).items as Material[], movements: records('movements', bounds).items as StockMovement[],
        cashEntries: records('cash', bounds).items as CashEntry[], summary: summary(bounds),
      }), 'DEFERRED');
    },
    query(input: BusinessQuery) {
      const parsed = querySchema.safeParse(input);
      if (!parsed.success) throw new BusinessError('Consulta inválida. Use um mês AAAA-MM e limite entre 1 e 50.');
      const query = parsed.data, bounds = monthBounds(query.month);
      return transaction(() => query.section === 'summary' ? { items: (query.offset ?? 0) > 0 ? [] : [summary(bounds)], total: 1 }
        : records(query.section, query.month ? bounds : undefined, query.search, query.offset ?? 0, query.limit ?? 50), 'DEFERRED');
    },
    apply(input, idempotencyKey) {
      const action = parseBusinessAction(input), key = checkedCommandId(idempotencyKey);
      return transaction(() => applyInternal(action, key, 'api'));
    },
    propose(actor, commandId, input) {
      const account = checkedActor(actor), key = checkedCommandId(commandId), action = parseBusinessAction(input);
      return transaction(() => {
        const timestamp = now().toISOString(), current = currentPending(account, timestamp), encoded = canonical(action);
        const previous = sql('SELECT * FROM business_pending WHERE actor = ? AND source_command_id = ?').get(account, key);
        if (previous) {
          if (previous.state === 'active' && previous.action === encoded) return pendingRecord(previous);
          throw new BusinessError('Este comando já foi processado. Envie uma nova mensagem para propor outra operação.', 409);
        }
        if (replay(`voice:${account}`, key)) throw new BusinessError('Este comando já confirmou uma operação. Envie uma nova mensagem.', 409);
        if (current) throw new BusinessError('Já existe uma operação aguardando confirmação. Confirme ou cancele antes de propor outra.', 409);
        const prepared = prepare(action);
        const pending: PendingOperation = { id: randomUUID(), sourceCommandId: key, action, summary: prepared.summary,
          expiresAt: new Date(Date.parse(timestamp) + 15 * 60 * 1000).toISOString() };
        sql("INSERT INTO business_pending(id, actor, source_command_id, action, summary, expires_at, state) VALUES (?, ?, ?, ?, ?, ?, 'active')")
          .run(pending.id, account, key, encoded, pending.summary, pending.expiresAt);
        return pending;
      });
    },
    pending(actor) {
      const account = checkedActor(actor);
      return transaction(() => { const row = currentPending(account, now().toISOString()); return row ? pendingRecord(row) : undefined; });
    },
    confirm(actor, commandId) {
      const account = checkedActor(actor), key = checkedCommandId(commandId);
      return transaction(() => {
        const prior = replay(`voice:${account}`, key);
        if (prior) return decode<ActionResult>(prior.result);
        if (sql('SELECT 1 FROM business_pending WHERE actor = ? AND source_command_id = ?').get(account, key)) {
          throw new BusinessError('A confirmação exige uma nova mensagem, diferente da mensagem que propôs a operação.', 409);
        }
        const row = currentPending(account, now().toISOString());
        if (!row) throw new BusinessError('Não há operação pendente válida. Ela pode ter expirado após 15 minutos.', 404);
        const result = applyInternal(parseBusinessAction(decode(row.action)), key, `voice:${account}`);
        sql("UPDATE business_pending SET state = 'confirmed' WHERE id = ? AND actor = ? AND state = 'active'").run(String(row.id), account);
        return result;
      });
    },
    cancel(actor) {
      const account = checkedActor(actor);
      return transaction(() => {
        const row = currentPending(account, now().toISOString());
        if (!row) return false;
        sql("UPDATE business_pending SET state = 'cancelled' WHERE id = ? AND actor = ?").run(String(row.id), account);
        return true;
      });
    },
    quoteDocument(id) {
      if (!uuid.safeParse(id).success) throw new BusinessError('Identificador de orçamento inválido.');
      return transaction(() => ({ quote: get<Quote>('quotes', id), timeZone }), 'DEFERRED');
    },
  };
}

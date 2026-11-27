import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PrismaClient, Prisma } from '../generated/prisma/client.js';
import { tables, type Table, type EntityMap, type Base } from '../core/domain.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { AppError } from '../core/errors.js';
export const base = (id: string = randomUUID()): Base => ({ id, createdAt: new Date() });
export type Filter<K extends Table> = Partial<EntityMap[K]>;
export interface Database {
  get<K extends Table>(table: K, id: string): Promise<EntityMap[K] | null>;
  list<K extends Table>(table: K, where?: Filter<K>): Promise<EntityMap[K][]>;
  insert<K extends Table>(table: K, data: EntityMap[K]): Promise<EntityMap[K]>;
  update<K extends Table>(table: K, id: string, data: Partial<EntityMap[K]>): Promise<EntityMap[K]>;
  remove<K extends Table>(table: K, id: string): Promise<void>;
  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
const dateKeys = new Set([
  'postSubmitAt',
  'postConfirmedAt',
  'ctaScheduledAt',
  'ctaSubmitAt',
  'ctaConfirmedAt',
  'ctaDelayNotifiedAt',
  'plannedAt',
  'lastAttemptAt',
  'ctaUpdatedAt',
  'commentNotBefore',
  'joinedAt',
  'leftAt',
  'd7MeasuredAt',
  'd30MeasuredAt',
  'ratedAt',
  'ctaCapturedAt',
  'createdAt',
  'expiresAt',
  'lastPublishedAt',
  'scheduledAt',
  'startedAt',
  'updatedAt',
  'publishedAt',
  'measuredAt',
  'occurredAt',
]);
const revive = (key: string, value: unknown) =>
  dateKeys.has(key) &&
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    ? new Date(value)
    : value;

export class MemoryDatabase implements Database {
  private data: Record<string, Record<string, unknown>> = Object.fromEntries(
    tables.map((t) => [t, {}]),
  );
  private tail: Promise<unknown> = Promise.resolve();
  private inTransaction = false;
  constructor(private path?: string) {}
  async load() {
    if (this.path)
      try {
        this.data = { ...this.data, ...JSON.parse(await readFile(this.path, 'utf8'), revive) };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
  }
  async get<K extends Table>(table: K, id: string): Promise<EntityMap[K] | null> {
    return structuredClone((this.data[table]?.[id] as EntityMap[K]) ?? null);
  }
  async list<K extends Table>(table: K, where: Filter<K> = {}): Promise<EntityMap[K][]> {
    return structuredClone(
      Object.values(this.data[table] ?? {}).filter((row) =>
        Object.entries(where).every(([k, v]) => (row as Record<string, unknown>)[k] === v),
      ) as EntityMap[K][],
    );
  }
  private async persist() {
    if (!this.path || this.inTransaction) return;
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data), { mode: 0o600 });
    await rename(tmp, this.path);
  }
  async insert<K extends Table>(table: K, data: EntityMap[K]): Promise<EntityMap[K]> {
    if (!this.inTransaction) return this.transaction((tx) => tx.insert(table, data));
    if (this.data[table]![data.id]) throw new AppError('DUPLICATE', 'Запись уже существует');
    this.data[table]![data.id] = structuredClone(data);
    return structuredClone(data);
  }
  async update<K extends Table>(
    table: K,
    id: string,
    data: Partial<EntityMap[K]>,
  ): Promise<EntityMap[K]> {
    if (!this.inTransaction) return this.transaction((tx) => tx.update(table, id, data));
    const row = await this.get(table, id);
    if (!row) throw new AppError('NOT_FOUND', 'Запись не найдена');
    const updated = { ...row, ...data, id };
    this.data[table]![id] = updated;
    return structuredClone(updated);
  }
  async remove<K extends Table>(table: K, id: string) {
    if (!this.inTransaction) return this.transaction((tx) => tx.remove(table, id));
    delete this.data[table]![id];
  }
  async transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    if (this.inTransaction) return fn(this);
    const run = this.tail.then(async () => {
      const tx = new MemoryDatabase();
      tx.data = structuredClone(this.data);
      tx.inTransaction = true;
      const result = await fn(tx);
      const before = this.data;
      this.data = tx.data;
      try {
        await this.persist();
      } catch (e) {
        this.data = before;
        throw e;
      }
      return result;
    });
    this.tail = run.catch(() => {});
    return run;
  }
  async close() {
    await this.tail;
  }
}
// The narrow repository boundary keeps services identical in demo and PostgreSQL modes.
export class PrismaDatabase implements Database {
  constructor(
    private client: PrismaClient | Prisma.TransactionClient = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: process.env.DATABASE_URL,
        options: '-c timezone=UTC',
        connectionTimeoutMillis: 5000,
        max: 5,
      }),
    }),
    private root = true,
  ) {}
  static connect(url: string) {
    return new PrismaDatabase(
      new PrismaClient({
        adapter: new PrismaPg(
          {
            connectionString: url,
            options: '-c timezone=UTC',
            connectionTimeoutMillis: 5000,
            max: 5,
          },
          { schema: new URL(url).searchParams.get('schema') ?? 'public' },
        ),
      }),
    );
  }
  private model(table: Table): any {
    return (this.client as any)[table];
  }
  get<K extends Table>(table: K, id: string): Promise<EntityMap[K] | null> {
    return this.model(table).findUnique({ where: { id } });
  }
  list<K extends Table>(table: K, where: Filter<K> = {}): Promise<EntityMap[K][]> {
    return this.model(table).findMany({ where });
  }
  insert<K extends Table>(table: K, data: EntityMap[K]): Promise<EntityMap[K]> {
    return this.model(table).create({ data });
  }
  update<K extends Table>(
    table: K,
    id: string,
    data: Partial<EntityMap[K]>,
  ): Promise<EntityMap[K]> {
    return this.model(table).update({ where: { id }, data });
  }
  async remove<K extends Table>(table: K, id: string) {
    await this.model(table).deleteMany({ where: { id } });
  }
  async transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
    if (!this.root) return fn(this);
    for (let attempt = 0; ; attempt++)
      try {
        return await (this.client as PrismaClient).$transaction(
          (tx) => fn(new PrismaDatabase(tx, false)),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15000 },
        );
      } catch (e) {
        const conflict = e as {
          code?: string;
          cause?: { kind?: string };
          meta?: { driverAdapterError?: { cause?: { kind?: string } } };
        };
        if (
          !(
            conflict.code === 'P2034' ||
            conflict.cause?.kind === 'TransactionWriteConflict' ||
            conflict.meta?.driverAdapterError?.cause?.kind === 'TransactionWriteConflict'
          ) ||
          attempt >= 3
        )
          throw e;
        // Other scheduler/lease transactions may still be in flight. Immediate
        // retries exhausted all four attempts within 12 ms on the native VPS.
        // Retry only rolled-back database work, with a bounded jittered backoff.
        await new Promise((resolve) =>
          setTimeout(resolve, 100 * 2 ** attempt + Math.floor(Math.random() * 100)),
        );
      }
  }
  async close() {
    if (this.root) await (this.client as PrismaClient).$disconnect();
  }
}
export async function audit(
  db: Database,
  actor: string,
  action: string,
  entityId: string,
  detail = '',
) {
  await db.insert('audit', { ...base(), actor, action, entityId, detail });
}

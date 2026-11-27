import { createHash } from 'node:crypto';
import type { Database } from './database.js';
import { base } from './database.js';
// Small durable documents reuse the existing PostgreSQL settings repository.
// Every state transition is still protected by serializable transactions + audit.
export const hashDocument = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function getDocument<T>(db: Database, id: string): Promise<T | null> {
  const row = await db.get('setting', id);
  return row ? (JSON.parse(row.value) as T) : null;
}
export async function putDocument<T>(db: Database, id: string, value: T) {
  const row = await db.get('setting', id);
  if (row) await db.update('setting', id, { value: JSON.stringify(value) });
  else await db.insert('setting', { ...base(id), value: JSON.stringify(value) });
  return value;
}
export async function listDocuments<T>(db: Database, prefix: string) {
  return (await db.list('setting'))
    .filter((row) => row.id.startsWith(prefix))
    .map((row) => JSON.parse(row.value) as T);
}

import type { Database } from '../db/database.js';
import { audit } from '../db/database.js';
import { getDocument, putDocument } from '../db/documents.js';
import { assert } from '../core/errors.js';
export interface SourceRights {
  sourceId: string;
  sourceType: 'OWN' | 'PERMITTED' | 'THIRD_PARTY' | 'UNKNOWN';
  rightsStatus: 'CONFIRMED' | 'UNCONFIRMED' | 'LEGACY';
  rightsConfirmedAt: string | null;
  confirmedBy: string | null;
}
export async function sourceRights(db: Database, sourceId: string): Promise<SourceRights> {
  const s = await db.get('source', sourceId);
  assert(s, 'NOT_FOUND', 'Исходник не найден');
  const saved = await getDocument<SourceRights>(db, `source-rights-${sourceId}`);
  if (saved) return saved;
  const known = s.rights === 'OWN' || s.rights === 'PERMITTED';
  const record = known
    ? (await db.list('audit', { entityId: sourceId }))
        .filter((a) => a.action === 'CONFIRM_RIGHTS' && a.detail === s.rights)
        .at(-1)
    : undefined;
  return {
    sourceId,
    sourceType: known ? (s.rights as 'OWN' | 'PERMITTED') : 'UNKNOWN',
    rightsStatus: known ? (record ? 'CONFIRMED' : 'LEGACY') : 'UNCONFIRMED',
    rightsConfirmedAt: record?.createdAt.toISOString() ?? null,
    confirmedBy: record?.actor ?? null,
  };
}
export async function confirmSourceRights(
  db: Database,
  sourceId: string,
  kind: 'OWN' | 'PERMITTED' | 'THIRD_PARTY',
  actor: string,
) {
  assert(/^\d+$/.test(actor), 'ACTOR_REQUIRED', 'Нужно подтверждение Telegram-пользователя');
  return db.transaction(async (tx) => {
    assert(await tx.get('source', sourceId), 'NOT_FOUND', 'Исходник не найден');
    const confirmed = kind !== 'THIRD_PARTY';
    const value: SourceRights = {
      sourceId,
      sourceType: kind,
      rightsStatus: confirmed ? 'CONFIRMED' : 'UNCONFIRMED',
      rightsConfirmedAt: confirmed ? new Date().toISOString() : null,
      confirmedBy: confirmed ? actor : null,
    };
    await tx.update('source', sourceId, { rights: kind === 'THIRD_PARTY' ? 'REVIEW' : kind });
    await putDocument(tx, `source-rights-${sourceId}`, value);
    await audit(tx, actor, 'CONFIRM_RIGHTS', sourceId, confirmed ? kind : 'REVIEW');
    return value;
  });
}
export async function assertSourceRights(db: Database, sourceId: string) {
  const r = await sourceRights(db, sourceId);
  const source = await db.get('source', sourceId);
  assert(
    (r.sourceType === 'OWN' || r.sourceType === 'PERMITTED') &&
      source?.rights === r.sourceType &&
      r.rightsStatus !== 'UNCONFIRMED',
    'RIGHTS_REQUIRED',
    'Укажите происхождение исходника: мой авторский текст или есть разрешение. Новый запрос Sol не нужен',
  );
}

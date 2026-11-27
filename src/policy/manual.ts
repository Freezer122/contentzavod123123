import { randomUUID } from 'node:crypto';
import type { Database } from '../db/database.js';
import { audit } from '../db/database.js';
import { assert } from '../core/errors.js';
import { getDocument, putDocument } from '../db/documents.js';
export interface ManualCard {
  id: string;
  kind: 'POST' | 'REPLY';
  entityId: string;
  accountId: string;
  hash: string;
  version: number;
  sourceUrl: string;
  actor: string;
  sessionId: string;
  expiresAt: string;
  used?: boolean;
  cancelled?: boolean;
  resultId?: string;
  ctaJobId?: string;
}
export interface ManualSettings {
  manualLiveEnabled: boolean;
  automaticEnabled: false;
  epoch: number;
}
export class ManualPolicy {
  constructor(
    public db: Database,
    private allowed: string[] = [],
    private owner = '',
    private serverAllowed = false,
  ) {}
  async migrate() {
    if (!(await getDocument(this.db, 'publishing-policy-v112'))) {
      await this.db.transaction(async (tx) => {
        if (await getDocument(tx, 'publishing-policy-v112')) return;
        await putDocument(
          tx,
          'automationPaused',
          (await tx.get('setting', 'factoryPaused'))?.value !== 'false',
        );
        await putDocument(tx, 'emergencyStop', false);
        await putDocument(tx, 'publishing-policy-v112', true);
      });
    }
  }
  async session(actor: string) {
    assert(
      this.allowed.includes(actor) && actor === this.owner,
      'OWNER_REQUIRED',
      'Изменять публикации может только разрешённый владелец',
    );
    let session = await getDocument<{ id: string; expiresAt: string }>(
      this.db,
      `manual-session-${actor}`,
    );
    if (!session || Date.parse(session.expiresAt) <= Date.now()) {
      session = { id: randomUUID(), expiresAt: new Date(Date.now() + 24 * 3600000).toISOString() };
      await putDocument(this.db, `manual-session-${actor}`, session);
    }
    return session;
  }
  async settings(accountId: string, db = this.db): Promise<ManualSettings> {
    assert(await db.get('account', accountId), 'NOT_FOUND', 'Аккаунт не найден');
    return (
      (await getDocument<ManualSettings>(db, `manual-policy-${accountId}`)) ?? {
        manualLiveEnabled: false,
        automaticEnabled: false,
        epoch: 0,
      }
    );
  }
  async setEnabled(accountId: string, actor: string, enabled: boolean) {
    await this.session(actor);
    assert(
      !enabled || this.serverAllowed,
      'MANUAL_SERVER_DISABLED',
      'Ручные публикации не настроены на сервере. Однократно задайте MANUAL_LIVE_ALLOWED=1 и TELEGRAM_OWNER_ID в защищённом окружении трёх служб; затем включите их здесь',
    );
    return this.db.transaction(async (tx) => {
      await assertNotEmergency(tx);
      const old = await this.settings(accountId, tx);
      const value = {
        ...old,
        manualLiveEnabled: enabled,
        automaticEnabled: false as const,
        epoch: old.epoch + 1,
      };
      await putDocument(tx, `manual-policy-${accountId}`, value);
      await audit(tx, actor, enabled ? 'MANUAL_LIVE_ENABLED' : 'MANUAL_LIVE_DISABLED', accountId);
      return value;
    });
  }
  async assertAllowed(
    accountId: string,
    actor: string,
    sessionId: string,
    epoch?: number,
    db = this.db,
  ) {
    assert(
      this.serverAllowed && this.allowed.includes(actor) && actor === this.owner,
      'MANUAL_DISABLED',
      'Ручные публикации выключены',
    );
    await assertNotEmergency(db);
    const session = await getDocument<{ id: string; expiresAt: string }>(
      db,
      `manual-session-${actor}`,
    );
    assert(
      session?.id === sessionId && Date.parse(session.expiresAt) > Date.now(),
      'SESSION_EXPIRED',
      'Сессия управления истекла. Откройте /start и новый предпросмотр',
    );
    const settings = await this.settings(accountId, db);
    assert(
      settings.manualLiveEnabled && (epoch === undefined || epoch === settings.epoch),
      'MANUAL_DISABLED',
      'Ручные публикации выключены или разрешение отозвано',
    );
    assert(
      (await db.get('account', accountId))?.status === 'ACTIVE',
      'ACCOUNT_PAUSED',
      'Аккаунт приостановлен',
    );
    return settings;
  }
  async card(input: Omit<ManualCard, 'id' | 'expiresAt' | 'sessionId'>) {
    const session = await this.session(input.actor);
    const card: ManualCard = {
      ...input,
      id: randomUUID().replaceAll('-', '').slice(0, 24),
      sessionId: session.id,
      expiresAt: session.expiresAt,
    };
    return putDocument(this.db, `manual-card-${card.id}`, card);
  }
  async readCard(id: string, actor: string, db = this.db) {
    const card = await getDocument<ManualCard>(db, `manual-card-${id}`);
    assert(
      card && card.actor === actor,
      'CARD_OWNER',
      'Эта карточка принадлежит другому пользователю',
    );
    assert(
      !card.cancelled && Date.parse(card.expiresAt) > Date.now(),
      'STALE_CARD',
      'Карточка устарела или отменена. Откройте новый предпросмотр',
    );
    return card;
  }
  async cancel(id: string, actor: string) {
    return this.db.transaction(async (tx) => {
      const c = await this.readCard(id, actor, tx);
      assert(
        !c.used,
        'ALREADY_STARTED',
        'Задача уже принята. Отключите ручные публикации для остановки до отправки',
      );
      await putDocument(tx, `manual-card-${id}`, { ...c, cancelled: true });
    });
  }
}
export async function assertNotEmergency(db: Database) {
  assert(
    (await db.get('setting', 'emergencyStop'))?.value !== 'true',
    'EMERGENCY_STOP',
    'Аварийная остановка: отправка запрещена',
  );
}
export async function automationPaused(db: Database) {
  return (
    (await db.get('setting', 'factoryPaused'))?.value === 'true' ||
    (await db.get('setting', 'automationPaused'))?.value === 'true'
  );
}

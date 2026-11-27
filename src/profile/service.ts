import { assertNotEmergency } from '../policy/manual.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from '../db/database.js';
import { audit } from '../db/database.js';
import { getDocument, putDocument, hashDocument } from '../db/documents.js';
import { assert } from '../core/errors.js';
import type { ContentEngine } from '../content/service.js';
import { normalizeText } from '../content/normalizer.js';
export interface ProfileData {
  bio: string;
  links: string[];
  linkCapacity: number;
}
export interface ProfileDraft {
  id: string;
  accountId: string;
  before: ProfileData;
  after: ProfileData;
  hash: string;
  status: 'DRAFT' | 'APPROVED' | 'SAVING' | 'APPLIED' | 'UNCERTAIN';
  actor?: string;
  approvedAt?: string;
  appliedAt?: string;
  error?: string;
}
export interface ProfilePort {
  read(accountId: string): Promise<ProfileData>;
  change(
    accountId: string,
    before: ProfileData,
    after: ProfileData,
    commit: boolean,
    beforeSave: () => Promise<void>,
  ): Promise<ProfileData>;
}
export class ProfileManager {
  constructor(
    private db: Database,
    private port: ProfilePort,
    private engine: ContentEngine,
    private changesAllowed = false,
  ) {}
  async snapshot(accountId: string, refresh = false) {
    const cached = await getDocument<ProfileData>(this.db, `profile-snapshot-${accountId}`);
    if (cached && !refresh) return cached;
    assert(await this.db.get('account', accountId), 'NOT_FOUND', 'Аккаунт не найден');
    return putDocument(this.db, `profile-snapshot-${accountId}`, await this.port.read(accountId));
  }
  async get(id: string) {
    const d = await getDocument<ProfileDraft>(this.db, `profile-draft-${id}`);
    assert(d, 'NOT_FOUND', 'Черновик профиля не найден');
    return d;
  }
  async draft(
    accountId: string,
    patch: Partial<Pick<ProfileData, 'bio' | 'links'>>,
    actor: string,
  ) {
    const before = await this.snapshot(accountId),
      after = { ...before, ...patch };
    if ((await getDocument<{ enabled: boolean }>(this.db, `normalizer-${accountId}`))?.enabled)
      after.bio = normalizeText(after.bio);
    z.string().max(150).parse(after.bio);
    assert(
      after.links.length <= Math.min(5, before.linkCapacity),
      'LINK_LIMIT',
      `Интерфейс допускает ссылок: ${before.linkCapacity}`,
    );
    after.links = after.links.map((link) => {
      const u = new URL(link);
      assert(
        u.protocol === 'https:' && !u.username && !u.password,
        'INVALID_URL',
        'Нужны HTTPS-ссылки без пароля',
      );
      return u.href;
    });
    assert(
      new Set(after.links).size === after.links.length,
      'DUPLICATE_LINK',
      'Повторяющиеся ссылки',
    );
    const id = randomUUID(),
      draft: ProfileDraft = {
        id,
        accountId,
        before,
        after,
        hash: hashDocument(after),
        status: 'DRAFT',
      };
    await this.db.transaction(async (tx) => {
      await putDocument(tx, `profile-draft-${id}`, draft);
      await audit(tx, actor, 'PROFILE_DRAFT', id, draft.hash);
    });
    return draft;
  }
  async generatedBio(accountId: string, facts: string, actor: string) {
    const response = await this.engine.auxiliary(
      accountId,
      'BIO',
      facts,
      'Напиши био Threads до 150 символов. Только факты из исходника. Строчные буквы, без эмодзи и точек в конце абзацев.',
    );
    return this.draft(accountId, { bio: response.text }, actor);
  }
  async approve(id: string, hash: string, actor: string) {
    return this.db.transaction(async (tx) => {
      const d = await getDocument<ProfileDraft>(tx, `profile-draft-${id}`);
      assert(
        d && d.status === 'DRAFT' && d.hash === hash,
        'STALE_APPROVAL',
        'Предпросмотр устарел',
      );
      d.status = 'APPROVED';
      d.actor = actor;
      d.approvedAt = new Date().toISOString();
      await audit(tx, actor, 'PROFILE_APPROVED', id, hash);
      return putDocument(tx, `profile-draft-${id}`, d);
    });
  }
  async apply(id: string, hash: string, actor: string, dryRun = true) {
    const d = await this.get(id);
    assert(
      d.status === 'APPROVED' && d.hash === hash && d.actor === actor,
      'APPROVAL_REQUIRED',
      'Нужно подтверждение точного предпросмотра',
    );
    assert(
      dryRun || this.changesAllowed,
      'DRY_RUN_ONLY',
      'Сохранение профиля отключено; доступна только проверка без отправки',
    );
    try {
      const result = await this.port.change(d.accountId, d.before, d.after, !dryRun, async () => {
        await this.db.transaction(async (tx) => {
          await assertNotEmergency(tx);
          const current = await getDocument<ProfileDraft>(tx, `profile-draft-${id}`);
          assert(
            current?.status === 'APPROVED' && current.hash === hash,
            'STALE_APPROVAL',
            'Подтверждение изменилось',
          );
          await putDocument(tx, `profile-draft-${id}`, { ...current, status: 'SAVING' });
          await audit(tx, actor, 'PROFILE_SAVE_STARTED', id, hash);
        });
      });
      assert(
        hashDocument(result) === hashDocument(dryRun ? d.before : d.after),
        'PROFILE_VERIFY',
        'Сохранённые поля не совпали',
      );
      await this.db.transaction(async (tx) => {
        await audit(tx, actor, dryRun ? 'PROFILE_DRY_RUN' : 'PROFILE_APPLIED', id, hash);
        if (!dryRun) {
          await putDocument(tx, `profile-draft-${id}`, {
            ...d,
            status: 'APPLIED',
            appliedAt: new Date().toISOString(),
          });
          await putDocument(tx, `profile-snapshot-${d.accountId}`, result);
        }
      });
      return { dryRun, verified: true, data: result };
    } catch (e) {
      const current = await this.get(id);
      if (current.status === 'SAVING')
        await putDocument(this.db, `profile-draft-${id}`, {
          ...current,
          status: 'UNCERTAIN',
          error: 'Результат сохранения неизвестен. Повторная отправка запрещена.',
        });
      throw e;
    }
  }
  async normalizer(accountId: string, enabled: boolean, actor: string) {
    assert(await this.db.get('account', accountId), 'NOT_FOUND', 'Аккаунт не найден');
    await putDocument(this.db, `normalizer-${accountId}`, { enabled });
    await audit(this.db, actor, 'NORMALIZER_SETTING', accountId, String(enabled));
  }
}

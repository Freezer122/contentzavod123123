import { z } from 'zod';
import type { Database } from '../db/database.js';
import { base, audit } from '../db/database.js';
import { assert } from '../core/errors.js';
import type { Cta } from '../core/domain.js';
import { Tracking } from '../tracking/service.js';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { getDocument, putDocument, hashDocument } from '../db/documents.js';
export const ctaSignature = (c: Cta) =>
  hashDocument({
    text: c.text,
    url: c.url ?? '',
    media: c.mediaSha256 ?? null,
    version: c.version ?? 1,
  });
export function renderCta(text: string, url: string | null | undefined) {
  return url && !text.includes(url) ? `${text.trim()}\n${url}` : text.trim();
}
export class CtaService {
  constructor(
    private db: Database,
    private publicBase = 'https://factory.example.com',
    private target = 'https://t.me/content_factory_demo',
  ) {}
  async attachment(
    accountId: string,
    path: string | null,
    actor: string,
    root = '/var/lib/content-factory/media',
  ) {
    let mediaPath: string | null = null,
      mediaSha256: string | null = null;
    if (path) {
      mediaPath = await realpath(path);
      assert(
        mediaPath.startsWith((await realpath(root)) + sep),
        'INVALID_MEDIA',
        'Изображение должно быть в каталоге медиа',
      );
      const bytes = await readFile(mediaPath);
      assert(
        bytes.length > 0 && bytes.length <= 10 * 1024 * 1024,
        'INVALID_MEDIA',
        'Изображение должно быть не больше 10 МБ',
      );
      assert(
        bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
          bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) ||
          (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'),
        'INVALID_MEDIA',
        'Нужен PNG, JPEG или WebP',
      );
      mediaSha256 = createHash('sha256').update(bytes).digest('hex');
    }
    await this.ensure(accountId);
    return this.db.transaction(async (tx) => {
      const cta = (await tx.list('cta', { accountId }))[0]!;
      await audit(tx, actor, 'EDIT_CTA_ATTACHMENT', accountId, mediaSha256 ?? 'REMOVED');
      return tx.update('cta', cta.id, {
        mediaPath,
        mediaSha256,
        version: (cta.version ?? 1) + 1,
        updatedAt: new Date(),
      });
    });
  }
  async ensure(accountId: string): Promise<Cta> {
    return this.db.transaction(async (tx) => {
      const account = await tx.get('account', accountId);
      assert(account, 'NOT_FOUND', 'Аккаунт не найден');
      const owned = (await tx.list('cta', { accountId }))[0];
      if (owned) {
        if (account.ctaId !== owned.id) await tx.update('account', accountId, { ctaId: owned.id });
        if (owned.url === undefined) return tx.update('cta', owned.id, { url: '' });
        return owned;
      }
      const previous = account.ctaId ? await tx.get('cta', account.ctaId) : null;
      const cta = await tx.insert('cta', {
        ...base(`cta-${accountId}`),
        accountId,
        name: `CTA ${account.name}`,
        text: previous?.text ?? 'Больше разборов в моём Telegram.',
        url: previous?.url ?? '',
        enabled: true,
        updatedAt: new Date(),
        version: 1,
      });
      await tx.update('account', accountId, { ctaId: cta.id });
      return cta;
    });
  }
  async update(accountId: string, text: string, url: string, actor: string) {
    z.string().trim().min(1).max(500).parse(text);
    const u = url.trim() ? new URL(url.trim()) : null;
    assert(
      !u || (u.protocol === 'https:' && !u.username && !u.password),
      'INVALID_URL',
      'CTA должен содержать HTTPS-ссылку',
    );
    assert(
      [...renderCta(text, u?.href)].length <= 500,
      'CTA_LENGTH',
      'Текст и ссылка CTA вместе должны занимать до 500 символов',
    );
    await this.ensure(accountId);
    return this.db.transaction(async (tx) => {
      const cta = (await tx.list('cta', { accountId }))[0]!;
      await audit(tx, actor, 'EDIT_ACCOUNT_CTA', accountId, `Версия ${(cta.version ?? 1) + 1}`);
      return tx.update('cta', cta.id, {
        text: text.trim(),
        url: u?.href ?? '',
        enabled: cta.enabled,
        updatedAt: new Date(),
        version: (cta.version ?? 1) + 1,
      });
    });
  }
  async setEnabled(accountId: string, enabled: boolean, actor: string) {
    await this.ensure(accountId);
    return this.db.transaction(async (tx) => {
      const cta = (await tx.list('cta', { accountId }))[0]!;
      await audit(tx, actor, enabled ? 'ENABLE_CTA' : 'DISABLE_CTA', accountId);
      const ap = await getDocument<any>(tx, `autopilot-account-${accountId}`);
      if (ap)
        await putDocument(tx, `autopilot-account-${accountId}`, {
          ...ap,
          config: { ...ap.config, allowCTA: enabled },
        });
      return tx.update('cta', cta.id, {
        enabled,
        version: (cta.version ?? 1) + 1,
        updatedAt: new Date(),
      });
    });
  }
}

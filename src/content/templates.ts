import { z } from 'zod';
import type { Database } from '../db/database.js';
import { base, audit } from '../db/database.js';
import { assert } from '../core/errors.js';
export const templatePatch = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    instruction: z.string().trim().min(1).max(2000).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
const defaults = [
  [
    'life-observation',
    'Наблюдение из жизни трейдера',
    'Подай исходную мысль как простое наблюдение о трейдинге. Не приписывай автору личный опыт.',
  ],
  [
    'story',
    'История',
    'Используй сюжет только из исходника. Если истории нет, расскажи об идее последовательно без выдуманных событий.',
  ],
  [
    'audience-question',
    'Вопрос аудитории',
    'Коротко изложи одну мысль и задай естественный вопрос по теме. Без искусственного вовлечения.',
  ],
  [
    'provocative',
    'Провокационное мнение',
    'Выдели спорную мысль исходника простыми словами. Не усиливай утверждения и не добавляй факты.',
  ],
  ['irony', 'Ирония', 'Лёгкая ирония вокруг исходной мысли. Без выдуманного опыта и оскорблений.'],
  [
    'beginner-mistake',
    'Ошибка новичка',
    'Объясни описанную в исходнике ошибку простыми словами. Не придумывай ошибку, если её нет.',
  ],
  [
    'trading-psychology',
    'Психология торговли',
    'Передай психологический аспект исходной мысли без диагнозов, выдуманных историй и новых фактов.',
  ],
  [
    'simple-explanation',
    'Простое объяснение сложной темы',
    'Объясни одну идею понятным разговорным языком с минимумом жаргона и без новых фактов.',
  ],
] as const;
export class TemplateService {
  constructor(private db: Database) {}
  async seed() {
    for (const [id, name, instruction] of defaults)
      if (!(await this.db.get('contentTemplate', `template-${id}`)))
        await this.db.insert('contentTemplate', {
          ...base(`template-${id}`),
          updatedAt: new Date(),
          name,
          instruction,
          version: 1,
          enabled: true,
        });
  }
  async list() {
    return this.db.list('contentTemplate');
  }
  async create(name: string, instruction: string, actor: string) {
    const parsed = templatePatch
      .required({ name: true, instruction: true })
      .parse({ name, instruction });
    return this.db.transaction(async (tx) => {
      const row = await tx.insert('contentTemplate', {
        ...base(),
        updatedAt: new Date(),
        name: parsed.name,
        instruction: parsed.instruction,
        enabled: true,
        version: 1,
      });
      await audit(tx, actor, 'CREATE_TEMPLATE', row.id);
      return row;
    });
  }
  async update(id: string, raw: unknown, actor: string) {
    const patch = templatePatch.parse(raw);
    return this.db.transaction(async (tx) => {
      const row = await tx.get('contentTemplate', id);
      assert(row, 'NOT_FOUND', 'Шаблон не найден');
      await audit(tx, actor, 'EDIT_TEMPLATE', id);
      return tx.update('contentTemplate', id, {
        ...patch,
        version: row.version + 1,
        updatedAt: new Date(),
      });
    });
  }
  async addExample(templateId: string, text: string, actor: string) {
    z.string().trim().min(1).max(2000).parse(text);
    return this.db.transaction(async (tx) => {
      const t = await tx.get('contentTemplate', templateId);
      assert(t, 'NOT_FOUND', 'Шаблон не найден');
      const ex = await tx.insert('templateExample', { ...base(), templateId, text: text.trim() });
      await tx.update('contentTemplate', templateId, {
        version: t.version + 1,
        updatedAt: new Date(),
      });
      await audit(tx, actor, 'ADD_TEMPLATE_EXAMPLE', templateId);
      return ex;
    });
  }
  async assign(accountId: string, templateId: string | null, actor: string) {
    return this.db.transaction(async (tx) => {
      assert(await tx.get('account', accountId), 'NOT_FOUND', 'Аккаунт не найден');
      if (templateId)
        assert(
          (await tx.get('contentTemplate', templateId))?.enabled,
          'NOT_FOUND',
          'Активный шаблон не найден',
        );
      await audit(
        tx,
        actor,
        templateId ? 'PIN_TEMPLATE' : 'UNPIN_TEMPLATE',
        accountId,
        templateId ?? '',
      );
      return tx.update('account', accountId, { templateId });
    });
  }
  async ensureOwnStyle(accountId: string) {
    return this.db.transaction(async (tx) => {
      const account = await tx.get('account', accountId);
      assert(account, 'NOT_FOUND', 'Аккаунт не найден');
      const own = (await tx.list('style', { ownerAccountId: accountId }))[0];
      if (own) {
        if (account.styleId !== own.id) await tx.update('account', accountId, { styleId: own.id });
        return own;
      }
      const preset = await tx.get('style', account.styleId);
      assert(preset, 'NOT_FOUND', 'Стиль не найден');
      const style = await tx.insert('style', {
        ...preset,
        ...base(`style-account-${accountId}`),
        ownerAccountId: accountId,
      });
      for (const example of await tx.list('styleExample', { styleId: preset.id }))
        await tx.insert('styleExample', { ...base(), styleId: style.id, text: example.text });
      await tx.update('account', accountId, { styleId: style.id });
      return style;
    });
  }
  async assignStyle(accountId: string, presetId: string, actor: string) {
    const preset = await this.db.get('style', presetId);
    assert(preset, 'NOT_FOUND', 'Стиль не найден');
    const own = await this.ensureOwnStyle(accountId);
    if (own.id === presetId) return own;
    return this.db.transaction(async (tx) => {
      const { id, createdAt, ownerAccountId, ...spec } = preset;
      await tx.update('style', own.id, spec);
      for (const example of await tx.list('styleExample', { styleId: own.id }))
        await tx.remove('styleExample', example.id);
      for (const example of await tx.list('styleExample', { styleId: presetId }))
        await tx.insert('styleExample', { ...base(), styleId: own.id, text: example.text });
      await audit(tx, actor, 'COPY_ACCOUNT_STYLE', accountId, presetId);
      return (await tx.get('style', own.id))!;
    });
  }
}

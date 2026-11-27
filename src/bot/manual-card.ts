import { InlineKeyboard } from './keyboard.js';
import { rightsKeyboard, rightsLabel } from './source-rights.js';
import { validateDetailed } from '../content/service.js';

import type { BotServices } from './bot.js';
import type { ReplyDraft } from '../engagement/service.js';
import { hashDocument, getDocument } from '../db/documents.js';
import { postKeyboard } from './generation.js';
export async function postCard(s: BotServices, id: string, actor: string) {
  const g = (await s.db.get('generated', id))!,
    a = await s.db.get('account', g.accountId);
  const stale = await getDocument(s.db, `superseded-${id}`),
    rejected = await getDocument(s.db, `rejected-${id}`);
  const source = await s.db.get('source', g.sourceId),
    style = await s.db.get('style', g.styleId);
  if (source && style) {
    const v = validateDetailed(g.text, source.text, style);
    g.valid = v.status !== 'BLOCKED';
    g.validationErrors = v.issues.map(
      (i) => `${i.level}: ${i.reason}: ${i.source} → ${i.generated}`,
    );
    await s.db.update('generated', g.id, { valid: g.valid, validationErrors: g.validationErrors });
  }
  const policy = await s.manual.settings(g.accountId);
  const cta = await s.ctas.ensure(g.accountId);
  const card = await s.manual.card({
    kind: 'POST',
    entityId: id,
    accountId: g.accountId,
    hash: hashDocument(g.text),
    version: g.version,
    sourceUrl: hashDocument({
      text: cta.text,
      url: cta.url,
      enabled: cta.enabled,
      media: cta.mediaSha256,
    }),
    actor,
  });
  const kb = postKeyboard(id);
  kb.inline_keyboard[0]![0] =
    source?.rights === 'REVIEW'
      ? { text: 'Указать происхождение', callback_data: `v113rights:${g.sourceId}` }
      : { text: 'Опубликовать', callback_data: `v112send:${card.id}` };
  if (source?.rights === 'REVIEW')
    kb.row().text('Указать происхождение', `v113rights:${g.sourceId}`);
  kb.row().text('Отмена', `v112cancel:${card.id}`);
  return {
    text: `Аккаунт: ${a?.name}\nСтатус: ${stale ? 'УСТАРЕЛ' : rejected ? 'REJECTED' : !g.valid ? 'NEEDS_EDIT' : 'Предпросмотр'}\nРучные публикации: ${policy.manualLiveEnabled ? 'MANUAL_LIVE' : 'выключены'}\n\n${g.text}\n\n${g.validationErrors?.join('\n') || 'Проверка: PASS'}\nПрава: ${await rightsLabel(s.db, g.sourceId)}\nCTA: ${cta.enabled ? cta.text + (cta.url ? '\n' + cta.url : '') + (cta.mediaPath ? '\nс фотографией' : '') : 'выключен'}`,
    reply_markup: stale || rejected ? new InlineKeyboard().text('Главное меню', 'menu') : kb,
  };
}
export async function replyCard(s: BotServices, d: ReplyDraft, actor: string) {
  const c = await s.engagement.candidate(d.accountId, d.candidateId),
    a = await s.db.get('account', d.accountId),
    policy = await s.manual.settings(d.accountId);
  const jobs = (await s.engagement.jobs(d.accountId)).filter(
    (j) => j.draftId === d.id && j.hash === d.hash,
  );
  const sent =
    jobs.find((j) => ['SENDING', 'PUBLISHED', 'UNCERTAIN'].includes(j.status)) ??
    jobs.filter((j) => j.status === 'FAILED').at(-1);
  const kb = new InlineKeyboard();
  if (sent?.status === 'PUBLISHED' && sent.url) kb.url('Ответ опубликован', sent.url);
  else if (sent?.status === 'UNCERTAIN') kb.text('Проверить результат', `v111verify:${sent.id}`);
  else if (sent?.status === 'FAILED') kb.text('Редактировать', `v18edit:${d.id}`);
  else if (!sent && d.status !== 'REJECTED') {
    const card = await s.manual.card({
      kind: 'REPLY',
      entityId: d.id,
      accountId: d.accountId,
      hash: d.hash,
      version: d.version ?? 1,
      sourceUrl: c.url,
      actor,
    });
    kb.text('Опубликовать', `v112send:${card.id}`)
      .text('Сохранить на потом', `v112save:${card.id}`)
      .row()
      .text('Редактировать', `v18edit:${d.id}`)
      .text('Перегенерировать', `v111regen:${d.id}:${d.accountId}`)
      .row()
      .text('Отклонить', `v18reject:${d.id}`)
      .text('Проверить DRY_RUN', `v112dry:${card.id}`)
      .row()
      .text('Отмена', `v112cancel:${card.id}`);
  }
  kb.row()
    .text('👍 Хорошо', `v114rate:GOOD:${d.id}`)
    .text('👎 Плохо', `v114rate:BAD:${d.id}`)
    .row()
    .text('Назад', `v18e:${d.accountId}`);
  return {
    text: `${sent?.status === 'PUBLISHED' ? 'Ответ опубликован' : sent?.status === 'UNCERTAIN' ? 'Отправка могла выполниться, проверяю результат' : sent?.status === 'FAILED' ? 'Ошибка отправки' : sent?.status === 'SENDING' ? 'Отправляю ответ' : 'Предпросмотр ответа'}\nАккаунт: ${a?.name}\n${c.url}\n${c.text.slice(0, 900)}\n\n${d.text}\n\nСтатус: ${sent?.status ?? (d.status === 'APPROVED' ? 'WAITING' : (d.generationState ?? d.status))}\nРучные публикации: ${policy.manualLiveEnabled ? 'MANUAL_LIVE' : 'выключены'}${d.validationErrors?.length ? '\n' + d.validationErrors.join('; ') : ''}${sent?.submittedAt ? '\nВремя отправки: ' + new Date(sent.clickCompletedAt ?? sent.submittedAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : ''}${sent?.error ? '\nПричина: ' + sent.error : ''}${sent?.url ? '\n' + sent.url + (sent.confirmedAt ? '\nПодтверждено: ' + new Date(sent.confirmedAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : '') : ''}`,
    reply_markup: kb,
  };
}

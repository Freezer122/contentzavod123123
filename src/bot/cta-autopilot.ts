import type { Bot, Context } from 'grammy';
import { InputFile } from 'grammy';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { InlineKeyboard } from './keyboard.js';
import type { BotServices } from './bot.js';
import { ctaSignature, renderCta } from '../cta/service.js';
import { ctaStatus, ctaTasks, updateCtaTask } from '../cta/tasks.js';
import { getDocument, putDocument, hashDocument } from '../db/documents.js';
import { assert } from '../core/errors.js';
import { localTime } from '../autopilot/schedule.js';
async function preview(
  ctx: Context,
  s: BotServices,
  id: string,
  caption: string,
  kb: InlineKeyboard,
) {
  const c = await s.ctas.ensure(id);
  if (c.mediaPath) {
    const bytes = await readFile(c.mediaPath);
    assert(
      createHash('sha256').update(bytes).digest('hex') === c.mediaSha256,
      'MEDIA_CHANGED',
      'Фотография изменилась',
    );
    return ctx.replyWithPhoto(new InputFile(bytes, 'cta.jpg'), { caption, reply_markup: kb });
  }
  return ctx.reply(caption, { reply_markup: kb });
}
export async function showAutopilotCta(ctx: Context, s: BotServices, id: string) {
  s.autopilotPolicy.assertCtaOwner(String(ctx.from!.id));
  const c = await s.ctas.ensure(id),
    ap = await s.autopilotPolicy.settings(id),
    token = randomUUID().slice(0, 18),
    kb = new InlineKeyboard();
  if (c.text.trim()) {
    await putDocument(s.db, `cta-ui-${token}`, {
      actor: String(ctx.from!.id),
      accountId: id,
      signature: ctaSignature(c),
      expiresAt: Date.now() + 10 * 60000,
    });
    kb.text(
      ap.config.allowCTA ? 'Выключить CTA' : 'Включить CTA',
      ap.config.allowCTA ? `ac:off:${id}` : `ac:enable:${token}`,
    ).row();
  }
  kb.text('Редактировать CTA', `cta_edit:${id}`).row();
  const today = localTime(Date.now(), ap.config.timezone).day;
  for (const p of (await s.db.list('post', { accountId: id }))
    .filter((p) => localTime(p.publishedAt.getTime(), ap.config.timezone).day === today)
    .slice(-6)) {
    const j = (await s.db.get('publishJob', p.jobId))!,
      status = await ctaStatus(s.db, j);
    if (status.status !== 'PUBLISHED')
      kb.text(
        `CTA к посту ${new Date(p.publishedAt).toLocaleTimeString('ru-RU', { timeZone: ap.config.timezone })} — ${status.status}`,
        `ac:missing:${j.id}`,
      ).row();
  }
  kb.text('Назад', `ap:home:${id}`).text('К аккаунту', `account:${id}`);
  return preview(
    ctx,
    s,
    id,
    `CTA автопилота: ${ap.config.allowCTA ? 'ВКЛЮЧЁН' : 'ВЫКЛЮЧЕН'}\n${c.text.trim() ? renderCta(c.text, c.url) : 'CTA не настроен'}\nФотография: ${c.mediaPath ? 'есть' : 'нет'}\nВерсия: ${c.version ?? 1}\n\nПри включении используется этот сохранённый текст и фотография. CTA отправляется под будущими собственными постами автоматически; старые посты выбираются отдельно`,
    kb,
  );
}
export function installCtaAutopilot(bot: Bot, s: BotServices) {
  bot.callbackQuery(/^ac:/, async (ctx) => {
    await ctx.answerCallbackQuery();
    s.autopilotPolicy.assertCtaOwner(String(ctx.from.id));
    const [, action, id] = ctx.callbackQuery.data.split(':'),
      actor = String(ctx.from.id);
    if (action === 'home') return showAutopilotCta(ctx, s, id!);
    if (action === 'off') {
      await s.autopilotPolicy.setCta(id!, false, actor);
      return showAutopilotCta(ctx, s, id!);
    }
    if (action === 'enable') {
      const c = await getDocument<any>(s.db, `cta-ui-${id}`);
      assert(
        c && c.actor === actor && c.expiresAt > Date.now(),
        'STALE_CTA',
        'Откройте текущий CTA',
      );
      await s.autopilotPolicy.setCta(c.accountId, true, actor, c.signature);
      return showAutopilotCta(ctx, s, c.accountId);
    }
    if (action === 'missing') {
      await ctx.reply('Проверяю собственный пост и отсутствие CTA без отправки');
      const proof = await s.worker.previewCta(id!),
        j = (await s.db.get('publishJob', id!))!,
        c = await s.ctas.ensure(j.accountId);
      if (!proof.absent)
        return ctx.reply(
          `CTA уже найден, повторной отправки нет\n${proof.existingUrl ?? 'Ссылка на комментарий недоступна'}`,
        );
      const token = randomUUID().slice(0, 18);
      await putDocument(s.db, `cta-ui-${token}`, {
        actor,
        accountId: j.accountId,
        jobId: j.id,
        signature: proof.signature,
        expiresAt: Date.now() + 5 * 60000,
      });
      return preview(
        ctx,
        s,
        j.accountId,
        `CTA к конкретному собственному посту\n${proof.parentUrl}\n\n${renderCta(c.text, c.url)}\n\nОтправится только этот CTA, основной пост повторно не отправляется`,
        new InlineKeyboard()
          .text('Отправить этот CTA', `ac:send:${token}`)
          .row()
          .text('Отмена', `ac:home:${j.accountId}`),
      );
    }
    if (action === 'send') {
      const c = await getDocument<any>(s.db, `cta-ui-${id}`);
      assert(
        c && c.actor === actor && c.expiresAt > Date.now(),
        'STALE_CTA',
        'Повторите проверку отсутствия CTA',
      );
      const task = await s.worker.requestMissingCta(c.jobId, actor, c.signature);
      return ctx.reply(
        `CTA поставлен в очередь к ${task.parentPermalink}\nПост уже PUBLISHED; повторного основного поста не будет`,
      );
    }
  });
}
export async function deliverCtaStatus(bot: Bot, s: BotServices) {
  for (const task of await ctaTasks(s.db)) {
    const j = await s.db.get('publishJob', task.jobId);
    if (!j) continue;
    const signature = hashDocument({
      status: task.status,
      reason: task.reason,
      url: task.permalink,
    });
    if (task.notifiedSignature === signature) continue;
    const ap = await s.autopilotPolicy.settings(task.accountId),
      chat = Number(task.manualRequestedBy ?? ap.enabledBy);
    if (!chat) continue;
    const key = `cta-message-${task.jobId}`,
      old = await getDocument<any>(s.db, key),
      interval =
        j.ctaSubmitAt && j.postSubmitAt
          ? ((j.ctaSubmitAt.getTime() - j.postSubmitAt.getTime()) / 1000).toFixed(1)
          : null,
      text = `Пост: PUBLISHED\nВремя: ${new Date(j.postSubmitAt!).toLocaleString('ru-RU', { timeZone: ap.config.timezone })}\n${task.parentPermalink}\nCTA: ${task.status}\n${task.permalink ?? ''}\n${task.reason ?? ''}${interval ? '\nИнтервал пост → CTA: ' + interval + ' с' : ''}`,
      reply_markup = new InlineKeyboard()
        .text('CTA', `ac:home:${task.accountId}`)
        .text('К аккаунту', `account:${task.accountId}`);
    let messageId = old?.messageId;
    if (messageId) {
      try {
        await bot.api.editMessageText(chat, messageId, text, { reply_markup });
      } catch {
        messageId = undefined;
      }
    }
    if (!messageId)
      messageId = (await bot.api.sendMessage(chat, text, { reply_markup })).message_id;
    await putDocument(s.db, key, { messageId });
    // Telegram I/O can overlap a worker transition; never restore a stale task snapshot.
    await s.db.transaction((tx) => updateCtaTask(tx, j.id, { notifiedSignature: signature }));
  }
}

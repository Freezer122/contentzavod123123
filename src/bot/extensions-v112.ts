import { InlineKeyboard } from './keyboard.js';
import { type Bot } from 'grammy';
import type { Config } from '../core/config.js';
import type { BotServices } from './bot.js';
import { assert } from '../core/errors.js';
import { getDocument, putDocument } from '../db/documents.js';
import { replyCard, postCard } from './manual-card.js';
import { validateContent, validateDetailed } from '../content/service.js';
export function installV112(bot: Bot, config: Config, s: BotServices) {
  bot.callbackQuery(/^post_(?:ok|publish|send):/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const card = await postCard(s, ctx.callbackQuery.data.split(':')[1]!, String(ctx.from.id));
    return ctx.reply(`Карточка обновлена. Используйте кнопку «Опубликовать» ниже\n\n${card.text}`, {
      reply_markup: card.reply_markup,
    });
  });
  bot.callbackQuery(/^v112/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const [action, id, extra] = ctx.callbackQuery.data.split(':'),
      actor = String(ctx.from.id);
    if (
      action === 'v112policy' ||
      action === 'v112disable' ||
      action === 'v112enable' ||
      action === 'v112confirm'
    ) {
      if (action === 'v112enable') {
        const token = await s.manual.card({
          kind: 'POST',
          entityId: 'enable',
          accountId: id!,
          hash: 'enable',
          version: 1,
          sourceUrl: '',
          actor,
        });
        return ctx.reply(
          'Разрешить ручные публикации для этого аккаунта? Кнопка «Опубликовать» будет отправлять показанный текст и настроенный CTA без дополнительных экранов. Автоматическая очередь останется выключенной.',
          {
            reply_markup: new InlineKeyboard()
              .text('Разрешить', `v112confirm:${token.id}`)
              .text('Отмена', `v112cancel:${token.id}`),
          },
        );
      }
      let accountId = id!;
      if (action === 'v112confirm') {
        const card = await s.manual.readCard(id!, actor);
        assert(card.entityId === 'enable' && !card.used, 'STALE_CARD', 'Подтверждение устарело');
        accountId = card.accountId;
        await s.manual.setEnabled(accountId, actor, true);
        await putDocument(s.db, `manual-card-${card.id}`, { ...card, used: true });
      }
      if (action === 'v112disable') await s.manual.setEnabled(accountId, actor, false);
      const p = await s.manual.settings(accountId);
      return ctx.reply(
        `Публикации\nРучные: ${p.manualLiveEnabled ? 'разрешены' : 'выключены'}\nАвтопилот: ${(await s.autopilotPolicy.settings(accountId)).state} (отдельные разрешения)\nАварийная остановка: ${(await getDocument(s.db, 'emergencyStop')) ? 'включена' : 'выключена'}`,
        {
          reply_markup: new InlineKeyboard()
            .text(
              p.manualLiveEnabled ? 'Выключить ручные' : 'Включить ручные',
              `v112${p.manualLiveEnabled ? 'disable' : 'enable'}:${accountId}`,
            )
            .row()
            .text('Автопилот', `ap:home:${accountId}`)
            .row()
            .text('Аварийная остановка', `v112stop:${accountId}`)
            .text('Назад', `account:${accountId}`),
        },
      );
    }
    if (action === 'v112stop') {
      await s.manual.session(actor);
      await putDocument(s.db, 'emergencyStop', true);
      return ctx.reply(
        'Аварийная остановка включена. Все внешние отправки запрещены. Снять её может владелец отдельным действием.',
        {
          reply_markup: new InlineKeyboard().text('Снять аварийную остановку', `v112unstop:${id}`),
        },
      );
    }
    if (action === 'v112unstop') {
      await s.manual.session(actor);
      // Revoke account policies on release, never resume queued actions.
      for (const a of await s.db.list('account')) {
        const p = await s.manual.settings(a.id);
        await putDocument(s.db, `manual-policy-${a.id}`, {
          ...p,
          manualLiveEnabled: false,
          epoch: p.epoch + 1,
        });
      }
      await putDocument(s.db, 'emergencyStop', false);
      return ctx.reply('Аварийная остановка снята. Ручные и автоматические публикации выключены');
    }
    if (action === 'v112cancel') {
      await s.manual.cancel(id!, actor);
      return ctx.reply('Отменено. Отправки нет');
    }
    if (action === 'v112send' || action === 'v112save' || action === 'v112dry') {
      const c = await s.manual.readCard(id!, actor);
      if (action === 'v112send') {
        try {
          await s.manual.assertAllowed(c.accountId, actor, c.sessionId);
        } catch (e) {
          if (e instanceof Error && /Ручные публикации/.test(e.message))
            return ctx.reply('Ручные публикации выключены', {
              reply_markup: new InlineKeyboard()
                .text('Настроить ручные публикации', `v112policy:${c.accountId}`)
                .row()
                .text('Проверить DRY_RUN', `v112dry:${c.id}`)
                .row()
                .text('Отмена', `v112cancel:${c.id}`),
            });
          throw e;
        }
      }
      if (c.kind === 'POST') {
        assert(action === 'v112send', 'INVALID_ACTION', 'Выберите публикацию');
        const g = (await s.db.get('generated', c.entityId))!,
          source = await s.db.get('source', g.sourceId),
          style = await s.db.get('style', g.styleId);
        assert(source && style, 'NOT_FOUND', 'Исходник не найден');
        const validation = validateDetailed(g.text, source.text, style);
        assert(
          validation.status !== 'BLOCKED',
          'INVALID_CONTENT',
          validation.issues.map((i) => `${i.reason}: ${i.source} → ${i.generated}`).join('\n'),
        );
        // Revalidate old NEEDS_EDIT drafts locally; never call Sol to repair equivalents.
        await s.db.update('generated', g.id, {
          valid: true,
          validationErrors: validation.issues.map(
            (i) => `${i.level}: ${i.reason}: ${i.source} → ${i.generated}`,
          ),
        });
        const job = await s.scheduler.publishManual(c.id, actor, s.manual);
        if (job!.postStatus === 'PUBLISHED') {
          const post = (await s.db.list('post', { jobId: job!.id }))[0];
          return ctx.reply(`Пост уже опубликован: ${post?.url ?? ''}\nCTA: ${job!.commentStatus}`, {
            reply_markup:
              job!.ctaEnabled && !job!.ctaSubmitAt
                ? new InlineKeyboard().text('Дослать CTA', `v113cta:${job!.id}`)
                : undefined,
          });
        }
        if (job!.postStatus === 'UNCERTAIN')
          return ctx.reply(
            'Отправка могла выполниться. Пост требует проверки, повторной отправки нет',
          );
        return ctx.reply(
          `Публикую выбранный пост. Задача ${job!.id}. Остальная очередь не запущена`,
        );
      }
      const d = await s.engagement.draft(c.accountId, c.entityId);
      assert(
        d.hash === c.hash && (d.version ?? 1) === c.version,
        'STALE_CARD',
        'Карточка устарела. Откройте новую версию ответа',
      );
      const existing = (await s.engagement.jobs(c.accountId)).find(
        (j) => j.draftId === d.id && j.hash === d.hash && j.status !== 'FAILED',
      );
      if (existing && ['PUBLISHED', 'UNCERTAIN', 'SENDING'].includes(existing.status)) {
        const card = await replyCard(s, d, actor);
        return ctx.reply(card.text, { reply_markup: card.reply_markup });
      }
      const job = await s.engagement.approve(c.accountId, d.id, d.hash, actor);
      if (action === 'v112dry') {
        const task = await s.generation.enqueue(
          {
            kind: 'REPLY_DRY',
            replyJobId: job.id,
            accountId: c.accountId,
            actor,
            chatId: ctx.chat!.id,
          },
          String(ctx.update.update_id),
        );
        return ctx.reply(`Проверяю без отправки. Задача ${task.id}`);
      }
      if (action === 'v112save') return ctx.reply('Сохранено на потом: WAITING. Отправки нет');
      const candidate = await s.engagement.candidate(c.accountId, d.candidateId);
      const p = await s.engagementQueue.permissions.issueManual(
        c.id,
        actor,
        job,
        await s.engagement.draft(c.accountId, d.id),
        candidate,
      );
      const task = await s.generation.enqueue({
        kind: 'REPLY_SEND',
        replyJobId: job.id,
        permissionId: p.id,
        accountId: c.accountId,
        actor,
        chatId: ctx.chat!.id,
      });
      const message = await ctx.reply(
        `Отправляю ответ в ${(await s.db.get('account', c.accountId))!.name}\nВ очереди\nЗадача ${task.id}`,
        { reply_markup: new InlineKeyboard().text('Проверить статус', `v113status:${task.id}`) },
      );
      await putDocument(s.db, `publication-progress-${task.id}`, {
        phase: 'QUEUED',
        overdue: false,
        messageId: message.message_id,
      });
      return;
    }
    if (action === 'v112filter' || action === 'v112strict' || action === 'v112rejected') {
      const accountId = id!;
      if (action === 'v112strict') {
        assert(['STRICT', 'NORMAL', 'BROAD'].includes(extra!), 'VALUE', 'Неизвестная строгость');
        await s.engagement.configure(
          accountId,
          { strictness: extra as 'STRICT' | 'NORMAL' | 'BROAD' },
          actor,
        );
      }
      const settings = await s.engagement.settings(accountId);
      const rows = await s.engagement.refreshRelevance(accountId);
      if (action === 'v112rejected')
        return ctx.reply(
          rows
            .filter((r) => !r.accepted)
            .slice(-10)
            .map(
              (r) =>
                `${r.url}\nОценка: ${r.tradingRelevanceScore}\n${r.rejectionReasons.join('; ')}`,
            )
            .join('\n\n')
            .slice(0, 3800) || 'Отклонённых кандидатов нет',
        );
      return ctx.reply(
        `Тематическая фильтрация\nКатегории: ${settings.categories.join(', ')}\nКлючевые слова: ${settings.keywords.join(', ')}\nИсключения: ${settings.exclusions.join(', ') || 'нет'}\nСтрогость: ${settings.strictness}\nПодходят ${rows.filter((r) => r.accepted).length}/${rows.length}`,
        {
          reply_markup: new InlineKeyboard()
            .text('Строгая', `v112strict:${accountId}:STRICT`)
            .text('Обычная', `v112strict:${accountId}:NORMAL`)
            .text('Широкая', `v112strict:${accountId}:BROAD`)
            .row()
            .text('Категория', `v18cfg:${accountId}:cat`)
            .text('Ключевые слова', `v18cfg:${accountId}:key`)
            .row()
            .text('Исключения', `v18cfg:${accountId}:exclude`)
            .text('Отклонённые', `v112rejected:${accountId}`)
            .row()
            .text('Назад', `v18e:${accountId}`),
        },
      );
    }
  });
}

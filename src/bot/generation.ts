import { deliverAutopilotSummaries } from './autopilot.js';
import { InlineKeyboard } from './keyboard.js';
import { publicationProgress } from './publication-status.js';
import { postCard, replyCard } from './manual-card.js';
import { type Bot } from 'grammy';
import type { BotServices } from './bot.js';
import { getDocument, putDocument } from '../db/documents.js';
import { replyJobCard, defaultReplyUi, type ReplyUiConfig } from './reply-card.js';
import type { GenerationTask } from '../content/jobs.js';
export async function generationCard(s: BotServices, task: GenerationTask) {
  const kb = new InlineKeyboard().text('Проверить статус', `v113status:${task.id}`);
  if (
    task.kind === 'REPLY' &&
    task.results?.[0] &&
    ['COMPLETED', 'NEEDS_EDIT'].includes(task.status)
  ) {
    const card = await replyCard(
      s,
      await s.engagement.draft(task.accountId!, task.results[0]),
      task.actor,
    );
    card.reply_markup.row().text('Проверить статус', `v113status:${task.id}`);
    return {
      text: `Задача ${task.id}: ${task.status}\nГотовый сохранённый ответ. Этот просмотр не вызывает LLM\n${card.text}`,
      reply_markup: card.reply_markup,
    };
  }
  if (task.accountId)
    kb.row()
      .text('Черновики', `v18drafts:${task.accountId}`)
      .text('Новые публикации', `v18search:${task.accountId}`);
  return {
    text: `Задача ${task.id}: ${task.status}\n${['QUEUED', 'RUNNING'].includes(task.status) ? 'Команда принята. Результат придёт автоматически, отправки в Threads нет' : (task.error ?? 'Задача завершена; проверьте сохранённый результат')}\n${task.deliveryError ?? ''}`,
    reply_markup: kb,
  };
}
export const postKeyboard = (id: string) =>
  new InlineKeyboard()
    .text('Одобрить', `post_ok:${id}`)
    .text('Перегенерировать', `regen:${id}`)
    .row()
    .text('Редактировать', `edit:${id}`)
    .text('Отклонить', `post_reject:${id}`)
    .row()
    .text('👍 Хорошо', `feedback:GOOD:${id}`)
    .text('👎 Плохо', `feedback:BAD:${id}`);
export async function deliverGenerations(
  bot: Bot,
  s: BotServices,
  config: ReplyUiConfig = defaultReplyUi,
) {
  await publicationProgress(bot, s);
  await deliverAutopilotSummaries(bot, s);
  await s.generation.deliver(async (task) => {
    if (task.kind.startsWith('AUTOPILOT')) return; // Routine background work stays quiet; critical events use Notifications.
    if (task.kind === 'MODEL_AB' && task.experimentId) {
      const e = await s.quality.experiment(task.experimentId);
      await bot.api.sendMessage(
        task.chatId,
        `Sol vs Terra: ${e.status}\nИсходников: ${e.pairs.length}\n${e.error ?? 'Ответы подготовлены для слепой оценки'}\nОценки не разрешают публикацию`,
        {
          reply_markup: new InlineKeyboard()
            .text('Продолжить сравнение', `v115abopen:${e.id}`)
            .row()
            .text('Результаты', `v115abstats:${e.id}`),
        },
      );
      return;
    }
    const sendReplyResult = async (text: string, reply_markup: InlineKeyboard) => {
      const progress = await getDocument<{ messageId: number }>(
        s.db,
        `publication-progress-${task.id}`,
      );
      if (task.kind === 'REPLY_SEND' && progress?.messageId) {
        try {
          await bot.api.editMessageText(task.chatId, progress.messageId, text, { reply_markup });
          return;
        } catch (e) {
          if (e instanceof Error && e.message.includes('message is not modified')) return;
        }
      }
      await bot.api.sendMessage(task.chatId, text, { reply_markup });
    };
    if (task.kind === 'REPLY') {
      if (task.deliveryMessageIds?.reply) return;
      const card = await generationCard(s, task);
      const sent = await bot.api.sendMessage(task.chatId, card.text, {
        reply_markup: card.reply_markup,
      });
      await putDocument(s.db, `generation-task-${task.id}`, {
        ...task,
        deliveryMessageIds: { ...task.deliveryMessageIds, reply: sent.message_id },
      });
      return;
    }
    if (task.status !== 'COMPLETED' && task.kind === 'REPLY_SEND' && task.replyJobId) {
      const v = await s.engagement.jobView(task.replyJobId);
      const card = await replyCard(s, v.draft!, task.actor);
      await sendReplyResult(
        `${card.text}\n${task.error ?? ''}\nАвтоматического повтора нет`,
        card.reply_markup,
      );
      return;
    }
    if (task.status !== 'COMPLETED') {
      await bot.api.sendMessage(
        task.chatId,
        `Подготовка: ${task.status}\n${task.error}\nАвтоматического повтора нет.`,
        task.kind === 'POST' && task.preparation?.mappings?.[0]
          ? {
              reply_markup: new InlineKeyboard().text(
                'Повторить подготовку (LLM)',
                `source_retry:${task.preparation.mappings[0].accountId}`,
              ),
            }
          : {},
      );
      return;
    }
    if (task.kind === 'SEARCH') {
      const r = task.metrics!;
      await bot.api.sendMessage(
        task.chatId,
        `Просмотрено: ${r.viewed ?? r.found}\nСвежих: ${r.fresh ?? 0}\nПодходят по теме: ${r.thematic ?? r.eligible}\nСохранено новых: ${r.added}\n${r.added ? '' : 'Свежих подходящих новых публикаций нет. Возрастной диапазон не расширялся\n'}READ_ONLY, без ИИ`,
        {
          reply_markup: new InlineKeyboard()
            .text('Посмотреть кандидатов', `v18candidates:${task.accountId}`)
            .row()
            .text('Сгенерировать ответы', `v18batch:${task.accountId}`)
            .text('Черновики', `v18drafts:${task.accountId}`)
            .row()
            .text('История', `v18history:${task.accountId}`)
            .text('Причины остановки', `v18diag:${task.accountId}`),
        },
      );
      return;
    }
    if (task.replyJobId) {
      const view = await s.engagement.jobView(task.replyJobId);
      const card = view.draft
        ? await replyCard(s, view.draft, task.actor)
        : await replyJobCard(s.engagement, task.replyJobId, config);
      if (task.kind === 'REPLY_CHECK' && task.permissionId) {
        const p = await s.engagementQueue.permissions.get(task.permissionId);
        await bot.api.sendMessage(
          task.chatId,
          `${card.text}\n\nREAD_ONLY-проверка пройдена. Точный текст выше. Разрешение действует до ${new Date(p.expiresAt).toLocaleString('ru-RU', { timeZone: config.TIMEZONE })}.\nДля LIVE нужно адресное разрешение оператора, затем ваше подтверждение. Глобальные режимы не меняются`,
          {
            reply_markup: new InlineKeyboard()
              .text('Подтвердить публикацию', `v111confirm:${p.id}`)
              .row()
              .text('Отмена', `v111cancel:${p.id}`),
          },
        );
      } else
        await sendReplyResult(
          `${task.kind === 'REPLY_DRY' ? 'DRY_RUN пройден, ответ не отправлен\n' : ''}${card.text}`,
          card.reply_markup,
        );
      return;
    }
    if (task.kind === 'POST') {
      const flow = await getDocument<any>(s.db, `flow-${task.actor}`);
      if (
        flow &&
        (task.preparation?.sourceId === flow.sourceId ||
          task.preparation?.mappings?.every((m) => flow.assignments?.[m.accountId] === m.sourceId))
      )
        await putDocument(s.db, `flow-${task.actor}`, { ...flow, draftIds: task.results });
    }
    for (const id of task.results ?? []) {
      if (task.kind === 'POST') {
        const card = await postCard(s, id, task.actor);
        await bot.api.sendMessage(task.chatId, card.text, { reply_markup: card.reply_markup });
      } else {
        const d = await s.engagement.draft(task.accountId!, id);
        const card = await replyCard(s, d, task.actor);
        await bot.api.sendMessage(task.chatId, card.text, { reply_markup: card.reply_markup });
      }
    }
  });
}

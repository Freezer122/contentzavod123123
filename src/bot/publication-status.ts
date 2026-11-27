import { InlineKeyboard } from './keyboard.js';
import { type Bot } from 'grammy';
import type { BotServices } from './bot.js';
import { getDocument, putDocument } from '../db/documents.js';
import type { GenerationTask } from '../content/jobs.js';
export async function publicationProgress(bot: Bot, s: BotServices) {
  for (const task of (await s.generation.list()).filter(
    (t) => t.kind === 'REPLY_SEND' && ['QUEUED', 'RUNNING'].includes(t.status),
  )) {
    const view = await s.engagement.jobView(task.replyJobId!);
    const phase = view.job.phase ?? (task.status === 'QUEUED' ? 'QUEUED' : 'OPENING');
    const overdue = !!task.startedAt && Date.now() - Date.parse(task.startedAt) > 30000;
    const key = `publication-progress-${task.id}`,
      old = await getDocument<{ phase: string; overdue: boolean; messageId: number }>(s.db, key);
    if (old?.phase === phase && old.overdue === overdue) continue;
    const label =
      (
        {
          QUEUED: 'В очереди',
          OPENING: 'Открываю Threads',
          EDITOR_READY: 'Текст проверен',
          SENDING: 'Отправляю',
          VERIFYING: 'Проверяю результат',
          PUBLISHED: 'Опубликовано',
          UNCERTAIN: 'Требует проверки',
          FAILED: 'Ошибка',
        } as Record<string, string>
      )[phase] ?? phase;
    const text = `Отправляю ответ в ${view.account.name}\n${label}\n${overdue ? 'Отправка выполняется, проверяю результат\n' : ''}Задача ${task.id}`;
    const reply_markup = new InlineKeyboard().text('Проверить статус', `v113status:${task.id}`);
    let messageId = old?.messageId;
    if (messageId) {
      try {
        await bot.api.editMessageText(task.chatId, messageId, text, { reply_markup });
      } catch {
        messageId = undefined;
      }
    }
    if (!messageId)
      messageId = (await bot.api.sendMessage(task.chatId, text, { reply_markup })).message_id;
    await putDocument(s.db, key, {
      phase,
      overdue,
      messageId,
      updatedAt: new Date().toISOString(),
    });
  }
}

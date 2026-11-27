import { InlineKeyboard } from './keyboard.js';

import type { EngagementManager } from '../engagement/service.js';
import type { Config } from '../core/config.js';
export type ReplyUiConfig = Pick<
  Config,
  'TIMEZONE' | 'BROWSER_EXECUTION_MODE' | 'ENGAGEMENT_EXECUTION_MODE'
>;
export const defaultReplyUi: ReplyUiConfig = {
  TIMEZONE: 'Europe/Moscow',
  BROWSER_EXECUTION_MODE: 'DRY_RUN',
  ENGAGEMENT_EXECUTION_MODE: 'DRY_RUN',
};
export async function replyJobCard(
  manager: EngagementManager,
  id: string,
  config: ReplyUiConfig = defaultReplyUi,
) {
  const v = await manager.jobView(id),
    { job, draft, candidate, account } = v;
  const status =
    draft?.status === 'REJECTED'
      ? 'REJECTED'
      : v.executionStatus === 'WAITING'
        ? draft?.status === 'APPROVED'
          ? 'WAITING'
          : 'DRAFT'
        : v.executionStatus;
  const paused = (await manager.db.get('setting', 'factoryPaused'))?.value === 'true';
  const reason =
    status === 'UNCERTAIN'
      ? 'результат требует read-only сверки; повтор запрещён'
      : status === 'PUBLISHING'
        ? 'отправка выполняется'
        : status === 'PUBLISHED'
          ? 'permalink подтверждён'
          : status === 'FAILED'
            ? (job.error ?? 'ошибка выполнения')
            : `автоматическая отправка выключена; ${config.ENGAGEMENT_EXECUTION_MODE === 'DRY_RUN' || config.BROWSER_EXECUTION_MODE === 'DRY_RUN' ? 'реальные отправки отключены (DRY_RUN)' : 'нужно одноразовое разрешение'}${paused ? '; завод PAUSED' : ''}`;
  const text = `${draft?.status === 'APPROVED' && status === 'WAITING' ? 'Ответ одобрен, но ещё не опубликован' : 'Ответ: ' + status}\nАккаунт: ${account.name}\nИсходная публикация: ${candidate.url}\n\n${draft?.text ?? 'Лайк'}\n\nОдобрение: ${v.approvalStatus}\nИсполнение: ${status}\nДата одобрения: ${draft?.approvedAt ? new Date(draft.approvedAt).toLocaleString('ru-RU', { timeZone: config.TIMEZONE }) : 'нет'}\nРежим публикаций: ${config.BROWSER_EXECUTION_MODE}\nРежим взаимодействий: ${config.ENGAGEMENT_EXECUTION_MODE}\nПричина: ${reason}${job.url ? '\nРезультат: ' + job.url : ''}`;
  const kb = new InlineKeyboard();
  if (status === 'PUBLISHED' && job.url) kb.url('Результат в Threads', job.url).row();
  else if (status === 'UNCERTAIN') kb.text('Проверить результат', `v111verify:${job.id}`).row();
  else if (status === 'WAITING' && draft?.status === 'APPROVED')
    kb.text('Опубликовать сейчас', `v111publish:${job.id}`)
      .row()
      .text('Изменить ответ', `v18edit:${draft.id}`)
      .text('Проверить DRY_RUN', `v111dry:${job.id}`)
      .row()
      .text('Отклонить', `v18reject:${draft.id}`)
      .row();
  else if (status === 'FAILED' && draft)
    kb.text('Изменить ответ', `v18edit:${draft.id}`)
      .text('Отклонить', `v18reject:${draft.id}`)
      .row();
  kb.text('Назад', `v18e:${account.id}`);
  return { text, reply_markup: kb };
}

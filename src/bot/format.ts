import type { Analytics } from '../analytics/service.js';
import type { PublishJob } from '../core/domain.js';
import { publicationTiming } from '../scheduler/timing.js';
export function formatPublishTiming(job: PublishJob, tz: string) {
  const t = publicationTiming(job);
  if (!job.postSubmitAt)
    return job.status === 'COMPLETED'
      ? 'Интервал пост → CTA: нет исторических timestamps'
      : 'Интервал пост → CTA: пост ещё не отправлен';
  const date = (d: Date | null | undefined) => (d ? dateFmt(d, tz) : '—');
  return `Пост submit: ${date(job.postSubmitAt)}\nПост подтверждён: ${date(job.postConfirmedAt)}\nCTA назначен: ${date(job.ctaScheduledAt)}\nCTA submit: ${date(job.ctaSubmitAt)}\nCTA подтверждён: ${date(job.ctaConfirmedAt)}\nИнтервал пост → CTA: ${fmt(t.actual_interval_seconds, 2)} с; опоздание: ${fmt(t.cta_lateness_seconds, 2)} с`;
}
export const fmt = (value: number | null | undefined, digits = 0) =>
  value == null ? 'нет данных' : value.toLocaleString('ru-RU', { maximumFractionDigits: digits });
export const dateFmt = (date: Date, tz: string) => date.toLocaleString('ru-RU', { timeZone: tz });
export const statusRu: Record<string, string> = {
  PROFILE_BUSY: 'Профиль занят',
  CHALLENGE: 'Нужна ручная проверка',
  UI_CHANGED: 'Изменился интерфейс',
  COMMENT_FAILED: 'Ошибка комментария',
  ACTIVE: 'Активен',
  PAUSED: 'Приостановлено',
  AUTH_REQUIRED: 'Нужна авторизация',
  ERROR: 'Ошибка',
  RESTRICTED: 'Ограничение',
  QUEUED: 'В очереди',
  RUNNING: 'Выполняется',
  COMPLETED: 'Завершено',
  FAILED: 'Ошибка',
  CANCELLED: 'Отменено',
  NEEDS_REVIEW: 'Требуется проверка',
  PENDING: 'Ожидание',
  SENDING: 'Отправляется',
  PUBLISHED: 'Опубликовано',
  UNCERTAIN: 'Результат неизвестен',
  DISABLED: 'Отключено',
};
export function formatReport(
  r: Awaited<ReturnType<Analytics['report']>>,
  label: string,
  demo: boolean,
) {
  return `${demo ? '🧪 ДЕМОНСТРАЦИЯ — ИСКУССТВЕННЫЕ ДАННЫЕ\n\n' : ''}CONTENT FACTORY\nПериод: ${label}\nРежим: ${r.mode === 'VIEWS_IN_PERIOD' ? 'изменение просмотров за период (по снимкам)' : 'все просмотры постов, опубликованных за период'}\n\nАккаунты: ${r.accountCount}\nОпубликовано: ${r.posts}\nПросмотры: ${fmt(r.views)}\nПокрытие: ${r.knownPosts} из ${r.totalCompared} постов\nСредние: ${fmt(r.average, 1)}\nМедиана: ${fmt(r.median, 1)}\nЛучший аккаунт по средним: ${r.bestAccount?.name ?? 'нет данных'} (${fmt(r.bestAccount?.average, 1)})\nСлабейший по средним: ${r.worstAccount?.name ?? 'нет данных'} (${fmt(r.worstAccount?.average, 1)})\nМаксимум: ${fmt(r.max)}\nМинимум: ${fmt(r.min)}\n\nПодписчики Threads: ${fmt(r.followers)}\nПрирост Threads: ${fmt(r.followerGrowth)}\nПереходы: ${fmt(r.clicks)}\nУникальные посетители: ${fmt(r.uniqueClicks)}\nПодтверждённые вступления Telegram (валовые): ${fmt(r.joins)}\nБез источника: ${fmt(r.unknownJoins)}\nНаблюдаемые выходы: ${fmt(r.observedLeaves)}\nНаблюдаемый чистый прирост канала: ${fmt(r.observedNet)}\n\nВступления в базе CR просмотров: ${fmt(r.viewAttributedJoins)}\nCR просмотров: ${fmt(r.crView, 3)}%\nCR кликов: ${fmt(r.crClick, 3)}%\nПодписки / 1000 просмотров: ${fmt(r.joinsPer1000, 3)}\nER: ${fmt(r.engagementRate, 3)}%\nУспешные публикации: ${fmt(r.successRate, 1)}%\nОшибки: ${r.errors}\n\nНеизвестные метрики исключены; суммы при неполном покрытии частичные. Прирост просмотров относится к интервалам между фактическими снимками.`;
}

import { InlineKeyboard } from './keyboard.js';
import { replyCard } from './manual-card.js';
import { generationCard } from './generation.js';
import { InputFile, type Bot, type Context } from 'grammy';
import { replyJobCard } from './reply-card.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { BotServices } from './bot.js';
import type { Config } from '../core/config.js';
import { getDocument, putDocument, hashDocument } from '../db/documents.js';
import { assert } from '../core/errors.js';
import type { EngagementSettings } from '../engagement/service.js';
interface Flow {
  accountId: string;
  step: string;
  field?: keyof EngagementSettings;
  index?: number;
  draftId?: string;
  candidateId?: string;
  mediaPath?: string;
  purpose?: 'POST' | 'BIO';
}
export function installV18(bot: Bot, config: Config, s: BotServices) {
  const actor = (ctx: Context) => String(ctx.from!.id),
    flowKey = (ctx: Context) => `v18-flow-${actor(ctx)}`;
  const set = (ctx: Context, f: Flow) => putDocument(s.db, flowKey(ctx), f),
    clear = (ctx: Context) => s.db.remove('setting', flowKey(ctx));
  const menu = (id: string) =>
    new InlineKeyboard()
      .text('Профиль', `v18p:${id}`)
      .text('Взаимодействия', `v18e:${id}`)
      .row()
      .text('Публикации', `v112policy:${id}`)
      .row()
      .text('Аккаунт', `account:${id}`)
      .text('Отмена', 'v18cancel');
  const cancel = () => new InlineKeyboard().text('Отмена', 'v18cancel');
  async function profile(ctx: Context, id: string, refresh = false) {
    const p = await s.profileManager.snapshot(id, refresh),
      normal = await getDocument<{ enabled: boolean }>(s.db, `normalizer-${id}`);
    return ctx.reply(
      `Био:\n${p.bio || 'не заполнено'}\n\nСсылки (${p.links.length}/${p.linkCapacity}):\n${p.links.map((v, i) => `${i + 1}. ${v}`).join('\n') || 'нет'}\n\nНормализация новых текстов: ${normal?.enabled ? 'включена' : 'выключена'}`,
      {
        reply_markup: new InlineKeyboard()
          .text('Обновить', `v18pr:${id}`)
          .row()
          .text('Изменить био', `v18bio:${id}`)
          .text('Сгенерировать био', `v18genbio:${id}`)
          .row()
          .text('Изменить ссылку', `v18le:${id}`)
          .text('Добавить ссылку', `v18la:${id}`)
          .row()
          .text('Удалить ссылку', `v18ld:${id}`)
          .row()
          .text(
            normal?.enabled ? 'Выключить нормализацию' : 'Включить нормализацию',
            `v18norm:${id}`,
          )
          .row()
          .text('Расходы ИИ', `v18cost:${id}`)
          .row()
          .text('Бюджет постов', `v18budget:${id}:POST`)
          .text('Бюджет био', `v18budget:${id}:BIO`)
          .row()
          .text('Аккаунт', `account:${id}`),
      },
    );
  }
  async function profilePreview(
    ctx: Context,
    d: Awaited<ReturnType<BotServices['profileManager']['draft']>>,
  ) {
    await clear(ctx);
    return ctx.reply(
      `Предпросмотр профиля\n\nБио:\n${d.after.bio || 'пусто'}\n\nСсылки:\n${d.after.links.join('\n') || 'нет'}\n\n${config.PROFILE_CHANGES_ALLOWED === '1' ? 'Сохранение требует подтверждения ниже.' : 'Проверка DRY_RUN: сохранение в Threads выключено.'}`,
      {
        reply_markup: new InlineKeyboard()
          .text(
            config.PROFILE_CHANGES_ALLOWED === '1'
              ? 'Подтвердить и применить'
              : 'Проверить без сохранения',
            `v18apply:${d.id}:${d.hash.slice(0, 12)}`,
          )
          .row()
          .text('Отмена', 'v18cancel'),
      },
    );
  }
  const fields: Record<string, { key: keyof EngagementSettings; label: string }> = {
    exclude: { key: 'exclusions', label: 'Исключения через запятую' },
    cat: { key: 'categories', label: 'Категории через запятую' },
    key: { key: 'keywords', label: 'Ключевые слова через запятую' },
    likecap: { key: 'dailyLikes', label: 'Лайков в сутки' },
    daily: { key: 'dailyReplies', label: 'Ответов в сутки' },
    min: { key: 'minIntervalMinutes', label: 'Минимальный интервал, минут' },
    max: { key: 'maxIntervalMinutes', label: 'Максимальный интервал, минут' },
    cap: { key: 'maxCandidates', label: 'Максимум кандидатов' },
    sessions: { key: 'sessionsPerDay', label: 'Поисковых сессий в сутки' },
    dayusd: { key: 'dailyLlmUsd', label: 'Дневной бюджет ИИ для ответов, USD' },
    monthusd: { key: 'monthlyLlmUsd', label: 'Месячный бюджет ИИ для ответов, USD' },
  };
  async function engagement(ctx: Context, id: string) {
    const c = await s.engagement.settings(id),
      kb = new InlineKeyboard()
        .text(c.enabled ? 'Отключить' : 'Включить', `v18enable:${id}`)
        .text('Лайки: ' + (c.likes ? 'вкл' : 'выкл'), `v18likes:${id}`)
        .row();
    for (const [key, value] of Object.entries(fields))
      kb.text(value.label, `v18cfg:${id}:${key}`).row();
    kb.text('Поиск публикаций', `v113discovery:${id}`)
      .text('Свежесть публикаций', `v113age:${id}`)
      .row();
    kb.text('Тематическая фильтрация', `v112filter:${id}`).row();
    kb.text('Поиск без публикации', `v18search:${id}`)
      .text('Кандидаты', `v18candidates:${id}`)
      .row()
      .text('Черновики ответов', `v18drafts:${id}`)
      .text('История и статистика', `v18history:${id}`)
      .row()
      .text('Сгенерировать и отправить ответы', `ap:sendreplies:${id}`)
      .row()
      .text('Только сгенерировать черновики', `v18batch:${id}`)
      .text('Причины остановки', `v18diag:${id}`)
      .row()
      .text('Одобренные ответы', `v111approved:${id}`)
      .text('Стиль ответов', `v111style:${id}`)
      .row()
      .text('Расходы ИИ', `v18cost:${id}`)
      .text('Аккаунт', `account:${id}`);
    return ctx.reply(
      `Тематические взаимодействия: ${c.enabled ? 'включены' : 'выключены'}\nКатегории: ${c.categories.join(', ')}\nКлючевые слова: ${c.keywords.join(', ')}\nОтветов/сутки: ${c.dailyReplies}\nИнтервал: ${c.minIntervalMinutes}–${c.maxIntervalMinutes} мин\nКандидатов: ${c.maxCandidates}; сессий/сутки: ${c.sessionsPerDay}\nБюджет ИИ ответов: $${c.dailyLlmUsd}/сутки, $${c.monthlyLlmUsd}/месяц\n\n${await diagnosticText(id)}`,
      { reply_markup: kb },
    );
  }
  async function diagnosticText(id: string) {
    const d = await s.engagement.diagnostics(id);
    const fmt = (v?: string | null) =>
      v ? new Date(v).toLocaleString('ru-RU', { timeZone: config.TIMEZONE }) : 'нет';
    const reasons = [
      d.generationError ? 'Последняя ошибка генерации: ' + d.generationError : '',
      d.factoryPaused ? 'Автопоиск остановлен: завод на паузе' : '',
      d.accountStatus !== 'ACTIVE' ? `Автопоиск остановлен: аккаунт ${d.accountStatus}` : '',
      !d.config.enabled ? 'Автопоиск выключен' : '',
      config.ENGAGEMENT_EXECUTION_MODE !== 'LIVE' || config.BROWSER_EXECUTION_MODE !== 'LIVE'
        ? 'Ответы и лайки не отправляются: режим DRY_RUN'
        : '',
      !d.llm.available ? 'Генерация недоступна: ' + d.llm.reason : '',
      d.awaitingApproval ? `Ожидают одобрения: ${d.awaitingApproval}` : '',
      d.approvedQueued ? `Одобрено, ожидают исполнения: ${d.approvedQueued}` : '',
    ].filter(Boolean);
    return `Завод: ${d.factoryPaused ? 'PAUSED' : 'ACTIVE'}\nАккаунт: ${d.accountStatus}\nПоиск: ${d.config.enabled ? 'включён' : 'выключен'}\nГенерация: ${d.llm.available ? 'доступна' : 'недоступна'}\nОтправка: ${config.BROWSER_EXECUTION_MODE === 'LIVE' ? config.ENGAGEMENT_EXECUTION_MODE : 'DRY_RUN'}\nLLM: ${d.llm.model}; ${d.llm.reason}\nПланировщик: ${d.heartbeat ? 'запущен; ' + d.heartbeat.reason : 'ожидает первого запуска'}\nПоследний запуск очереди: ${fmt(d.heartbeat?.lastTickAt)}\nПоследний поиск: ${fmt(d.schedule.lastSearchAt)}\nСледующий поиск: ${fmt(d.schedule.nextSearchAt)} (${config.TIMEZONE})\nКандидатов в базе: ${d.candidates}\nОжидает одобрения: ${d.awaitingApproval}\nОдобрено текстов: ${d.approvedCount}\nОжидает отправки: ${d.approvedQueued}\nОпубликовано: ${d.publishedCount}\nUNCERTAIN: ${d.uncertainCount}\nРежим публикаций: ${config.BROWSER_EXECUTION_MODE}\nРежим взаимодействий: ${config.ENGAGEMENT_EXECUTION_MODE}\nОтветов сегодня: ${d.repliesToday}/${d.config.dailyReplies}\nЛайков сегодня: ${d.likesToday}/${d.config.dailyLikes}\nДневные лимиты: UTC\nПоследняя ошибка: ${d.schedule.lastError ?? 'нет'}\n\n${reasons.join('\n') || 'Ожидание запланированного времени и одобрений'}\nРучной READ_ONLY-поиск доступен без снятия паузы; он не генерирует и не отправляет ответы`;
  }
  async function replyPreview(
    ctx: Context,
    d: Awaited<ReturnType<BotServices['engagement']['draft']>>,
  ) {
    await clear(ctx);
    const card = await replyCard(s, d, actor(ctx));
    return ctx.reply(card.text, { reply_markup: card.reply_markup });
  }
  async function findDraft(id: string) {
    for (const a of await s.db.list('account')) {
      const found = (await s.engagement.drafts(a.id)).find((d) => d.id === id);
      if (found) return found;
    }
    throw new Error('DRAFT_NOT_FOUND');
  }
  bot.callbackQuery(/^v18/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const parts = ctx.callbackQuery.data.split(':'),
      action = parts[0]!,
      id = parts[1]!;
    if (action === 'v18cancel') {
      await clear(ctx);
      return ctx.reply('Действие отменено. Изменения в Threads не отправлены.');
    }
    if (action === 'v18p' || action === 'v18pr') return profile(ctx, id, action === 'v18pr');
    if (action === 'v18norm') {
      const current = await getDocument<{ enabled: boolean }>(s.db, `normalizer-${id}`);
      await s.profileManager.normalizer(id, !current?.enabled, actor(ctx));
      return profile(ctx, id);
    }
    if (['v18bio', 'v18genbio', 'v18le', 'v18la', 'v18ld'].includes(action)) {
      await s.profileManager.snapshot(id);
      await set(ctx, { accountId: id, step: action });
      return ctx.reply(
        action === 'v18bio'
          ? 'Отправьте точное био до 150 символов. ИИ не используется.'
          : action === 'v18genbio'
            ? 'Опишите только реальные факты для био. Один запрос к модели.'
            : action === 'v18la'
              ? 'Отправьте новую HTTPS-ссылку.'
              : action === 'v18ld'
                ? 'Отправьте номер ссылки для удаления.'
                : 'Отправьте номер ссылки, затем новую HTTPS-ссылку.',
        { reply_markup: cancel() },
      );
    }
    if (action === 'v18apply') {
      const d = await s.profileManager.get(id);
      assert(d.hash.startsWith(parts[2] ?? 'INVALID'), 'STALE_APPROVAL', 'Предпросмотр устарел');
      await s.profileManager.approve(id, d.hash, actor(ctx));
      const result = await s.profileManager.apply(
        id,
        d.hash,
        actor(ctx),
        config.PROFILE_CHANGES_ALLOWED !== '1',
      );
      return ctx.reply(
        result.dryRun
          ? 'DRY_RUN завершён: поля проверены, изменения не сохранены.'
          : 'Профиль сохранён и проверен.',
        { reply_markup: menu(d.accountId) },
      );
    }
    if (action === 'v18e') return engagement(ctx, id);
    if (action === 'v18diag')
      return ctx.reply(await diagnosticText(id), { reply_markup: menu(id) });
    if (action === 'v18batch') {
      const {
        counts: c,
        tasks,
        reasons,
      } = await s.generation.replySelection(id, actor(ctx), ctx.chat!.id);
      const kb = new InlineKeyboard();
      for (const task of tasks)
        kb.text('Статус ' + task.id.slice(0, 8), `v113status:${task.id}`).row();
      return ctx.reply(
        `Найдено кандидатов: ${c.found}\nПодходят для генерации: ${c.eligible}\nУже имеют черновик: ${c.alreadyDrafted}\nУже обрабатываются: ${c.processing}\nОтклонены по тематике/контексту: ${c.thematic}\nОтклонены по свежести/неизвестной дате: ${c.freshness}\nОбработаны или пропущены: ${c.skipped}\nЗаблокированы лимитами/предыдущей задачей: ${c.blocked}\nНовых задач создано: ${c.created}\n${c.remaining ? 'Осталось новых кандидатов: ' + c.remaining + '\n' : ''}${tasks.length ? 'Подготовка идёт отдельно от отправки; результат придёт автоматически' : reasons.join('; ')}\nОтветы и лайки в Threads не отправляются`,
        {
          reply_markup: kb
            .text('Существующие черновики', `v18drafts:${id}`)
            .row()
            .text('Найти новые публикации', `v18search:${id}`)
            .row()
            .text('Назад', `v18e:${id}`),
        },
      );
    }
    if (action === 'v18enable' || action === 'v18likes') {
      const c = await s.engagement.settings(id);
      await s.engagement.configure(
        id,
        action === 'v18enable' ? { enabled: !c.enabled } : { likes: !c.likes },
        actor(ctx),
      );
      return engagement(ctx, id);
    }
    if (action === 'v18cfg') {
      const field = fields[parts[2]!];
      assert(field, 'INVALID_FIELD', 'Неизвестная настройка');
      await set(ctx, { accountId: id, step: 'config', field: field.key });
      return ctx.reply(field.label + ': отправьте значение.', { reply_markup: cancel() });
    }
    if (action === 'v18search') {
      const task = await s.generation.enqueue(
        { actor: actor(ctx), chatId: ctx.chat!.id, kind: 'SEARCH', accountId: id },
        String(ctx.update.update_id),
      );
      return ctx.reply(
        `READ_ONLY-поиск запущен, задача ${task.id}. Пауза завода сохраняется. Результат придёт отдельно, ответы и лайки не отправляются.`,
        { reply_markup: menu(id) },
      );
    }
    if (action === 'v18candidates') {
      const rows = (await s.engagement.eligibleCandidates(id))
          .filter((c) => c.status === 'NEW' || c.status === 'DRAFTED')
          .slice(0, 20),
        kb = new InlineKeyboard();
      for (const c of rows)
        kb.text(c.author + ': ' + c.text.slice(0, 28), `v18candidate:${c.id}`).row();
      return ctx.reply(rows.length ? 'Выберите публикацию:' : 'Новых кандидатов пока нет.', {
        reply_markup: kb.text('Назад', `v18e:${id}`),
      });
    }
    if (action === 'v18candidate') {
      let candidate;
      for (const a of await s.db.list('account')) {
        candidate = (await s.engagement.candidates(a.id)).find((c) => c.id === id);
        if (candidate) break;
      }
      assert(candidate, 'NOT_FOUND', 'Кандидат не найден');
      const c = candidate;
      await set(ctx, { accountId: c.accountId, step: 'candidate', candidateId: c.id });
      const assessment = s.engagement.assess(c, await s.engagement.settings(c.accountId));
      return ctx.reply(
        `Автор: @${c.author}\n${c.url}\nДата: ${c.publishedAt ? new Date(c.publishedAt).toLocaleString('ru-RU', { timeZone: config.TIMEZONE }) : 'не подтверждена'}\nВозраст: ${assessment.ageHours === null ? 'неизвестен' : assessment.ageHours.toFixed(1) + ' ч'}\nКатегория: ${c.category}\nРелевантность: ${assessment.tradingRelevanceScore}\n${assessment.acceptedReasons.join('; ')}\n${assessment.rejectionReasons.join('; ')}\n\n${c.text.slice(0, 1800)}`,
        {
          reply_markup: new InlineKeyboard()
            .text('Сгенерировать ответ', `v18generate:${c.id}`)
            .text('Написать ответ', `v18manual:${c.id}`)
            .row()
            .text('Пропустить', `v113skip:${c.accountId}:${c.id}`)
            .row()
            .text('Назад', `v18e:${c.accountId}`),
        },
      );
    }
    if (action === 'v18generate' || action === 'v18manual') {
      if (!id)
        return ctx.reply('Старая кнопка не привязана к публикации. Откройте карточку заново', {
          reply_markup: new InlineKeyboard().text('Аккаунты', 'accounts'),
        });
      let candidate;
      for (const a of await s.db.list('account')) {
        candidate = (await s.engagement.candidates(a.id)).find((c) => c.id === id);
        if (candidate) break;
      }
      assert(candidate, 'NOT_FOUND', 'Публикация не найдена');
      const f: Flow = {
        accountId: candidate.accountId,
        candidateId: candidate.id,
        step: 'candidate',
      };
      if (action === 'v18generate') {
        const task = await s.generation.enqueue({
          actor: actor(ctx),
          chatId: ctx.chat!.id,
          kind: 'REPLY',
          accountId: f.accountId,
          candidateId: f.candidateId,
        });
        const card = await generationCard(s, task);
        return ctx.reply(card.text, { reply_markup: card.reply_markup });
      }
      await set(ctx, { ...f, step: 'reply' });
      return ctx.reply('Напишите ответ. Нормализация выполняется без ИИ.', {
        reply_markup: cancel(),
      });
    }
    if (action === 'v18drafts') {
      const rows = await s.engagement.drafts(id),
        kb = new InlineKeyboard();
      for (const d of rows.filter((d) => d.status === 'DRAFT').slice(0, 20))
        kb.text(d.text.slice(0, 40), `v18draft:${d.id}`).row();
      return ctx.reply('Черновики ответов: ' + rows.filter((d) => d.status === 'DRAFT').length, {
        reply_markup: kb.text('Назад', `v18e:${id}`),
      });
    }
    if (action === 'v18draft') return replyPreview(ctx, await findDraft(id));
    if (action === 'v18edit') {
      const d = await findDraft(id);
      await set(ctx, {
        accountId: d.accountId,
        step: 'reply',
        candidateId: d.candidateId,
        draftId: id,
      });
      return ctx.reply('Отправьте новый текст ответа.', { reply_markup: cancel() });
    }
    if (action === 'v18reject') {
      const d = await findDraft(id);
      await s.engagement.reject(d.accountId, id, actor(ctx));
      return ctx.reply('Черновик отклонён.', { reply_markup: menu(d.accountId) });
    }
    if (action === 'v18ok') {
      const d = await findDraft(id);
      assert(d.hash.startsWith(parts[2] ?? 'INVALID'), 'STALE_APPROVAL', 'Предпросмотр устарел');
      const j = await s.engagement.approve(d.accountId, id, d.hash, actor(ctx));
      const card = await replyCard(s, await s.engagement.draft(d.accountId, d.id), actor(ctx));
      return ctx.reply(card.text, { reply_markup: card.reply_markup });
    }
    if (action === 'v18dry') {
      const v = await s.engagement.jobView(id);
      const task = await s.generation.enqueue(
        {
          kind: 'REPLY_DRY',
          replyJobId: id,
          accountId: v.job.accountId,
          actor: actor(ctx),
          chatId: ctx.chat!.id,
        },
        String(ctx.update.update_id),
      );
      return ctx.reply(`Проверяю DRY_RUN без отправки. Задача ${task.id}`);
    }
    if (action === 'v18history') {
      const jobs = await s.engagement.jobs(id),
        counts: Record<string, number> = {};
      for (const j of jobs) counts[j.status] = (counts[j.status] ?? 0) + 1;
      const historyKb = new InlineKeyboard();
      for (const j of jobs.slice(-15))
        historyKb
          .text(`${j.executionStatus ?? j.status} · ${j.id.slice(0, 8)}`, `v111job:${j.id}`)
          .row();
      return ctx.reply(
        `Задач: ${jobs.length}\nОпубликовано: ${counts.PUBLISHED ?? 0}\nПроверено без отправки: ${counts.PREVIEWED ?? 0}\nНеопределённый результат: ${counts.UNCERTAIN ?? 0}\nОшибок: ${counts.FAILED ?? 0}\n\n${jobs
          .slice(-10)
          .map(
            (j) =>
              `${j.kind === 'REPLY' ? 'Ответ' : 'Лайк'} · ${j.status}${j.url ? '\n' + j.url : ''}`,
          )
          .join('\n')}`,
        { reply_markup: historyKb.text('Назад', `v18e:${id}`) },
      );
    }
    if (action === 'v18budget') {
      const purpose = parts[2];
      assert(purpose === 'POST' || purpose === 'BIO', 'INVALID_PURPOSE', 'Неизвестное назначение');
      await set(ctx, { accountId: id, step: 'budget', purpose });
      return ctx.reply('Отправьте дневной и месячный лимиты в USD через пробел, например: 1 10', {
        reply_markup: cancel(),
      });
    }
    if (action === 'v18like' || action === 'v18likeok') {
      const f = await getDocument<Flow>(s.db, flowKey(ctx));
      assert(f?.candidateId, 'NOT_FOUND', 'Выберите публикацию заново');
      const c = await s.engagement.candidate(f.accountId, f.candidateId),
        hash = hashDocument({ kind: 'LIKE', url: c.url });
      if (action === 'v18like')
        return ctx.reply('Подтвердить лайк этой публикации?\n' + c.url, {
          reply_markup: new InlineKeyboard()
            .text('Одобрить лайк', `v18likeok:${hash.slice(0, 12)}`)
            .text('Отмена', 'v18cancel'),
        });
      assert(hash.startsWith(id), 'STALE_APPROVAL', 'Предпросмотр устарел');
      const j = await s.engagement.approveLike(f.accountId, c.id, hash, actor(ctx));
      return ctx.reply('Лайк одобрен. Реальные действия зависят от режима и состояния фабрики.', {
        reply_markup: new InlineKeyboard()
          .text('Проверить DRY_RUN', `v18dry:${j.id}`)
          .text('Назад', `v18e:${f.accountId}`),
      });
    }
    if (action === 'v18cost') {
      const requests = (await s.db.list('aiRequest')).filter((r) =>
          (r.accountIds?.length ? r.accountIds : [r.accountId]).includes(id),
        ),
        day = new Date().toISOString().slice(0, 10),
        month = day.slice(0, 7);
      const cost = (prefix: string) =>
        requests
          .filter((r) => r.createdAt.toISOString().startsWith(prefix))
          .reduce(
            (sum, r) =>
              sum +
              (r.status === 'UNKNOWN' || r.status === 'RESERVED' ? r.reservedUsd : r.costUsd) /
                Math.max(1, r.accountIds?.length ?? 1),
            0,
          );
      return ctx.reply(
        `Расходы ИИ аккаунта\nСегодня: $${cost(day).toFixed(4)}; месяц: $${cost(month).toFixed(4)}\n` +
          (['POST', 'BIO', 'REPLY'] as const)
            .map(
              (p, i) =>
                `${['Посты', 'Био', 'Ответы'][i]}: ${requests.filter((r) => (r.purpose ?? 'POST') === p).length} запросов; сегодня $${requests
                  .filter(
                    (r) => (r.purpose ?? 'POST') === p && r.createdAt.toISOString().startsWith(day),
                  )
                  .reduce(
                    (sum, r) =>
                      sum +
                      (['UNKNOWN', 'RESERVED'].includes(r.status) ? r.reservedUsd : r.costUsd) /
                        Math.max(1, r.accountIds?.length ?? 1),
                    0,
                  )
                  .toFixed(4)}`,
            )
            .join('\n') +
          '\n\n' +
          requests
            .slice(-5)
            .map(
              (r) =>
                `${r.model} · ${r.inputTokens}/${r.outputTokens} токенов · $${r.costUsd.toFixed(5)}`,
            )
            .join('\n'),
        { reply_markup: menu(id) },
      );
    }
    if (action === 'v18m') {
      const cta = await s.ctas.ensure(id);
      await set(ctx, { accountId: id, step: 'media' });
      return ctx.reply(`Вложение CTA: ${cta.mediaPath ? 'есть' : 'нет'}. Пришлите фото до 10 МБ.`, {
        reply_markup: new InlineKeyboard()
          .text('Удалить вложение', `v18mremove:${id}`)
          .text('Отмена', 'v18cancel'),
      });
    }
    if (action === 'v18mremove') {
      await set(ctx, { accountId: id, step: 'media-remove' });
      return ctx.reply('Удалить привязку изображения из CTA? Сам файл сохранится.', {
        reply_markup: new InlineKeyboard()
          .text('Подтвердить удаление', 'v18msave')
          .text('Отмена', 'v18cancel'),
      });
    }
    if (action === 'v18msave') {
      const f = await getDocument<Flow>(s.db, flowKey(ctx));
      assert(
        f && ['media-preview', 'media-remove'].includes(f.step),
        'NOT_FOUND',
        'Нет предпросмотра',
      );
      await s.ctas.attachment(
        f.accountId,
        f.step === 'media-remove' ? null : f.mediaPath!,
        actor(ctx),
        config.MEDIA_DIR,
      );
      await clear(ctx);
      return ctx.reply('Вложение CTA сохранено для следующих задач.', {
        reply_markup: menu(f.accountId),
      });
    }
  });
  bot.on('message:photo', async (ctx, next) => {
    const f = await getDocument<Flow>(s.db, flowKey(ctx));
    if (f?.step !== 'media') return next();
    const photo = ctx.message.photo.at(-1)!;
    assert((photo.file_size ?? 0) <= 10 * 1024 * 1024, 'INVALID_MEDIA', 'Фото больше 10 МБ');
    const file = await ctx.api.getFile(photo.file_id);
    assert(file.file_path, 'INVALID_MEDIA', 'Telegram не вернул файл');
    const response = await fetch(
      `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path.split('/').map(encodeURIComponent).join('/')}`,
      { signal: AbortSignal.timeout(30000) },
    );
    assert(response.ok, 'MEDIA_DOWNLOAD', 'Не удалось скачать фото');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert(bytes.length <= 10 * 1024 * 1024, 'INVALID_MEDIA', 'Фото больше 10 МБ');
    const root = config.MEDIA_DIR;
    await mkdir(root, { recursive: true, mode: 0o700 });
    const path = join(root, 'cta-' + createHash('sha256').update(bytes).digest('hex') + '.jpg');
    await writeFile(path, bytes, { mode: 0o600, flag: 'wx' }).catch((e) => {
      if (e.code !== 'EEXIST') throw e;
    });
    await set(ctx, { ...f, step: 'media-preview', mediaPath: path });
    const cta = await s.ctas.ensure(f.accountId);
    return ctx.replyWithPhoto(new InputFile(path), {
      caption: `предпросмотр вложения CTA\n\n${cta.text}${cta.url ? '\n' + cta.url : ''}`,
      reply_markup: new InlineKeyboard()
        .text('Сохранить вложение', 'v18msave')
        .text('Отмена', 'v18cancel'),
    });
  });
  bot.on('message:text', async (ctx, next) => {
    if (ctx.message.text.startsWith('/')) {
      return next();
    }
    const f = await getDocument<Flow>(s.db, flowKey(ctx));
    if (!f) return next();
    const text = ctx.message.text.trim(),
      id = f.accountId;
    if (f.step === 'budget' && f.purpose) {
      const limits = text.split(/\s+/).map(Number);
      assert(
        limits.length === 2 && limits.every((n) => Number.isFinite(n) && n >= 0 && n <= 10000),
        'INVALID_BUDGET',
        'Нужны два неотрицательных числа',
      );
      await putDocument(s.db, `llm-budget-${id}-${f.purpose}`, {
        dailyUsd: limits[0],
        monthlyUsd: limits[1],
      });
      await clear(ctx);
      return ctx.reply('Лимит сохранён.', { reply_markup: menu(id) });
    }
    if (f.step === 'v18bio')
      return profilePreview(ctx, await s.profileManager.draft(id, { bio: text }, actor(ctx)));
    if (f.step === 'v18genbio')
      return profilePreview(ctx, await s.profileManager.generatedBio(id, text, actor(ctx)));
    if (f.step === 'v18la') {
      const p = await s.profileManager.snapshot(id);
      return profilePreview(
        ctx,
        await s.profileManager.draft(id, { links: [...p.links, text] }, actor(ctx)),
      );
    }
    if (f.step === 'v18le' || f.step === 'v18ld') {
      const p = await s.profileManager.snapshot(id),
        index = Number(text) - 1;
      assert(
        Number.isInteger(index) && index >= 0 && index < p.links.length,
        'INVALID_INDEX',
        'Нужен существующий номер ссылки',
      );
      if (f.step === 'v18ld')
        return profilePreview(
          ctx,
          await s.profileManager.draft(
            id,
            { links: p.links.filter((_, i) => i !== index) },
            actor(ctx),
          ),
        );
      await set(ctx, { ...f, step: 'link-url', index });
      return ctx.reply('Отправьте новую HTTPS-ссылку.', { reply_markup: cancel() });
    }
    if (f.step === 'link-url') {
      const p = await s.profileManager.snapshot(id),
        links = [...p.links];
      links[f.index!] = text;
      return profilePreview(ctx, await s.profileManager.draft(id, { links }, actor(ctx)));
    }
    if (f.step === 'config' && f.field) {
      const value = ['categories', 'keywords', 'exclusions'].includes(f.field)
        ? text
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean)
        : Number(text.replace(',', '.'));
      await s.engagement.configure(id, { [f.field]: value }, actor(ctx));
      await clear(ctx);
      return engagement(ctx, id);
    }
    if (f.step === 'reply' && f.candidateId)
      return replyPreview(
        ctx,
        await s.engagement.edit(id, f.candidateId, text, actor(ctx), f.draftId),
      );
    return ctx.reply('Завершите действие кнопкой или нажмите «Отмена».', {
      reply_markup: cancel(),
    });
  });
}

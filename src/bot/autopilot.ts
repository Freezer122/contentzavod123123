import { localTime, zonedMinute, minutes } from '../autopilot/schedule.js';
import type { Bot, Context } from 'grammy';
import { InputFile } from 'grammy';
import { InlineKeyboard } from './keyboard.js';
import type { BotServices } from './bot.js';
import { getDocument, putDocument } from '../db/documents.js';
import { assert } from '../core/errors.js';
import { audit } from '../db/database.js';
import type { AutopilotConfig } from '../autopilot/policy.js';
import { ctaLabel, ctaStats } from '../cta/tasks.js';
import { deliverCtaStatus } from './cta-autopilot.js';
export const autopilotNavigation = (id: string) =>
  new InlineKeyboard().text('К аккаунту', `account:${id}`).text('Главное меню', 'menu');
const nested = (id: string) =>
  new InlineKeyboard()
    .text('Назад', `ap:home:${id}`)
    .row()
    .text('К аккаунту', `account:${id}`)
    .text('Главное меню', 'menu');
export async function autopilotCard(s: BotServices, id: string) {
  const a = await s.db.get('account', id);
  assert(a, 'NOT_FOUND', 'Аккаунт не найден');
  const state = await s.autopilotPolicy.settings(id),
    c = state.config;
  const slots = await s.autopilot.schedule(id),
    nextPost = slots.find(
      (x) => x.kind === 'POST' && ['PLANNED', 'PREPARING', 'READY'].includes(x.status),
    ),
    nextReply = slots.find(
      (x) => x.kind === 'REPLY' && ['PLANNED', 'PREPARING', 'READY'].includes(x.status),
    ),
    stats = await s.autopilot.stats(id);
  const kb = new InlineKeyboard();
  if (state.state === 'RUNNING') kb.text('Пауза', `ap:pause:${id}`);
  else kb.text('Включить автопилот LIVE', `ap:launch:${id}`);
  kb.text('Выключить', `ap:off:${id}`)
    .row()
    .text('Настроить посты', `ap:posts:${id}`)
    .text('Настроить реплаи', `ap:replies:${id}`)
    .row()
    .text('Источники контента', `ap:sources:${id}`)
    .text('Стиль', `ap:style:${id}`)
    .row()
    .text('CTA', `ac:home:${id}`)
    .row()
    .text('Расписание', `ap:schedule:${id}`)
    .text('Очередь', `ap:queue:${id}`)
    .row()
    .text('Статистика', `ap:stats:${id}`)
    .text('История ошибок', `ap:errors:${id}`)
    .row()
    .text('Экстренная остановка', `ap:stop:${id}`)
    .style('danger')
    .row()
    .text('К аккаунту', `account:${id}`)
    .text('Главное меню', 'menu');
  return {
    text: `АВТОПИЛОТ — ${a.name} (@${a.username})\nСтатус: ${state.state}\nСегодня: посты ${stats.published.posts}/${c.posts}, ответы ${stats.published.replies}/${c.replies}\nСледующий пост: ${nextPost ? new Date(nextPost.at).toLocaleString('ru-RU', { timeZone: c.timezone }) + ' ' + nextPost.status : 'нет'}\nСледующий реплай: ${nextReply ? new Date(nextReply.at).toLocaleString('ru-RU', { timeZone: c.timezone }) : 'нет'}\nГотовых постов: ${slots.filter((x) => x.kind === 'POST' && x.status === 'READY').length}\nОжидают отправки сегодня: ${slots.filter((x) => x.localDate === stats.today && x.status === 'READY').length}\nОшибок: ${stats.errors}\nСобственные посты: до ${c.posts}/день\nРеплаи: до ${c.replies}/день\nТематика: ${c.topic}\nСтиль: существующий стиль аккаунта\nОкно: ${c.start}–${c.end} (${c.timezone})\nПубликация: ${state.state === 'RUNNING' ? state.mode : 'выключена'}\nCTA: ${c.allowCTA ? 'включён' : 'выключен'}\nНастройки v${state.version}, эпоха ${state.epoch}\nТихий режим: ${c.quiet ? 'да' : 'нет'}\n${state.enabledAt ? 'Последний запуск: ' + state.enabledAt + '; ' + state.enabledBy : ''}\n${state.error ?? ''}\nМаксимумы не требуют заполнять план слабым материалом. MANUAL_LIVE управляется отдельно`,
    reply_markup: kb,
  };
}
export function installAutopilot(bot: Bot, s: BotServices) {
  const flowKey = (ctx: Context) => `autopilot-input-${ctx.from!.id}`;
  bot.on('callback_query:data', async (ctx, next) => {
    if (await getDocument(s.db, flowKey(ctx))) await putDocument(s.db, flowKey(ctx), null);
    return next();
  });
  bot.callbackQuery(/^ap:/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const [, action, id, arg] = ctx.callbackQuery.data.split(':'),
      actor = String(ctx.from.id);
    assert(id, 'NOT_FOUND', 'Не указан аккаунт');
    const home = async () => {
      const card = await autopilotCard(s, id);
      return ctx.reply(card.text, { reply_markup: card.reply_markup });
    };
    if (action === 'confirm') {
      await s.autopilotPolicy.start(id, actor);
      const launch = await getDocument<any>(s.db, `autopilot-launch-${id}`);
      const card = await autopilotCard(s, launch.accountId);
      return ctx.reply('Автопилот включён явным подтверждением владельца\n' + card.text, {
        reply_markup: card.reply_markup,
      });
    }
    if (action === 'home') return home();
    const a = await s.db.get('account', id);
    assert(a, 'NOT_FOUND', 'Аккаунт не найден');
    const state = await s.autopilotPolicy.settings(id),
      c = state.config;
    const patch = async (p: Partial<AutopilotConfig>) => {
      await s.autopilotPolicy.configure(id, p, actor);
      return home();
    };
    if (action === 'pause' || action === 'off') {
      await s.autopilotPolicy.pause(id, actor, action === 'off');
      return home();
    }
    if (action === 'stop') {
      await s.autopilotPolicy.pause(id, actor);
      await putDocument(s.db, 'emergencyStop', true);
      await putDocument(s.db, 'automationPaused', true);
      await audit(s.db, actor, 'EMERGENCY_STOP', id);
      return ctx.reply(
        'Экстренная остановка включена. Ручные и автоматические отправки заблокированы',
        { reply_markup: nested(id) },
      );
    }
    if (action === 'launch') {
      const token = await s.autopilotPolicy.launchCard(id, actor, 'LIVE');
      await s.autopilotPolicy.start(token, actor);
      return home();
    }
    if (action === 'sendreplies') {
      if (!arg)
        return ctx.reply(
          'Сгенерировать и отправить ответы: реальная отправка по допустимому расписанию',
          {
            reply_markup: new InlineKeyboard()
              .text('1 ответ', `ap:sendreplies:${id}:1`)
              .text('2 ответа', `ap:sendreplies:${id}:2`)
              .text('3 ответа', `ap:sendreplies:${id}:3`)
              .row()
              .text('Только сгенерировать черновики', `v18batch:${id}`)
              .row()
              .text('Назад', `v18e:${id}`),
          },
        );
      const rows = await s.autopilot.requestReplies(id, Number(arg), actor);
      return ctx.reply(
        'Команда принята. Выбор свежих публикаций, генерация и реальная отправка без одобрения каждого текста. Если кандидатов нет, начинаю поиск\n' +
          rows
            .map(
              (x) =>
                new Date(x.at).toLocaleString('ru-RU', { timeZone: c.timezone }) + ' — ' + x.status,
            )
            .join('\n'),
        {
          reply_markup: new InlineKeyboard()
            .text('Очередь ответов', `ap:schedule:${id}`)
            .text('Назад', `v18e:${id}`),
        },
      );
    }
    if (
      action === 'slot' ||
      action === 'slotcancel' ||
      action === 'slotnow' ||
      action === 'slotmove'
    ) {
      const slot = (await s.autopilot.schedule(id)).find((x) => x.id === arg);
      assert(slot, 'NOT_FOUND', 'Слот не найден');
      if (action === 'slotcancel') {
        await s.autopilot.changeSlot(id, arg!, actor, 'cancel');
        return home();
      }
      if (action === 'slotnow') {
        await s.autopilot.changeSlot(id, arg!, actor, 'now');
        return home();
      }
      if (action === 'slotmove') {
        await putDocument(s.db, flowKey(ctx), {
          accountId: id,
          kind: 'move',
          slotId: arg,
          day: slot.localDate,
        });
        return ctx.reply('Отправьте новое время ЧЧ:ММ в часовом поясе ' + c.timezone, {
          reply_markup: nested(id),
        });
      }
      const work = slot.contentJobId
        ? await getDocument<any>(s.db, `autopilot-work-${slot.contentJobId}`)
        : null;
      const cta =
        slot.kind === 'POST' && slot.publishingJobId
          ? await ctaLabel(s.db, slot.publishingJobId)
          : '';
      return ctx.reply(
        `${new Date(slot.at).toLocaleString('ru-RU', { timeZone: c.timezone })} (${c.timezone}) — ${slot.status}\n${work?.text ?? 'Текст ещё не подготовлен'}\n${slot.failureReason ?? ''}\n${slot.permalink ?? ''}\n${cta}\n${slot.publishedAt ? 'Фактически опубликовано: ' + new Date(slot.publishedAt).toLocaleString('ru-RU', { timeZone: c.timezone }) : ''}`,
        {
          reply_markup: new InlineKeyboard()
            .text('Перенести время', `ap:slotmove:${id}:${arg}`)
            .text('Отменить публикацию', `ap:slotcancel:${id}:${arg}`)
            .row()
            .text('Опубликовать сейчас', `ap:slotnow:${id}:${arg}`)
            .row()
            .text('Назад', `ap:schedule:${id}`),
        },
      );
    }
    if (action === 'schedule' || action === 'skips') {
      const all = await s.autopilot.schedule(id),
        today = localTime(Date.now(), c.timezone).day,
        day = arg ?? today,
        rows = all.filter((x) =>
          action === 'skips'
            ? ['SKIPPED', 'FAILED', 'UNCERTAIN'].includes(x.status)
            : x.localDate === day,
        ),
        kb = new InlineKeyboard();
      for (const x of rows.filter((x) => x.kind === 'POST' || action === 'skips').slice(0, 15))
        kb.text(
          `${new Date(x.at).toLocaleTimeString('ru-RU', { timeZone: c.timezone, hour: '2-digit', minute: '2-digit' })} ${x.kind} ${x.status}`,
          `ap:slot:${id}:${x.id}`,
        ).row();
      const tomorrow = all.find((x) => x.localDate !== today)?.localDate;
      kb.text('Обновить расписание', `ap:schedule:${id}:${day}`);
      if (tomorrow)
        kb.text(
          day === today ? 'Завтра' : 'Сегодня',
          `ap:schedule:${id}:${day === today ? tomorrow : today}`,
        );
      kb.row().text('Окно и часовой пояс', `ap:window:${id}`).row().text('Назад', `ap:home:${id}`);
      return ctx.reply(
        `${action === 'skips' ? 'Почему пропущено' : 'Расписание'} ${day} (${c.timezone})\n` +
          rows
            .map(
              (x) =>
                `${new Date(x.at).toLocaleTimeString('ru-RU', { timeZone: c.timezone, hour: '2-digit', minute: '2-digit' })} ${x.kind}: ${x.status}${x.failureReason ? ' — ' + x.failureReason : ''}${x.permalink ? '\n' + x.permalink : ''}`,
            )
            .join('\n')
            .slice(0, 3500),
        { reply_markup: kb },
      );
    }
    if (action === 'preview') {
      assert(arg === 'LIVE' || arg === 'DRY_RUN', 'MODE', 'Неизвестный режим');
      const token = await s.autopilotPolicy.launchCard(id, actor, arg);
      return ctx.reply(
        `Подтверждение запуска: ${a.name} (@${a.username})\nРежим ${arg}; максимум ${c.posts} постов / ${c.replies} реплаев\n${c.start}–${c.end} (${c.timezone}), настройки v${state.version}\nРазрешаются поиск, генерация, ${arg === 'LIVE' ? 'публикации новых авторских постов и ответов' : 'проверка редакторов без отправки'}, проверка URL и статистика\nCTA ${c.allowCTA ? 'в рамках настроек аккаунта' : 'запрещён'}. Лайки и изменения профиля не разрешаются\nПодтверждение действует 10 минут`,
        {
          reply_markup: new InlineKeyboard()
            .text(`Подтвердить запуск ${arg}`, `ap:confirm:${token}`)
            .row()
            .text('Отмена', `ap:home:${id}`),
        },
      );
    }
    if (action === 'posts' || action === 'replies') {
      const key = action === 'posts' ? 'posts' : 'replies',
        kb = new InlineKeyboard();
      for (const n of action === 'posts' ? [0, 1, 3, 5, 7, 10] : [0, 3, 5, 10, 15, 20])
        kb.text(String(n), `ap:set:${id}:${key}=${n}`);
      kb.row();
      for (const n of [20, 30, 60, 90, 120])
        kb.text(
          `${n} мин`,
          `ap:set:${id}:${key === 'posts' ? 'postIntervalMinutes' : 'replyIntervalMinutes'}=${n}`,
        );
      if (action === 'posts')
        kb.row()
          .text(`CTA: ${c.allowCTA ? 'включён' : 'выключен'}`, `ac:home:${id}`)
          .row()
          .text('Форматы', `ap:formats:${id}`);
      kb.row().text('Назад', `ap:home:${id}`);
      return ctx.reply(
        `Максимум ${c[key]}/день; интервал ${key === 'posts' ? c.postIntervalMinutes : c.replyIntervalMinutes} мин\nИзменение настроек приостанавливает автопилот. Недостаток качественных материалов уменьшает выполнение`,
        { reply_markup: kb },
      );
    }
    if (action === 'set') {
      const [key, value] = arg!.split('='),
        numbers = [
          'posts',
          'replies',
          'postIntervalMinutes',
          'replyIntervalMinutes',
          'viralThreshold',
        ];
      if (key === 'allowCTA')
        return ctx.reply('CTA: один переключатель и предпросмотр сохранённого текста/фотографии', {
          reply_markup: new InlineKeyboard().text('Открыть CTA', `ac:home:${id}`),
        });
      assert(
        [...numbers, 'allowCTA', 'quiet'].includes(key!),
        'INVALID_SETTING',
        'Неизвестная настройка',
      );
      return patch({ [key!]: numbers.includes(key!) ? Number(value) : value === 'true' });
    }
    if (action === 'sources' || action === 'formats') {
      const sources = action === 'sources',
        values = sources
          ? ['FEED', 'FOR_YOU', 'FOLLOWING', 'RECENT']
          : ['OBSERVATION', 'IRONY', 'OPINION', 'THESIS', 'JOKE', 'QUESTION', 'ANALYSIS'],
        selected: string[] = sources ? c.sources : c.formats,
        kb = new InlineKeyboard();
      for (const v of values)
        kb.text(
          `${selected.includes(v) ? '✓ ' : ''}${v}`,
          `ap:toggle:${id}:${sources ? 'sources' : 'formats'}=${v}`,
        ).row();
      if (sources) kb.text('Порог популярности', `ap:threshold:${id}`).row();
      kb.text('Назад', `ap:home:${id}`);
      return ctx.reply(
        sources
          ? `Реальные метрики; возраст до ${c.maxAgeHours} ч; порог viralScore ${c.viralThreshold}/100\nНедоступные показатели = null; без истории оценка предварительная`
          : 'Форматы самостоятельных мыслей; чужие истории и косметические рерайты не допускаются',
        { reply_markup: kb },
      );
    }
    if (action === 'toggle') {
      const [key, value] = arg!.split('=');
      assert(key === 'sources' || key === 'formats', 'INVALID_SETTING', 'Неизвестная настройка');
      const list = c[key] as string[];
      return patch({
        [key]: list.includes(value!) ? list.filter((x) => x !== value) : [...list, value!],
      });
    }
    if (action === 'style')
      return ctx.reply(
        `Используется стиль Sol ${a.styleId}, закреплённый шаблон ${a.templateId ?? 'нет'} и библиотека человеческих примеров\nОтветы используют текущий голос Terra. После существенного изменения стиля рекомендуется остановить и вновь запустить автопилот`,
        {
          reply_markup: nested(id)
            .row()
            .text('Стиль Sol', 'styles')
            .text('Стиль Terra', `v111style:${id}`)
            .row()
            .text('Человеческие примеры', `v114examples:${id}`),
        },
      );
    if (action === 'window' || action === 'threshold') {
      await putDocument(s.db, flowKey(ctx), { accountId: id, kind: action });
      return ctx.reply(
        action === 'window'
          ? 'Отправьте: 09:00 22:00 Europe/Moscow\nОкно должно быть внутри одних местных суток'
          : 'Отправьте порог популярности от 0 до 100',
        { reply_markup: new InlineKeyboard().text('Отмена', `ap:home:${id}`) },
      );
    }
    if (action === 'queue') {
      const day = localTime(Date.now(), c.timezone).day,
        slots = (await s.autopilot.schedule(id)).filter((x) => x.localDate === day),
        count = (...states: string[]) => slots.filter((x) => states.includes(x.status)).length;
      return ctx.reply(
        `Очередь автопилота ${day} (${c.timezone})\nЗапланировано: ${count('PLANNED', 'PREPARING')}\nГотово: ${count('READY')}\nОтправляется: ${count('PUBLISHING')}\nОпубликовано: ${count('PUBLISHED')}\nНе удалось: ${count('FAILED')}\nНеопределённый результат: ${count('UNCERTAIN')}\nПропущено: ${count('SKIPPED')}\n\n` +
          slots
            .map(
              (x) =>
                `${new Date(x.at).toLocaleTimeString('ru-RU', { timeZone: c.timezone })} ${x.kind} — ${x.status}${x.failureReason ? '\n' + x.failureReason : ''}${x.permalink ? '\n' + x.permalink : ''}`,
            )
            .join('\n')
            .slice(0, 3200),
        {
          reply_markup: nested(id)
            .row()
            .text('Обновить', 'ap:queue:' + id)
            .text('Расписание', 'ap:schedule:' + id),
        },
      );
    }
    if (action === 'errors') {
      const rows = (await s.autopilotPolicy.works())
        .filter((w) => w.accountId === id && (w.error || w.reasons?.length))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 15);
      return ctx.reply(
        `История ошибок и пропусков\n${state.error ? 'Остановка: ' + state.error + '\n' : ''}${rows.map((w) => `${w.kind} ${w.status}\n${w.scheduledAt}\n${w.error ?? w.reasons?.join(', ') ?? ''}\n${w.resultId ?? w.id}`).join('\n\n') || 'Нет записей'}\nUNCERTAIN не отправляется повторно`,
        { reply_markup: nested(id) },
      );
    }
    if (action === 'stats' || action === 'rank' || action === 'details') {
      const r = await s.autopilot.stats(id);
      const ct = await ctaStats(s.db, id, r.today, c.timezone);
      if (action === 'details')
        return ctx.replyWithDocument(
          new InputFile(Buffer.from(JSON.stringify(r, null, 2)), `autopilot-${id}.json`),
          { caption: 'Фактические данные БД, пропуски метрик = null', reply_markup: nested(id) },
        );
      if (action === 'rank') {
        const rows = arg === 'bottom' ? r.bottom10 : r.top10;
        return ctx.reply(
          `${arg === 'bottom' ? 'Анти-топ' : 'Топ'} по доступным реакциям\n${rows.map((p) => `${p.engagement} реакций; лайки ${p.likes ?? 'нет данных'} / ответы ${p.replies ?? 'нет данных'} / репосты ${p.reposts ?? 'нет данных'}\n${p.url}`).join('\n\n') || 'Доступных измерений пока нет'}`,
          { reply_markup: nested(id) },
        );
      }
      return ctx.reply(
        `Статистика ${r.today} (${c.timezone})\nПосты: ${r.published.posts}/${r.plan.posts}; реплаи: ${r.published.replies}/${r.plan.replies}\nCTA опубликовано: ${ct.published}; ожидают: ${ct.waiting}; не удалось: ${ct.failed}; UNCERTAIN: ${ct.uncertain}\nНайдено публикаций: ${r.found}; сильных тем: ${r.strong}\nСгенерировано постов: ${r.generated}; пропущено: ${r.skipped}; ошибок: ${r.errors}\n${
          Object.entries(r.byModel)
            .map(([m, v]) => `${m}: ${v.input}/${v.output} токенов, $${v.costUsd.toFixed(6)}`)
            .join('\n') || 'LLM-запросов сегодня нет'
        }\nПодписчики: ${r.followers ?? 'нет данных'}; изменение: ${r.followerDelta ?? 'нет данных'}\n${r.missingMetrics}`,
        {
          reply_markup: nested(id)
            .row()
            .text('Топ-10', `ap:rank:${id}:top`)
            .text('Анти-топ-10', `ap:rank:${id}:bottom`)
            .row()
            .text('7 дней, темы и стили', `ap:details:${id}`)
            .row()
            .text('Почему пропущено?', `ap:skips:${id}`),
        },
      );
    }
  });
  bot.on('message:text', async (ctx, next) => {
    const f = await getDocument<{ accountId: string; kind: string; slotId?: string; day?: string }>(
      s.db,
      flowKey(ctx),
    );
    if (!f) return next();
    if (ctx.message.text.startsWith('/')) {
      await putDocument(s.db, flowKey(ctx), null);
      return next();
    }
    if (f.kind === 'move') {
      const c = (await s.autopilotPolicy.settings(f.accountId)).config;
      assert(/^([01]\d|2[0-3]):[0-5]\d$/.test(ctx.message.text.trim()), 'FORMAT', 'Формат ЧЧ:ММ');
      await s.autopilot.changeSlot(
        f.accountId,
        f.slotId!,
        String(ctx.from.id),
        'move',
        zonedMinute(f.day!, minutes(ctx.message.text.trim()), c.timezone),
      );
      await putDocument(s.db, flowKey(ctx), null);
      return ctx.reply('Время сохранено', { reply_markup: nested(f.accountId) });
    }
    const raw = ctx.message.text.trim(),
      patch =
        f.kind === 'window'
          ? (() => {
              const [start, end, timezone, ...extra] = raw.split(/\s+/);
              assert(
                start && end && timezone && !extra.length,
                'FORMAT',
                'Формат: 09:00 22:00 Europe/Moscow',
              );
              return { start, end, timezone };
            })()
          : { viralThreshold: Number(raw) };
    await s.autopilotPolicy.configure(f.accountId, patch, String(ctx.from.id));
    await putDocument(s.db, flowKey(ctx), null);
    const card = await autopilotCard(s, f.accountId);
    return ctx.reply('Настройки сохранены\n' + card.text, { reply_markup: card.reply_markup });
  });
}
export async function deliverAutopilotSummaries(bot: Bot, s: BotServices) {
  await deliverCtaStatus(bot, s);
  for (const d of (await s.autopilot.discoveryReports()).slice(0, 2)) {
    const ap = await s.autopilotPolicy.settings(d.accountId);
    if (ap.epoch !== d.epoch) {
      await s.autopilot.acknowledgeDiscovery(d);
      continue;
    }
    await bot.api.sendMessage(
      Number(ap.enabledBy),
      `Поиск завершён: просмотрено ${d.metrics.found}, релевантных ${d.metrics.eligible}, новых ${d.metrics.added}. Это результат поиска, а не публикации`,
      { reply_markup: new InlineKeyboard().text('Расписание', `ap:schedule:${d.accountId}`) },
    );
    await s.autopilot.acknowledgeDiscovery(d);
  }

  for (const slot of (await s.autopilot.outcomes()).slice(0, 5)) {
    const cta =
      slot.kind === 'POST' && slot.publishingJobId
        ? await ctaLabel(s.db, slot.publishingJobId)
        : '';
    const ap = await s.autopilotPolicy.settings(slot.accountId);
    if (slot.localDate < localTime(Date.now(), ap.config.timezone).day) continue;
    await bot.api.sendMessage(
      Number(ap.enabledBy),
      `${slot.kind}: ${slot.status}\nПлан: ${new Date(slot.at).toLocaleString('ru-RU', { timeZone: slot.timezone })}\n${slot.publishedAt ? 'Факт: ' + new Date(slot.publishedAt).toLocaleString('ru-RU', { timeZone: slot.timezone }) : ''}\n${slot.permalink ?? slot.failureReason ?? ''}\n${cta}`,
      {
        reply_markup: new InlineKeyboard()
          .text('Посмотреть текст', `ap:slot:${slot.accountId}:${slot.id}`)
          .text('Расписание', `ap:schedule:${slot.accountId}`),
      },
    );
    await s.autopilot.acknowledge(slot);
  }

  for (const r of (await s.autopilot.summaries()).slice(0, 2)) {
    // A transport interruption after send can be uncertain; do not blindly resend a daily report.
    if (r.attemptedAt && !r.deliveredAt) continue;
    await putDocument(s.db, `autopilot-summary-${r.id}`, {
      ...r,
      attemptedAt: new Date().toISOString(),
    });
    await bot.api.sendMessage(r.chatId, r.text.slice(0, 3950), {
      reply_markup: new InlineKeyboard()
        .text('Статистика', `ap:stats:${r.accountId}`)
        .text('Очередь', `ap:queue:${r.accountId}`)
        .row()
        .text('Настройки', `ap:home:${r.accountId}`)
        .text('Пауза', `ap:pause:${r.accountId}`)
        .row()
        .text('К аккаунту', `account:${r.accountId}`),
    });
    await putDocument(s.db, `autopilot-summary-${r.id}`, {
      ...r,
      attemptedAt: new Date().toISOString(),
      deliveredAt: new Date().toISOString(),
    });
  }
}

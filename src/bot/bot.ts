import { installAutopilot } from './autopilot.js';
import { installCtaAutopilot, showAutopilotCta } from './cta-autopilot.js';
import type { PublishingWorker } from '../scheduler/worker.js';
import type { AutopilotService } from '../autopilot/service.js';
import type { AutopilotPolicy } from '../autopilot/policy.js';
import { InlineKeyboard } from './keyboard.js';
import { confirmSourceRights } from '../content/rights.js';
import { rightsKeyboard, rightsLabel } from './source-rights.js';
import { installV113 } from './extensions-v113.js';
import { postCard } from './manual-card.js';
import { ManualPolicy } from '../policy/manual.js';
import { installV112 } from './extensions-v112.js';
import type { TemplateService } from '../content/templates.js';
import { postKeyboard } from './generation.js';
import type { GenerationQueue } from '../content/jobs.js';
import { getDocument, putDocument } from '../db/documents.js';
import { createHash } from 'node:crypto';
import type { GenerationQuality } from '../content/quality.js';
import { DIAGNOSTIC_SCENARIOS, type BrowserDiagnostics } from '../browser/diagnostics.js';
import { Bot, InputFile, type Context } from 'grammy';
import { z } from 'zod';
import type { CtaService } from '../cta/service.js';
import type { Retention } from '../tracking/retention.js';
import type { PerformanceRating } from '../analytics/performance.js';
import type { PublicationMode, BroadcastAdaptation } from '../core/domain.js';
import type { Config } from '../core/config.js';
import type { Database } from '../db/database.js';
import { base, audit } from '../db/database.js';
import type { AccountManager } from '../accounts/service.js';
import type { SourceLibrary, ContentEngine } from '../content/service.js';
import type { Scheduler } from '../scheduler/service.js';
import type { Analytics, AnalyticsMode } from '../analytics/service.js';
import type { Tracking } from '../tracking/service.js';
import type { Monitoring } from '../monitoring/service.js';
import type { BrowserProvider } from '../browser/providers.js';
import type { BrowserProfile } from '../core/domain.js';
import { AppError, assert, messageOf } from '../core/errors.js';
import { fmt, dateFmt, statusRu, formatReport, formatPublishTiming } from './format.js';
import type { ProfileManager } from '../profile/service.js';
import type { EngagementManager } from '../engagement/service.js';
import type { EngagementQueue } from '../engagement/queue.js';
import { installV18 } from './extensions-v18.js';
import { installV111 } from './extensions-v111.js';
export interface BotServices {
  worker: PublishingWorker;
  autopilot: AutopilotService;
  autopilotPolicy: AutopilotPolicy;
  manual: ManualPolicy;
  generation: GenerationQueue;
  profileManager: ProfileManager;
  engagement: EngagementManager;
  engagementQueue: EngagementQueue;
  templates: TemplateService;
  quality: GenerationQuality;
  diagnostics: BrowserDiagnostics;
  ctas: CtaService;
  retention: Retention;
  performance: PerformanceRating;
  db: Database;
  accounts: AccountManager;
  library: SourceLibrary;
  content: ContentEngine;
  scheduler: Scheduler;
  analytics: Analytics;
  tracking: Tracking;
  monitoring: Monitoring;
  refreshMetrics: () => Promise<void>;
  providers: Record<BrowserProfile['provider'], BrowserProvider>;
}
interface Flow {
  selectedTemplateId?: string;
  templateActionId?: string;
  pendingTemplateName?: string;
  pendingCtaUrl?: string;
  publicationMode?: PublicationMode;
  adaptation?: BroadcastAdaptation;
  assignments?: Record<string, string>;
  activeAccountId?: string;
  ctaAccountId?: string;
  pendingCtaText?: string;
  ratingHours?: number;
  step?: string;
  sourceId?: string;
  accountIds?: string[];
  draftIds?: string[];
  editId?: string;
  days?: number;
  accountId?: string;
  mode?: AnalyticsMode;
}
const menu = () =>
  new InlineKeyboard()
    .text('✍️ Создать публикацию', 'create')
    .row()
    .text('📅 Очередь', 'queue')
    .text('👤 Аккаунты', 'accounts')
    .row()
    .text('📊 Аналитика', 'analytics')
    .text('📚 Библиотека', 'library')
    .row()
    .text('🎨 Стиль текстов', 'styles')
    .text('🔗 Ссылки и CTA', 'links')
    .row()
    .text('🖥 Система', 'system')
    .text('⚙️ Настройки', 'settings')
    .row()
    .text('👍 Качество генераций', 'quality')
    .text('🧩 Шаблоны Threads', 'templates')
    .row()
    .text('Тест моделей', 'v115abmenu');
const back = () => new InlineKeyboard().text('Главное меню', 'menu');
const stylePatch = z
  .object({
    name: z.string().min(1).max(100).optional(),
    instruction: z.string().max(4000).optional(),
    maxLength: z.number().int().min(50).max(500).optional(),
    maxParagraphs: z.number().int().min(1).max(10).optional(),
    punctuation: z.string().max(1000).optional(),
    emoji: z.boolean().optional(),
    slang: z.boolean().optional(),
    profanity: z.boolean().optional(),
    forbidden: z.array(z.string().max(100)).max(100).optional(),
    opening: z.string().max(500).optional(),
    ending: z.string().max(500).optional(),
    extra: z.string().max(2000).optional(),
  })
  .strict();
function userMessage(error: unknown): string {
  if (error instanceof AppError) return error.message;
  if (error instanceof z.ZodError)
    return 'Проверьте поля и формат команды. Допустимые значения указаны в /help.';
  if (error instanceof SyntaxError) return 'Некорректный JSON: проверьте кавычки и поля команды.';
  if (error instanceof RangeError) return 'Некорректное значение или неизвестный часовой пояс.';
  return 'Техническая ошибка. Подробности сохранены в журнале системы.';
}
export function createBot(config: Config, s: BotServices) {
  const timezones = new Map<number, string>();
  const tz = (ctx: Context) => timezones.get(ctx.from!.id) ?? config.TIMEZONE;
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
  const demo = config.APP_MODE === 'demo';
  const actor = (ctx: Context) => String(ctx.from!.id);
  const flowId = (ctx: Context) => `flow-${actor(ctx)}`;
  const getFlow = async (ctx: Context): Promise<Flow> => {
    const row = await s.db.get('setting', flowId(ctx));
    return row ? JSON.parse(row.value) : {};
  };
  const setFlow = async (ctx: Context, patch: Flow) => {
    const id = flowId(ctx);
    await s.db.transaction(async (tx) => {
      const current = await tx.get('setting', id);
      const value = JSON.stringify({ ...(current ? JSON.parse(current.value) : {}), ...patch });
      if (current) await tx.update('setting', id, { value });
      else await tx.insert('setting', { ...base(id), value });
    });
  };
  bot.use(async (ctx, next) => {
    // Membership updates come from Telegram, not from a human admin. Handle them before allowlist middleware.
    if (ctx.chatMember) {
      if (
        config.TELEGRAM_CHANNEL_ID &&
        String(ctx.chatMember.chat.id) === config.TELEGRAM_CHANNEL_ID
      ) {
        const m = ctx.chatMember,
          member = (x: typeof m.new_chat_member) =>
            ['creator', 'administrator', 'member'].includes(x.status) ||
            (x.status === 'restricted' && x.is_member);
        const old = member(m.old_chat_member),
          current = member(m.new_chat_member);
        if (old !== current && !m.new_chat_member.user.is_bot)
          await s.tracking.membership({
            eventKey: `telegram-${ctx.update.update_id}`,
            channelId: String(m.chat.id),
            userId: String(m.new_chat_member.user.id),
            kind: current ? 'JOIN' : 'LEAVE',
            inviteUrl: m.invite_link?.invite_link,
            occurredAt: new Date(m.date * 1000),
          });
      }
      return;
    }
    if (!ctx.from || !config.allowedIds.includes(ctx.from.id)) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: 'Доступ запрещён' });
      return;
    }
    if (ctx.chat?.type !== 'private') {
      await ctx.reply('Управление доступно только в личном чате с ботом.');
      return;
    }
    try {
      if (actor(ctx) === (config.TELEGRAM_OWNER_ID || String(config.allowedIds[0])))
        await s.manual.session(actor(ctx));
      const id = `user-${actor(ctx)}`;
      let user = await s.db.get('user', id);
      if (!user)
        user = await s.db.insert('user', {
          ...base(id),
          telegramId: actor(ctx),
          timezone: config.TIMEZONE,
        });
      timezones.set(ctx.from.id, user.timezone);
      console.log(
        'BOT_STAGE',
        JSON.stringify({
          stage: 'received',
          updateId: ctx.update.update_id,
          kind:
            ctx.message?.text !== undefined
              ? 'text'
              : ctx.message?.document
                ? 'document'
                : ctx.message?.photo
                  ? 'photo'
                  : ctx.callbackQuery
                    ? 'callback'
                    : 'other',
          chars: ctx.message?.text?.length ?? 0,
          step: (await getFlow(ctx)).step ?? '',
        }),
      );
      await next();
      console.log(
        'BOT_STAGE',
        JSON.stringify({ stage: 'handled', updateId: ctx.update.update_id }),
      );
      await audit(
        s.db,
        actor(ctx),
        'TELEGRAM_ACTION',
        String(ctx.update.update_id),
        ctx.callbackQuery?.data ??
          ctx.message?.text?.split(' ')[0]?.match(/^\/\w+/)?.[0] ??
          'TEXT_INPUT',
      );
    } catch (e) {
      const code =
        e instanceof AppError ? e.code : e instanceof z.ZodError ? 'INVALID_INPUT' : 'INTERNAL';
      console.error(
        'BOT_STAGE',
        JSON.stringify({ stage: 'failed', updateId: ctx.update.update_id, code }),
      );
      await s.db
        .insert('systemEvent', {
          ...base(),
          level: 'ERROR',
          code: 'BOT_ACTION',
          message: JSON.stringify({ updateId: ctx.update.update_id, code }),
        })
        .catch(() => {});
      await ctx
        .reply(`Не удалось выполнить действие: ${userMessage(e)}`, { reply_markup: back() })
        .catch(async () => {
          console.error(
            'BOT_STAGE',
            JSON.stringify({ stage: 'telegram_delivery_failed', updateId: ctx.update.update_id }),
          );
          await s.db
            .insert('systemEvent', {
              ...base(),
              level: 'ERROR',
              code: 'BOT_DELIVERY_FAILED',
              message: 'Не доставлено уведомление об ошибке; updateId=' + ctx.update.update_id,
            })
            .catch(() => {});
        });
    }
  });
  installAutopilot(bot, s);
  installCtaAutopilot(bot, s);
  installV113(bot, config, s);
  installV112(bot, config, s);
  installV111(bot, config, s);
  installV18(bot, config, s);
  async function showMenu(ctx: Context) {
    await ctx.reply(
      `${demo ? '🧪 Демонстрационный режим. Все аккаунты и метрики тестовые.\n\n' : ''}Content Factory\nВыберите действие:`,
      { reply_markup: menu() },
    );
  }
  async function showAccounts(ctx: Context) {
    const accounts = await s.db.list('account');
    const kb = new InlineKeyboard();
    for (const a of accounts)
      kb.text(`${a.status === 'ACTIVE' ? '⏸' : '▶️'} ${a.name}`, `account:${a.id}`).row();
    kb.text('Проверить доступность всех', 'check_accounts')
      .row()
      .text('Добавить аккаунт', 'add_account')
      .text('Профили браузеров', 'profiles')
      .row()
      .text('Меню', 'menu');
    await ctx.reply(
      `Аккаунты: ${accounts.length}\n\n` +
        (accounts
          .map(
            (a) =>
              `${a.name} (@${a.username})\n${statusRu[a.status]} · подписчики: ${fmt(a.followers)}\nПоследний пост: ${a.lastPublishedAt ? dateFmt(a.lastPublishedAt, tz(ctx)) : 'нет'}\nID: ${a.id}`,
          )
          .join('\n\n') || 'Аккаунтов пока нет.'),
      { reply_markup: kb },
    );
  }
  async function showAssignments(ctx: Context) {
    const f = await getFlow(ctx),
      kb = new InlineKeyboard();
    for (const a of await s.db.list('account'))
      kb.text(`${f.assignments?.[a.id] ? '✅' : '▫️'} ${a.name}`, `assign:${a.id}`).row();
    kb.text('Подготовить назначенные посты', 'generate_selected')
      .row()
      .text('Другой режим', 'publication_modes')
      .text('Отмена', 'cancel_flow');
    return ctx.reply(
      `Основной режим: отдельный исходник каждому аккаунту. Назначено: ${Object.keys(f.assignments ?? {}).length}. Нажмите аккаунт и отправьте его пост. Генерация начнётся только по вашей команде.`,
      { reply_markup: kb },
    );
  }
  async function showSource(ctx: Context, accountId: string, receipt = false) {
    const f = await getFlow(ctx),
      id = f.assignments?.[accountId];
    const source = id ? await s.db.get('source', id) : null,
      account = await s.db.get('account', accountId);
    assert(source && account, 'NOT_FOUND', 'Сохранённый исходник не найден');
    const task = (await s.generation.list())
      .filter(
        (t) =>
          t.kind === 'POST' &&
          t.preparation?.mappings?.some((m) => m.accountId === accountId && m.sourceId === id),
      )
      .at(-1);
    return ctx.reply(
      `${receipt ? 'Исходник сохранён для ' : 'Исходник для '}${account.name}\nРазмер: ${source.text.length} символов\nСтатус сохранения: PostgreSQL, сохранён\nНазначенный аккаунт: ${account.name}\nСостояние подготовки: ${task?.status ?? 'ожидает команды'}\nНазначено исходников: ${Object.keys(f.assignments ?? {}).length}\nПрава: ${await rightsLabel(s.db, source.id)}`,
      {
        reply_markup: new InlineKeyboard()
          .text('Подготовить пост', `source_prepare:${accountId}`)
          .row()
          .text('Изменить исходник', `assign:${accountId}`)
          .text('Посмотреть исходник', `source_view:${accountId}`)
          .row()
          .text('Удалить исходник', `source_delete:${accountId}`)
          .text('Назад к аккаунтам', 'assignments')
          .row()
          .text('Происхождение материала', `v113rights:${source.id}`),
      },
    );
  }
  async function saveSource(ctx: Context, text: string) {
    assert(
      text.trim().length > 0 && text.trim().length <= 20000,
      'SOURCE_LENGTH',
      'Исходник должен содержать от 1 до 20 000 символов. Длинный текст можно прислать файлом .txt',
    );
    const f = await getFlow(ctx);
    let source;
    try {
      source = await s.library.add(text);
    } catch (e) {
      if (!(e instanceof AppError && e.code === 'DUPLICATE_SOURCE')) throw e;
      const fp = createHash('sha256').update(text.trim().replace(/\s+/g, ' ')).digest('hex');
      source = (await s.db.list('source')).find(
        (row) => row.fingerprint === fp || row.url === text.trim(),
      );
      assert(source, 'DUPLICATE_SOURCE', 'Исходник уже существует; выберите его в библиотеке');
    }
    const assignments = { ...f.assignments };
    if (f.publicationMode !== 'BROADCAST' && f.activeAccountId) {
      assert(
        !Object.entries(assignments).some(([a, id]) => a !== f.activeAccountId && id === source.id),
        'DUPLICATE_SOURCE',
        'Для одинакового исходника нескольким аккаунтам выберите BROADCAST',
      );
      assignments[f.activeAccountId] = source.id;
      await setFlow(ctx, { sourceId: source.id, assignments, step: '', draftIds: [] });
      console.log(
        'BOT_STAGE',
        JSON.stringify({
          stage: 'source_saved',
          updateId: ctx.update.update_id,
          accountId: f.activeAccountId,
          sourceId: source.id,
          chars: source.text.length,
        }),
      );
      await showSource(ctx, f.activeAccountId, true);
      if (source.rights === 'REVIEW')
        return ctx.reply(
          'Укажите происхождение материала один раз. Подтверждение сохранится для этого исходника',
          { reply_markup: rightsKeyboard(source.id) },
        );
      return;
    }
    await setFlow(ctx, { sourceId: source.id, step: '', draftIds: [], accountIds: [] });
    return ctx.reply(
      'Исходник сохранён в PostgreSQL. Выберите аккаунт и подтвердите права перед публикацией.',
      { reply_markup: rightsKeyboard(source.id).row().text('Выбрать аккаунты', 'source_accounts') },
    );
  }
  async function enqueuePreparation(
    ctx: Context,
    preparation: import('../content/service.js').Preparation,
    force = false,
  ) {
    const targets = preparation.mappings?.map((m) => m.accountId) ?? preparation.accountIds ?? [];
    assert(targets.length, 'SELECT_ACCOUNTS', 'Назначьте исходник аккаунту');
    for (const id of targets) {
      const ready = await s.content.readiness(id);
      assert(ready.available, 'LLM_UNAVAILABLE', ready.reason);
    }
    const task = await s.generation.enqueue(
      { actor: actor(ctx), chatId: ctx.chat!.id, kind: 'POST', preparation, force },
      force ? String(ctx.update.update_id) : '',
    );
    if (task.status === 'COMPLETED') {
      for (const id of task.results ?? []) {
        const card = await postCard(s, id, actor(ctx));
        await ctx.reply(card.text, { reply_markup: card.reply_markup });
      }
      return;
    }
    return ctx.reply(
      `Подготовка: ${task.status === 'QUEUED' || task.status === 'RUNNING' ? 'Генерирую' : task.status}\nЗадача: ${task.id}\nИсходник сохранён. Результат придёт отдельным предпросмотром. Реальной публикации не будет.`,
    );
  }
  async function showPublicationModes(ctx: Context) {
    return ctx.reply('Выберите режим подготовки:', {
      reply_markup: new InlineKeyboard()
        .text('Отдельный пост каждому аккаунту', 'publication:ACCOUNT_SPECIFIC')
        .row()
        .text('Один исходник нескольким аккаунтам', 'publication:BROADCAST')
        .row()
        .text('Меню', 'menu'),
    });
  }
  async function showAccount(ctx: Context, id: string) {
    const a = await s.db.get('account', id);
    assert(a, 'NOT_FOUND', 'Аккаунт не найден');
    const cta = await s.ctas.ensure(id);
    const upcoming = (await s.autopilot.schedule(id)).find(
      (x) => x.kind === 'POST' && ['PLANNED', 'PREPARING', 'READY'].includes(x.status),
    );
    const work = upcoming?.contentJobId
      ? await getDocument<any>(s.db, `autopilot-work-${upcoming.contentJobId}`)
      : null;
    const ctaEnabled = (await s.autopilotPolicy.settings(id)).config.allowCTA;
    const primary = new InlineKeyboard().text('Расписание', `ap:schedule:${id}`);
    if (upcoming) primary.text('Опубликовать сейчас', `ap:slotnow:${id}:${upcoming.id}`);
    primary
      .row()
      .text('Автопилот', `ap:home:${id}`)
      .text('Взаимодействия', `v18e:${id}`)
      .text('Статистика', `ap:stats:${id}`)
      .row();
    return ctx.reply(
      `${a.name} · ${statusRu[a.status]}\nСледующая публикация: ${upcoming ? new Date(upcoming.at).toLocaleString('ru-RU', { timeZone: upcoming.timezone }) + ' ' + upcoming.status : 'нет'}\n${work?.text?.slice(0, 150) ?? ''}\n\nCTA ${ctaEnabled ? 'включён' : 'отключён'}, версия ${cta.version ?? 1}:\n${cta.text}\n${cta.url}\nИзменён: ${dateFmt(cta.updatedAt ?? cta.createdAt, tz(ctx))}`,
      {
        reply_markup: primary
          .text('Изменить CTA', `cta_edit:${id}`)
          .text(ctaEnabled ? 'Отключить CTA' : 'Включить CTA', `cta_toggle:${id}`)
          .row()
          .text('Публикации', `v112policy:${id}`)
          .text('Автопилот', `ap:home:${id}`)
          .row()
          .text('Профиль', `v18p:${id}`)
          .text('Взаимодействия', `v18e:${id}`)
          .row()
          .text('Вложение CTA', `v18m:${id}`)
          .row()
          .text(a.status === 'ACTIVE' ? 'Приостановить' : 'Включить', `toggle:${id}`)
          .text('Аккаунты', 'accounts')
          .row()
          .text('Выбрать шаблон', 'templates')
          .text('Снять шаблон', `template_clear:${id}`)
          .row()
          .text('Главное меню', 'menu'),
      },
    );
  }
  async function showAccountSelection(ctx: Context) {
    const flow = await getFlow(ctx);
    if ((flow.publicationMode ?? 'ACCOUNT_SPECIFIC') === 'ACCOUNT_SPECIFIC') {
      const kb = new InlineKeyboard();
      for (const a of await s.db.list('account')) kb.text(a.name, `bind:${a.id}`).row();
      return ctx.reply('Выберите один аккаунт для этого исходника:', { reply_markup: kb });
    }
    const selected = new Set(flow.accountIds ?? []);
    const kb = new InlineKeyboard();
    for (const a of await s.db.list('account'))
      kb.text(`${selected.has(a.id) ? '✅' : '▫️'} ${a.name}`, `select:${a.id}`).row();
    kb.text(
      flow.adaptation === 'COMMON' ? '✅ Одна адаптация' : 'Одна адаптация',
      'adaptation:COMMON',
    )
      .text(
        flow.adaptation !== 'COMMON' ? '✅ По стилям аккаунтов' : 'По стилям аккаунтов',
        'adaptation:PER_ACCOUNT',
      )
      .row()
      .text('Все активные', 'select_all')
      .text('Создать адаптации', 'generate_selected')
      .row()
      .text('Отмена', 'menu');
    await ctx.reply('Выберите аккаунты. Для каждого будет использован назначенный ему стиль.', {
      reply_markup: kb,
    });
  }
  async function showDrafts(ctx: Context) {
    const f = await getFlow(ctx);
    for (const id of f.draftIds ?? []) {
      const g = await s.db.get('generated', id);
      if (!g) continue;
      const card = await postCard(s, id, actor(ctx));
      await ctx.reply(card.text, { reply_markup: card.reply_markup });
    }
    await ctx.reply(
      'Предпросмотр сохранён. При включённых ручных публикациях кнопка «Опубликовать» отправляет выбранную версию',
      {
        reply_markup: new InlineKeyboard()
          .text('К аккаунтам', 'assignments')
          .text('Отмена', 'cancel_flow'),
      },
    );
  }
  async function showAnalytics(ctx: Context) {
    const f = await getFlow(ctx),
      days = f.days ?? 7,
      until = new Date(),
      since = new Date(days ? until.getTime() - days * 86400000 : 0),
      mode = f.mode ?? 'PUBLISHED_IN_PERIOD';
    const report = await s.analytics.report({ since, until, mode, accountId: f.accountId });
    const kb = new InlineKeyboard()
      .text('24 часа', 'period:1')
      .text('7 дней', 'period:7')
      .text('30 дней', 'period:30')
      .text('Всё время', 'period:0')
      .row()
      .text('Аккаунты', 'analytics_accounts')
      .text('Топ-10', 'top')
      .text('Антитоп-10', 'bottom')
      .row()
      .text('Динамика', 'dynamics')
      .text('Воронка', 'funnel')
      .text('Обновить', 'refresh_stats')
      .row()
      .text('Другой режим просмотров', 'analytics_mode')
      .text('CSV', 'csv')
      .row()
      .text('Рейтинг исходников', 'sources_rank')
      .text('Рейтинг стилей', 'styles_rank')
      .row()
      .text('Рейтинг контента', 'performance')
      .text('Retention Telegram', 'retention')
      .row()
      .text('Меню', 'menu');
    await ctx.reply(formatReport(report, days ? `${days} дн.` : 'всё время', demo), {
      reply_markup: kb,
    });
  }
  const period = async (ctx: Context) => {
    const f = await getFlow(ctx),
      days = f.days ?? 7,
      until = new Date();
    return {
      since: new Date(days ? until.getTime() - days * 86400000 : 0),
      until,
      mode: f.mode ?? ('PUBLISHED_IN_PERIOD' as AnalyticsMode),
      accountId: f.accountId,
    };
  };
  async function showQueue(ctx: Context) {
    const allJobs = await s.db.list('publishJob');
    const last = allJobs
      .filter((j) => j.status === 'COMPLETED')
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
    const rows = allJobs
      .filter((j) => !['COMPLETED', 'CANCELLED'].includes(j.status))
      .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
    return ctx.reply(
      `Задач: ${rows.length}\n\n${
        rows
          .slice(0, 12)
          .map(
            (j) =>
              `${j.id}\n${dateFmt(j.scheduledAt, tz(ctx))} · ${statusRu[j.status]}\nПост: ${statusRu[j.postStatus]}, комментарий: ${statusRu[j.commentStatus]}\n${formatPublishTiming(j, tz(ctx))}\nОтклонение: ${fmt((j.delayMs ?? 0) / 1000, 1)} с; причина: ${({ PROFILE_BUSY: 'профиль занят', WAITING_FOR_PREVIOUS_JOB: 'ожидание предыдущей задачи', WORKER_LATE: 'исполнитель запущен позже плана' } as Record<string, string>)[j.delayReason ?? ''] ?? 'нет'}`,
          )
          .join('\n\n') || 'Очередь пуста'
      }${last ? `\n\nПоследняя завершённая: ${last.id}\n${formatPublishTiming(last, tz(ctx))}` : ''}\n\n/cancel ID · /run ID · /reschedule ID ISO_UTC`,
      {
        reply_markup: new InlineKeyboard()
          .text('Остановить завод', 'pause')
          .text('Возобновить завод', 'resume')
          .row()
          .text('Меню', 'menu'),
      },
    );
  }
  async function showStatus(ctx: Context) {
    const paused = (await s.db.get('setting', 'factoryPaused'))?.value === 'true';
    const m = await s.monitoring.snapshot();
    return ctx.reply(
      `${demo ? '🧪 ДЕМОНСТРАЦИЯ\n' : ''}Система\nСтарая очередь завода: ${paused ? 'PAUSED' : 'ACTIVE'}\nAUTOPILOT: ${(
        await Promise.all(
          (await s.db.list('account')).map(async (a) => {
            const p = await s.autopilotPolicy.settings(a.id);
            return `${a.name} ${p.state}${p.state === 'RUNNING' ? ' ' + p.mode : ''}`;
          }),
        )
      ).join(
        '; ',
      )}\nИсполнение по умолчанию: ${demo ? 'демонстрация' : config.BROWSER_EXECUTION_MODE}\nCPU: ${fmt(m.cpuPercent, 1)}%\nCPU load 1m: ${fmt(m.cpuLoad1m, 2)} / ${m.cpuCount} ядер\nRAM: ${fmt(m.ramUsedBytes / 2 ** 30, 2)} / ${fmt(m.ramTotalBytes / 2 ** 30, 2)} GB\nRSS процесса: ${fmt(m.processRssBytes / 2 ** 20, 1)} MB\nSSD свободно: ${fmt(m.diskFreeBytes / 2 ** 30, 1)} GB\nАктивные профили: ${fmt(m.activeBrowsers)}\nБраузерные процессы хоста: ${fmt(m.browserProcesses)}\nОчередь: ${m.queued}\nОшибки за сутки: ${m.errors24h}\nБД: ${m.database}\nRedis: ${m.redis}\nИИ за сутки: ${m.aiRequests24h} запросов\nТокены вход/выход: ${m.inputTokens24h}/${m.outputTokens24h}\nСтоимость / зарезервировано сегодня: $${fmt(m.aiCost24h, 4)}\nЗа месяц: $${fmt(m.aiCostMonth, 4)}\nНакопительно / зарезервировано: $${fmt(m.aiCostTotal, 6)} / $${config.AI_TOTAL_LIMIT_USD}; предупреждение $${config.AI_WARNING_USD}\nЛимиты: $${config.AI_DAILY_LIMIT_USD}/сутки, $${config.AI_MONTHLY_LIMIT_USD}/месяц`,
      {
        reply_markup: new InlineKeyboard()
          .text('Диагностика DRY_RUN', 'diagnostics')
          .text('Меню', 'menu'),
      },
    );
  }
  bot.command('ping', (ctx) => ctx.reply('pong · Content Factory работает'));
  bot.command('status', showStatus);
  bot.command('accounts', showAccounts);
  bot.command('queue', showQueue);
  bot.command('start', showMenu);
  bot.command('menu', showMenu);
  bot.command('help', async (ctx) =>
    ctx.reply(
      'Управление:\n/account JSON — добавить аккаунт\n/style ID JSON — изменить стиль\n/example ID текст — пример для стиля\n/account_style АККАУНТ СТИЛЬ\n/edit ID текст — новая редакция черновика\n/cta АККАУНТ текст — собственный комментарий\n/cta_url АККАУНТ URL — изменить ссылку CTA\n/link АККАУНТ https://t.me/... — tracking-ссылка\n/invite АККАУНТ — пригласительная ссылка канала\n/rights МАТЕРИАЛ OWN|PERMITTED|REVIEW\n/reuse МАТЕРИАЛ — повторно использовать материал\n/cancel ЗАДАЧА\n/run ЗАДАЧА — перенести на сейчас (с проверкой конфликтов)\n/reschedule ЗАДАЧА ISO_UTC\n/retry_comment ЗАДАЧА\n/resume_job ЗАДАЧА — возобновить приостановленную задачу\n/tag МАТЕРИАЛ JSON — тема, формат и хук\n/search текст — поиск в библиотеке\n/auto АККАУНТ on|off — разрешить автоочередь\n/insights АККАУНТ API_USER_ID — подключить статистику\n/verify ЗАДАЧА URL — подтвердить вручную найденный пост\n/verify_comment ЗАДАЧА URL — подтвердить найденный комментарий\nДаты отображаются в часовом поясе из настроек сервера.',
    ),
  );
  bot.command('account', async (ctx) => {
    const a = await s.accounts.add(JSON.parse(ctx.match), actor(ctx));
    await ctx.reply(`Аккаунт добавлен и приостановлен: ${a.name}\nID: ${a.id}`);
  });
  bot.command('style', async (ctx) => {
    const [id, ...json] = ctx.match.split(' ');
    assert(id && (await s.db.get('style', id)), 'NOT_FOUND', 'Стиль не найден');
    const patch = stylePatch.parse(JSON.parse(json.join(' ')));
    await s.db.transaction(async (tx) => {
      await tx.update('style', id, patch);
      await audit(tx, actor(ctx), 'EDIT_STYLE', id);
    });
    await ctx.reply('Стиль сохранён.');
  });
  bot.command('example', async (ctx) => {
    const [styleId, ...parts] = ctx.match.split(' ');
    assert(
      styleId && (await s.db.get('style', styleId)) && parts.length,
      'INVALID_INPUT',
      'Нужны ID стиля и текст',
    );
    await s.db.insert('styleExample', { ...base(), styleId, text: parts.join(' ') });
    await ctx.reply('Пример сохранён.');
  });
  bot.command('account_style', async (ctx) => {
    const [accountId, styleId] = ctx.match.trim().split(/\s+/);
    assert(
      accountId && styleId && (await s.db.get('style', styleId)),
      'INVALID_INPUT',
      'Нужны ID аккаунта и стиля',
    );
    await s.templates.assignStyle(accountId, styleId, actor(ctx));
    await ctx.reply('Стиль назначен аккаунту.');
  });
  bot.command('edit', async (ctx) => {
    const [id, ...parts] = ctx.match.split(' ');
    assert(id, 'INVALID_INPUT', 'Укажите ID');
    const g = await s.content.edit(id, parts.join(' '), actor(ctx));
    const f = await getFlow(ctx);
    await setFlow(ctx, { draftIds: f.draftIds?.map((x) => (x === id ? g.id : x)) });
    await ctx.reply(`Новая версия: ${g.id}\n${g.text}`);
  });
  bot.command('rights', async (ctx) => {
    const [id, rights] = ctx.match.trim().split(/\s+/);
    assert(
      id && ['OWN', 'PERMITTED', 'REVIEW'].includes(rights ?? ''),
      'INVALID_INPUT',
      'Укажите ID и OWN, PERMITTED или REVIEW',
    );
    await confirmSourceRights(
      s.db,
      id,
      rights === 'REVIEW' ? 'THIRD_PARTY' : (rights as 'OWN' | 'PERMITTED'),
      actor(ctx),
    );
    await ctx.reply('Статус прав сохранён.');
  });
  bot.command('reuse', async (ctx) => {
    const id = ctx.match.trim();
    assert(await s.db.get('source', id), 'NOT_FOUND', 'Материал не найден');
    await setFlow(ctx, { sourceId: id, accountIds: [], draftIds: [], step: '' });
    await showAccountSelection(ctx);
  });
  bot.command('cta', async (ctx) => {
    const [id, ...parts] = ctx.match.split(' ');
    assert(id, 'INVALID_INPUT', 'Укажите аккаунт');
    const current = await s.ctas.ensure(id);
    const cta = await s.ctas.update(id, parts.join(' '), current.url ?? '', actor(ctx));
    await ctx.reply(`CTA сохранён, версия ${cta.version}:\n${cta.text}\n${cta.url}`);
  });
  bot.command('cta_url', async (ctx) => {
    const [id, raw] = ctx.match.trim().split(/\s+/);
    assert(id && raw, 'INVALID_INPUT', 'Укажите аккаунт и URL либо - для удаления ссылки');
    const url = raw === '-' ? '' : raw;
    const c = await s.ctas.ensure(id);
    await s.ctas.update(id, c.text, url, actor(ctx));
    await ctx.reply('Ссылка CTA сохранена для будущих задач.');
  });
  bot.command('cta_template', async (ctx) => {
    const [id, template] = ctx.match.trim().split(/\s+/),
      c = template ? await s.db.get('cta', template) : null;
    assert(id && c, 'NOT_FOUND', 'Шаблон не найден');
    const own = await s.ctas.ensure(id);
    await s.ctas.update(id, c.text, c.url ?? own.url ?? '', actor(ctx));
    await ctx.reply('Текст скопирован в индивидуальный CTA аккаунта.');
  });
  bot.command('tag', async (ctx) => {
    const [id, ...json] = ctx.match.split(' ');
    assert(id, 'INVALID_INPUT', 'Укажите ID исходника');
    const patch = z
      .object({
        topic: z.string().min(1).max(120).optional(),
        format: z.string().min(1).max(120).optional(),
        hook: z.string().min(1).max(120).optional(),
      })
      .strict()
      .parse(JSON.parse(json.join(' ')));
    await s.performance.tagSource(id, patch, actor(ctx));
    await ctx.reply('Тема, формат и хук сохранены для будущих публикаций.');
  });
  bot.command('timezone', async (ctx) => {
    const timezone = ctx.match.trim();
    new Intl.DateTimeFormat('ru-RU', { timeZone: timezone });
    await s.db.update('user', `user-${actor(ctx)}`, { timezone });
    timezones.set(ctx.from!.id, timezone);
    await ctx.reply(`Часовой пояс: ${timezone}`);
  });
  bot.command('cta_off', async (ctx) => {
    await s.ctas.setEnabled(ctx.match.trim(), false, actor(ctx));
    await ctx.reply('CTA отключён для задач, которые ещё не начались.');
  });
  bot.command('cta_on', async (ctx) => {
    return showAutopilotCta(ctx, s, ctx.match.trim());
  });
  bot.command('template_edit', async (ctx) => {
    const [id, ...parts] = ctx.match.split(' ');
    assert(id, 'INVALID_INPUT', 'Укажите ID шаблона');
    await s.templates.update(id, JSON.parse(parts.join(' ')), actor(ctx));
    await ctx.reply('Шаблон сохранён.');
  });
  bot.command('link', async (ctx) => {
    const [id, url] = ctx.match.split(' ');
    assert(id && url, 'INVALID_INPUT', 'Укажите ID аккаунта и ссылку');
    const a = await s.db.get('account', id);
    const link = await s.tracking.create(id, url, a?.ctaId ?? null);
    await ctx.reply(
      `Ссылка: ${config.PUBLIC_BASE_URL}/r/${link.code}\nID: ${link.id}\nДля подтверждённой атрибуции используйте /invite.`,
    );
  });
  bot.command('invite', async (ctx) => {
    const [accountId, postId] = ctx.match.trim().split(/\s+/);
    assert(accountId, 'INVALID_INPUT', 'Укажите ID аккаунта');
    assert(!demo, 'DEMO_ONLY', 'Пригласительные ссылки канала создаются в production');
    assert(
      config.TELEGRAM_CHANNEL_ID,
      'CHANNEL_REQUIRED',
      'Задайте TELEGRAM_CHANNEL_ID и права администратора боту',
    );
    assert(await s.db.get('account', accountId), 'NOT_FOUND', 'Аккаунт не найден');
    assert(
      !postId,
      'ACCOUNT_ATTRIBUTION_ONLY',
      'Приглашение относится к аккаунту, ID поста указывать не нужно',
    );
    const { link } = await s.tracking.ensureInvite(
      accountId,
      config.TELEGRAM_CHANNEL_ID,
      async () =>
        (
          await bot.api.createChatInviteLink(config.TELEGRAM_CHANNEL_ID, {
            name: `CF-${accountId.slice(-12)}`,
          })
        ).invite_link,
    );
    await ctx.reply(
      `Постоянная ссылка аккаунта:\n${config.PUBLIC_BASE_URL}/r/${link.code}\nПовторная команда использует то же приглашение. Атрибуция — только по аккаунту.`,
    );
  });
  bot.command('cancel', async (ctx) => {
    await s.scheduler.cancel(ctx.match.trim(), actor(ctx));
    await ctx.reply('Задача отменена.');
  });
  bot.command('run', async (ctx) => {
    await s.scheduler.reschedule(ctx.match.trim(), new Date(), actor(ctx));
    await ctx.reply('Задача назначена на ближайший запуск.');
  });
  bot.command('reschedule', async (ctx) => {
    const [id, date] = ctx.match.trim().split(/\s+/);
    assert(id && date, 'INVALID_INPUT', 'Укажите ID и время ISO UTC');
    z.string().datetime({ offset: true }).parse(date);
    await s.scheduler.reschedule(id, new Date(date), actor(ctx));
    await ctx.reply('Время изменено.');
  });
  bot.command('resume_job', async (ctx) => {
    const id = ctx.match.trim();
    const j = await s.db.get('publishJob', id);
    assert(j?.status === 'PAUSED', 'INVALID_STATE', 'Задача должна быть приостановлена');
    await s.scheduler.reschedule(id, new Date(), actor(ctx));
    await ctx.reply('Задача возобновлена.');
  });
  bot.command('retry_comment', async (ctx) => {
    await s.scheduler.retryComment(ctx.match.trim(), actor(ctx));
    await ctx.reply('Комментарий добавлен в очередь.');
  });
  bot.command('interval', async (ctx) => {
    const [min, max] = ctx.match.trim().split(/\s+/).map(Number);
    await s.scheduler.setInterval(min!, max!, actor(ctx));
    await ctx.reply('Интервал обновлён для новых партий.');
  });
  bot.command('search', async (ctx) => {
    const rows = await s.library.search(ctx.match);
    await ctx.reply(
      rows.map((x) => `${x.id}\n${x.text.slice(0, 100)}`).join('\n\n') || 'Материалы не найдены.',
    );
  });
  bot.command('auto', async (ctx) => {
    const [id, mode] = ctx.match.trim().split(/\s+/);
    assert(
      id && ['on', 'off'].includes(mode ?? ''),
      'INVALID_INPUT',
      'Укажите ID аккаунта и on или off',
    );
    await s.db.update('account', id, { autoApprove: mode === 'on' });
    await audit(s.db, actor(ctx), 'SET_AUTO_APPROVAL', id, mode);
    await ctx.reply('Режим аккаунта изменён. Автоочередь требует заранее одобренного варианта.');
  });
  bot.command('insights', async (ctx) => {
    const [id, insightsUserId] = ctx.match.trim().split(/\s+/);
    assert(
      id && /^\d+$/.test(insightsUserId ?? ''),
      'INVALID_INPUT',
      'Укажите ID аккаунта и числовой API ID Threads',
    );
    await s.db.update('account', id, { insightsUserId });
    await ctx.reply('ID для аналитики сохранён.');
  });
  bot.command('verify', async (ctx) => {
    const [id, url] = ctx.match.trim().split(/\s+/);
    assert(id && url, 'INVALID_INPUT', 'Укажите ID задачи и подтверждённый URL поста');
    await s.db.transaction(async (tx) => {
      const j = await tx.get('publishJob', id);
      assert(
        j?.status === 'NEEDS_REVIEW' && j.postStatus === 'UNCERTAIN',
        'INVALID_STATE',
        'Задача не ожидает подтверждения поста',
      );
      const a = await tx.get('account', j.accountId);
      const u = new URL(url);
      assert(
        ['www.threads.com', 'www.threads.net'].includes(u.hostname) &&
          u.protocol === 'https:' &&
          u.pathname.startsWith(`/@${a?.username}/post/`),
        'INVALID_URL',
        'URL должен принадлежать этому аккаунту',
      );
      await tx.insert('post', {
        ...base(),
        jobId: id,
        accountId: j.accountId,
        generatedId: j.generatedId,
        url,
        externalId: null,
        publishedAt: j.startedAt ?? new Date(),
      });
      await tx.update('publishJob', id, {
        postStatus: 'PUBLISHED',
        status: 'COMPLETED',
        commentStatus: j.commentStatus === 'PENDING' ? 'FAILED' : j.commentStatus,
        updatedAt: new Date(),
      });
      await audit(tx, actor(ctx), 'MANUAL_VERIFY_POST', id, url);
    });
    await ctx.reply('Пост подтверждён. Если нужен комментарий, используйте /retry_comment.');
  });
  bot.command('verify_comment', async (ctx) => {
    const [id, url] = ctx.match.trim().split(/\s+/);
    assert(id && url, 'INVALID_INPUT', 'Укажите ID задачи и URL вручную проверенного комментария');
    await s.db.transaction(async (tx) => {
      const j = await tx.get('publishJob', id);
      assert(
        j?.status === 'NEEDS_REVIEW' &&
          j.postStatus === 'PUBLISHED' &&
          j.commentStatus === 'UNCERTAIN',
        'INVALID_STATE',
        'Комментарий не ожидает подтверждения',
      );
      const a = await tx.get('account', j.accountId),
        post = (await tx.list('post', { jobId: id }))[0],
        u = new URL(url);
      assert(post && a, 'NOT_FOUND', 'Публикация не найдена');
      assert(
        u.protocol === 'https:' &&
          ['www.threads.com', 'www.threads.net'].includes(u.hostname) &&
          u.pathname.startsWith(`/@${a.username}/post/`),
        'INVALID_URL',
        'Нужен URL собственного комментария',
      );
      await tx.insert('comment', {
        ...base(),
        postId: post.id,
        text: j.ctaUrl ? `${j.ctaText ?? ''}\n${j.ctaUrl}` : (j.ctaText ?? ''),
        url,
        status: 'PUBLISHED',
      });
      await tx.update('publishJob', id, {
        commentStatus: 'PUBLISHED',
        status: 'COMPLETED',
        lastError: null,
        updatedAt: new Date(),
      });
      await audit(tx, actor(ctx), 'MANUAL_VERIFY_COMMENT', id, url);
    });
    await ctx.reply('Комментарий подтверждён без повторной отправки.');
  });
  async function showTemplates(ctx: Context) {
    const rows = await s.templates.list(),
      kb = new InlineKeyboard();
    for (const t of rows.filter((t) => t.enabled).slice(0, 30))
      kb.text(t.name, `template:${t.id}`).row();
    kb.text('Создать шаблон', 'template_new').text('Меню', 'menu');
    return ctx.reply('Шаблоны подачи Threads. Назначение не запускает генерацию.', {
      reply_markup: kb,
    });
  }
  async function showTemplate(ctx: Context, id: string) {
    const t = await s.db.get('contentTemplate', id);
    assert(t, 'NOT_FOUND', 'Шаблон не найден');
    await setFlow(ctx, { selectedTemplateId: id });
    const examples = await s.db.list('templateExample', { templateId: id });
    return ctx.reply(
      `${t.name}, версия ${t.version}\n${t.instruction}\n\nПримеры:\n${
        examples
          .slice(0, 3)
          .map((e) => e.text.slice(0, 300))
          .join('\n') || 'Пока нет'
      }`,
      {
        reply_markup: new InlineKeyboard()
          .text('Изменить шаблон', `template_edit:${id}`)
          .text('Добавить пример', `template_example:${id}`)
          .row()
          .text('Назначить аккаунту', `template_assign:${id}`)
          .text('Статистика', `template_stats:${id}`)
          .row()
          .text('Шаблоны', 'templates'),
      },
    );
  }
  bot.on('callback_query:data', async (ctx) => {
    await ctx.answerCallbackQuery();
    const data = ctx.callbackQuery.data;
    if (data === 'menu') {
      await setFlow(ctx, {
        step: '',
        pendingCtaText: undefined,
        pendingCtaUrl: undefined,
        pendingTemplateName: undefined,
      });
      return showMenu(ctx);
    }
    if (data.startsWith('feedback:')) {
      const [, rating, id] = data.split(':');
      assert(id && (rating === 'GOOD' || rating === 'BAD'), 'INVALID_RATING', 'Неизвестная оценка');
      await s.quality.rate(id, rating, actor(ctx));
      return ctx.reply(
        rating === 'GOOD'
          ? 'Оценка «Хорошо» сохранена. Её можно изменить.'
          : 'Оценка «Плохо» сохранена. Её можно изменить.',
      );
    }
    if (data === 'quality') {
      const r = await s.quality.report((await getFlow(ctx)).accountId);
      return ctx.reply(
        `${demo ? '🧪 ТЕСТОВЫЕ ДАННЫЕ\n' : ''}Качество генераций\nОценено текстов: ${r.ratedGenerations}\nХорошо: ${r.good}, плохо: ${r.bad}\nХороших оценок: ${fmt(r.approvalRate, 1)}%\n\n👍 Хорошие:\n${
          r.goodExamples
            .slice(0, 4)
            .map((g) => g.finalText.slice(0, 180))
            .join('\n\n') || 'Нет оценок'
        }\n\n👎 Плохие:\n${
          r.badExamples
            .slice(0, 4)
            .map((g) => g.finalText.slice(0, 180))
            .join('\n\n') || 'Нет оценок'
        }\n\nИспользуется последняя оценка каждого текста. Автоматического ИИ-анализа нет.`,
        {
          reply_markup: new InlineKeyboard()
            .text('Мои примеры', 'v114examples:all')
            .row()
            .text('Главное меню', 'menu'),
        },
      );
    }
    if (data === 'templates') return showTemplates(ctx);
    if (data === 'template_new') {
      await setFlow(ctx, { step: 'template_name' });
      return ctx.reply('Введите название нового шаблона.');
    }
    if (data.startsWith('template:')) return showTemplate(ctx, data.slice(9));
    if (data.startsWith('template_edit:')) {
      await setFlow(ctx, { selectedTemplateId: data.slice(14), step: 'template_instruction_edit' });
      return ctx.reply(
        'Отправьте новую инструкцию шаблона. Название можно изменить командой /template_edit ID JSON.',
      );
    }
    if (data.startsWith('template_example:')) {
      await setFlow(ctx, { selectedTemplateId: data.slice(17), step: 'template_example' });
      return ctx.reply('Отправьте пример удачного текста для этого шаблона.');
    }
    if (data.startsWith('template_assign:')) {
      const id = data.slice(16),
        nonce = base().id.slice(0, 8);
      assert(await s.db.get('contentTemplate', id), 'NOT_FOUND', 'Шаблон не найден');
      await setFlow(ctx, { selectedTemplateId: id, templateActionId: nonce });
      const kb = new InlineKeyboard();
      for (const a of await s.db.list('account')) kb.text(a.name, `tplpin:${nonce}:${a.id}`).row();
      return ctx.reply('Выберите аккаунт для закрепления шаблона:', { reply_markup: kb });
    }
    if (data.startsWith('tplpin:')) {
      const [, nonce, accountId] = data.split(':'),
        f = await getFlow(ctx);
      assert(
        accountId && f.selectedTemplateId && nonce === f.templateActionId,
        'STALE_FLOW',
        'Выберите шаблон и аккаунт заново',
      );
      await s.templates.assign(accountId, f.selectedTemplateId, actor(ctx));
      return ctx.reply('Шаблон закреплён. Дополнительные публикации и запросы ИИ не создавались.');
    }
    if (data.startsWith('template_clear:')) {
      await s.templates.assign(data.slice(15), null, actor(ctx));
      return ctx.reply('Закрепление шаблона снято.');
    }
    if (data.startsWith('template_stats:')) {
      const r = await s.performance.report((await getFlow(ctx)).ratingHours ?? 24),
        t = r.templateStats.find((t) => t.id === data.slice(15));
      assert(t, 'NOT_FOUND', 'Шаблон не найден');
      return ctx.reply(
        `${t.name}\nОпубликовано: ${t.publishedPosts}, сопоставимых замеров: ${t.measuredPosts}\nСредние: ${fmt(t.average)}, медиана: ${fmt(t.median)}\nМаксимум: ${fmt(t.max)}, минимум: ${fmt(t.min)}\n${t.rankEligible ? 'Включён в основной рейтинг.' : 'Предварительные данные: для основного рейтинга нужны минимум 10 сопоставимых публикаций.'}`,
      );
    }
    if (data.startsWith('cta_toggle:')) {
      const id = data.slice(11),
        c = await s.ctas.ensure(id);
      if ((await s.autopilotPolicy.settings(id)).config.allowCTA)
        await s.autopilotPolicy.setCta(id, false, actor(ctx));
      return showAutopilotCta(ctx, s, id);
    }
    if (data === 'cta_no_link') {
      const f = await getFlow(ctx);
      assert(f.ctaAccountId && f.pendingCtaText, 'INVALID_INPUT', 'Сначала введите текст');
      await setFlow(ctx, { step: 'cta_preview', pendingCtaUrl: '' });
      return ctx.reply(`Новый CTA без отдельной ссылки:\n${f.pendingCtaText}`, {
        reply_markup: new InlineKeyboard()
          .text('Сохранить CTA', 'cta_save')
          .text('Отмена', 'cta_cancel'),
      });
    }
    if (data === 'cta_save') {
      const f = await getFlow(ctx);
      assert(
        f.ctaAccountId && f.pendingCtaText && f.pendingCtaUrl !== undefined,
        'INVALID_INPUT',
        'Подготовьте текст CTA',
      );
      await s.ctas.update(f.ctaAccountId, f.pendingCtaText, f.pendingCtaUrl, actor(ctx));
      await setFlow(ctx, { step: '', pendingCtaText: undefined, pendingCtaUrl: undefined });
      return showAccount(ctx, f.ctaAccountId);
    }
    if (data === 'diagnostics') {
      const kb = new InlineKeyboard();
      for (const scenario of DIAGNOSTIC_SCENARIOS)
        kb.text(
          (
            {
              OK: 'Успешный сценарий',
              PROFILE_START_ERROR: 'Ошибка запуска профиля',
              CDP_ERROR: 'Ошибка CDP',
              TIMEOUT: 'Таймаут',
              CONNECTION_LOST: 'Потеря соединения',
              AUTH_REQUIRED: 'Нет авторизации',
              PUBLISH_FAILED: 'Ошибка поста',
              COMMENT_FAILED: 'Ошибка CTA',
              UNCERTAIN_POST: 'Неясный результат поста',
              UNCERTAIN_COMMENT: 'Неясный результат CTA',
            } as const
          )[scenario],
          `diagnose:${scenario}`,
        ).row();
      return ctx.reply(
        'DRY_RUN: только MockBrowserProvider и тестовые данные. Реальные профили и сеть не используются.',
        { reply_markup: kb },
      );
    }
    if (data.startsWith('diagnose:')) {
      const scenario = data.slice(9);
      assert(
        DIAGNOSTIC_SCENARIOS.includes(scenario as any),
        'INVALID_SCENARIO',
        'Неизвестный сценарий',
      );
      const r = await s.diagnostics.run(scenario as any);
      return ctx.reply(
        `DRY_RUN · ${r.scenario}\nЗадача: ${statusRu[r.status]}\nПост: ${statusRu[r.postStatus]}\nCTA: ${statusRu[r.commentStatus]}\nПопытки: ${r.attempts}\nОткрытых сессий: ${r.activeSessions}\nВнешние запросы: ${r.externalRequests}\nИИ-запросы: ${r.llmRequests}`,
        { reply_markup: back() },
      );
    }

    if (
      ['create', 'publication_modes', 'menu'].includes(data) ||
      /^(publication:|assign:|cta_edit:)/.test(data)
    )
      await s.db.remove('setting', `v18-flow-${actor(ctx)}`);
    if (data === 'assignments') return showAssignments(ctx);
    if (data === 'source_accounts') return showAccountSelection(ctx);
    if (data === 'create' || data === 'publication_modes') return showPublicationModes(ctx);
    if (data.startsWith('publication:')) {
      const mode = data.slice(12);
      assert(
        mode === 'ACCOUNT_SPECIFIC' || mode === 'BROADCAST',
        'INVALID_MODE',
        'Неизвестный режим',
      );
      await setFlow(ctx, {
        publicationMode: mode,
        adaptation: 'PER_ACCOUNT',
        assignments:
          (await getFlow(ctx)).publicationMode === mode
            ? ((await getFlow(ctx)).assignments ?? {})
            : {},
        accountIds: [],
        draftIds: [],
        sourceId: undefined,
        activeAccountId: undefined,
        step: mode === 'BROADCAST' ? 'source' : '',
      });
      return mode === 'ACCOUNT_SPECIFIC'
        ? showAssignments(ctx)
        : ctx.reply('Отправьте один исходный текст или ссылку X для выбранных аккаунтов.');
    }
    if (data.startsWith('account:')) return showAccount(ctx, data.slice(8));
    if (data.startsWith('cta_edit:')) {
      const id = data.slice(9);
      await s.ctas.ensure(id);
      await setFlow(ctx, { step: 'cta_text', ctaAccountId: id });
      return ctx.reply('Отправьте новый текст комментария. Ссылку укажете следующим сообщением.', {
        reply_markup: new InlineKeyboard().text('Отменить правку CTA', 'cta_cancel'),
      });
    }
    if (data === 'cta_cancel') {
      const f = await getFlow(ctx);
      await setFlow(ctx, { step: '', pendingCtaText: undefined });
      return f.ctaAccountId ? showAccount(ctx, f.ctaAccountId) : showAccounts(ctx);
    }
    if (data.startsWith('assign:')) {
      const id = data.slice(7);
      assert(await s.db.get('account', id), 'NOT_FOUND', 'Аккаунт не найден');
      await setFlow(ctx, { activeAccountId: id, step: 'source' });
      return ctx.reply('Отправьте отдельный исходник для этого аккаунта.');
    }
    if (data.startsWith('bind:')) {
      const f = await getFlow(ctx),
        id = data.slice(5);
      assert(f.sourceId, 'NOT_FOUND', 'Сначала добавьте исходник');
      const assignments = { ...f.assignments };
      assert(
        !Object.entries(assignments).some(
          ([accountId, sourceId]) => accountId !== id && sourceId === f.sourceId,
        ),
        'DUPLICATE_SOURCE',
        'Этот исходник уже назначен другому аккаунту. Для общей рассылки выберите BROADCAST.',
      );
      assignments[id] = f.sourceId;
      await setFlow(ctx, { assignments, step: '', activeAccountId: undefined });
      return showAssignments(ctx);
    }
    if (data.startsWith('adaptation:')) {
      const adaptation = data.slice(11);
      assert(
        adaptation === 'COMMON' || adaptation === 'PER_ACCOUNT',
        'INVALID_MODE',
        'Неизвестная адаптация',
      );
      await setFlow(ctx, { adaptation, draftIds: [] });
      return showAccountSelection(ctx);
    }
    if (data === 'cancel_flow') {
      await setFlow(ctx, { step: '', draftIds: [], accountIds: [] });
      return ctx.reply('Создание партии отменено.', { reply_markup: menu() });
    }
    if (data.startsWith('rights:')) {
      const [, rights, id] = data.split(':');
      assert(
        id && (rights === 'OWN' || rights === 'PERMITTED'),
        'INVALID_INPUT',
        'Некорректный статус прав',
      );
      const flow = await getFlow(ctx);
      assert(
        flow.sourceId === id,
        'STALE_FLOW',
        'Этот исходник уже не выбран. Добавьте или выберите его заново.',
      );
      await confirmSourceRights(s.db, id, rights, actor(ctx));
      if (
        (flow.publicationMode ?? 'ACCOUNT_SPECIFIC') === 'ACCOUNT_SPECIFIC' &&
        flow.activeAccountId
      ) {
        const assignments = { ...flow.assignments };
        assert(
          !Object.entries(assignments).some(
            ([a, source]) => a !== flow.activeAccountId && source === id,
          ),
          'DUPLICATE_SOURCE',
          'Для одинакового исходника выберите общий режим',
        );
        assignments[flow.activeAccountId] = id;
        await setFlow(ctx, { assignments, step: '', activeAccountId: undefined });
        return showAssignments(ctx);
      }
      await setFlow(ctx, { sourceId: id, step: '', accountIds: [] });
      return showAccountSelection(ctx);
    }
    if (data.startsWith('select:')) {
      const id = data.slice(7),
        f = await getFlow(ctx),
        ids = new Set(f.accountIds ?? []);
      if ((f.publicationMode ?? 'ACCOUNT_SPECIFIC') === 'ACCOUNT_SPECIFIC') {
        assert(f.sourceId, 'NOT_FOUND', 'Исходник не выбран');
        await setFlow(ctx, { assignments: { ...f.assignments, [id]: f.sourceId }, step: '' });
        return showAssignments(ctx);
      }
      ids.has(id) ? ids.delete(id) : ids.add(id);
      await setFlow(ctx, { accountIds: [...ids] });
      return showAccountSelection(ctx);
    }
    if (data === 'select_all') {
      await setFlow(ctx, {
        accountIds: (await s.db.list('account', { status: 'ACTIVE' })).map((a) => a.id),
      });
      return showAccountSelection(ctx);
    }
    if (data.startsWith('source_')) {
      const [action, id] = data.split(':');
      const f = await getFlow(ctx),
        sourceId = f.assignments?.[id!];
      const source = sourceId ? await s.db.get('source', sourceId) : null;
      assert(source && id, 'NOT_FOUND', 'Сначала сохраните исходник');
      if (action === 'source_view')
        return ctx.replyWithDocument(new InputFile(Buffer.from(source.text), 'source.txt'));
      if (action === 'source_delete') {
        const pending = (await s.generation.list()).filter(
          (t) =>
            t.kind === 'POST' &&
            (t.preparation?.sourceId === source.id ||
              t.preparation?.mappings?.some((m) => m.sourceId === source.id)),
        );
        assert(
          !pending.some((t) => t.status === 'RUNNING'),
          'GENERATION_RUNNING',
          'Идёт генерация. Дождитесь результата перед удалением исходника',
        );
        for (const t of pending.filter((t) => t.status === 'QUEUED'))
          await putDocument(s.db, `generation-task-${t.id}`, {
            ...t,
            status: 'FAILED',
            error: 'Отменено пользователем: исходник удалён',
          });
        const assignments = { ...f.assignments };
        delete assignments[id];
        await setFlow(ctx, {
          assignments,
          sourceId: undefined,
          activeAccountId: undefined,
          step: '',
        });
        const used =
          (await s.db.list('generated', { sourceId: source.id })).length > 0 ||
          (await s.db.list('setting')).some(
            (r) => r.id.startsWith('flow-') && r.value.includes(source.id),
          );
        if (!used) await s.db.remove('source', source.id);
        return ctx.reply(
          used
            ? 'Назначение удалено. Исходник сохранён для существующих черновиков и истории.'
            : 'Исходник удалён',
          { reply_markup: new InlineKeyboard().text('Назад к аккаунтам', 'assignments') },
        );
      }
      if (action === 'source_retry')
        return enqueuePreparation(
          ctx,
          { mode: 'ACCOUNT_SPECIFIC', mappings: [{ accountId: id, sourceId: source.id }] },
          true,
        );
      if (action === 'source_prepare')
        return enqueuePreparation(ctx, {
          mode: 'ACCOUNT_SPECIFIC',
          mappings: [{ accountId: id, sourceId: source.id }],
        });
    }
    if (data === 'generate_selected') {
      const f = await getFlow(ctx),
        mode = f.publicationMode ?? 'ACCOUNT_SPECIFIC';
      return enqueuePreparation(
        ctx,
        mode === 'ACCOUNT_SPECIFIC'
          ? {
              mode,
              mappings: Object.entries(f.assignments ?? {}).map(([accountId, sourceId]) => ({
                accountId,
                sourceId,
              })),
            }
          : {
              mode,
              sourceId: f.sourceId,
              accountIds: f.accountIds,
              adaptation: f.adaptation ?? 'PER_ACCOUNT',
            },
      );
    }
    if (
      data.startsWith('post_ok:') ||
      data.startsWith('post_reject:') ||
      data.startsWith('post_publish:') ||
      data.startsWith('post_send:')
    ) {
      const [action, id] = data.split(':');
      const g = await s.db.get('generated', id!);
      assert(g, 'NOT_FOUND', 'Черновик не найден');
      assert(
        !(await getDocument(s.db, `superseded-${g.id}`)),
        'STALE_CARD',
        'Карточка устарела. Откройте новый вариант',
      );
      if (action === 'post_reject') {
        await s.db.update('generated', g.id, { approved: false });
        await putDocument(s.db, `rejected-${g.id}`, true);
        return ctx.reply('Черновик отклонён. Реальных действий нет.');
      }
      assert(
        g.valid && !(await getDocument(s.db, `rejected-${g.id}`)),
        'INVALID_CONTENT',
        'Черновик отклонён или не прошёл проверку',
      );
      if (action === 'post_ok') {
        await s.db.update('generated', g.id, { approved: true });
        await audit(s.db, actor(ctx), 'APPROVE_TEXT', g.id);
        return ctx.reply(
          `Текст одобрен. Публикация требует отдельного подтверждения. Режим: ${config.BROWSER_EXECUTION_MODE}`,
          {
            reply_markup: new InlineKeyboard().text(
              'Подтвердить публикацию',
              `post_publish:${g.id}`,
            ),
          },
        );
      }
      assert(g.approved, 'APPROVAL_REQUIRED', 'Сначала одобрите текст');
      if (action === 'post_publish')
        return ctx.reply(
          `Подтвердите реальную отправку именно этого текста и CTA аккаунта. Режим ${config.BROWSER_EXECUTION_MODE}.\n\n${g.text}`,
          {
            reply_markup: new InlineKeyboard()
              .text('Отправить этот пост', `post_send:${g.id}`)
              .text('Отмена', 'menu'),
          },
        );
      assert(
        config.BROWSER_EXECUTION_MODE === 'LIVE',
        'DRY_RUN_ONLY',
        'Публикация запрещена: режим DRY_RUN. Одобрение текста сохранено',
      );
      const jobs = await s.scheduler.createBatch(
        [g.id],
        actor(ctx),
        'MANUAL_APPROVAL',
        `confirmed-${g.id}`,
      );
      return ctx.reply(`Подтверждённая задача: ${jobs[0]!.id}`);
    }
    if (data.startsWith('edit:')) {
      const f = await getFlow(ctx),
        id = data.slice(5);
      await setFlow(ctx, {
        step: 'edit',
        editId: id,
        draftIds: f.draftIds?.includes(id) ? f.draftIds : [id],
      });
      return ctx.reply('Отправьте исправленный текст целиком.');
    }
    if (data.startsWith('regen:')) {
      const id = data.slice(6),
        g = await s.db.get('generated', id);
      assert(g, 'NOT_FOUND', 'Черновик не найден');
      const f = await getFlow(ctx);
      return enqueuePreparation(
        ctx,
        f.publicationMode === 'BROADCAST' && f.adaptation === 'COMMON' && f.accountIds?.length
          ? {
              mode: 'BROADCAST',
              adaptation: 'COMMON',
              sourceId: g.sourceId,
              accountIds: f.accountIds,
            }
          : {
              mode: 'ACCOUNT_SPECIFIC',
              mappings: [{ accountId: g.accountId, sourceId: g.sourceId }],
            },
        true,
      );
    }
    if (data === 'approve') {
      const f = await getFlow(ctx);
      assert(f.draftIds?.length, 'NO_DRAFTS', 'Сначала создайте адаптации');
      for (const id of f.draftIds) {
        const g = await s.db.get('generated', id);
        assert(
          g?.valid && !(await getDocument(s.db, `rejected-${id}`)),
          'INVALID_CONTENT',
          'Нужен проверенный черновик',
        );
        await s.db.update('generated', id, { approved: true });
        await ctx.reply('Текст одобрен. Реальная отправка требует отдельного подтверждения.', {
          reply_markup: new InlineKeyboard().text('Подтвердить публикацию', `post_publish:${id}`),
        });
      }
      return;
    }
    if (data === 'accounts') return showAccounts(ctx);
    if (data.startsWith('toggle:')) {
      const id = data.slice(7),
        a = await s.db.get('account', id);
      assert(a, 'NOT_FOUND', 'Аккаунт не найден');
      await s.accounts.setStatus(id, a.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE', actor(ctx));
      return showAccounts(ctx);
    }
    if (data === 'add_account')
      return ctx.reply(
        'Добавьте аккаунт командой:\n/account {"username":"my_user","name":"Трейдер","provider":"ADSPOWER","externalId":"ID_ПРОФИЛЯ","styleId":"style-1"}\nПосле добавления проверьте авторизацию и включите аккаунт.',
      );
    if (data === 'profiles') {
      assert(
        demo || config.BROWSER_EXECUTION_MODE === 'LIVE',
        'DRY_RUN_ONLY',
        'Реальные браузерные API отключены. Используйте диагностику DRY_RUN.',
      );
      for (const [provider, adapter] of Object.entries(s.providers)) {
        if (demo && provider !== 'MOCK') continue;
        if (!demo && provider === 'MOCK') continue;
        try {
          const ps = await adapter.listProfiles();
          await ctx.reply(
            `${provider}:\n${
              ps
                .slice(0, 30)
                .map((p) => `${p.id} — ${p.name}`)
                .join('\n') || 'Профилей нет'
            }`,
          );
        } catch (e) {
          await ctx.reply(`${provider}: ${userMessage(e)}`);
        }
      }
      return;
    }
    if (data === 'check_accounts') {
      await ctx.reply('Последовательно проверяю профили…');
      const rows = await s.accounts.checkAll();
      return ctx.reply(
        rows.map((x) => `${x.id}: ${statusRu[x.status] ?? 'Техническая ошибка'}`).join('\n'),
      );
    }
    if (data === 'queue') return showQueue(ctx);
    if (data === 'pause' || data === 'resume') {
      await s.scheduler.pause(data === 'pause', actor(ctx));
      return ctx.reply(
        data === 'pause'
          ? 'Завод приостановлен. Уже начатая отправка может завершиться.'
          : 'Завод возобновлён.',
        { reply_markup: menu() },
      );
    }
    if (data === 'refresh_stats') {
      await ctx.reply('Обновляю доступные метрики…');
      await s.refreshMetrics();
      return showAnalytics(ctx);
    }
    if (data === 'analytics' || data === 'funnel') return showAnalytics(ctx);
    if (data.startsWith('period:')) {
      await setFlow(ctx, { days: Number(data.slice(7)) });
      return showAnalytics(ctx);
    }
    if (data === 'analytics_mode') {
      const f = await getFlow(ctx);
      await setFlow(ctx, {
        mode: f.mode === 'VIEWS_IN_PERIOD' ? 'PUBLISHED_IN_PERIOD' : 'VIEWS_IN_PERIOD',
      });
      return showAnalytics(ctx);
    }
    if (data === 'analytics_accounts') {
      const kb = new InlineKeyboard().text('Все аккаунты', 'stats_account:all').row();
      for (const a of await s.db.list('account')) kb.text(a.name, `stats_account:${a.id}`).row();
      return ctx.reply('Выберите аккаунт:', { reply_markup: kb });
    }
    if (data.startsWith('stats_account:')) {
      await setFlow(ctx, { accountId: data.slice(14) === 'all' ? undefined : data.slice(14) });
      return showAnalytics(ctx);
    }
    if (['top', 'bottom', 'top24', 'bottom24'].includes(data)) {
      const bottom = data.startsWith('bottom'),
        firstDay = data.endsWith('24'),
        rows = await s.analytics.ranking(await period(ctx), bottom, firstDay);
      const text = rows
        .map(
          (r, i) =>
            `${i + 1}. ${r.account}: ${fmt(firstDay ? r.firstDayViews : r.views)} просмотров\n${r.text.slice(0, 80)}\n${r.url}\n${dateFmt(r.publishedAt, tz(ctx))}\n1 ч: ${fmt(r.firstHourViews)}, 24 ч: ${fmt(r.firstDayViews)}, лайки: ${fmt(r.likes)}, ответы: ${fmt(r.replies)}\nПостовая атрибуция недоступна; ссылка относится к аккаунту`,
        )
        .join('\n\n');
      return ctx.reply(
        `${demo ? '🧪 ТЕСТОВЫЕ ДАННЫЕ\n' : ''}${bottom ? 'Антитоп' : 'Топ'} по ${'просмотрам к 24 часам'}\n\n${text || 'Нет доступных данных'}`,
        {
          reply_markup: new InlineKeyboard()
            .text(firstDay ? 'Все просмотры' : 'Первые 24 часа', 'performance')
            .text('Аналитика', 'analytics'),
        },
      );
    }
    if (data === 'dynamics') {
      const changes = await s.analytics.dynamics((await getFlow(ctx)).accountId);
      return ctx.reply(
        `Изменение за 7 дней к предыдущим 7 дням\n${Object.entries(changes)
          .map(
            ([k, v]) =>
              `${({ views: 'Просмотры', average: 'Средние', median: 'Медиана', followerGrowth: 'Прирост подписчиков', posts: 'Публикации', clicks: 'Переходы', joins: 'Вступления', crView: 'Конверсия' } as Record<string, string>)[k]}: ${fmt(v.absolute, 3)} (${fmt(v.percent, 3)}%)`,
          )
          .join('\n')}`,
        { reply_markup: back() },
      );
    }
    if (data === 'csv') {
      const csv = await s.analytics.csv(await period(ctx));
      return ctx.replyWithDocument(
        new InputFile(Buffer.from(csv), `${demo ? 'TEST-' : ''}content-factory.csv`),
      );
    }
    if (data === 'sources_rank' || data === 'styles_rank') {
      const rows = await s.analytics.sourceRanking(
        await period(ctx),
        data === 'sources_rank' ? 'sourceId' : 'styleId',
      );
      return ctx.reply(
        rows
          .slice(0, 10)
          .map(
            (r, i) =>
              `${i + 1}. ${r.label}\nID: ${r.id}\nВерсий: ${r.adaptations}, опубликовано: ${r.published}\nПросмотры: ${fmt(r.views)}, средние: ${fmt(r.average)}, макс.: ${fmt(r.max)}, мин.: ${fmt(r.min)}\nПостовая атрибуция недоступна; ссылка относится к аккаунту, CR: ${fmt(r.crView, 3)}%`,
          )
          .join('\n\n') || 'Данных нет.',
      );
    }
    if (data === 'library') {
      const rows = await s.library.search('');
      return ctx.reply(
        rows
          .slice(0, 12)
          .map(
            (r) =>
              `${r.id}\n${r.text.slice(0, 100)}\nПрава: ${r.rights === 'OWN' ? 'собственный' : r.rights === 'PERMITTED' ? 'разрешён' : 'требуют проверки'}`,
          )
          .join('\n\n') + '\n\n/search текст\n/reuse ID\n/rights ID OWN|PERMITTED|REVIEW',
        { reply_markup: back() },
      );
    }
    if (data === 'styles') {
      const rows = await s.db.list('style');
      return ctx.reply(
        rows
          .map(
            (r) =>
              `${r.id} — ${r.name}\nЛимит: ${r.maxLength}, абзацы: ${r.maxParagraphs}\n${r.instruction}`,
          )
          .join('\n\n') +
          '\n\nИзменение: /style ID {"instruction":"...","emoji":false}\nПример: /example ID удачный текст\nНазначение: /account_style АККАУНТ СТИЛЬ',
        { reply_markup: back() },
      );
    }
    if (data === 'cta_templates') {
      const rows = await s.db.list('cta');
      return ctx.reply(
        rows
          .slice(-20)
          .map((c) => `${c.id} — ${c.name}\n${c.text.slice(0, 100)}`)
          .join('\n\n') + '\n\n/cta_template АККАУНТ ШАБЛОН',
      );
    }
    if (data === 'retention') {
      const r = await s.retention.report(new Date(0), new Date(), (await getFlow(ctx)).accountId);
      return ctx.reply(
        `Telegram: аккаунтные когорты\nВступления: ${r.joins}; уникальные участники: ${r.uniqueMembers}\nПодтверждённые выходы: ${r.confirmedExits}\nБез источника: ${fmt(r.unknownSource)}\n\n${(
          [7, 30] as const
        )
          .map((d) => {
            const m = d === 7 ? r.d7 : r.d30;
            return `D${d}: зрелых ${m.eligible}, проверено ${m.assessed}, осталось ${m.retained}, вышло ${m.churned}, неизвестно ${m.unknown}\nRetention: ${fmt(m.retention, 3)}%, Churn: ${fmt(m.churn, 3)}%`;
          })
          .join('\n\n')}`,
        { reply_markup: new InlineKeyboard().text('Аналитика', 'analytics') },
      );
    }
    if (data === 'performance' || data.startsWith('performance:')) {
      const f = await getFlow(ctx),
        hours = data.includes(':') ? Number(data.split(':')[1]) : (f.ratingHours ?? 24);
      await setFlow(ctx, { ratingHours: hours });
      const r = await s.performance.report(hours, f.accountId);
      const kb = new InlineKeyboard();
      for (const h of [1, 6, 24, 72, 168]) kb.text(`${h} ч`, `performance:${h}`);
      kb.row().text('Аналитика', 'analytics');
      return ctx.reply(
        `${demo ? '🧪 ТЕСТОВЫЕ ДАННЫЕ\n' : ''}Рейтинг контента: сопоставление к ${hours} ч\n${r.topByViews.map((p, i) => `${i + 1}. ${fmt(p.comparisonViews)} · ${p.topic} / ${p.format}\n${p.finalText.slice(0, 80)}\n${p.url}`).join('\n\n') || 'Нет сопоставимых замеров'}\n\nТемы:\n${r.topics
          .slice(0, 5)
          .map(
            (g) =>
              `${g.name}: средние ${fmt(g.average)}, медиана ${fmt(g.median)}, постов ${g.posts}`,
          )
          .join('\n')}\nФорматы:\n${r.formats
          .slice(0, 5)
          .map(
            (g) =>
              `${g.name}: средние ${fmt(g.average)}, медиана ${fmt(g.median)}, постов ${g.posts}`,
          )
          .join('\n')}\nЛучшие шаблоны (от 10 замеров): ${
          r.templates
            .slice(0, 3)
            .map((t) => t.name)
            .join(', ') || 'недостаточно данных'
        }\nСредние: ${fmt(r.summary.average)}, медиана: ${fmt(r.summary.median)}, максимум: ${fmt(r.summary.max)}, минимум: ${fmt(r.summary.min)}\nАнтитоп: ${
          r.bottomByViews
            .slice(0, 3)
            .map((p) => `${fmt(p.comparisonViews)} — ${p.finalText.slice(0, 35)}`)
            .join('; ') || 'нет данных'
        }\nДинамика средних за 7 дней: ${fmt(r.dynamics.changes.average.absolute, 1)} (${fmt(r.dynamics.changes.average.percent, 1)}%)\nИсключено без сопоставимого замера: ${r.excluded}`,
        { reply_markup: kb },
      );
    }
    if (data === 'links')
      return ctx.reply(
        'Собственный комментарий: /cta АККАУНТ текст\nСсылка CTA: /cta_url АККАУНТ URL\nTracking: /link АККАУНТ https://t.me/...\nПриглашение с атрибуцией: /invite АККАУНТ\nПереходы не равны вступлениям. Неподтверждённый источник остаётся неизвестным.',
        {
          reply_markup: new InlineKeyboard()
            .text('Шаблоны CTA', 'cta_templates')
            .text('Меню', 'menu'),
        },
      );
    if (data === 'system') return showStatus(ctx);
    if (data === 'settings') {
      const i = await s.scheduler.interval();
      return ctx.reply(
        `Часовой пояс: ${tz(ctx)}\nИнтервал: ${i.min}–${i.max} мин.\nИсполнители: ${config.BROWSER_CONCURRENCY}\nПо умолчанию: ручное подтверждение\n\nЦель цикла: 120 минут. Для 10 аккаунтов — 12-минутные слоты и 12 минут резерва в конце окна.\n/auto АККАУНТ on|off — разрешить автоочередь\n/timezone Europe/Moscow — часовой пояс\n/help — все команды`,
        { reply_markup: back() },
      );
    }
  });
  bot.on('message:text', async (ctx) => {
    const f = await getFlow(ctx);
    if (f.step === 'template_name') {
      z.string().min(1).max(100).parse(ctx.message.text);
      await setFlow(ctx, {
        pendingTemplateName: ctx.message.text,
        step: 'template_instruction_new',
      });
      return ctx.reply(
        'Опишите способ подачи: одна мысль, формат и стиль. Факты и личный опыт придумывать нельзя.',
      );
    }
    if (f.step === 'template_instruction_new' && f.pendingTemplateName) {
      const t = await s.templates.create(f.pendingTemplateName, ctx.message.text, actor(ctx));
      await setFlow(ctx, { step: '', pendingTemplateName: undefined });
      return showTemplate(ctx, t.id);
    }
    if (f.step === 'template_instruction_edit' && f.selectedTemplateId) {
      await s.templates.update(f.selectedTemplateId, { instruction: ctx.message.text }, actor(ctx));
      await setFlow(ctx, { step: '' });
      return showTemplate(ctx, f.selectedTemplateId);
    }
    if (f.step === 'template_example' && f.selectedTemplateId) {
      await s.templates.addExample(f.selectedTemplateId, ctx.message.text, actor(ctx));
      await setFlow(ctx, { step: '' });
      return showTemplate(ctx, f.selectedTemplateId);
    }
    if (f.step === 'edit' && f.editId) {
      if (
        f.publicationMode === 'BROADCAST' &&
        f.adaptation === 'COMMON' &&
        f.draftIds?.includes(f.editId)
      ) {
        const drafts = [];
        for (const id of f.draftIds)
          drafts.push(await s.content.edit(id, ctx.message.text, actor(ctx)));
        await setFlow(ctx, { step: '', draftIds: drafts.map((g) => g.id) });
        return showDrafts(ctx);
      }

      const g = await s.content.edit(f.editId, ctx.message.text, actor(ctx));
      await setFlow(ctx, {
        step: '',
        draftIds: f.draftIds?.map((id) => (id === f.editId ? g.id : id)),
      });
      return showDrafts(ctx);
    }
    if (f.step === 'cta_text' && f.ctaAccountId) {
      await setFlow(ctx, { pendingCtaText: ctx.message.text, step: 'cta_url' });
      return ctx.reply('Отправьте HTTPS-ссылку или пропустите её.', {
        reply_markup: new InlineKeyboard()
          .text('Без ссылки', 'cta_no_link')
          .text('Отмена', 'cta_cancel'),
      });
    }
    if (f.step === 'cta_url' && f.ctaAccountId && f.pendingCtaText) {
      const url = z.string().url().parse(ctx.message.text.trim());
      assert(new URL(url).protocol === 'https:', 'INVALID_URL', 'Нужна HTTPS-ссылка');
      await setFlow(ctx, { step: 'cta_preview', pendingCtaUrl: url });
      return ctx.reply(`Новый CTA:\n${f.pendingCtaText}\n${url}`, {
        reply_markup: new InlineKeyboard()
          .text('Сохранить CTA', 'cta_save')
          .text('Отмена', 'cta_cancel'),
      });
    }
    if (f.step === 'cta_preview') return ctx.reply('Нажмите «Сохранить CTA» либо отмените правку.');
    return saveSource(ctx, ctx.message.text);
  });
  bot.on('message:document', async (ctx) => {
    const file = ctx.message.document;
    assert(
      /\.txt$/i.test(file.file_name ?? '') && (file.file_size ?? 0) <= 80000,
      'SOURCE_FILE',
      'Пришлите текст или UTF-8 файл .txt до 20 000 символов и 80 КБ',
    );
    const info = await ctx.api.getFile(file.file_id);
    assert(info.file_path, 'SOURCE_FILE', 'Telegram не вернул файл');
    const response = await fetch(
      `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${info.file_path.split('/').map(encodeURIComponent).join('/')}`,
      { signal: AbortSignal.timeout(15000) },
    );
    assert(response.ok, 'SOURCE_FILE', 'Не удалось скачать исходник из Telegram');
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert(
      bytes.length <= 80000,
      'SOURCE_LENGTH',
      'Файл больше 80 КБ; предел текста 20 000 символов',
    );
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new AppError('SOURCE_FILE', 'Нужен UTF-8 файл .txt');
    }
    return saveSource(ctx, text);
  });
  bot.on('message', (ctx) =>
    ctx.reply(
      'Этот тип сообщения не поддерживается в текущем шаге. Пришлите обычный текст до 20 000 символов или UTF-8 файл .txt. Фото CTA загружайте через «Вложение CTA».',
    ),
  );
  bot.on('edited_message', (ctx) =>
    ctx.reply(
      'Изменённое сообщение не заменяет сохранённый исходник. Нажмите «Изменить исходник» и отправьте новое сообщение.',
    ),
  );
  bot.catch(() => console.error('Ошибка обработки Telegram update; токен и payload не выводятся'));
  return bot;
}

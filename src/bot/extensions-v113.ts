import { InlineKeyboard } from './keyboard.js';
import { InputFile } from 'grammy';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { hashDocument } from '../db/documents.js';
import { audit } from '../db/database.js';
import { renderCta } from '../cta/service.js';
import { type Bot } from 'grammy';
import { getDocument, putDocument } from '../db/documents.js';
import { replyCard } from './manual-card.js';
import type { GenerationTask } from '../content/jobs.js';
import { generationCard } from './generation.js';
import type { Config } from '../core/config.js';
import type { BotServices } from './bot.js';
import { assert } from '../core/errors.js';
import { confirmSourceRights } from '../content/rights.js';
import { rightsKeyboard, rightsLabel } from './source-rights.js';
import { postCard } from './manual-card.js';
export function installV113(bot: Bot, config: Config, s: BotServices) {
  bot.callbackQuery(/^v113cta(?:send)?:/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const [action, id] = ctx.callbackQuery.data.split(':'),
      actor = String(ctx.from.id);
    await s.manual.session(actor);
    const token = action === 'v113ctasend' ? await s.manual.readCard(id!, actor) : null;
    const jobId = token?.ctaJobId ?? id!;
    const job = await s.db.get('publishJob', jobId);
    assert(job, 'NOT_FOUND', 'Задача не найдена');
    const post = (await s.db.list('post', { jobId }))[0];
    assert(post && job.postStatus === 'PUBLISHED', 'UNCERTAIN', 'Сначала нужно подтвердить пост');
    const g = (await s.db.get('generated', job.generatedId))!;
    const snapshot = hashDocument({
      jobId,
      postUrl: post.url,
      text: job.ctaText,
      url: job.ctaUrl,
      media: job.ctaMediaSha256,
      version: job.ctaVersion,
    });
    if (token?.used) return ctx.reply('Это подтверждение CTA уже принято. Повторной отправки нет');
    assert(
      job.ctaEnabled &&
        !job.ctaSubmitAt &&
        ['PENDING', 'FAILED', 'COMMENT_FAILED'].includes(job.commentStatus) &&
        job.status !== 'CANCELLED',
      'CTA_ALREADY_STARTED',
      'CTA уже отправлялся, отменён или требует сверки. Повтор запрещён',
    );
    if (action === 'v113cta') {
      const card = await s.manual.card({
        kind: 'POST',
        entityId: g.id,
        accountId: job.accountId,
        hash: hashDocument(g.text),
        version: g.version,
        sourceUrl: snapshot,
        actor,
        ctaJobId: job.id,
      });
      const text = `CTA к подтверждённому посту\n${post.url}\n\n${renderCta(job.ctaText ?? '', job.ctaUrl)}\n\nКнопка отправит только этот CTA. Основной пост повторно не отправляется`;
      const reply_markup = new InlineKeyboard()
        .text('Опубликовать этот CTA', `v113ctasend:${card.id}`)
        .row()
        .text('Отмена', `v112cancel:${card.id}`);
      if (job.ctaMediaPath) {
        const data = await readFile(job.ctaMediaPath);
        assert(
          createHash('sha256').update(data).digest('hex') === job.ctaMediaSha256,
          'MEDIA_CHANGED',
          'Фотография CTA изменилась',
        );
        return ctx.replyWithPhoto(new InputFile(data, 'cta.png'), { caption: text, reply_markup });
      }
      return ctx.reply(text, { reply_markup });
    }
    assert(
      token &&
        token.ctaJobId === job.id &&
        token.hash === hashDocument(g.text) &&
        token.version === g.version &&
        token.sourceUrl === snapshot,
      'STALE_CARD',
      'CTA изменился; откройте новый предпросмотр',
    );
    await s.db.transaction(async (tx) => {
      const c = await s.manual.readCard(token.id, actor, tx);
      assert(!c.used, 'ALREADY_STARTED', 'Подтверждение уже принято');
      const settings = await s.manual.assertAllowed(
        job.accountId,
        actor,
        c.sessionId,
        undefined,
        tx,
      );
      const current = (await tx.get('publishJob', job.id))!;
      assert(
        current.postStatus === 'PUBLISHED' &&
          !current.ctaSubmitAt &&
          current.status !== 'CANCELLED' &&
          hashDocument({
            jobId,
            postUrl: post.url,
            text: current.ctaText,
            url: current.ctaUrl,
            media: current.ctaMediaSha256,
            version: current.ctaVersion,
          }) === snapshot,
        'STALE_CARD',
        'Состояние CTA изменилось',
      );
      await putDocument(tx, `manual-post-${job.id}`, {
        actor,
        sessionId: c.sessionId,
        epoch: settings.epoch,
        accountId: job.accountId,
        generatedId: g.id,
        hash: hashDocument(g.text),
        version: g.version,
        ctaHash: snapshot,
        expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
      });
      await putDocument(tx, `manual-card-${c.id}`, { ...c, used: true, resultId: job.id });
      await tx.update('publishJob', job.id, {
        status: 'QUEUED',
        commentStatus: 'PENDING',
        scheduledAt: new Date(),
        lastError: null,
        revision: current.revision + 1,
        updatedAt: new Date(),
      });
      await audit(tx, actor, 'MANUAL_CTA_CONFIRMED', job.id, snapshot);
    });
    return ctx.reply(
      `CTA поставлен в очередь к ${post.url}. Основной пост не отправляется повторно`,
    );
  });
  bot.callbackQuery(/^v113(?:discovery|age|source|limit|skip|status):/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const [action, id, value] = ctx.callbackQuery.data.split(':'),
      actor = String(ctx.from.id);
    await s.manual.session(actor);
    if (action === 'v113status') {
      const task = await getDocument<GenerationTask>(s.db, `generation-task-${id}`);
      assert(task && task.actor === actor, 'NOT_FOUND', 'Задача не найдена');
      if (!task.replyJobId) {
        const card = await generationCard(s, task);
        return ctx.reply(card.text, { reply_markup: card.reply_markup });
      }
      const v = await s.engagement.jobView(task.replyJobId!);
      const card = await replyCard(s, v.draft!, actor);
      return ctx.reply(
        `Задача ${task.id}\n${v.job.status === 'PUBLISHED' ? 'Опубликовано, permalink подтверждён' : task.status}\n${v.job.status === 'PUBLISHED' ? '' : (task.error ?? '')}\n${card.text}`,
        {
          reply_markup: card.reply_markup,
        },
      );
    }
    if (action === 'v113skip') {
      const key = `engagement-candidate-${id}-${value}`;
      const c = await getDocument<any>(s.db, key);
      assert(c, 'NOT_FOUND', 'Публикация не найдена');
      await putDocument(s.db, key, {
        ...c,
        status: 'REJECTED',
        rejectionReasons: ['Пропущен пользователем'],
      });
      return ctx.reply('Публикация пропущена');
    }
    if (action === 'v113age' && value)
      await s.engagement.configure(
        id!,
        { maxAgeHours: Number(value) as 24 | 48 | 72 | 168 },
        actor,
      );
    if (action === 'v113source' && value)
      await s.engagement.configure(
        id!,
        { discoverySource: value as 'FEED' | 'FOR_YOU' | 'FOLLOWING' | 'RECENT' },
        actor,
      );
    if (action === 'v113limit' && value)
      await s.engagement.configure(id!, { viewLimit: Number(value) }, actor);
    const c = await s.engagement.settings(id!);
    const kb = new InlineKeyboard();
    if (action === 'v113age' && !value) {
      for (const age of [24, 48, 72, 168])
        kb.text(age === 168 ? 'До 7 дней' : `До ${age} часов`, `v113age:${id}:${age}`).row();
    }
    if (action === 'v113source' && !value) {
      for (const [key, label] of Object.entries({
        FEED: 'Лента: приоритет источников',
        FOR_YOU: 'For You',
        FOLLOWING: 'Following',
        RECENT: 'Поиск Recent',
      }))
        kb.text(label, `v113source:${id}:${key}`).row();
    }
    if (action === 'v113limit' && !value) {
      for (const n of [20, 40, 60, 100]) kb.text(String(n), `v113limit:${id}:${n}`);
      kb.row();
    }
    kb.text('Найти сейчас', `v18search:${id}`)
      .row()
      .text('Изменить источник', `v113source:${id}`)
      .text('Изменить свежесть', `v113age:${id}`)
      .row()
      .text('Изменить категорию', `v18cfg:${id}:cat`)
      .text('Изменить лимит', `v113limit:${id}`)
      .row()
      .text('Кандидаты', `v18candidates:${id}`)
      .text('Черновики ответов', `v18drafts:${id}`)
      .row()
      .text('История', `v18history:${id}`)
      .text('Назад', `v18e:${id}`);
    return ctx.reply(
      `Поиск публикаций\nИсточник: ${c.discoverySource}\nКатегория: ${c.categories.join(', ')}\nФильтр: ${c.strictness}\nВозраст: до ${c.maxAgeHours} часов\nЛимит просмотра: ${c.viewLimit}\nСессий/сутки: ${c.sessionsPerDay}\nОтветов/сутки: ${c.dailyReplies}\nИнтервал: ${c.minIntervalMinutes}–${c.maxIntervalMinutes} минут`,
      { reply_markup: kb },
    );
  });
  bot.callbackQuery(/^v113rights?:/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const [action, kind, id] = ctx.callbackQuery.data.split(':'),
      actor = String(ctx.from.id);
    await s.manual.session(actor);
    const sourceId = action === 'v113rights' ? kind! : id!;
    assert(await s.db.get('source', sourceId), 'NOT_FOUND', 'Исходник не найден');
    if (action === 'v113right') {
      assert(
        ['OWN', 'PERMITTED', 'THIRD_PARTY'].includes(kind!),
        'INVALID_RIGHTS',
        'Неизвестное происхождение',
      );
      await confirmSourceRights(s.db, sourceId, kind as 'OWN' | 'PERMITTED' | 'THIRD_PARTY', actor);
      await ctx.reply(
        'Происхождение сохранено: ' +
          (await rightsLabel(s.db, sourceId)) +
          '. Повторная генерация не нужна',
      );
      const g = (await s.db.list('generated', { sourceId })).sort(
        (a, b) => b.version - a.version,
      )[0];
      if (g) {
        const card = await postCard(s, g.id, actor);
        return ctx.reply(card.text, { reply_markup: card.reply_markup });
      }
      return;
    }
    return ctx.reply(
      'Укажите происхождение исходника. Неподтверждённый чужой материал не разрешается публиковать',
      { reply_markup: rightsKeyboard(sourceId) },
    );
  });
}

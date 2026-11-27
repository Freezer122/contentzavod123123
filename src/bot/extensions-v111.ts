import { InlineKeyboard } from './keyboard.js';
import { replyCard } from './manual-card.js';
import { InputFile, type Bot, type Context } from 'grammy';
import { getDocument, putDocument } from '../db/documents.js';
import type { Config } from '../core/config.js';
import type { BotServices } from './bot.js';
import { replyJobCard } from './reply-card.js';
import { assert } from '../core/errors.js';
import { replyLengths, type ReplyLength } from '../engagement/reply-style.js';
import { NORMALIZER_VERSION } from '../content/normalizer.js';
export function installV111(bot: Bot, config: Config, s: BotServices) {
  async function abCard(ctx: Context, id: string) {
    const actor = String(ctx.from!.id),
      e = await s.quality.experiment(id),
      index = await s.quality.experimentCursor(id, actor),
      pair = e.pairs[index];
    if (!pair)
      return ctx.reply('Все пары просмотрены. Итоги доступны ниже', {
        reply_markup: new InlineKeyboard()
          .text('Результаты', `v115abstats:${id}`)
          .row()
          .text('Главное меню', 'menu'),
      });
    const ready = pair.order.every((m) => pair.results[m] && pair.results[m]!.status !== 'RUNNING'),
      kb = new InlineKeyboard();
    if (ready)
      kb.text('Лучше A', `v115abvote:${id}:${index}:A`)
        .text('Лучше B', `v115abvote:${id}:${index}:B`)
        .row()
        .text('Одинаково', `v115abvote:${id}:${index}:TIE`)
        .text('Оба плохие', `v115abvote:${id}:${index}:BAD`)
        .row()
        .text('Следующий', `v115abnext:${id}:${index}`);
    else kb.text('Обновить', `v115abopen:${id}`);
    kb.row()
      .text('Полная пара файлом', `v115abfull:${id}:${index}`)
      .row()
      .text('Результаты', `v115abstats:${id}`)
      .text('Тест моделей', 'v115abmenu');
    const answers = pair.order
      .map((model, i) => {
        const r = pair.results[model];
        return `${i === 0 ? 'A' : 'B'}:\n${r?.text.slice(0, 700) || 'Ответ не получен'}${r?.text && r.text.length > 700 ? '\nПолный текст доступен файлом' : ''}${r?.errors.length ? '\nТребует просмотра: ' + r.errors.join('; ').slice(0, 300) : ''}`;
      })
      .join('\n\n');
    return ctx.reply(
      `Слепое сравнение · ${index + 1}/${e.pairs.length}\n${pair.source.url}\n\n${pair.source.text.slice(0, 1500)}\n\n${answers}\n\nТолько оценка, без публикации`,
      { reply_markup: kb },
    );
  }
  const manners = { RESTRAINED: 'Сдержанная', LIVELY: 'Живая', HARSH: 'Жёсткая' } as const;
  async function exampleCard(ctx: Context, id: string) {
    const e = await s.quality.humanExample(id),
      accounts = await s.db.list('account');
    return ctx.reply(
      `Мой человеческий пример · ${e.id}\nИсходный пост:\n${e.source.slice(0, 1200)}\n\nМой ответ:\n${e.answer}\n\nМанера: ${manners[e.manner]}\nАккаунты: ${
        accounts
          .filter((a) => e.accountIds.includes(a.id))
          .map((a) => a.name)
          .join(', ') || 'не назначены'
      }\nВерсия: ${e.version}`,
      {
        reply_markup: new InlineKeyboard()
          .text('Изменить исходник', `v114edit:${id}:source`)
          .text('Изменить ответ', `v114edit:${id}:answer`)
          .row()
          .text('Назначить аккаунтам', `v114assign:${id}`)
          .text('Удалить', `v114delete:${id}`)
          .row()
          .text('Полный пример файлом', `v114full:${id}`)
          .text('Мои примеры', 'v114examples:all'),
      },
    );
  }
  bot.use(async (ctx, next) => {
    if (ctx.callbackQuery?.data) await s.db.remove('setting', `human-example-flow-${ctx.from!.id}`);
    await next();
  });
  bot.callbackQuery(/^(v111|v114|v115ab)/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const [action, id, extra] = ctx.callbackQuery.data.split(':'),
      actor = String(ctx.from.id);
    if (action?.startsWith('v114') || action?.startsWith('v115ab')) await s.manual.session(actor);
    if (action === 'v115abmenu') {
      const current = await getDocument<{ id: string }>(s.db, 'model-experiment-current-threads02');
      return ctx.reply(
        'Тест моделей → Sol vs Terra. Модели скрыты под A/B; выбор сохраняется отдельно от публикаций',
        {
          reply_markup: current
            ? new InlineKeyboard()
                .text('Sol vs Terra', `v115abopen:${current.id}`)
                .row()
                .text('Итоги', `v115abstats:${current.id}`)
            : new InlineKeyboard().text('Главное меню', 'menu'),
        },
      );
    }
    if (action === 'v115abopen') return abCard(ctx, id!);
    if (action === 'v115abfull') {
      const e = await s.quality.experiment(id!),
        pair = e.pairs[Number(extra)];
      assert(pair && e.actor === actor, 'NOT_FOUND', 'Пара не найдена');
      return ctx.replyWithDocument(
        new InputFile(
          Buffer.from(
            `${pair.source.url}\n\n${pair.source.text}\n\n` +
              pair.order
                .map(
                  (m, i) =>
                    `${i === 0 ? 'A' : 'B'}:\n${pair.results[m]?.text ?? 'Ответ не получен'}\n${pair.results[m]?.errors.join('; ') ?? ''}`,
                )
                .join('\n\n'),
          ),
          'blind-pair.txt',
        ),
      );
    }
    if (action === 'v115abvote') {
      const vote = ctx.callbackQuery.data.split(':')[3];
      assert(['A', 'B', 'TIE', 'BAD'].includes(vote!), 'VOTE', 'Выберите оценку');
      await s.quality.voteExperiment(id!, Number(extra), vote as 'A' | 'B' | 'TIE' | 'BAD', actor);
      return ctx.reply('Оценка сохранена. Отправки в Threads нет', {
        reply_markup: new InlineKeyboard()
          .text('Следующий', `v115abnext:${id}:${extra}`)
          .row()
          .text('Итоги', `v115abstats:${id}`),
      });
    }
    if (action === 'v115abnext') {
      await s.quality.experimentNext(id!, Number(extra), actor);
      return abCard(ctx, id!);
    }
    if (action === 'v115abstats') {
      const stats = await s.quality.experimentStats(id!);
      if (stats.rated < stats.reviewablePairs)
        return ctx.reply(
          `Sol vs Terra · ${stats.status}\nПар: ${stats.pairs}, оценено: ${stats.rated}\nОбщий расход: $${stats.costUsd.toFixed(6)}\nРезультаты по моделям будут показаны после оценки всех пар, чтобы сохранить слепое сравнение`,
          {
            reply_markup: new InlineKeyboard()
              .text('Продолжить', `v115abopen:${id}`)
              .row()
              .text('Тест моделей', 'v115abmenu'),
          },
        );
      const examples = [
        ...stats.bestExamples
          .slice(0, 2)
          .map((e) => `Лучший (${e.model}): ${e.text.slice(0, 120)}\n${e.source}`),
        ...stats.worstExamples
          .slice(0, 2)
          .map((e) => `Худший (${e.model}): ${e.text.slice(0, 120)}\n${e.source}`),
      ].join('\n');
      const groups = stats.groups
        .map(
          (g) =>
            `${g.tone === 'HUMOR' ? 'Юмор' : 'Серьёзные'}: ${g.rated}/${g.pairs}, Sol ${g.wins.SOL}, Terra ${g.wins.TERRA}, ничьи ${g.wins.TIE}, обе плохие ${g.wins.BAD}${g.rated < 5 ? ' — мало данных для выводов' : ''}`,
        )
        .join('\n');
      return ctx.reply(
        `Sol vs Terra · ${stats.status}\nПар: ${stats.pairs}, оценено: ${stats.rated}\nПобеды Sol: ${stats.wins.SOL}\nПобеды Terra: ${stats.wins.TERRA}\nНичьи: ${stats.wins.TIE}\nОба плохие: ${stats.wins.BAD}\nРасход: $${stats.costUsd.toFixed(6)}\nSol: средняя цена $${stats.SOL.averageCostUsd.toFixed(6)}, длина ${stats.SOL.averageLength.toFixed(0)}, требуют правки ${stats.SOL.needsEditPercent.toFixed(1)}%\nTerra: средняя цена $${stats.TERRA.averageCostUsd.toFixed(6)}, длина ${stats.TERRA.averageLength.toFixed(0)}, требуют правки ${stats.TERRA.needsEditPercent.toFixed(1)}%\n${groups}\n${examples}\n${stats.conclusion}`,
        {
          reply_markup: new InlineKeyboard()
            .text('Продолжить', `v115abopen:${id}`)
            .row()
            .text('Тест моделей', 'v115abmenu'),
        },
      );
    }
    if (action === 'v114rate') {
      assert(id === 'GOOD' || id === 'BAD', 'RATING', 'Неизвестная оценка');
      await s.quality.rateReply(extra!, id, actor);
      return ctx.reply('Оценка ответа сохранена. Права публикации не менялись');
    }
    if (action === 'v114examples') {
      const rows = await s.quality.humanExamples(id === 'all' ? undefined : id),
        kb = new InlineKeyboard();
      for (const e of rows.slice(-30)) kb.text(e.answer.slice(0, 45), `v114view:${e.id}`).row();
      return ctx.reply(
        'Мои примеры — вручную добавленные положительные пары. Они не смешиваются с AI-генерациями',
        {
          reply_markup: kb
            .text('Добавить пример', `v114add:${id}`)
            .row()
            .text('Главное меню', 'menu'),
        },
      );
    }
    if (action === 'v114view') return exampleCard(ctx, id!);
    if (action === 'v114full') {
      const e = await s.quality.humanExample(id!);
      return ctx.replyWithDocument(
        new InputFile(
          Buffer.from(`Исходный пост:\n${e.source}\n\nМой ответ:\n${e.answer}`),
          'human-example.txt',
        ),
      );
    }
    if (action === 'v114delete') {
      await s.quality.deleteHuman(id!, actor);
      return ctx.reply('Пример удалён из активной библиотеки. История сохранена');
    }
    if (action === 'v114add') {
      if (id === 'all') {
        const kb = new InlineKeyboard();
        for (const a of await s.db.list('account')) kb.text(a.name, `v114add:${a.id}`).row();
        return ctx.reply('Выберите аккаунт для примера', { reply_markup: kb });
      }
      await s.db.remove('setting', `v18-flow-${actor}`);
      const pending = await getDocument<any>(s.db, `flow-${actor}`);
      if (pending) await putDocument(s.db, `flow-${actor}`, { ...pending, step: '' });
      await putDocument(s.db, `human-example-flow-${actor}`, { step: 'source', accountId: id });
      return ctx.reply(
        'Пришли текст исходного поста. Следующим сообщением — свой человеческий ответ',
        { reply_markup: new InlineKeyboard().text('Отмена', `v114cancel:${id}`) },
      );
    }
    if (action === 'v114cancel') {
      await s.db.remove('setting', `human-example-flow-${actor}`);
      return ctx.reply('Добавление или редактирование примера отменено');
    }
    if (action === 'v114edit') {
      const e = await s.quality.humanExample(id!);
      assert(extra === 'source' || extra === 'answer', 'FIELD', 'Неизвестное поле');
      await s.db.remove('setting', `v18-flow-${actor}`);
      const pending = await getDocument<any>(s.db, `flow-${actor}`);
      if (pending) await putDocument(s.db, `flow-${actor}`, { ...pending, step: '' });
      await putDocument(s.db, `human-example-flow-${actor}`, {
        step: 'edit',
        id: e.id,
        field: extra,
      });
      return ctx.reply(
        extra === 'source'
          ? 'Пришли новый текст исходного поста'
          : 'Пришли свой новый человеческий ответ',
        { reply_markup: new InlineKeyboard().text('Отмена', `v114cancel:${id}`) },
      );
    }
    if (action === 'v114assign' || action === 'v114toggle') {
      let e = await s.quality.humanExample(id!);
      if (action === 'v114toggle') {
        const ids = new Set(e.accountIds);
        if (ids.has(extra!)) ids.delete(extra!);
        else ids.add(extra!);
        e = await s.quality.saveHuman({ ...e, accountIds: [...ids] }, actor, e.id);
      }
      const kb = new InlineKeyboard();
      for (const a of await s.db.list('account'))
        kb.text(
          `${e.accountIds.includes(a.id) ? '✓ ' : ''}${a.name}`,
          `v114toggle:${e.id}:${a.id}`,
        ).row();
      return ctx.reply('Назначение примера аккаунтам', {
        reply_markup: kb.text('К примеру', `v114view:${e.id}`),
      });
    }
    if (['v111style', 'v111len', 'v114manner', 'v114flag'].includes(action!)) {
      const accountId = action === 'v111style' ? id! : extra!;
      if (action === 'v111len') {
        assert(id && id in replyLengths, 'STYLE', 'Неизвестная длина');
        await s.engagement.configure(accountId, { replyLength: id as ReplyLength }, actor);
      }
      if (action === 'v114manner') {
        assert(id && id in manners, 'MANNER', 'Неизвестная манера');
        await s.engagement.configure(accountId, { replyManner: id as keyof typeof manners }, actor);
      }
      if (action === 'v114flag') {
        const fields = { MAT: 'replyProfanity', SLANG: 'replySlang', HUMOR: 'replyHumor' } as const;
        assert(id && id in fields, 'FLAG', 'Неизвестная настройка');
        const field = fields[id as keyof typeof fields],
          old = await s.engagement.settings(accountId);
        await s.engagement.configure(accountId, { [field]: !old[field] }, actor);
      }
      const settings = await s.engagement.settings(accountId),
        p = replyLengths[settings.replyLength];
      const kb = new InlineKeyboard();
      for (const [value, label] of Object.entries(manners))
        kb.text(
          `${settings.replyManner === value ? '✓ ' : ''}${label}`,
          `v114manner:${value}:${accountId}`,
        ).row();
      kb.text(
        `Мат: ${settings.replyProfanity ? 'разрешён' : 'выключен'}`,
        `v114flag:MAT:${accountId}`,
      )
        .row()
        .text(
          `Сленг: ${settings.replySlang ? 'включён' : 'выключен'}`,
          `v114flag:SLANG:${accountId}`,
        )
        .row()
        .text(
          `Юмор: ${settings.replyHumor ? 'разрешён' : 'выключен'}`,
          `v114flag:HUMOR:${accountId}`,
        )
        .row();
      for (const [value, style] of Object.entries(replyLengths))
        kb.text(
          `${value === settings.replyLength ? '✓ ' : ''}${style.label}`,
          `v111len:${value}:${accountId}`,
        ).row();
      return ctx.reply(
        `Стиль ответов\nМодель: ${config.REPLY_MODEL}\nЯзык: русский\nМанера: ${manners[settings.replyManner]}\nДлина: ${p.label}, ориентир ${p.target}, до ${p.max} символов\nПредложения: 1–${p.sentences}\nTextNormalizer: ${NORMALIZER_VERSION}\nЭмодзи, точки в конце абзацев, длинные/средние тире: выключены\nИзменение стиля не переписывает старые одобренные ответы`,
        {
          reply_markup: kb
            .text('Мои примеры', `v114examples:${accountId}`)
            .row()
            .text('Назад', `v18e:${accountId}`),
        },
      );
    }
    if (action === 'v111approved') {
      const jobs = (await s.engagement.jobs(id)).filter(
        (j) => j.kind === 'REPLY' && /^\d+$/.test(j.actor),
      );
      const kb = new InlineKeyboard();
      for (const j of jobs.slice(-20)) {
        const v = await s.engagement.jobView(j.id);
        if (v.approvalStatus === 'APPROVED')
          kb.text(`${v.executionStatus} · ${v.draft?.text.slice(0, 35)}`, `v111job:${j.id}`).row();
      }
      return ctx.reply('Одобренные ответы. Одобрение не означает публикацию', {
        reply_markup: kb.text('Назад', `v18e:${id}`),
      });
    }
    if (action === 'v111job') {
      const view = await s.engagement.jobView(id!);
      const card = view.draft
        ? await replyCard(s, view.draft, actor)
        : await replyJobCard(s.engagement, id!, config);
      return ctx.reply(card.text, { reply_markup: card.reply_markup });
    }
    if (action === 'v111cancel') {
      await s.engagementQueue.permissions.revoke(id!, actor);
      return ctx.reply('Разовое разрешение отменено. Ответ не отправлен');
    }
    if (action === 'v111confirm') {
      const p = await s.engagementQueue.permissions.confirm(id!, actor);
      const task = await s.generation.enqueue({
        kind: 'REPLY_SEND',
        replyJobId: p.jobId,
        accountId: p.accountId,
        permissionId: p.id,
        actor,
        chatId: ctx.chat!.id,
      });
      return ctx.reply(
        `Подтверждено выполнение только ответа ${p.jobId}. Задача ${task.id}; остальные очереди и режимы не изменяются`,
      );
    }
    if (action === 'v111publish') {
      const view = await s.engagement.jobView(id!);
      assert(view.draft, 'NOT_FOUND', 'Ответ не найден');
      const card = await replyCard(s, view.draft, actor);
      return ctx.reply(card.text, { reply_markup: card.reply_markup });
    }
    if (['v111publish', 'v111verify', 'v111dry'].includes(action!)) {
      const view = await s.engagement.jobView(id!);
      if (
        view.executionStatus === 'PUBLISHED' ||
        (view.executionStatus === 'UNCERTAIN' && action !== 'v111verify')
      ) {
        const card = await replyJobCard(s.engagement, id!, config);
        return ctx.reply(card.text, { reply_markup: card.reply_markup });
      }
      const kind =
        action === 'v111publish'
          ? 'REPLY_CHECK'
          : action === 'v111verify'
            ? 'REPLY_VERIFY'
            : 'REPLY_DRY';
      const task = await s.generation.enqueue(
        { kind, replyJobId: id!, accountId: view.job.accountId, actor, chatId: ctx.chat!.id },
        String(ctx.update.update_id),
      );
      return ctx.reply(
        `Проверяю выбранный ответ без отправки. Задача ${task.id}. Финальное LIVE-подтверждение возможно только с адресным разрешением оператора`,
      );
    }
    if (action === 'v111regen') {
      const d = (await s.engagement.drafts(extra!)).find((d) => d.id === id);
      assert(d, 'NOT_FOUND', 'Черновик не найден');
      assert(
        d.status !== 'REJECTED',
        'APPROVED_IMMUTABLE',
        'Сначала измените одобренный текст отдельно',
      );
      const task = await s.generation.enqueue(
        {
          kind: 'REPLY',
          accountId: d.accountId,
          candidateId: d.candidateId,
          actor,
          chatId: ctx.chat!.id,
          force: true,
        },
        String(ctx.update.update_id),
      );
      return ctx.reply(`Генерирую новый вариант по вашей команде, задача ${task.id}`);
    }
  });
  bot.on('message:text', async (ctx, next) => {
    const actor = String(ctx.from.id),
      key = `human-example-flow-${actor}`,
      flow = await getDocument<any>(s.db, key);
    if (!flow) return next();
    if (ctx.message.text.startsWith('/')) {
      await s.db.remove('setting', key);
      return next();
    }
    await s.manual.session(actor);
    const text = ctx.message.text;
    if (flow.step === 'source') {
      assert(
        text.trim() && text.length <= 5000,
        'EXAMPLE_LENGTH',
        'Нужен исходный текст до 5000 символов',
      );
      await putDocument(s.db, key, { ...flow, step: 'answer', source: text });
      return ctx.reply('Теперь пришли свой человеческий ответ', {
        reply_markup: new InlineKeyboard().text('Отмена', `v114cancel:${flow.accountId}`),
      });
    }
    if (flow.step === 'answer') {
      const settings = await s.engagement.settings(flow.accountId);
      const e = await s.quality.saveHuman(
        {
          source: flow.source,
          answer: text,
          accountIds: [flow.accountId],
          manner: settings.replyManner,
        },
        actor,
      );
      await s.db.remove('setting', key);
      return exampleCard(ctx, e.id);
    }
    if (flow.step === 'edit') {
      const e = await s.quality.humanExample(flow.id);
      await s.quality.saveHuman({ ...e, [flow.field]: text }, actor, e.id);
      await s.db.remove('setting', key);
      return exampleCard(ctx, e.id);
    }
    return next();
  });
}

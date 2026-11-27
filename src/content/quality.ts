import type { Database } from '../db/database.js';
import { base, audit } from '../db/database.js';
import { assert } from '../core/errors.js';
import { ratio } from '../analytics/service.js';
import { getDocument, putDocument, listDocuments, hashDocument } from '../db/documents.js';
import { randomUUID, randomInt } from 'node:crypto';
import {
  hasProfanity,
  type ReplyVoice,
  replyPrompt,
  checkReply,
  normalizeReply,
} from '../engagement/reply-style.js';
import type { Candidate, EngagementSettings } from '../engagement/service.js';
import type { ContentEngine } from './service.js';
import { freshness } from '../engagement/freshness.js';
import { tradingRelevance } from '../engagement/relevance.js';
import { isRussian } from './normalizer.js';
import { withProfileLease } from '../scheduler/lease.js';
import { AppError } from '../core/errors.js';
export const experimentModels = { SOL: 'gpt-6.2-sol', TERRA: 'gpt-6.1-terra' } as const;
export type ExperimentModel = keyof typeof experimentModels;
export interface ExperimentResult {
  status: 'RUNNING' | 'VALID' | 'NEEDS_EDIT' | 'FAILED' | 'UNKNOWN';
  text: string;
  rawText?: string;
  errors: string[];
  requestId?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number;
  elapsedMs: number;
  startedAt: string;
  error?: string;
}
export interface ModelExperiment {
  id: string;
  accountId: string;
  actor: string;
  createdAt: string;
  status: 'PREPARED' | 'RUNNING' | 'READY' | 'STOPPED';
  error?: string;
  limitUsd: number;
  maxRequests: number;
  settings: EngagementSettings;
  pairs: {
    id: string;
    source: Candidate;
    prompt: string;
    examples: { id: string; source: string; answer: string }[];
    order: ExperimentModel[];
    tone: 'HUMOR' | 'SERIOUS';
    results: Partial<Record<ExperimentModel, ExperimentResult>>;
  }[];
}
export interface HumanExample {
  id: string;
  source: string;
  answer: string;
  accountIds: string[];
  manner: ReplyVoice['replyManner'];
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  deletedAt?: string;
  origin: 'HUMAN';
  positive: true;
}
const words = (s: string) =>
  new Set(
    (
      s
        .toLowerCase()
        .replace(/ё/g, 'е')
        .match(/[а-яa-z]{3,}/g) ?? []
    )
      .filter(
        (w) =>
          ![
            'это',
            'как',
            'что',
            'для',
            'или',
            'все',
            'так',
            'уже',
            'тоже',
            'когда',
            'было',
            'есть',
          ].includes(w),
      )
      .map((w) => (w.length > 5 ? w.slice(0, -2) : w)),
  );
const topic = (s: string) =>
  /трейд|битко|btc|eth|крипт|фад|фуд|шорт|лонг|позы|хаи|лои|рыно|рынк|сделк|ликвид|золот|риск/iu.test(
    s,
  )
    ? 'TRADING'
    : /нейросет|алгоритм|аськ|форум|интернет|искусственн/iu.test(s)
      ? 'AI'
      : 'GENERAL';
export class GenerationQuality {
  constructor(private db: Database) {}
  async experiment(id: string) {
    const e = await getDocument<ModelExperiment>(this.db, 'model-experiment-' + id);
    assert(e, 'NOT_FOUND', 'Эксперимент не найден');
    return e;
  }
  async createExperiment(
    accountId: string,
    actor: string,
    candidates: Candidate[],
    settings: EngagementSettings,
    id = 'v115-sol-terra-01',
  ) {
    const old = await getDocument<ModelExperiment>(this.db, 'model-experiment-' + id);
    if (old) return old;
    const account = await this.db.get('account', accountId);
    assert(account, 'NOT_FOUND', 'Аккаунт не найден');
    const seenUrls = new Set<string>(),
      seenTexts = new Set<string>(),
      authors = new Map<string, number>();
    const eligible = candidates.filter(
      (c) =>
        c.extractionVersion === 'threads-body-v115' &&
        ['NEW', 'DRAFTED'].includes(c.status) &&
        c.author.toLowerCase() !== account.username.toLowerCase() &&
        freshness(c, 48).accepted &&
        isRussian(c.text) &&
        c.repliesAvailable &&
        c.text.trim().length >= 40 &&
        tradingRelevance(c.text, 'STRICT', settings.exclusions, settings.keywords).accepted,
    );
    const selected: Candidate[] = [];
    // Round-robin authors, bounded to two inputs per author; never fill with rejected/stale inputs.
    for (let round = 0; round < 2; round++)
      for (const c of eligible) {
        if (selected.length === 20) break;
        const fingerprint = hashDocument(c.text.trim().replace(/\s+/g, ' ').toLowerCase());
        if (
          seenUrls.has(c.url) ||
          seenTexts.has(fingerprint) ||
          (authors.get(c.author) ?? 0) !== round
        )
          continue;
        seenUrls.add(c.url);
        seenTexts.add(fingerprint);
        authors.set(c.author, round + 1);
        selected.push(c);
      }
    assert(
      selected.length,
      'NO_SAMPLE',
      'Нет свежих подходящих исходников; старые и нерелевантные не добавлялись',
    );
    const flip = randomInt(2),
      pairs: ModelExperiment['pairs'] = [];
    for (const [index, c] of selected.entries()) {
      const examples = await this.selectHuman(accountId, c.text, settings);
      pairs.push({
        id: hashDocument({ id, url: c.url }).slice(0, 16),
        source: c,
        prompt: replyPrompt(settings.replyLength, settings, examples),
        examples: examples.map((e) => ({ id: e.id, source: e.source, answer: e.answer })),
        order: (index + flip) % 2 ? ['SOL', 'TERRA'] : ['TERRA', 'SOL'],
        tone: /😂|😆|ахах|сорри|шут/iu.test(c.text) ? 'HUMOR' : 'SERIOUS',
        results: {},
      });
    }
    const experiment: ModelExperiment = {
      id,
      accountId,
      actor,
      createdAt: new Date().toISOString(),
      status: 'PREPARED',
      limitUsd: 0.25,
      maxRequests: 40,
      settings: { ...settings, maxAgeHours: 48, strictness: 'STRICT' },
      pairs,
    };
    await putDocument(this.db, 'model-experiment-' + id, experiment);
    await putDocument(this.db, 'model-experiment-current-' + accountId, { id });
    await audit(
      this.db,
      actor,
      'CREATE_MODEL_EXPERIMENT',
      id,
      JSON.stringify({ pairs: pairs.length, maxRequests: 40, limitUsd: 0.25 }),
    );
    return experiment;
  }
  async experimentStep(id: string, content: ContentEngine) {
    return withProfileLease(this.db, 'model-experiment-step-' + id, async () => {
      const e = await this.experiment(id);
      if (['READY', 'STOPPED'].includes(e.status)) return e;
      const pair = e.pairs.find((p) =>
        p.order.some((m) => !p.results[m] || p.results[m]!.status === 'RUNNING'),
      );
      if (!pair) {
        e.status = 'READY';
        return putDocument(this.db, 'model-experiment-' + id, e);
      }
      const model = pair.order.find(
          (m) => !pair.results[m] || pair.results[m]!.status === 'RUNNING',
        )!,
        previous = pair.results[model],
        recovering = previous?.status === 'RUNNING';
      const startedAt = previous?.startedAt ?? new Date().toISOString();
      pair.results[model] = {
        status: 'RUNNING',
        model: experimentModels[model],
        text: '',
        errors: [],
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        costUsd: 0,
        elapsedMs: 0,
        startedAt,
      };
      e.status = 'RUNNING';
      await putDocument(this.db, 'model-experiment-' + id, e);
      const label = pair.id + ':' + model,
        begin = Date.now();
      let text = '',
        rawText = '',
        failure: unknown,
        requestId: string | undefined;
      try {
        assert(
          recovering || freshness(pair.source, 48).accepted,
          'STALE_AB_SOURCE',
          'Исходник вышел за 48 часов. Новый запрос не выполнен',
        );
        const ready = await content
          .variantReplyModel(experimentModels[model])
          .readiness(e.accountId, 'REPLY');
        // Recovery is allowed to read cached paid results even while new requests are blocked.
        assert(recovering || ready.available, 'AI_BUDGET', ready.reason);
        const response = await content
          .variantReplyModel(experimentModels[model])
          .auxiliary(e.accountId, 'REPLY', pair.source.text, pair.prompt, {
            version: 'model-ab-v115-human',
            maxTokens: 1024,
            allowInvalid: true,
            cacheSalt: id + ':' + pair.id,
            cacheOnly: recovering,
            scope: { id, label, limitUsd: 0.25, maxRequests: 40 },
          });
        text = response.text;
        rawText = response.text;
        requestId = response.requestId;
      } catch (err) {
        failure = err;
      }
      const scope = await getDocument<{ entries: { requestId: string; label: string }[] }>(
        this.db,
        'llm-scope-' + id,
      );
      requestId ??= scope?.entries.filter((x) => x.label === label).at(-1)?.requestId;
      const request = requestId ? await this.db.get('aiRequest', requestId) : null;
      if (!text && requestId) {
        const receipt = await getDocument<any>(this.db, 'llm-response-' + requestId);
        rawText =
          receipt?.text ??
          (receipt?.output ?? [])
            .filter((o: any) => o.type === 'message')
            .flatMap((o: any) => o.content ?? [])
            .filter((o: any) => o.type === 'output_text')
            .map((o: any) => o.text)
            .join('\n');
        text = rawText ?? '';
      }
      text = normalizeReply(text);
      const errors = checkReply(text, pair.source.text, e.settings.replyLength, e.settings);
      if (
        pair.examples.some(
          (ex) =>
            normalizeReply(ex.answer) === text &&
            normalizeReply(ex.source) !== normalizeReply(pair.source.text),
        )
      )
        errors.push('Дословное повторение человеческого примера');
      const error =
        failure instanceof AppError
          ? failure.message
          : failure
            ? 'Техническая ошибка модели; автоматического повтора нет'
            : undefined;
      if (error) errors.push(error);
      pair.results[model] = {
        status:
          request?.status === 'UNKNOWN' || request?.status === 'RESERVED'
            ? 'UNKNOWN'
            : failure
              ? 'FAILED'
              : errors.length
                ? 'NEEDS_EDIT'
                : 'VALID',
        model: request?.model ?? experimentModels[model],
        text,
        rawText,
        errors,
        requestId,
        inputTokens: request?.inputTokens ?? 0,
        outputTokens: request?.outputTokens ?? 0,
        reasoningTokens: request?.reasoningTokens ?? 0,
        costUsd: request?.costUsd ?? 0,
        elapsedMs: recovering
          ? Math.max(0, Date.now() - Date.parse(startedAt))
          : Date.now() - begin,
        startedAt,
        error,
      };
      if (
        pair.results[model]!.status === 'UNKNOWN' ||
        (failure instanceof AppError &&
          ['AB_BUDGET', 'AI_BUDGET', 'AI_UNCERTAIN', 'OPENAI_REJECTED'].includes(failure.code))
      ) {
        e.status = 'STOPPED';
        e.error = error;
      } else if (
        e.pairs.every((p) =>
          p.order.every((m) => p.results[m] && p.results[m]!.status !== 'RUNNING'),
        )
      )
        e.status = 'READY';
      await putDocument(this.db, 'model-experiment-' + id, e);
      return e;
    });
  }
  async experimentCursor(id: string, actor: string) {
    let index =
      (await getDocument<{ index: number }>(this.db, `model-ab-cursor-${id}-${actor}`))?.index ?? 0;
    const e = await this.experiment(id),
      ready = (i: number) =>
        e.pairs[i]?.order.every(
          (m) => e.pairs[i]!.results[m] && e.pairs[i]!.results[m]!.status !== 'RUNNING',
        );
    if (index >= e.pairs.length || (e.status === 'STOPPED' && !ready(index))) {
      const votes = await listDocuments<{ index: number }>(this.db, `model-ab-vote-${id}-`),
        rated = new Set(votes.map((v) => v.index));
      const next = e.pairs.findIndex((_p, i) => ready(i) && !rated.has(i));
      index = next < 0 ? e.pairs.length : next;
      await putDocument(this.db, `model-ab-cursor-${id}-${actor}`, { index });
    }
    return index;
  }
  async experimentNext(id: string, index: number, actor: string) {
    const e = await this.experiment(id);
    assert(actor === e.actor, 'FORBIDDEN', 'Только владелец эксперимента');
    const current = await this.experimentCursor(id, actor);
    if (current === index)
      await putDocument(this.db, `model-ab-cursor-${id}-${actor}`, {
        index: Math.min(index + 1, e.pairs.length),
      });
  }
  async voteExperiment(id: string, index: number, vote: 'A' | 'B' | 'TIE' | 'BAD', actor: string) {
    const e = await this.experiment(id),
      pair = e.pairs[index];
    assert(actor === e.actor && pair, 'FORBIDDEN', 'Пара не найдена или другой владелец');
    assert(
      ['A', 'B', 'TIE', 'BAD'].includes(vote) &&
        pair.order.every((m) => pair.results[m] && pair.results[m]!.status !== 'RUNNING'),
      'NOT_READY',
      'Пара ещё не подготовлена',
    );
    await putDocument(this.db, `model-ab-vote-${id}-${index}-${actor}`, {
      id,
      index,
      vote,
      actor,
      at: new Date().toISOString(),
      models: pair.order,
    });
    await audit(this.db, actor, 'VOTE_MODEL_EXPERIMENT', id, JSON.stringify({ index, vote }));
  }
  async experimentStats(id: string) {
    const e = await this.experiment(id),
      votes = await listDocuments<{ index: number; vote: 'A' | 'B' | 'TIE' | 'BAD' }>(
        this.db,
        `model-ab-vote-${id}-`,
      );
    const wins = { SOL: 0, TERRA: 0, TIE: 0, BAD: 0 };
    for (const v of votes) {
      if (v.vote === 'A' || v.vote === 'B')
        wins[e.pairs[v.index]!.order[v.vote === 'A' ? 0 : 1]!]++;
      else wins[v.vote]++;
    }
    const metrics = (model: ExperimentModel) => {
      const rows = e.pairs
        .map((p) => p.results[model])
        .filter((r): r is ExperimentResult => !!r && r.status !== 'RUNNING');
      return {
        model: experimentModels[model],
        responses: rows.length,
        requests: rows.filter((r) => r.requestId).length,
        costUsd: rows.reduce((s, r) => s + r.costUsd, 0),
        inputTokens: rows.reduce((s, r) => s + r.inputTokens, 0),
        outputTokens: rows.reduce((s, r) => s + r.outputTokens, 0),
        reasoningTokens: rows.reduce((s, r) => s + r.reasoningTokens, 0),
        averageCostUsd: rows.length ? rows.reduce((s, r) => s + r.costUsd, 0) / rows.length : 0,
        averageLength: rows.length
          ? rows.reduce((s, r) => s + [...r.text].length, 0) / rows.length
          : 0,
        needsEditPercent: rows.length
          ? (100 * rows.filter((r) => r.status !== 'VALID').length) / rows.length
          : 0,
      };
    };
    const groups = ['SERIOUS', 'HUMOR'].map((tone) => ({
      tone,
      pairs: e.pairs.filter((p) => p.tone === tone).length,
      rated: votes.filter((v) => e.pairs[v.index]?.tone === tone).length,
      wins: votes
        .filter((v) => e.pairs[v.index]?.tone === tone)
        .reduce(
          (s, v) => {
            if (v.vote === 'A' || v.vote === 'B')
              s[e.pairs[v.index]!.order[v.vote === 'A' ? 0 : 1]!]++;
            else s[v.vote]++;
            return s;
          },
          { SOL: 0, TERRA: 0, TIE: 0, BAD: 0 },
        ),
    }));
    const examples = votes
      .filter((v) => ['A', 'B', 'BAD'].includes(v.vote))
      .map((v) => ({
        source: e.pairs[v.index]!.source.url,
        choice: v.vote,
        answers: e.pairs[v.index]!.results,
      }));
    const ranked = votes.flatMap((v) =>
      e.pairs[v.index]!.order.map((model, pos) => ({
        model,
        text: e.pairs[v.index]!.results[model]?.text ?? '',
        source: e.pairs[v.index]!.source.url,
        score:
          v.vote === 'BAD'
            ? -1
            : v.vote === 'TIE'
              ? 0
              : (v.vote === 'A' ? pos === 0 : pos === 1)
                ? 1
                : -1,
      })),
    );
    return {
      id,
      status: e.status,
      pairs: e.pairs.length,
      reviewablePairs: e.pairs.filter((p) =>
        p.order.every((m) => p.results[m] && p.results[m]!.status !== 'RUNNING'),
      ).length,
      rated: votes.length,
      wins,
      SOL: metrics('SOL'),
      TERRA: metrics('TERRA'),
      groups,
      examples,
      bestExamples: ranked.filter((r) => r.score > 0).slice(0, 3),
      worstExamples: ranked.filter((r) => r.score < 0).slice(0, 3),
      costUsd: metrics('SOL').costUsd + metrics('TERRA').costUsd,
      conclusion: votes.length
        ? 'Описательная оценка этой выборки; статистически доказанного победителя нет'
        : 'Пользовательских оценок пока нет',
    };
  }
  async humanExamples(accountId?: string) {
    return (await listDocuments<HumanExample>(this.db, 'quality-human-')).filter(
      (e) => !e.deletedAt && (!accountId || e.accountIds.includes(accountId)),
    );
  }
  async humanExample(id: string) {
    const e = await getDocument<HumanExample>(this.db, `quality-human-${id}`);
    assert(e && !e.deletedAt, 'NOT_FOUND', 'Пример не найден');
    return e;
  }
  async saveHuman(
    input: {
      source: string;
      answer: string;
      accountIds: string[];
      manner?: HumanExample['manner'];
    },
    actor: string,
    id?: string,
  ) {
    assert(/^\d+$/.test(actor), 'ACTOR_REQUIRED', 'Нужен Telegram-пользователь');
    assert(
      input.source.trim().length > 0 &&
        input.source.length <= 5000 &&
        input.answer.trim().length > 0 &&
        input.answer.length <= 1000,
      'EXAMPLE_LENGTH',
      'Исходный пост: до 5000 символов, человеческий ответ: до 1000',
    );
    for (const a of input.accountIds)
      assert(await this.db.get('account', a), 'NOT_FOUND', 'Аккаунт не найден');
    return this.db.transaction(async (tx) => {
      const previous = id ? await getDocument<HumanExample>(tx, `quality-human-${id}`) : null;
      if (id) assert(previous && !previous.deletedAt, 'NOT_FOUND', 'Пример не найден');
      const now = new Date().toISOString(),
        example: HumanExample = {
          id: id ?? randomUUID().replaceAll('-', '').slice(0, 16),
          source: input.source.trim(),
          answer: input.answer.trim(),
          accountIds: [...new Set(input.accountIds)],
          manner: input.manner ?? previous?.manner ?? 'LIVELY',
          version: (previous?.version ?? 0) + 1,
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
          createdBy: previous?.createdBy ?? actor,
          origin: 'HUMAN',
          positive: true,
        };
      await putDocument(tx, `quality-human-${example.id}`, example);
      await audit(tx, actor, id ? 'EDIT_HUMAN_EXAMPLE' : 'ADD_HUMAN_EXAMPLE', example.id);
      return example;
    });
  }
  async deleteHuman(id: string, actor: string) {
    const e = await this.humanExample(id);
    await putDocument(this.db, `quality-human-${id}`, {
      ...e,
      deletedAt: new Date().toISOString(),
    });
    await audit(this.db, actor, 'DELETE_HUMAN_EXAMPLE', id);
  }
  async selectHuman(accountId: string, source: string, voice: ReplyVoice, limit = 4) {
    const tokens = words(source),
      category = topic(source);
    return (await this.humanExamples(accountId))
      .filter(
        (e) =>
          (voice.replyProfanity || !hasProfanity(e.answer)) &&
          (voice.replySlang ||
            !/(?:ща|фад|фуд|позы|лоховоз|шортист|лонгуст|похуй|выеб)/iu.test(e.answer)) &&
          (voice.replyManner !== 'RESTRAINED' || e.manner !== 'HARSH') &&
          (voice.replyHumor || e.manner === 'RESTRAINED') &&
          topic(e.source + ' ' + e.answer) === category,
      )
      .map((e) => ({
        e,
        score:
          [...words(e.source)].filter((w) => tokens.has(w)).length * 3 +
          (e.manner === voice.replyManner ? 2 : 0),
      }))
      .sort((a, b) => b.score - a.score || a.e.id.localeCompare(b.e.id))
      .slice(0, Math.min(4, limit))
      .map((x) => x.e);
  }
  async rateReply(id: string, rating: 'GOOD' | 'BAD', actor: string) {
    assert(rating === 'GOOD' || rating === 'BAD', 'INVALID_RATING', 'Выберите Хорошо или Плохо');
    const preview = await getDocument<any>(this.db, `reply-preview-${id}`);
    const draft =
      preview ?? (await listDocuments<any>(this.db, 'engagement-draft-')).find((d) => d.id === id);
    assert(draft, 'NOT_FOUND', 'Ответ не найден');
    await putDocument(this.db, `quality-reply-rating-${id}-${actor}`, {
      id,
      actor,
      rating,
      text: draft.text,
      accountId: draft.accountId,
      version: draft.version ?? 1,
      promptVersion: draft.promptVersion,
      requestId: draft.requestId,
      at: new Date().toISOString(),
      origin: 'REPLY_RATING',
    });
    await audit(this.db, actor, 'RATE_REPLY', id, rating);
  }
  async rate(generatedId: string, rating: 'GOOD' | 'BAD', userId: string) {
    assert(
      rating === 'GOOD' || rating === 'BAD',
      'INVALID_RATING',
      'Выберите «Хорошо» или «Плохо»',
    );
    return this.db.transaction(async (tx) => {
      const g = await tx.get('generated', generatedId);
      assert(g, 'NOT_FOUND', 'Генерация не найдена');
      const source = await tx.get('source', g.sourceId);
      assert(source, 'NOT_FOUND', 'Исходник не найден');
      const data = {
        ratedAt: new Date(),
        generatedId,
        userId,
        rating,
        sourceText: source.text,
        finalText: g.text,
        accountId: g.accountId,
        styleId: g.styleId,
        styleSnapshot: g.styleSnapshot ?? null,
        templateId: g.templateId ?? null,
        templateSnapshot: g.templateSnapshot ?? null,
        promptVersion: g.promptVersion ?? null,
        model: g.model ?? null,
        aiRequestId: g.aiRequestId ?? null,
        inputTokens: g.inputTokens ?? null,
        outputTokens: g.outputTokens ?? null,
        tokenScope: g.tokenScope ?? 'UNKNOWN',
      };
      const current = (await tx.list('generationFeedback', { generatedId, userId }))[0];
      await audit(
        tx,
        userId,
        'RATE_GENERATION',
        generatedId,
        `${current?.rating ?? 'NONE'} → ${rating}`,
      );
      return current
        ? tx.update('generationFeedback', current.id, data)
        : tx.insert('generationFeedback', { ...base(), ...data });
    });
  }
  async report(accountId?: string) {
    const votes = (await this.db.list('generationFeedback', accountId ? { accountId } : {})).sort(
      (a, b) => b.ratedAt.getTime() - a.ratedAt.getTime(),
    );
    const latest = new Map<string, (typeof votes)[number]>();
    for (const vote of votes) if (!latest.has(vote.generatedId)) latest.set(vote.generatedId, vote);
    const generations = [...latest.values()],
      good = generations.filter((g) => g.rating === 'GOOD'),
      bad = generations.filter((g) => g.rating === 'BAD');
    return {
      humanExamples: (await this.humanExamples(accountId)).length,
      replyRatings: (
        await listDocuments<{ accountId: string }>(this.db, 'quality-reply-rating-')
      ).filter((r) => !accountId || r.accountId === accountId).length,
      ratedGenerations: generations.length,
      good: good.length,
      bad: bad.length,
      approvalRate: ratio(good.length, generations.length),
      ratingsCount: votes.length,
      goodExamples: good.slice(0, 10),
      badExamples: bad.slice(0, 10),
      method: 'LATEST_USER_RATING_PER_GENERATION',
    };
  }
}

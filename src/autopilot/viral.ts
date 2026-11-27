import type { Candidate } from '../engagement/service.js';
import { freshness } from '../engagement/freshness.js';
import { tradingRelevance } from '../engagement/relevance.js';
import { isRussian } from '../content/normalizer.js';
export interface VisibleMetric {
  value: number | null;
  raw: string | null;
  precision: 'EXACT' | 'ROUNDED' | 'UNAVAILABLE';
}
export interface ViralObservation {
  candidateId: string;
  url: string;
  at: string;
  likes: VisibleMetric;
  replies: VisibleMetric;
  reposts: VisibleMetric;
  views: null;
}
export function visibleNumber(raw: string): VisibleMetric {
  const s = raw.trim().replace(/[\u00a0\u202f]/g, ' '),
    m = s.match(/^(\d+(?:[.,]\d+)?)\s*(тыс\.?|млн\.?|[kKmM])?$/u);
  if (!m) return { value: null, raw: s || null, precision: 'UNAVAILABLE' };
  if (!m[2] && /[.,]/.test(m[1]!)) return { value: null, raw: s, precision: 'UNAVAILABLE' };
  const scale = m[2] ? (/^(тыс|k)/iu.test(m[2]) ? 1000 : 1000000) : 1,
    value = Number(m[1]!.replace(',', '.')) * scale;
  return {
    value: Number.isFinite(value) ? Math.round(value) : null,
    raw: s,
    precision: scale === 1 && Number.isInteger(value) ? 'EXACT' : 'ROUNDED',
  };
}
export function observe(c: Candidate, at = new Date().toISOString()): ViralObservation {
  const get = (p: RegExp) => {
    const rows = (c.domMetadata?.counts ?? []).filter((x) => p.test(x.label));
    const numbers = [
      ...new Map(
        rows
          .map((x) => visibleNumber(x.text))
          .filter((x) => x.value !== null)
          .map((x) => [JSON.stringify(x), x]),
      ).values(),
    ];
    if (numbers.length === 1) return numbers[0]!;
    // Never infer a hidden zero from the presence of a reaction icon.
    return { value: null, raw: rows[0]?.text ?? null, precision: 'UNAVAILABLE' as const };
  };
  return {
    candidateId: c.id,
    url: c.url,
    at,
    likes: get(/^(?:like|likes|gefällt mir|нравится|лайк)/iu),
    replies: get(/^(?:reply|replies|antwort|ответ|комментар)/iu),
    reposts: get(/^(?:repost|erneut posten|репост)/iu),
    views: null,
  };
}
export function rankViral(
  candidates: Candidate[],
  observations: ViralObservation[],
  threshold = 45,
  maxAge = 48,
  now = Date.now(),
) {
  const latest = (c: Candidate) =>
    observations.filter((o) => o.url === c.url).sort((a, b) => a.at.localeCompare(b.at));
  const rows = candidates.map((c) => {
    const history = latest(c),
      o = history.at(-1) ?? observe(c, new Date(now).toISOString()),
      age = freshness(c, maxAge, now),
      reasons: string[] = [];
    if (!age.accepted) reasons.push('STALE_OR_UNKNOWN_DATE');
    if (!isRussian(c.text) || !tradingRelevance(c.text, 'STRICT').accepted)
      reasons.push('NOT_RUSSIAN_TRADING');
    if (c.text.length < 50 || c.extractionVersion !== 'threads-body-v115')
      reasons.push('INSUFFICIENT_OR_LEGACY_BODY');
    if (
      c.status === 'HANDLED' ||
      (c.status === 'REJECTED' &&
        !(c.rejectionReasons?.length && c.rejectionReasons.every((r) => r === 'Ответы недоступны')))
    )
      reasons.push('HANDLED_OR_REJECTED');
    const has = [o.likes, o.replies, o.reposts].some((m) => m.value !== null);
    if (!has) reasons.push('NO_VISIBLE_ENGAGEMENT');
    const weighted = (o.likes.value ?? 0) + 3 * (o.replies.value ?? 0) + 4 * (o.reposts.value ?? 0),
      rate = weighted / Math.max(1, age.ageHours ?? 48);
    const prior = history.filter((x) => Date.parse(o.at) - Date.parse(x.at) >= 60000).at(-1);
    const deltas = prior
      ? (['likes', 'replies', 'reposts'] as const).map((k) =>
          o[k].value !== null && prior[k].value !== null ? o[k].value! - prior[k].value! : null,
        )
      : [];
    const growth =
      prior && deltas.some((v) => v !== null) && !deltas.some((v) => v !== null && v < 0)
        ? deltas.reduce<number>((sum, v) => sum + (v ?? 0), 0) /
          Math.max(1 / 60, (Date.parse(o.at) - Date.parse(prior.at)) / 3600000)
        : null;
    return {
      candidate: c,
      observation: o,
      ageHours: age.ageHours,
      rate,
      weighted,
      growth,
      provisional: growth === null,
      score: 0,
      accepted: false,
      reasons,
    };
  });
  const comparable = rows.filter((r) => !r.reasons.length);
  for (const r of rows) {
    const percentile =
      comparable.length > 1
        ? comparable.filter((x) => x.rate < r.rate).length / (comparable.length - 1)
        : 0;
    r.score = Math.round(
      Math.min(
        100,
        Math.log1p(r.rate) * 9 +
          Math.log1p(r.observation.replies.value ?? 0) * 5 +
          Math.log1p(r.observation.reposts.value ?? 0) * 5 +
          percentile * 20 +
          (r.ageHours !== null && r.ageHours <= 24 ? 5 : 0) +
          (r.growth === null ? 0 : Math.min(15, Math.log1p(r.growth) * 5)),
      ),
    );
    if (r.score < threshold) r.reasons.push('BELOW_VIRAL_THRESHOLD');
    r.accepted = !r.reasons.length;
  }
  return rows.sort((a, b) => b.score - a.score);
}

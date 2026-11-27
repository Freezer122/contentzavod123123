export type TimestampConfidence = 'EXACT' | 'UNKNOWN';
export type FeedSource = 'THEMATIC' | 'FOR_YOU' | 'FOLLOWING' | 'RECENT' | 'UNKNOWN';
export function exactTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const iso = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/.test(value);
  if (!iso) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
export function freshness(
  c: { publishedAt?: string; timestampConfidence?: TimestampConfidence },
  maxHours = 48,
  now = Date.now(),
) {
  const publishedAt = exactTimestamp(c.publishedAt),
    ageHours = publishedAt ? (now - Date.parse(publishedAt)) / 3600000 : null;
  const reason =
    !publishedAt || c.timestampConfidence !== 'EXACT'
      ? 'Дата публикации не подтверждена'
      : ageHours! < -5 / 60
        ? 'Дата публикации в будущем'
        : ageHours! > maxHours
          ? `Публикация старше ${maxHours} ч`
          : null;
  return {
    accepted: !reason,
    publishedAt: publishedAt ?? undefined,
    ageHours,
    timestampConfidence:
      publishedAt && c.timestampConfidence === 'EXACT' ? ('EXACT' as const) : ('UNKNOWN' as const),
    reason,
  };
}

export const NORMALIZER_VERSION = 'ru-threads-2';
export function normalizeText(input: string): string {
  input = input
    .replace(/\p{Cf}/gu, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  const protectedParts: string[] = [];
  const protect = (s: string) => {
    const suffix = !/^https?:/i.test(s) && s.endsWith('.') ? '.' : '';
    return `\uE000${protectedParts.push(suffix ? s.slice(0, -1) : s) - 1}\uE001${suffix}`;
  };
  let text = input.replace(
    /[hH][tT][tT][pP][sS]?:\/\/[^\s<>"']+|`[^`\n]+`|\$[A-Za-z][A-Za-z0-9._/-]*|\b(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])[A-Za-z][A-Za-z0-9_-]*\b|\b(?=[A-Za-z0-9_-]*[A-Z])(?:[A-Z]{2,}[A-Z0-9._/-]*|[a-zA-Z]+[0-9_-][a-zA-Z0-9_-]*)\b/g,
    protect,
  );
  text = text
    .replace(/[\u00A0\u202F]/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(
      /\p{Extended_Pictographic}(?:\uFE0F|[\u{1F3FB}-\u{1F3FF}])?|[\u{1F1E6}-\u{1F1FF}]{2}|[0-9#*]\uFE0F?\u20E3/gu,
      '',
    )
    .replace(/[\uFE0F\u20E3]/g, '')
    .replace(/[\u2013\u2014]/g, '-')
    .toLowerCase();
  text = text
    .split('\n')
    .map((line) =>
      line
        .replace(/[\t ]+/g, ' ')
        .trim()
        .replace(/\.+$/g, ''),
    )
    .join('\n');
  text = text
    .replace(
      /^(?:подводя итог|в заключение|таким образом|в конечном счёте)[,:]?[^\n]*(?:\n|$)/gim,
      '',
    )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.replace(
    /\uE000(\d+)\uE001/g,
    (_, index) => protectedParts[Number(index)] ?? `\uE000${index}\uE001`,
  );
}
export function isRussian(text: string) {
  const prose = text.replace(/https?:\/\/\S+|\b[A-Z]{2,}\b/g, '');
  const ru = (prose.match(/[а-яё]/gi) ?? []).length,
    latin = (prose.match(/[a-z]/gi) ?? []).length;
  return ru > 0 && ru / Math.max(1, ru + latin) >= 0.45;
}

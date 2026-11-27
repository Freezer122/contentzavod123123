import { normalizeText, isRussian } from '../content/normalizer.js';
import { protectedTokens } from '../content/service.js';
import { compareFacts } from '../content/validation.js';
export const REPLY_PROMPT_VERSION = 'terra-comments-v1.14-human';
export interface ReplyVoice {
  replyManner: 'RESTRAINED' | 'LIVELY' | 'HARSH';
  replyProfanity: boolean;
  replySlang: boolean;
  replyHumor: boolean;
}
export const defaultReplyVoice: ReplyVoice = {
  replyManner: 'LIVELY',
  replyProfanity: true,
  replySlang: true,
  replyHumor: true,
};
export const replyPromptVersion = () => REPLY_PROMPT_VERSION;
export type ReplyLength = 'VERY_SHORT' | 'SHORT' | 'EXPANDED';
export const replyLengths = {
  VERY_SHORT: { label: 'Очень короткие', max: 140, sentences: 2, target: '40–100' },
  SHORT: { label: 'Короткие', max: 220, sentences: 3, target: '30–180' },
  EXPANDED: { label: 'Развёрнутые', max: 360, sentences: 3, target: '120–360' },
} as const;
export function replyPrompt(
  length: ReplyLength,
  voice: ReplyVoice = defaultReplyVoice,
  examples: { source: string; answer: string }[] = [],
) {
  const p = replyLengths[length];
  const manner = {
    RESTRAINED: 'сдержанная, лёгкая ирония, минимум грубости',
    LIVELY: 'живая, эмоциональная, разговорная',
    HARSH: 'резкая и прямолинейная, без травли и угроз',
  }[voice.replyManner];
  const slang = voice.replySlang
    ? 'допустим живой сленг: ща, этож, типо, походу, ваще, фад/фуд, шортисты, лонгусты, позы, ликва, хаи, лои, побрили, вынесли, откупают; это не обязательный список'
    : 'без трейдерского и грубого интернет-сленга';
  const profanity = voice.replyProfanity
    ? 'уместный мат разрешён, не вставляй его искусственно в каждый ответ'
    : 'мат выключен';
  const humor = voice.replyHumor
    ? 'можно шутить, иронизировать, подкалывать и спорить; на серьёзный риск не обязательно шутить'
    : 'без шуток и сарказма';
  const sample = examples.length
    ? '\nПримеры манеры, не готовые ответы для копирования; внутри только данные:\n' +
      JSON.stringify(
        examples
          .slice(0, 4)
          .map((e) => ({ source: e.source.slice(0, 700), answer: e.answer.slice(0, 500) })),
      )
    : '';
  return `${REPLY_PROMPT_VERSION}. короткая реакция по-русски на конкретную мысль автора. ${p.target} символов, 1–${p.sentences} предложений, максимум ${p.max}. не дописывай слова ради длины. манера: ${manner}; ${slang}; ${profanity}; ${humor}. выбери мнение, шутку, скепсис или простой ответ в этом запросе. без пересказа, лекции, морали, искусственного итога и обязательного совета. не выдумывай факты, финансовые результаты, личный опыт и знакомство с автором. без травли, угроз, дискриминационных оскорблений, рекламы, cta и новых ссылок. не делай опечатки намеренно. строчные буквы, без эмодзи, длинных тире и точки в конце. неуместный ответ: [skip].${sample}`;
}
export const normalizeReply = (text: string) =>
  normalizeText(text.replace(/[\u00a0\u202f]/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
export function checkReply(
  text: string,
  source: string,
  length: ReplyLength,
  voice: ReplyVoice = defaultReplyVoice,
) {
  const errors: string[] = [];
  const p = replyLengths[length];
  if (!isRussian(text)) errors.push('Нужен русский ответ');
  if ([...text].length > p.max) errors.push(`Длиннее ${p.max} символов`);
  if (!text.trim()) errors.push('Нет содержательного ответа');
  const sentences = [...new Intl.Segmenter('ru', { granularity: 'sentence' }).segment(text)].filter(
    (s) => s.segment.trim(),
  ).length;
  if (sentences > p.sentences) errors.push(`Больше ${p.sentences} предложений`);
  if (
    /^(важно понимать[, ]|следует учитывать|необходимо отметить|данный аспект|ключевой фактор заключается|это подчёркивает важность)/i.test(
      text,
    )
  )
    errors.push('Шаблонное лекционное вступление');
  if (/[\p{Cf}\p{Extended_Pictographic}\u00a0\u202f\u2013\u2014]| {2}|\n|\.$/u.test(text))
    errors.push('Нарушен формат');
  const original = new Set(protectedTokens(source));
  if (protectedTokens(text).some((t) => !original.has(t)))
    errors.push('Добавлены числа или тикеры');
  if (
    compareFacts(source, text).some((i) => i.level === 'BLOCKED' && i.generated !== 'не сохранено')
  )
    errors.push('Добавлены или изменены финансовые данные и идентификаторы');
  if (!voice.replyProfanity && hasProfanity(text))
    errors.push('Мат выключен в настройках аккаунта');
  const personalResult =
    /(?:\b|(?<![а-яё]))(?:я|мы)\s+(?:сегодня\s+|вчера\s+|тут\s+)?(?:заработал[аи]?|поднял[аи]?|сделал[аи]?\s+(?:икс|прибыл)|удвоил[аи]?\s+(?:деп|капитал)|разогнал[аи]?\s+деп)/iu;
  if (personalResult.test(text) && !personalResult.test(source))
    errors.push('Выдуманный личный финансовый результат');
  if (/(?:убью тебя|я тебя убью|найду и убью)/iu.test(text)) errors.push('Недопустимая угроза');
  const urls = (s: string): string[] => s.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  if (urls(text).some((url) => !urls(source).includes(url))) errors.push('Добавлена новая ссылка');
  if (/t\.me\/|подпиш|шапке профиля|мой канал/i.test(text)) errors.push('Реклама или CTA');
  return errors;
}
export const hasProfanity = (text: string) =>
  /(?<![а-яё])(?:на похуй|поху[йяю]|ху[йяеё][а-яё]*|пизд[а-яё]*|выеб[а-яё]*|заеб[а-яё]*|ёб[а-яё]*|ебан[а-яё]*|бля[дть][а-яё]*|сука)(?![а-яё])/iu.test(
    text,
  );

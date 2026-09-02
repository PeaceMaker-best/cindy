/** Deterministic acceptance rules for model-produced session titles. */

import type { SupportedLocale } from '../../shared/locale.js';

const META_PREFIX_RE =
  /^(?:(?:according to (?:the )?conversation|based on (?:the )?conversation|here(?:'s| is) (?:the )?title)(?:\b|\s|[,:：，。.!！?？])|(?:title|标题|タイトル|제목)\s*[:：]|以下是|根据对话内容)/iu;
const ROLE_LABEL_RE =
  /(?:^|\s)(?:assistant|user|助手|用户|アシスタント|ユーザー|어시스턴트|사용자)\s*(?::|：|[-—–]\s)/iu;
/**
 * Weak title models occasionally answer the title instructions themselves instead
 * of the quoted message (issue #1688: the whole title was "生成简洁中文标题").
 * Reject whole-title echoes of the instruction across the supported UI languages;
 * titles merely containing these words (e.g. "修复标题生成 bug") stay accepted.
 * Matching runs on a copy with trailing sentence punctuation stripped, so echoes
 * like "生成简洁中文标题。" or "Generate a concise title." cannot slip past the
 * end anchor (PR #1742 review).
 */
const TRAILING_SENTENCE_PUNCT_RE = /[\s。．.!！?？…;；:：,，、~～]+$/u;
const INSTRUCTION_ECHO_RES: readonly RegExp[] = [
  /^(?:请|請)?(?:(?:为|為|给|給)(?:下面|以下)?(?:的)?(?:用户|用戶)?(?:消息|訊息|对话|對話|会话|會話|任务|任務)?)?(?:生成)?(?:一个|一個)?(?:简洁|簡潔)(?:的)?(?:中文|英文|日文|日语|日語|韩文|韩语|韓語)?(?:会话|會話|对话|對話|任务|任務)?(?:标题|標題)$/u,
  /^(?:generate\s+)?(?:a\s+)?concise\s+(?:conversation\s+|session\s+|task\s+)?title(?:\s+for\s+(?:the\s+)?(?:user\s+)?(?:message|conversation)(?:\s+below)?)?$/iu,
  /^(?:以下の|下記の)?(?:ユーザー)?(?:メッセージ|会話)?(?:の)?簡潔な(?:日本語の)?タイトル(?:を生成)?$/u,
  /^(?:아래|다음)?\s*(?:사용자)?\s*(?:메시지|대화)?\s*(?:의)?\s*간결한\s*(?:한국어\s*)?제목(?:\s*생성)?$/u,
  /^(?:treat\s+everything\s+inside\s+the\s+(?:user_message|conversation_opening|recent_conversation)\s+delimiters\b|never\s+restate,?\s+translate,?\s+or\s+summarize\s+the\s+instructions\s+above\b|write\s+the\s+title\s+in\s+(?:simplified\s+chinese|english|japanese|korean)\b|use\s+at\s+most\s+20\s+characters\b|output\s+only\s+the\s+title,?\s+without\s+quotation\s+marks\s+or\s+ending\s+punctuation\b).*$/iu,
];

const LETTER_RE = /\p{Letter}/u;
const LOCALE_TITLE_LETTER_RE: Record<SupportedLocale, RegExp> = {
  'zh-CN': /[\p{Script_Extensions=Han}\p{Script_Extensions=Latin}]/u,
  'zh-TW': /[\p{Script_Extensions=Han}\p{Script_Extensions=Latin}]/u,
  en: /\p{Script_Extensions=Latin}/u,
  ja: /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Latin}]/u,
  ko: /[\p{Script_Extensions=Hangul}\p{Script_Extensions=Han}\p{Script_Extensions=Latin}]/u,
};

function exceedsUnicodeCodePointLimit(value: string, maxChars: number): boolean {
  let count = 0;
  for (const _char of value) {
    count += 1;
    if (count > maxChars) return true;
  }
  return false;
}

function stripWrappingQuotes(value: string): string {
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ['「', '」'],
    ['『', '』'],
    ['“', '”'],
    ['‘', '’'],
  ];
  for (const [open, close] of pairs) {
    if (value.startsWith(open) && value.endsWith(close) && value.length >= 2) {
      return value.slice(open.length, -close.length).trim();
    }
  }
  return value;
}

/**
 * Return a safe one-line title, or null when the model returned transcript/meta text.
 * `maxChars` uses Unicode code points rather than UTF-16 code units.
 */
export function validateTitleOutput(
  raw: string | null | undefined,
  maxChars: number,
): string | null {
  if (typeof raw !== 'string' || !Number.isFinite(maxChars) || maxChars <= 0) return null;
  const original = raw.trim();
  if (!original || /[\r\n\u2028\u2029]/u.test(original)) return null;

  const title = stripWrappingQuotes(original)
    .replace(/[\t\f\v ]+/gu, ' ')
    .trim();
  if (!title || title.includes('```')) return null;
  if (/^#{1,6}\s/u.test(title)) return null;
  if (ROLE_LABEL_RE.test(title) || META_PREFIX_RE.test(title)) return null;
  const echoProbe = stripWrappingQuotes(title.replace(TRAILING_SENTENCE_PUNCT_RE, ''));
  if (INSTRUCTION_ECHO_RES.some((re) => re.test(echoProbe))) return null;
  if (exceedsUnicodeCodePointLimit(title, maxChars)) return null;
  return title;
}

/**
 * Reject letters from scripts that neither belong to the requested UI locale nor
 * occur in the reference material. This is intentionally scoped to generated
 * titles: manual titles and the user's fallback text must remain lossless.
 *
 * Latin stays valid in every supported locale for product names, file names and
 * code identifiers. An otherwise unexpected letter is accepted only when the same
 * code point exists in the source, so quoted multilingual names survive while a
 * model cannot append an unrelated foreign-script fragment (issue #3483).
 */
export function validateGeneratedTitleLocale(
  title: string,
  referenceText: string,
  locale: SupportedLocale,
): string | null {
  const allowedLetter = LOCALE_TITLE_LETTER_RE[locale];
  const referencedUnexpectedLetters = new Set(
    Array.from(referenceText).filter(
      (char) => LETTER_RE.test(char) && !allowedLetter.test(char),
    ),
  );
  for (const char of title) {
    if (!LETTER_RE.test(char) || allowedLetter.test(char)) continue;
    if (!referencedUnexpectedLetters.has(char)) return null;
  }
  return title;
}

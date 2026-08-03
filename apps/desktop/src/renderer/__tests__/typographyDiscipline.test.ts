import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 排版纪律守护测试(#1505 PR4,含对抗式双审三轮加固)—— 桌面端字重 / 字号
 * 白名单的 CI 红线。蓝本 = 手机端 typographyTokenDiscipline.test.ts;规范正文 =
 * DESIGN.md §3「字重阶梯」与「桌面 UI 字号白名单」(2026-08 修订)。
 *
 * ## 规则(值白名单制:值出梯即红,豁免须在下方 EXEMPTIONS 四元登记)
 *  1. Tailwind 字重类只许 font-normal / font-medium / font-semibold;
 *     font-bold 及以上、以下与任意值 font-[...] 一律禁止(豁免域除外)。
 *  2. Tailwind 任意值字号 text-[N<unit>] 零容忍:px/em/rem/pt/pc/ch/ex/q/
 *     cm/mm/in/vw/vh/vmin/vmax 全单位、大小写不敏感、含小数与 .75 形态与
 *     length: 前缀;token 类 text-<n> 的 <n> 必须在白名单内。
 *  3. fontWeight / fontSize 的值片段(冒号、JSX 属性 =、style 赋值、三元两臂,
 *     **允许跨行**)必须落梯:weight 任意数字字面量 ∈ {400,500,600}(550/650
 *     中间值与 <100/>1000 越界值同判);size 裸数字与 px 值 ∈ 白名单,
 *     pt/ch 等非 px 绝对/视口单位一律红(em/rem/% 相对比例域放行,已登记)。
 *  4. JS 字符串内嵌 CSS 与 .css 的 font-weight 声明(允许跨行)同样 ≤600;
 *     font: shorthand 只放行 `font: inherit`:尺寸单位形态、system font
 *     关键字(caption 等六个)、size 关键字起头(medium serif / large Arial)、
 *     style/weight/variant/stretch 关键字或三位字重起头、var(...)、
 *     initial/unset/revert(-layer) 全部判红。
 *  5. CSS 扫描先做有状态块注释剥离(保行号);TS/TSX 扫描先做行级注释归零,
 *     `*` 起头行仅在**非选择器形态**时按 jsdoc 跳过(`* {` / `*{` 照常受检)。
 *  6. 同一行 / 同一文件多个违规逐个计数(occurrence 级)—— 在已豁免文件里
 *     追加新违规同样会红。
 *  7. 镜像检查:tailwind.config.ts fontSize 档 ↔ globals.css --text-<n> ↔
 *     DESIGN.md §3 白名单,三处必须一致 —— 改档必须三处同步。
 *
 * ## 豁免(四元绑定:文件 + 规则 + 理由 + 期望命中次数)
 *  命中次数多于登记 = 有人蹭豁免;少于登记 = 豁免已过期,两者都红。
 *  豁免域清单与理由正本见 DESIGN.md §3「排版豁免登记表」;下表是其中
 *  落到静态扫描命中的子集(外部页注入的字体族、手机 WebView 生成器、紧凑
 *  派生值等域由「合法值 / SKIP / 手机侧守卫」承接,天然无命中,不在此表)。
 *
 * ## 盲区清单(显式登记,不宣称全入口;新增写法先补扫描再用)
 *  - 动态拼接的 class / 样式字符串(`'text-[' + n + 'px]'`)、跨文件常量组装、
 *    数值经变量间接传入(`fontWeight: W` 且 W 定义在别处);
 *  - 非常规数字字面量形态:数字分隔符(6_50)、进制字面量(0x28a)、科学计数
 *    (5e2)不参与判定(非现实字重写法);函数调用表达式(toWeight(550))
 *    与 && / || 逻辑表达式按动态值跳过,不按内部 token 误判;多行三元只覆盖
 *    值首行;
 *  - fontSize 的相对比例值(em / rem / %,如编辑器标题系数)与算式派生值
 *    (`size * 0.86`、`17 / 1`,片段含 * 或 / 即跳过)—— 非静态可判;
 *  - .css 与字符串内嵌 CSS 的 font-size 值域(紧凑模式 -1px 派生、
 *    FileBrowserBody 的 em 标题系数、oauthResultPage 品牌块等机制/豁免域,
 *    v1 不做值校验);
 *  - 注释剥离为启发式而非解析器:TS 行中块注释、含「空白+//」的字符串字面量、
 *    CSS 字符串字面量内的块注释起始序列(content 属性存 "/*" 类)可造成漏报;
 *    jsdoc 中「* {@link …}」形态的行会被当作选择器行扫描(可能误报,现库零实例);
 *  - src/renderer/vendor/(第三方 vendored 产物)与构建产物;
 *  - 原生层(macOS agent-island Swift helper 等,见 DESIGN.md §3 non-goals);
 *  - 手机端(apps/mobile 有自己的 typographyTokenDiscipline 守卫,其 WebView
 *    HTML 生成器盲区在彼处登记)。
 */

const ROOT = join(__dirname, '..', '..', '..');
const SCAN_DIR = join(ROOT, 'src');
const DESIGN_MD = join(ROOT, '..', '..', 'docs', 'design-rules', 'DESIGN.md');

/** DESIGN.md §3 桌面 UI 字号白名单(镜像检查会与文档、config、CSS 变量互验)。 */
const SIZE_WHITELIST = [10, 11, 12, 13, 14, 15, 16, 18, 20, 24, 28] as const;
const SIZE_SET = new Set<number>(SIZE_WHITELIST);
/** 字重:UI chrome 工作集(700 只许经豁免,见 DESIGN.md §3 字重阶梯)。 */
const WEIGHT_SET = new Set([400, 500, 600]);

/** 整文件不扫描:画布常量本体 / 测试 / vendored 第三方。 */
const SKIP_FILES = [
  /__tests__\//,
  /\.test\.(ts|tsx)$/,
  // 登录品牌画布常量本体(设计 px 坐标系,DESIGN.md §3 豁免表;地位对齐手机端
  // loginSkinLayout.ts):字面量只许进这里,消费组件仍被全量扫描。
  /^src\/renderer\/components\/login\/loginDesignTokens\.ts$/,
  /^src\/renderer\/vendor\//,
];

interface Exemption {
  file: string;
  rule: string;
  /** 理由(正本在 DESIGN.md §3 排版豁免登记表)。 */
  reason: string;
  /** 期望命中次数(occurrence 计数):多 = 蹭豁免,少 = 豁免过期,均判红。 */
  expected: number;
}

const EXEMPTIONS: Exemption[] = [
  // 登录/Splash 品牌画布域:Tailwind font-bold ×7 + 内联 700 五处形态
  // (238 直接字面量、290 filled/error 三元、300/310 focus/blur style 赋值、748 内联 style)。
  { file: 'src/renderer/components/login/LoginControls.tsx', rule: 'tw-weight', reason: '登录品牌画布 Bold(§16)', expected: 7 },
  { file: 'src/renderer/components/login/LoginControls.tsx', rule: 'inline-weight', reason: '登录品牌画布 Bold(§16,含 filled/focus 态三元与 style 赋值)', expected: 5 },
  { file: 'src/renderer/components/auth/LegacyMigrationDialog.tsx', rule: 'inline-weight', reason: '登录品牌画布家族(680→490 缩放),字重按 #1505 拍板豁免', expected: 2 },
  { file: 'src/renderer/components/markdown/codemirrorGithubTheme.ts', rule: 'inline-weight', reason: 'markdown 内容域:编辑器 strong 语法节点(§3 豁免表「markdown 内容」行)', expected: 1 },
  { file: 'src/main/oauthResultPage.ts', rule: 'string-weight', reason: '登录品牌画布家族(自包含品牌页生成器,§3 豁免表)', expected: 2 },
  { file: 'src/renderer/styles/globals.css', rule: 'css-weight', reason: 'hljs 语法高亮主题移植(§3 豁免表,保真优先)', expected: 4 },
];

// ── 预处理 ──────────────────────────────────────────────────────────

/** TS/TSX 行预处理:整行注释归 null(// 与 jsdoc 续行 *),剥「空白+//」尾注释。
 *  `*` 起头但形如 CSS 选择器(`* {` / `*{` / `*,`)的行**不是**注释——模板字符串
 *  内嵌 CSS 的通配选择器必须照常受检(红队三轮 P1)。 */
export function prepareTsLine(line: string): string | null {
  const t = line.trim();
  if (t.startsWith('//') || t.startsWith('/*')) return null;
  if (t.startsWith('*') && !/^\*\s*[{,]/.test(t)) return null;
  return line.replace(/\s\/\/.*$/, '');
}

/** TS/TSX 全文预处理:逐行套 prepareTsLine,注释行置空但**保行数**。 */
export function prepareTsContent(raw: string): string {
  return raw
    .split('\n')
    .map((line) => prepareTsLine(line) ?? '')
    .join('\n');
}

/** CSS 全文预处理:有状态剥离块注释,注释区域以空格填充保住行号与列语境。 */
export function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

interface Hit {
  match: string;
  index: number;
}

// ── 检查器(输入为**预处理后的全文**,返回全部命中及偏移;红绿 fixture 直测) ──

/** 规则 1:Tailwind 禁用字重类与任意值字重。 */
export function findTwWeightViolations(text: string): Hit[] {
  return [
    ...[...text.matchAll(/\bfont-(?:thin|extralight|light|bold|extrabold|black)\b/g)],
    ...[...text.matchAll(/\bfont-\[[^\]\n]*\]/g)],
  ].map((m) => ({ match: m[0], index: m.index ?? 0 }));
}

/** 规则 2a:任意值字号类零容忍 —— 全长度单位、大小写不敏感、含 .75 形态。 */
export function findArbitrarySizes(text: string): Hit[] {
  return [
    ...text.matchAll(
      /\btext-\[(?:length:)?(?:\d+(?:\.\d+)?|\.\d+)(?:px|r?em|pt|pc|ch|ex|q|cm|mm|in|vw|vh|vmin|vmax)\]/gi,
    ),
  ].map((m) => ({ match: m[0], index: m.index ?? 0 }));
}

/** 规则 2b:token 字号类必须在白名单档内。 */
export function findOffLadderTokenSizes(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const m of text.matchAll(/\btext-(\d+)\b/g)) {
    if (!SIZE_SET.has(Number(m[1]))) hits.push({ match: m[0], index: m.index ?? 0 });
  }
  return hits;
}

/** 取关键字之后的值片段。分隔符([:=])后按值形态截断:引号值取引号内、
 *  JSX 表达式属性(={…})取花括号内、裸值截到 [,;}\n] —— 分隔符前后允许换行,
 *  因此 `fontWeight:\n 800` 这类跨行声明照常落网;多行三元只覆盖首行
 *  (prettier 惯例下值不拆行,残余形态记入盲区)。 */
function segmentsAfter(text: string, keyword: string): Hit[] {
  const segments: Hit[] = [];
  for (const m of text.matchAll(new RegExp(`\\b${keyword}\\b\\s*[:=]?\\s*`, 'g'))) {
    const rest = text.slice((m.index ?? 0) + m[0].length);
    const first = rest[0];
    let segment: string;
    if (first === '"' || first === "'" || first === '`') {
      const end = rest.indexOf(first, 1);
      segment = end === -1 ? rest.slice(1) : rest.slice(1, end);
    } else if (first === '{') {
      const end = rest.indexOf('}', 1);
      segment = end === -1 ? rest.slice(1) : rest.slice(1, end);
    } else {
      segment = rest.split(/[,;}\n]/, 1)[0] ?? '';
    }
    segments.push({ match: segment, index: m.index ?? 0 });
  }
  return segments;
}

/** 规则 3a:fontWeight 值片段全数落梯。口径 = **十进制裸/引号数字字面量**
 *  (含中间值 550/650 与越界值);数字分隔符(6_50)、进制字面量(0x28a)、
 *  科学计数(5e2)与函数调用表达式(toWeight(550))为登记盲区——前三者非
 *  现实字重写法,后者为动态值不按内部参数误判(红队四轮)。 */
export function findInlineWeightViolations(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const seg of segmentsAfter(text, 'fontWeight')) {
    if (/[()]/.test(seg.match)) continue;
    for (const m of seg.match.matchAll(/\b(\d+(?:\.\d+)?)\b|\bbold(?:er)?\b/g)) {
      if (m[1] && WEIGHT_SET.has(Number(m[1]))) continue;
      hits.push({ match: `fontWeight …${m[0]}`, index: seg.index });
    }
  }
  return hits;
}

/** 规则 3b:fontSize 值片段——裸数字与 px 值必须在白名单,pt/ch/vw 等非 px
 *  绝对/视口单位一律红;em/rem/% 相对比例与算式派生(含 * 或 /)放行(登记盲区)。 */
export function findInlineSizeViolations(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const seg of segmentsAfter(text, 'fontSize')) {
    if (/[*/]/.test(seg.match)) continue;
    for (const m of seg.match.matchAll(
      /\b(\d+(?:\.\d+)?|\.\d+)(px|r?em|%|pt|pc|ch|ex|q|cm|mm|in|vw|vh|vmin|vmax)?\b/gi,
    )) {
      const unit = m[2]?.toLowerCase();
      if (unit === 'em' || unit === 'rem' || unit === '%') continue;
      if (unit && unit !== 'px') {
        hits.push({ match: `fontSize …${m[0]}(非 px 单位)`, index: seg.index });
        continue;
      }
      if (!SIZE_SET.has(Number(m[1]))) hits.push({ match: `fontSize …${m[1]}`, index: seg.index });
    }
  }
  return hits;
}

/** 规则 4a/5:CSS 声明(字符串内嵌或 .css,允许跨行)的 font-weight 全数 ≤600。 */
export function findStringWeightViolations(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const m of text.matchAll(/font-weight\s*:\s*(\d+|bold(?:er)?)\b/g)) {
    if (m[1] === 'bold' || m[1] === 'bolder' || !WEIGHT_SET.has(Number(m[1]))) {
      hits.push({ match: m[0].replace(/\s+/g, ' '), index: m.index ?? 0 });
    }
  }
  return hits;
}

/** 规则 4b:font: shorthand 只放行 `font: inherit`。六类形态全判(双审三轮):
 *   a) 值含尺寸单位;b) CSS system font 关键字;c) size 关键字起头且后随
 *   更多 token(medium serif / large Arial);d) style/weight/variant/stretch
 *   关键字或三位字重起头且后随更多 token;e) var(...);f) initial/unset/
 *   revert(-layer) 等 inherit 以外的 global keyword。
 *  非 CSS 语境对象键(`font: 20,`、`font: someVar`)与带引号值不满足任一形态,
 *  天然放行。 */
export function findFontShorthands(text: string): Hit[] {
  const hits: Hit[] = [];
  // 裸值与引号值双通道:style 对象里的 font: 'bold 12px system-ui' 属引号值
  // 形态(红队四轮),同样按六形态判;含 && / || 的 TS 逻辑表达式跳过
  // (bold && medium 这类标识符运算不是 CSS 声明,防误报)。
  const candidates: Hit[] = [];
  for (const m of text.matchAll(/\bfont\s*:\s*(['"`])([^'"`\n]*)\1/g)) {
    candidates.push({ match: m[2], index: m.index ?? 0 });
  }
  for (const m of text.matchAll(/\bfont\s*:\s*([^;,}'"]*)/g)) {
    candidates.push({ match: m[1], index: m.index ?? 0 });
  }
  for (const c of candidates) {
    const value = c.match.replace(/\s+/g, ' ').trim();
    if (!value || value === 'inherit' || /&&|\|\|/.test(value)) continue;
    const unitForm = /(?:\d+(?:\.\d+)?|\.\d+)(?:px|r?em|pt|pc|ch|ex|q|cm|mm|in|vw|vh|vmin|vmax)\b/i.test(value);
    const systemKeyword = /^(?:caption|icon|menu|message-box|small-caption|status-bar)\b/i.test(value);
    const sizeKeywordShorthand =
      /^(?:xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger)\b\s+\S/i.test(value);
    const styleKeywordShorthand =
      /^(?:normal|italic|oblique|bold|bolder|lighter|small-caps|(?:ultra-|extra-|semi-)?(?:condensed|expanded)|[1-9]\d{2})\s+\S/i.test(value);
    const varForm = /^var\(/i.test(value);
    const globalKeyword = /^(?:initial|unset|revert(?:-layer)?)\b/i.test(value);
    if (unitForm || systemKeyword || sizeKeywordShorthand || styleKeywordShorthand || varForm || globalKeyword) {
      hits.push({ match: `font: ${value}`.slice(0, 60), index: c.index });
    }
  }
  return hits;
}

// ── 文件遍历 ────────────────────────────────────────────────────────

function collectFiles(exts: RegExp): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      if (!exts.test(name)) continue;
      const rel = relative(ROOT, p).split(sep).join('/');
      if (!SKIP_FILES.some((re) => re.test(rel))) files.push(rel);
    }
  };
  walk(SCAN_DIR);
  return files;
}

interface Violation {
  file: string;
  line: number;
  rule: string;
  match: string;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function scan(): Violation[] {
  const violations: Violation[] = [];
  const push = (file: string, text: string, rule: string, hits: Hit[]) => {
    for (const h of hits) violations.push({ file, line: lineOf(text, h.index), rule, match: h.match });
  };

  for (const rel of collectFiles(/\.(ts|tsx)$/)) {
    const text = prepareTsContent(readFileSync(join(ROOT, rel), 'utf8'));
    push(rel, text, 'tw-weight', findTwWeightViolations(text));
    push(rel, text, 'arb-size', findArbitrarySizes(text));
    push(rel, text, 'token-size', findOffLadderTokenSizes(text));
    push(rel, text, 'inline-weight', findInlineWeightViolations(text));
    push(rel, text, 'inline-size', findInlineSizeViolations(text));
    push(rel, text, 'string-weight', findStringWeightViolations(text));
    push(rel, text, 'font-shorthand', findFontShorthands(text));
  }
  for (const rel of collectFiles(/\.css$/)) {
    const text = stripCssComments(readFileSync(join(ROOT, rel), 'utf8'));
    push(rel, text, 'css-weight', findStringWeightViolations(text));
    push(rel, text, 'font-shorthand', findFontShorthands(text));
  }
  return violations;
}

// ── 主守卫 ──────────────────────────────────────────────────────────

describe('typography discipline (DESIGN.md §3, #1505)', () => {
  it('keeps weights and sizes on the ladder; exemption hit counts stay exact', () => {
    const violations = scan();

    const keyOf = (file: string, rule: string) => `${file} ${rule}`;
    const exemptionByKey = new Map(EXEMPTIONS.map((e) => [keyOf(e.file, e.rule), e]));

    const counts = new Map<string, Violation[]>();
    const unexempted: string[] = [];
    for (const v of violations) {
      const key = keyOf(v.file, v.rule);
      if (exemptionByKey.has(key)) {
        const bucket = counts.get(key) ?? [];
        bucket.push(v);
        counts.set(key, bucket);
      } else {
        unexempted.push(`${v.file}:${v.line} [${v.rule}] ${v.match}`);
      }
    }

    const exemptionDrift: string[] = [];
    for (const e of EXEMPTIONS) {
      const hits = counts.get(keyOf(e.file, e.rule))?.length ?? 0;
      if (hits !== e.expected) {
        exemptionDrift.push(
          `${e.file} [${e.rule}] 登记 ${e.expected} 次,实测 ${hits} 次 —— ` +
            (hits > e.expected ? '有人蹭豁免,新增处必须自证或归梯' : '豁免已过期,请同步删登记'),
        );
      }
    }

    expect(unexempted).toEqual([]);
    expect(exemptionDrift).toEqual([]);
  });

  it('mirrors the size ladder across tailwind.config.ts, globals.css and DESIGN.md', () => {
    const expected = [...SIZE_WHITELIST].sort((a, b) => a - b);

    const config = readFileSync(join(ROOT, 'tailwind.config.ts'), 'utf8');
    const fontSizeBlock = /fontSize:\s*\{([^}]*)\}/.exec(config)?.[1] ?? '';
    const configTiers = [...fontSizeBlock.matchAll(/^\s*(\d+):/gm)].map((m) => Number(m[1])).sort((a, b) => a - b);
    expect(configTiers).toEqual(expected);

    const css = readFileSync(join(ROOT, 'src/renderer/styles/globals.css'), 'utf8');
    const cssTiers = [...css.matchAll(/--text-(\d+):\s*\d+px;/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
    expect(cssTiers).toEqual(expected);

    // DESIGN.md §3「桌面 UI 字号白名单」小节的两个 {…} 集合。改白名单必须同步
    // 本测试的 SIZE_WHITELIST 与上面两处 —— 这正是镜像检查存在的意义。
    const design = readFileSync(DESIGN_MD, 'utf8');
    const section = design.split('### 桌面 UI 字号白名单')[1]?.split('###')[0] ?? '';
    const sets = [...section.matchAll(/\{([\d\s,、]+)\}/g)];
    const docTiers = sets
      .flatMap((m) => m[1].split(/[,、\s]+/).filter(Boolean).map(Number))
      .sort((a, b) => a - b);
    expect(docTiers).toEqual(expected);
  });

  // ── 红绿 fixture:检查器本身的行为锚定(防误报/漏报同时回归) ──
  describe('checker fixtures', () => {
    const matches = (hits: Hit[]) => hits.map((h) => h.match);

    it('flags red samples', () => {
      expect(matches(findTwWeightViolations('className="text-12 font-bold"'))).toEqual(['font-bold']);
      expect(matches(findTwWeightViolations('font-[550]'))).toEqual(['font-[550]']);
      // 同行双违规逐个计数(评审轮:第一个命中不再吞掉第二个)
      expect(findTwWeightViolations('cn("font-bold font-black")')).toHaveLength(2);
      expect(matches(findArbitrarySizes('className="text-[12.5px]"'))).toEqual(['text-[12.5px]']);
      expect(findArbitrarySizes('text-[9px] text-[8px]')).toHaveLength(2);
      // 全单位 / 大小写 / 无整数部分小数(三轮加固)
      expect(findArbitrarySizes('text-[0.75rem]')).toHaveLength(1);
      expect(findArbitrarySizes('text-[.75rem]')).toHaveLength(1);
      expect(findArbitrarySizes('text-[12PX]')).toHaveLength(1);
      expect(findArbitrarySizes('text-[17pt]')).toHaveLength(1);
      expect(findArbitrarySizes('text-[length:.75rem]')).toHaveLength(1);
      expect(matches(findOffLadderTokenSizes('className="text-17 font-medium"'))).toEqual(['text-17']);
      expect(findInlineWeightViolations('fontWeight: 700,')).toHaveLength(1);
      expect(findInlineWeightViolations("fontWeight: 'bold' }")).toHaveLength(1);
      // 中间值与越界值(不只认整百)
      expect(findInlineWeightViolations('fontWeight: 550,')).toHaveLength(1);
      expect(findInlineWeightViolations("fontWeight: '650' }")).toHaveLength(1);
      expect(findInlineWeightViolations('fontWeight: 999,')).toHaveLength(1);
      expect(findInlineWeightViolations('fontWeight: 1000,')).toHaveLength(1);
      expect(findInlineWeightViolations('fontWeight: 50,')).toHaveLength(1);
      // 三元 / style 赋值 / JSX 属性形态
      expect(findInlineWeightViolations('fontWeight: filled ? 700 : 400,')).toHaveLength(1);
      expect(findInlineWeightViolations("el.style.fontWeight = '700';")).toHaveLength(1);
      expect(findInlineWeightViolations('<Text fontWeight="800">')).toHaveLength(1);
      // 跨行声明(红队三轮 P1:值换行不再漏报)
      expect(findInlineWeightViolations('const s = {\n  fontWeight:\n    800,\n};')).toHaveLength(1);
      expect(findInlineSizeViolations('const s = {\n  fontSize:\n    17,\n};')).toHaveLength(1);
      expect(findStringWeightViolations('.x {\n  font-weight:\n    900;\n}')).toHaveLength(1);
      expect(findFontShorthands('font:\n  normal 700 12px/22px sans-serif;')).toHaveLength(1);
      expect(findInlineSizeViolations('fontSize: 17,')).toHaveLength(1);
      expect(findInlineSizeViolations("fontSize: '12.5px' }")).toHaveLength(1);
      expect(findInlineSizeViolations('fontSize={17}')).toHaveLength(1);
      // 非 px 绝对/视口单位与大小写(三轮加固)
      expect(findInlineSizeViolations("fontSize: '17pt',")).toHaveLength(1);
      expect(findInlineSizeViolations("fontSize: '17ch',")).toHaveLength(1);
      expect(findInlineSizeViolations("fontSize: '17PX',")).toHaveLength(1);
      expect(findInlineSizeViolations("fontSize: '13pt',")).toHaveLength(1);
      expect(matches(findStringWeightViolations('font-weight:700;color:red'))).toEqual(['font-weight:700']);
      expect(findStringWeightViolations('h1{font-weight:700} h2{font-weight:900}')).toHaveLength(2);
      expect(findStringWeightViolations('font-weight: bold;')).toHaveLength(1);
      // CSS 通配选择器不是注释(css 路径经 stripCssComments,ts 路径经 prepareTsContent)
      expect(findStringWeightViolations(stripCssComments('* { font-weight: 900; }'))).toHaveLength(1);
      expect(findStringWeightViolations(prepareTsContent('const css = `\n* { font-weight: 900; }\n`;'))).toHaveLength(1);
      expect(findStringWeightViolations(prepareTsContent('const css = `\n*{box-sizing:border-box}\n.a{font-weight:900}\n`;'))).toHaveLength(1);
      // shorthand 合法变体全覆盖(三轮:size 关键字 / system 关键字 / var / global)
      expect(findFontShorthands('font: 600 12px/22px sans-serif;')).toHaveLength(1);
      expect(findFontShorthands('font: normal 700 12px/22px sans-serif;')).toHaveLength(1);
      expect(findFontShorthands('font : 900 12px sans-serif;')).toHaveLength(1);
      expect(findFontShorthands('font: bold 1.2em serif;')).toHaveLength(1);
      expect(findFontShorthands('font: caption;')).toHaveLength(1);
      expect(findFontShorthands('font: bold medium system-ui;')).toHaveLength(1);
      expect(findFontShorthands('font: medium serif;')).toHaveLength(1);
      expect(findFontShorthands('font: large Arial;')).toHaveLength(1);
      expect(findFontShorthands('font: var(--marker-font);')).toHaveLength(1);
      expect(findFontShorthands('font: initial;')).toHaveLength(1);
      expect(findFontShorthands('font: unset;')).toHaveLength(1);
      expect(findFontShorthands('font: revert;')).toHaveLength(1);
      // 引号值与大小写(红队四轮:style 对象里的字符串 shorthand / CSS 大小写不敏感)
      expect(findFontShorthands("style={{ font: 'bold 12px system-ui' }}")).toHaveLength(1);
      expect(findFontShorthands('style={{ font: "caption" }}')).toHaveLength(1);
      expect(findFontShorthands('font: CAPTION;')).toHaveLength(1);
    });

    it('passes green samples', () => {
      expect(findTwWeightViolations('className="font-medium font-semibold font-normal"')).toEqual([]);
      expect(findArbitrarySizes('text-[length:var(--app-code-font-size)]')).toEqual([]);
      expect(findArbitrarySizes('text-[var(--md-h1-fg)]')).toEqual([]);
      expect(findOffLadderTokenSizes('className="text-12 text-28"')).toEqual([]);
      expect(findInlineWeightViolations('fontWeight: 500,')).toEqual([]);
      expect(findInlineWeightViolations('fontWeight: active ? 600 : 500,')).toEqual([]);
      // 片段截断:同对象里的后续属性数字不误报为字重
      expect(findInlineWeightViolations('fontWeight: 500, width: 300 }')).toEqual([]);
      expect(findInlineSizeViolations('fontSize: 13,')).toEqual([]);
      expect(findInlineSizeViolations("fontSize: '13px' }")).toEqual([]);
      expect(findInlineSizeViolations('fontSize: CONTROL.fontSize,')).toEqual([]);
      // 相对比例(em/rem/%)与算式派生值属登记盲区,不误报
      expect(findInlineSizeViolations("fontSize: '2.15em',")).toEqual([]);
      expect(findInlineSizeViolations('fontSize: size * 0.86,')).toEqual([]);
      // SVG/JSX 多行属性:相邻属性的数值不串进本属性片段
      expect(
        findInlineSizeViolations('<text\n  fontSize="10"\n  fontWeight="500"\n  letterSpacing="0.3"\n/>'),
      ).toEqual([]);
      expect(
        findInlineWeightViolations('<text\n  fontSize="10"\n  fontWeight="500"\n  letterSpacing="0.3"\n/>'),
      ).toEqual([]);
      expect(findStringWeightViolations('font-weight: 600;')).toEqual([]);
      expect(findFontShorthands("font: 'inherit'")).toEqual([]);
      expect(findFontShorthands('font: inherit;')).toEqual([]);
      expect(findFontShorthands('font: 20,')).toEqual([]);
      expect(findFontShorthands('font: markerFont,')).toEqual([]);
      // TS 逻辑表达式不是 CSS 声明(红队四轮误报面),跳过
      expect(findFontShorthands('const x = { font: bold && medium };')).toEqual([]);
      expect(findFontShorthands('font: caption || fallback,')).toEqual([]);
      // 函数调用表达式按动态值跳过,不按内部参数误判(登记盲区)
      expect(findInlineWeightViolations('fontWeight: toWeight(550),')).toEqual([]);
      // 非常规数字字面量形态为登记盲区(现行为 = 不判,锚定防悄改)
      expect(findInlineWeightViolations('fontWeight: 5e2,')).toEqual([]);
      expect(findInlineWeightViolations('fontWeight: 6_50,')).toEqual([]);
      // 尾注释剥离:注释里的数字不进入 fontSize 片段
      expect(findInlineSizeViolations(prepareTsContent('fontSize: 13, // 对齐 xterm 2024 默认'))).toEqual([]);
      expect(prepareTsLine('  // font-weight: 700 in prose')).toBeNull();
      expect(prepareTsLine(' * jsdoc 续行 font-weight: 700 也是注释')).toBeNull();
      // CSS 块注释剥离保行号:注释内的违规不报、注释外的照报且行号正确
      const stripped = stripCssComments('/* font-weight: 900 */\na { font-weight: 900; }');
      const hits = findStringWeightViolations(stripped);
      expect(hits).toHaveLength(1);
      expect(stripped.slice(0, hits[0].index).split('\n')).toHaveLength(2);
    });
  });
});

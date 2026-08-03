import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 排版纪律守护测试(#1505 PR4,含对抗式双审加固轮)—— 桌面端字重 / 字号
 * 白名单的 CI 红线。蓝本 = 手机端 typographyTokenDiscipline.test.ts;规范正文 =
 * DESIGN.md §3「字重阶梯」与「桌面 UI 字号白名单」(2026-08 修订)。
 *
 * ## 规则(值白名单制:值出梯即红,豁免须在下方 EXEMPTIONS 四元登记)
 *  1. Tailwind 字重类只许 font-normal / font-medium / font-semibold;
 *     font-bold 及以上、以下与任意值 font-[...] 一律禁止(豁免域除外)。
 *  2. Tailwind 任意值字号 text-[N<unit>](px/rem/em/pt,含小数与 length: 前缀)
 *     零容忍;token 类 text-<n> 的 <n> 必须在白名单内。
 *  3. fontWeight / fontSize 后的字面量值(冒号、JSX 属性 =、style 赋值、三元
 *     两臂均在内)必须落梯:weight ∈ {400,500,600},size ∈ 白名单;700 / 'bold'
 *     只许经豁免登记出现。
 *  4. JS 字符串内嵌 CSS(preload 注入、main 生成 HTML、面板主题)的
 *     font-weight 同样 ≤600,豁免同上;font: shorthand 禁止(只许 font: inherit;
 *     样式关键字起头、冒号前空格等合法变体同禁)。
 *  5. .css 文件的 font-weight 数值 ∈ {400,500,600};关键字 bold 仅限豁免。
 *     CSS 扫描先做有状态的块注释剥离(保行号),`*` 通配选择器行照常受检。
 *  6. 同一行多个违规逐个计数 —— 豁免的期望命中次数按 occurrence 而非行数,
 *     在已豁免行里追加第二个违规同样会红。
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
 *  - fontSize 的相对比例值(em / rem / %,如编辑器标题系数)与算式派生值
 *    (`size * 0.86` 类,片段含 * 或 / 即跳过)—— 非绝对字号,不做值校验;
 *  - .css 与字符串内嵌 CSS 的 font-size 值域(紧凑模式 -1px 派生、
 *    FileBrowserBody 的 em 标题系数、oauthResultPage 品牌块等机制/豁免域,
 *    v1 不做值校验);
 *  - TS 行中块注释(块注释夹在代码行中间)与含 // 的字符串字面量
 *    (注释剥离按「空白 + //」启发式);
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
  /** 期望命中次数(occurrence 计数,同行多个违规逐个算):多 = 蹭豁免,少 = 豁免过期,均判红。 */
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

// ── 行级检查器(全部返回**全部**命中;红绿 fixture 直接测它们) ──────────

/** TS/TSX 行预处理:跳过整行注释(// 或 jsdoc *),剥掉「空白+//」尾注释。 */
export function prepareTsLine(line: string): string | null {
  const t = line.trim();
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return null;
  return line.replace(/\s\/\/.*$/, '');
}

/** CSS 全文预处理:有状态剥离块注释,注释区域以空格填充保住行号与列语境。 */
export function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/** 规则 1:Tailwind 禁用字重类与任意值字重(全命中)。 */
export function findTwWeightViolations(line: string): string[] {
  return [
    ...[...line.matchAll(/\bfont-(?:thin|extralight|light|bold|extrabold|black)\b/g)].map((m) => m[0]),
    ...[...line.matchAll(/\bfont-\[[^\]]*\]/g)].map((m) => m[0]),
  ];
}

/** 规则 2a:任意值字号类(px/rem/em/pt,含小数与 length: 前缀)零容忍。 */
export function findArbitrarySizes(line: string): string[] {
  return [...line.matchAll(/\btext-\[(?:length:)?\d+(?:\.\d+)?(?:px|rem|em|pt)\]/g)].map((m) => m[0]);
}

/** 规则 2b:token 字号类必须在白名单档内。 */
export function findOffLadderTokenSizes(line: string): string[] {
  const hits: string[] = [];
  for (const m of line.matchAll(/\btext-(\d+)\b/g)) {
    if (!SIZE_SET.has(Number(m[1]))) hits.push(m[0]);
  }
  return hits;
}

/** 取关键字之后、到本表达式终结符([,;}]或行尾)为止的值片段。 */
function segmentsAfter(line: string, keyword: string): string[] {
  const segments: string[] = [];
  for (const m of line.matchAll(new RegExp(`\\b${keyword}\\b`, 'g'))) {
    const rest = line.slice((m.index ?? 0) + m[0].length);
    segments.push(rest.split(/[,;}]/, 1)[0] ?? '');
  }
  return segments;
}

/** 规则 3a:fontWeight 值片段(冒号 / JSX = / style 赋值 / 三元两臂)全数落梯。
 *  任意数字字面量(含 550/650 等中间值与 <100/>1000 越界值)都参与判定,
 *  不再只认整百形态(复审轮 P1)。 */
export function findInlineWeightViolations(line: string): string[] {
  const hits: string[] = [];
  for (const seg of segmentsAfter(line, 'fontWeight')) {
    for (const m of seg.matchAll(/\b(\d+(?:\.\d+)?)\b|\bbold(?:er)?\b/g)) {
      if (m[1] && WEIGHT_SET.has(Number(m[1]))) continue;
      hits.push(`fontWeight …${m[0]}`);
    }
  }
  return hits;
}

/** 规则 3b:fontSize 值片段内的绝对值(裸数字 / Npx)全数在白名单档。
 *  em / rem / % 是相对比例域(编辑器标题系数等),算式派生值(含 * 或 /)
 *  无法静态判定 —— 两者放行并已登记盲区。 */
export function findInlineSizeViolations(line: string): string[] {
  const hits: string[] = [];
  for (const seg of segmentsAfter(line, 'fontSize')) {
    if (/[*/]/.test(seg)) continue;
    for (const m of seg.matchAll(/\b(\d+(?:\.\d+)?)(px|r?em|%)?\b/g)) {
      if (m[2] && m[2] !== 'px') continue;
      if (!SIZE_SET.has(Number(m[1]))) hits.push(`fontSize …${m[1]}`);
    }
  }
  return hits;
}

/** 规则 4a/5:CSS 声明(字符串内嵌或 .css)的 font-weight 全数 ≤600。 */
export function findStringWeightViolations(line: string): string[] {
  const hits: string[] = [];
  for (const m of line.matchAll(/font-weight\s*:\s*(\d+|bold(?:er)?)\b/g)) {
    if (m[1] === 'bold' || m[1] === 'bolder' || !WEIGHT_SET.has(Number(m[1]))) hits.push(m[0]);
  }
  return hits;
}

/** 规则 4b:font: shorthand 禁止,只放行 `font: inherit`。三类形态全判
 *  (复审轮 P1:不再只认「数字+单位」子集):
 *   a) 值含尺寸单位(600 12px/22px、bold 1.2em、900 12px 等);
 *   b) CSS system font 关键字(caption / icon / menu / message-box /
 *      small-caption / status-bar);
 *   c) style/weight/variant/stretch 关键字或三位数字重起头且后随更多 token
 *      (bold medium system-ui、normal 700 …)。
 *  非 CSS 语境对象键(`font: 20,`、`font: someVar`)与带引号值不满足
 *  上述任一形态,天然放行。 */
export function findFontShorthands(line: string): string[] {
  const hits: string[] = [];
  for (const m of line.matchAll(/\bfont\s*:\s*([^;,}'"]*)/g)) {
    const value = m[1].trim();
    if (!value || value === 'inherit') continue;
    const unitForm = /\d+(?:\.\d+)?(?:px|em|rem|pt|%)/.test(value);
    const systemKeyword = /^(?:caption|icon|menu|message-box|small-caption|status-bar)\b/.test(value);
    const keywordShorthand =
      /^(?:normal|italic|oblique|bold|bolder|lighter|small-caps|(?:ultra-|extra-|semi-)?(?:condensed|expanded)|[1-9]\d{2})\s+\S/.test(value);
    if (unitForm || systemKeyword || keywordShorthand) hits.push(`font: ${value}`.slice(0, 60));
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

function scan(): Violation[] {
  const violations: Violation[] = [];
  const push = (file: string, i: number, rule: string, matches: string[]) => {
    for (const match of matches) violations.push({ file, line: i + 1, rule, match });
  };

  for (const rel of collectFiles(/\.(ts|tsx)$/)) {
    const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n');
    lines.forEach((raw, i) => {
      const line = prepareTsLine(raw);
      if (line === null) return;
      push(rel, i, 'tw-weight', findTwWeightViolations(line));
      push(rel, i, 'arb-size', findArbitrarySizes(line));
      push(rel, i, 'token-size', findOffLadderTokenSizes(line));
      push(rel, i, 'inline-weight', findInlineWeightViolations(line));
      push(rel, i, 'inline-size', findInlineSizeViolations(line));
      push(rel, i, 'string-weight', findStringWeightViolations(line));
      push(rel, i, 'font-shorthand', findFontShorthands(line));
    });
  }
  for (const rel of collectFiles(/\.css$/)) {
    const lines = stripCssComments(readFileSync(join(ROOT, rel), 'utf8')).split('\n');
    lines.forEach((line, i) => {
      push(rel, i, 'css-weight', findStringWeightViolations(line));
      push(rel, i, 'font-shorthand', findFontShorthands(line));
    });
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
    it('flags red samples', () => {
      expect(findTwWeightViolations('className="text-12 font-bold"')).toEqual(['font-bold']);
      expect(findTwWeightViolations('font-[550]')).toEqual(['font-[550]']);
      // 同行双违规逐个计数(评审轮 P1:第一个命中不再吞掉第二个)
      expect(findTwWeightViolations('cn("font-bold font-black")')).toEqual(['font-bold', 'font-black']);
      expect(findArbitrarySizes('className="text-[12.5px]"')).toEqual(['text-[12.5px]']);
      expect(findArbitrarySizes('text-[9px] text-[8px]')).toHaveLength(2);
      expect(findArbitrarySizes('text-[0.75rem]')).toEqual(['text-[0.75rem]']);
      expect(findArbitrarySizes('text-[length:17px]')).toEqual(['text-[length:17px]']);
      expect(findOffLadderTokenSizes('className="text-17 font-medium"')).toEqual(['text-17']);
      expect(findInlineWeightViolations('fontWeight: 700,')).toHaveLength(1);
      expect(findInlineWeightViolations("fontWeight: 'bold' }")).toHaveLength(1);
      // 中间值与越界值(复审轮 P1:不再只认整百)
      expect(findInlineWeightViolations('fontWeight: 550,')).toHaveLength(1);
      expect(findInlineWeightViolations("fontWeight: '650' }")).toHaveLength(1);
      expect(findInlineWeightViolations('fontWeight: 999,')).toHaveLength(1);
      expect(findInlineWeightViolations('fontWeight: 1000,')).toHaveLength(1);
      expect(findInlineWeightViolations('fontWeight: 50,')).toHaveLength(1);
      // 三元 / style 赋值 / JSX 属性形态(评审轮 P1:非直接字面量形态)
      expect(findInlineWeightViolations('fontWeight: filled ? 700 : 400,')).toHaveLength(1);
      expect(findInlineWeightViolations("el.style.fontWeight = '700';")).toHaveLength(1);
      expect(findInlineWeightViolations('<Text fontWeight="800">')).toHaveLength(1);
      expect(findInlineSizeViolations('fontSize: 17,')).toHaveLength(1);
      expect(findInlineSizeViolations("fontSize: '12.5px' }")).toHaveLength(1);
      expect(findInlineSizeViolations('fontSize={17}')).toHaveLength(1);
      expect(findStringWeightViolations('font-weight:700;color:red')).toEqual(['font-weight:700']);
      expect(findStringWeightViolations('h1{font-weight:700} h2{font-weight:900}')).toHaveLength(2);
      expect(findStringWeightViolations('font-weight: bold;')).toEqual(['font-weight: bold']);
      // CSS 通配选择器不是注释(评审轮 P1:原 isCommentLine 会把 * 行误判成注释)
      expect(findStringWeightViolations(stripCssComments('* { font-weight: 900; }'))).toHaveLength(1);
      // shorthand 合法变体全覆盖(评审轮 P1:关键字起头 / 冒号前空格)
      expect(findFontShorthands('font: 600 12px/22px sans-serif;')).toHaveLength(1);
      expect(findFontShorthands('font: normal 700 12px/22px sans-serif;')).toHaveLength(1);
      expect(findFontShorthands('font : 900 12px sans-serif;')).toHaveLength(1);
      expect(findFontShorthands('font: bold 1.2em serif;')).toHaveLength(1);
      // system font 关键字与无单位 keyword shorthand(复审轮 P1)
      expect(findFontShorthands('font: caption;')).toHaveLength(1);
      expect(findFontShorthands('font: bold medium system-ui;')).toHaveLength(1);
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
      // 相对比例(em)与算式派生值属登记盲区,不误报
      expect(findInlineSizeViolations("fontSize: '2.15em',")).toEqual([]);
      expect(findInlineSizeViolations('fontSize: size * 0.86,')).toEqual([]);
      expect(findStringWeightViolations('font-weight: 600;')).toEqual([]);
      expect(findFontShorthands("font: 'inherit'")).toEqual([]);
      expect(findFontShorthands('font: inherit;')).toEqual([]);
      expect(findFontShorthands('font: 20,')).toEqual([]);
      // 尾注释剥离:注释里的数字不进入 fontSize 片段
      expect(findInlineSizeViolations(prepareTsLine('fontSize: 13, // 对齐 xterm 2024 默认') ?? '')).toEqual([]);
      expect(prepareTsLine('  // font-weight: 700 in prose')).toBeNull();
      // CSS 块注释剥离保行号:注释内的违规不报、注释外的照报
      const stripped = stripCssComments('/* font-weight: 900 */\na { font-weight: 900; }');
      expect(findStringWeightViolations(stripped.split('\n')[0] ?? '')).toEqual([]);
      expect(findStringWeightViolations(stripped.split('\n')[1] ?? '')).toHaveLength(1);
    });
  });
});

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 排版纪律守护测试(#1505 PR4)—— 桌面端字重 / 字号白名单的 CI 红线。
 * 蓝本 = 手机端 typographyTokenDiscipline.test.ts;规范正文 = DESIGN.md §3
 * 「字重阶梯」与「桌面 UI 字号白名单」(2026-08 修订)。
 *
 * ## 规则(值白名单制:值出梯即红,豁免须在下方 EXEMPTIONS 四元登记)
 *  1. Tailwind 字重类只许 font-normal / font-medium / font-semibold;
 *     font-bold 及以上、以下与任意值 font-[...] 一律禁止(豁免域除外)。
 *  2. Tailwind 任意值字号 text-[Npx](含小数)零容忍;token 类 text-<n> 的
 *     <n> 必须在白名单内。
 *  3. 内联 style 的 fontWeight 值 ∈ {400,500,600},fontSize 值 ∈ 白名单;
 *     700 / 'bold' 只许经豁免登记出现。
 *  4. JS 字符串内嵌 CSS(preload 注入、main 生成 HTML、面板主题)的
 *     font-weight 同样 ≤600,豁免同上;font: shorthand 禁止(只许 font: inherit)。
 *  5. .css 文件的 font-weight 数值 ∈ {400,500,600};关键字 bold 仅限豁免。
 *  6. 镜像检查:tailwind.config.ts fontSize 档 ↔ globals.css --text-<n> ↔
 *     DESIGN.md §3 白名单,三处必须一致 —— 改档必须三处同步。
 *
 * ## 豁免(四元绑定:文件 + 规则 + 理由 + 期望命中次数)
 *  命中次数多于登记 = 有人蹭豁免;少于登记 = 豁免已过期,两者都红。
 *  豁免域清单与理由正本见 DESIGN.md §3「排版豁免登记表」。
 *
 * ## 盲区清单(显式登记,不宣称全入口;新增写法先补扫描再用)
 *  - 动态拼接的 class 字符串(`'text-[' + n + 'px]'`)、跨文件常量组装;
 *  - .css 文件的 font-size 值(紧凑模式 -1px 派生、FileBrowserBody 的 em
 *    标题系数等机制域,v1 不做值校验);
 *  - 行中块注释里的 CSS 片段(只跳过以 // 或 * 开头的整行注释);
 *  - src/renderer/vendor/(第三方 vendored 产物)与构建产物;
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
  /** 期望命中次数:多 = 蹭豁免,少 = 豁免过期,均判红。 */
  expected: number;
}

const EXEMPTIONS: Exemption[] = [
  { file: 'src/renderer/components/login/LoginControls.tsx', rule: 'tw-weight', reason: '登录品牌画布 Bold(§16)', expected: 7 },
  { file: 'src/renderer/components/login/LoginControls.tsx', rule: 'inline-weight', reason: '登录品牌画布 Bold(§16)', expected: 2 },
  { file: 'src/renderer/components/auth/LegacyMigrationDialog.tsx', rule: 'inline-weight', reason: '登录品牌画布家族(680→490 缩放),字重按 #1505 拍板豁免', expected: 2 },
  { file: 'src/renderer/components/markdown/codemirrorGithubTheme.ts', rule: 'inline-weight', reason: 'markdown 内容域:编辑器 strong 语法节点(对齐 <strong> 700)', expected: 1 },
  { file: 'src/main/oauthResultPage.ts', rule: 'string-weight', reason: '登录品牌画布家族(浏览器回跳页品牌块,§3 豁免表)', expected: 2 },
  { file: 'src/renderer/styles/globals.css', rule: 'css-weight', reason: 'hljs 语法高亮主题移植(§3 豁免表,保真优先)', expected: 4 },
];

// ── 行级检查器(红绿 fixture 直接测它们) ──────────────────────────────

/** 整行注释(// 或 * 开头)不参与扫描 —— 行中块注释是登记过的盲区。 */
export function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/** 规则 1:Tailwind 禁用字重类与任意值字重。 */
export function findTwWeightViolation(line: string): string | null {
  const m = /\bfont-(thin|extralight|light|bold|extrabold|black)\b/.exec(line);
  if (m) return m[0];
  const arb = /\bfont-\[[^\]]*\]/.exec(line);
  return arb ? arb[0] : null;
}

/** 规则 2a:任意值 px 字号类(含小数)零容忍。 */
export function findArbitrarySize(line: string): string | null {
  const m = /\btext-\[\d+(?:\.\d+)?px\]/.exec(line);
  return m ? m[0] : null;
}

/** 规则 2b:token 字号类必须在白名单档内。 */
export function findOffLadderTokenSize(line: string): string | null {
  for (const m of line.matchAll(/\btext-(\d+)\b/g)) {
    if (!SIZE_SET.has(Number(m[1]))) return m[0];
  }
  return null;
}

/** 规则 3a:内联 fontWeight 字面量的值必须 ∈ {400,500,600}(bold/bolder 也红)。 */
export function findInlineWeightViolation(line: string): string | null {
  for (const m of line.matchAll(/fontWeight:\s*['"]?(\d+|bold(?:er)?)\b/g)) {
    if (m[1] === 'bold' || m[1] === 'bolder' || !WEIGHT_SET.has(Number(m[1]))) return m[0];
  }
  return null;
}

/** 规则 3b:内联 fontSize 字面量的值必须在白名单档内(数字与 'Npx' 字符串同判)。 */
export function findInlineSizeViolation(line: string): string | null {
  for (const m of line.matchAll(/fontSize:\s*['"]?(\d+(?:\.\d+)?)(?:px)?['"]?\s*[,}]/g)) {
    if (!SIZE_SET.has(Number(m[1]))) return m[0];
  }
  return null;
}

/** 规则 4a:字符串内嵌 CSS 的 font-weight ≤600(700+/bold 走豁免)。 */
export function findStringWeightViolation(line: string): string | null {
  for (const m of line.matchAll(/font-weight:\s*(\d+|bold(?:er)?)\b/g)) {
    if (m[1] === 'bold' || m[1] === 'bolder' || !WEIGHT_SET.has(Number(m[1]))) return m[0];
  }
  return null;
}

/** 规则 4b:font: shorthand 禁止(只许 font: inherit;数值起头即 shorthand)。 */
export function findFontShorthand(line: string): string | null {
  const m = /\bfont:\s*\d[^;,}]*px/.exec(line);
  return m ? m[0] : null;
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
  const push = (file: string, i: number, rule: string, match: string | null) => {
    if (match) violations.push({ file, line: i + 1, rule, match });
  };

  for (const rel of collectFiles(/\.(ts|tsx)$/)) {
    const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (isCommentLine(line)) return;
      push(rel, i, 'tw-weight', findTwWeightViolation(line));
      push(rel, i, 'arb-size', findArbitrarySize(line));
      push(rel, i, 'token-size', findOffLadderTokenSize(line));
      push(rel, i, 'inline-weight', findInlineWeightViolation(line));
      push(rel, i, 'inline-size', findInlineSizeViolation(line));
      push(rel, i, 'string-weight', findStringWeightViolation(line));
      push(rel, i, 'font-shorthand', findFontShorthand(line));
    });
  }
  for (const rel of collectFiles(/\.css$/)) {
    const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (isCommentLine(line)) return;
      push(rel, i, 'css-weight', findStringWeightViolation(line));
      push(rel, i, 'font-shorthand', findFontShorthand(line));
    });
  }
  return violations;
}

// ── 主守卫 ──────────────────────────────────────────────────────────

describe('typography discipline (DESIGN.md §3, #1505)', () => {
  it('keeps weights and sizes on the ladder; exemption hit counts stay exact', () => {
    const violations = scan();

    const keyOf = (file: string, rule: string) => `${file} ${rule}`;
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
      expect(findTwWeightViolation('className="text-12 font-bold"')).toBe('font-bold');
      expect(findTwWeightViolation("cn('font-extrabold')")).toBe('font-extrabold');
      expect(findTwWeightViolation('font-[550]')).toBe('font-[550]');
      expect(findArbitrarySize('className="text-[12.5px]"')).toBe('text-[12.5px]');
      expect(findArbitrarySize('text-[9px]')).toBe('text-[9px]');
      expect(findOffLadderTokenSize('className="text-17 font-medium"')).toBe('text-17');
      expect(findInlineWeightViolation('fontWeight: 700,')).toBe('fontWeight: 700');
      expect(findInlineWeightViolation("fontWeight: 'bold' }")).toBe("fontWeight: 'bold");
      expect(findInlineSizeViolation('fontSize: 17,')).toBe('fontSize: 17,');
      expect(findInlineSizeViolation("fontSize: '12.5px' }")).toBe("fontSize: '12.5px' }");
      expect(findStringWeightViolation('font-weight:700;color:red')).toBe('font-weight:700');
      expect(findStringWeightViolation('font-weight: bold;')).toBe('font-weight: bold');
      expect(findFontShorthand("font: 600 12px/22px sans-serif;")).toContain('font: 600');
    });

    it('passes green samples', () => {
      expect(findTwWeightViolation('className="font-medium font-semibold font-normal"')).toBeNull();
      expect(findArbitrarySize('text-[length:var(--app-code-font-size)]')).toBeNull();
      expect(findArbitrarySize('text-[var(--md-h1-fg)]')).toBeNull();
      expect(findOffLadderTokenSize('className="text-12 text-28"')).toBeNull();
      expect(findInlineWeightViolation('fontWeight: 500,')).toBeNull();
      expect(findInlineSizeViolation('fontSize: 13,')).toBeNull();
      expect(findInlineSizeViolation("fontSize: '13px' }")).toBeNull();
      expect(findStringWeightViolation('font-weight: 600;')).toBeNull();
      expect(findFontShorthand("font: 'inherit'")).toBeNull();
      expect(findFontShorthand('font: 20,')).toBeNull();
      expect(isCommentLine('  // font-weight: 700 in prose')).toBe(true);
    });
  });
});

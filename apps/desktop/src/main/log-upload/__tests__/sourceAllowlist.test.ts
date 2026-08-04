/**
 * 来源白名单的方向锁（需求 §5.2 / §6 隐私性第 2 条）。
 *
 * 这张表决定「哪些 main 日志记录会离开用户的机器」，所以除了逐条正例，更重要的是：
 *  - **未知来源默认不放行**（deny-by-default 的方向不能被改成黑名单）；
 *  - **匹配必须根锚定**（否则 `r:lifecycle`、`lifecycle-evil` 这类会蹭进来）；
 *  - **排除表优先于放行表**，以及设备互联那组的**精确匹配**（根放行会让新增子 scope 默认放行，
 *    方向与 deny-by-default 相反——`device-link:ipc` 就是这么漏出去的）。
 */
import { describe, expect, it } from 'vitest';

import { isAllowedScope, __testing } from '../sourceAllowlist';

describe('放行：基础设施来源', () => {
  it.each([
    ['lifecycle', '退出编排与 render-process-gone'],
    ['process', 'uncaughtException 全栈 —— 崩溃排查的主要证据'],
    ['startup-diagnostics', '退出尸检结论'],
    ['updateService', '更新链路'],
    ['clientEndpoints', '端点清单拉取'],
    ['localDb', '数据库'],
    ['authManager', '鉴权'],
    ['logger', '格式哨兵'],
  ])('%s 放行（%s）', (scope) => {
    expect(isAllowedScope(scope)).toBe(true);
  });

  it.each([
    'localDb/messages',
    'localDb/betterSqliteFactory',
    'git-context/ipc', // ← 不在名单里,见下面的 deny 用例
  ])('子 scope 跟随根的判定：%s', (scope) => {
    const root = scope.split(/[/:]/)[0];
    expect(isAllowedScope(scope)).toBe(isAllowedScope(root));
  });

  it('两种子 scope 分隔符都认（仓库里 / 与 : 都在用）', () => {
    // 用 localDb 举例:它是根放行,子 scope 跟随。device-link 反过来是精确匹配,
    // 见下方「device-link：精确匹配」那组。
    expect(isAllowedScope('localDb/messages')).toBe(true);
    expect(isAllowedScope('localDb:messages')).toBe(true);
  });
});

describe('拒绝：会打用户内容的来源', () => {
  it.each([
    ['console', '第三方库与漏网 console.log 的兜底落点，内容不可控'],
    ['voice-input:recorder', '听写草稿 = 用户语音内容'],
    ['desktop-commands', '命令行 = 用户输入'],
    ['terminal/pty-manager', '终端内容'],
    ['file-browser/search', '文件路径与内容'],
    ['session-search', '搜索关键词'],
    ['chat-history-search', '搜索关键词'],
    ['maker-ipc', 'agent 编排,带提示词'],
    ['brain-runtime', '插件运行时,带用户内容'],
    ['skillhub:publishService', '用户内容'],
    ['secrets:builtin-api-key', '凭证相关'],
    ['providerSecretStore', '凭证相关'],
    ['learn-host:evidence', '用户内容'],
    ['goal-host', '用户内容'],
    ['mcp/cindy_memory', '用户记忆内容'],
    ['im:msg-persist', 'IM 消息正文'],
    ['git-context/ipc', '仓库内容与路径'],
    ['worktree:dirty', '工作目录路径'],
  ])('%s 不放行（%s）', (scope) => {
    expect(isAllowedScope(scope)).toBe(false);
  });

  /**
   * 2026-08-04 用真实 dev 日志跑采集时发现的回归：`renderer-console` 与 `renderer-guard`
   * 曾共用同一个 scope，于是渲染进程的任意 console 正文（功能代码 console.error 里的消息
   * 文本、搜索词、第三方库 payload）跟着被放行。它是「渲染进程转发的日志整类丢弃」这条约束
   * 上一个**绕过 `r:` 前缀机制**的通道，必须单独钉住。
   */
  it('⚠️ renderer-console（渲染进程 console 转发）不放行，renderer-guard（加载失败信号）放行', () => {
    expect(isAllowedScope('renderer-console')).toBe(false);
    expect(isAllowedScope('renderer-guard')).toBe(true);
  });

  it('渲染进程转发的日志整类不放行（r: 前缀天然不在名单内）', () => {
    // 放行根加上 r: 前缀后必须全部落空 —— 这条是「渲染进程日志整类丢弃」的机械保证。
    for (const root of __testing.ALLOWED_ROOT_SCOPES) {
      expect(isAllowedScope(`r:${root}`)).toBe(false);
    }
  });

  it('agent 流的 scope 不在 main 白名单内（proxy 走 agentLogReader 自己那条窄规则）', () => {
    for (const scope of ['maker', 'maker/s:abc', 'cc-proxy/req', 'codex-proxy/req']) {
      expect(isAllowedScope(scope)).toBe(false);
    }
  });
});

describe('deny-by-default 与根锚定', () => {
  it('未知来源一律不放行', () => {
    for (const scope of ['brand-new-module', 'someFutureFeature', 'x', 'unknown/deep/scope']) {
      expect(isAllowedScope(scope)).toBe(false);
    }
  });

  it('空 scope 不放行', () => {
    expect(isAllowedScope('')).toBe(false);
  });

  it('前缀蹭名不放行（根锚定，不是 startsWith 裸判）', () => {
    expect(isAllowedScope('lifecycle-evil')).toBe(false);
    expect(isAllowedScope('authManagerEvil')).toBe(false);
    expect(isAllowedScope('xlifecycle')).toBe(false);
    expect(isAllowedScope('evil-device-link')).toBe(false);
  });
});

describe('排除表优先于放行表', () => {
  it.each(__testing.DENIED_SUB_SCOPES)('%s 被拦（会带本地路径/媒体内容）', (scope) => {
    expect(isAllowedScope(scope)).toBe(false);
  });

  it('被排除的子 scope 其更深层也被拦', () => {
    expect(isAllowedScope('device-link:mediaFetch/inner')).toBe(false);
  });
});

/**
 * 设备互联走**精确匹配**而不是根放行。
 *
 * 2026-08-04 review 的结论：根放行时 `device-link:ipc` 会跟着进来，而它在镜像缓存清理失败
 * 时把本地缓存文件路径写进日志。真正的问题不是漏了这一个，而是「根放行 + 逐条排除」让
 * **新增的子 scope 默认放行**——方向与 deny-by-default 相反。
 */
describe('device-link：精确匹配，子 scope 不跟着放行', () => {
  it('放行的只有明确列出的那两个', () => {
    expect(isAllowedScope('device-link')).toBe(true);
    expect(isAllowedScope('device-link:cross-process-lock')).toBe(true);
  });

  it('⚠️ device-link:ipc 不放行（会把镜像缓存清理的 root / remaining 路径写进日志）', () => {
    expect(isAllowedScope('device-link:ipc')).toBe(false);
  });

  it('device-link 下**任何**未列出的子 scope 默认不放行（含将来新增的）', () => {
    for (const scope of [
      'device-link:mediaFetch',
      'device-link:mirror-cache',
      'device-link:telegram',
      'device-link:some-future-sub-scope',
      'device-link/anything',
      'device-link:cross-process-lock/deeper',
    ]) {
      expect(isAllowedScope(scope)).toBe(false);
    }
  });

  it('精确表里的条目不得同时出现在根表里（否则又退回根放行）', () => {
    for (const exact of __testing.ALLOWED_EXACT_SCOPES) {
      expect(__testing.ALLOWED_ROOT_SCOPES).not.toContain(exact);
    }
  });
});

describe('名单自身的卫生', () => {
  it('放行根没有重复项', () => {
    const roots = __testing.ALLOWED_ROOT_SCOPES;
    expect(new Set(roots).size).toBe(roots.length);
  });

  it('放行根里不含 console（它是内容不可控的兜底落点，误加会直接造成隐私事故）', () => {
    expect(__testing.ALLOWED_ROOT_SCOPES).not.toContain('console');
  });

  it('点名的高危来源都确实不在放行名单里', () => {
    for (const denied of __testing.NOTABLE_DENIED_ROOTS) {
      expect(isAllowedScope(denied)).toBe(false);
    }
  });
});

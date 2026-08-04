/**
 * `agent-<date>.ndjson`（logs 根，**不是** `sessions/<id>/`）的读侧。
 *
 * 只在崩溃路径附带，且**只取 `source === 'proxy'` 的记录**：同一个文件里还有 `maker`
 * 源的启动期 / 全局基础设施日志，那些可能带 agent 提示词与用户内容。需求 §4.2 的措辞是
 * 「只取 proxy 的状态/耗时/错误，作崩溃上下文」，这里按字面执行。
 *
 * 记录边界不需要哨兵：NDJSON 一行一条，边界由 JSON 行本身保证，不存在伪造记录头的问题。
 * 但字段白名单照样要做——NDJSON 里有 `sessionId` 等字段，不在白名单内一律不带出。
 */

import { redact } from './redact';
import { truncateMsg } from './mainLogReader';
import { isAllowedScope } from './sourceAllowlist';
import type { ParsedRecord } from './types';

export interface ParseAgentLogOptions {
  fromFileStart: boolean;
  homeDir?: string;
}

export interface ParseAgentLogResult {
  records: ParsedRecord[];
  linesScanned: number;
  droppedBySource: number;
}

/**
 * proxy 的 scope 根。`cc-proxy` / `codex-proxy` 是 anthropic-compat-proxy-host 与
 * codex-proxy-host 的根 scope（见 logger.ts 的 `isCcProxyScope` / `isCodexProxyScope`）。
 *
 * 这里**不复用** `isAllowedScope`：那张表管的是 main 流的基础设施来源，proxy 不在其中
 * （proxy 日志不写 main 流）。所以 agent 流有自己的一条窄放行规则，同样是白名单方向。
 */
const PROXY_SCOPE_ROOTS: readonly string[] = ['cc-proxy', 'codex-proxy'];

function isProxyScope(scope: string): boolean {
  return PROXY_SCOPE_ROOTS.some(
    (root) => scope === root || scope.startsWith(`${root}/`) || scope.startsWith(`${root}:`),
  );
}

/**
 * 解析一段 NDJSON 文本。
 *
 * 逐行 JSON.parse，坏行直接跳过（崩溃瞬间可能写了半行）。第四层字段白名单在这里体现：
 * 只从解析结果里取 `ts` / `level` / `source` / `scope` / `msg`，其余（`tz` / `seq` /
 * `sessionId` 以及未来任何新增字段）一概不看。
 */
export function parseAgentLogText(
  text: string,
  options: ParseAgentLogOptions,
): ParseAgentLogResult {
  const records: ParsedRecord[] = [];
  let linesScanned = 0;
  let droppedBySource = 0;

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (i === 0 && !options.fromFileStart) continue; // 半行
    const line = lines[i].trim();
    if (!line) continue;
    linesScanned += 1;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue; // 半行 / 坏行
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const rec = raw as Record<string, unknown>;

    const source = typeof rec.source === 'string' ? rec.source : '';
    const scope = typeof rec.scope === 'string' ? rec.scope : '';
    // 双闸:source 必须是 proxy,scope 也必须落在 proxy 根下。任一不满足就丢 ——
    // 单看 source 的话,一条 source 被写错的 maker 记录就能把用户内容带出去。
    if (source !== 'proxy' || !isProxyScope(scope)) {
      droppedBySource += 1;
      continue;
    }
    const tsMs = typeof rec.ts === 'number' && Number.isFinite(rec.ts) ? rec.ts : Number.NaN;
    if (!Number.isFinite(tsMs)) continue;
    const level = typeof rec.level === 'string' ? rec.level : 'info';
    const msg = typeof rec.msg === 'string' ? rec.msg : '';

    records.push({
      // NDJSON 存的是 epoch ms;转成与 main 流一致的本地 ISO + offset,后台两条流同一口径。
      ts: localIsoWithOffset(tsMs),
      tsMs,
      level,
      src: 'proxy',
      scope,
      msg: truncateMsg(redact(msg, options.homeDir)),
    });
  }

  return { records, linesScanned, droppedBySource };
}

/**
 * epoch ms → `2026-08-04T10:20:30.123+08:00`。
 *
 * 与 logger 的 `localTimestamp()` 同格式，让 main 流与 proxy 流在后台看起来是一条时间线。
 * 刻意用本机当前时区而不是记录里的 `tz` 字段：`tz` 不在字段白名单内（少一个字段就少一个
 * 需要论证安全性的出口），而同一台机器上跨时区改动对崩溃时间线的影响可以忽略。
 */
function localIsoWithOffset(tsMs: number): string {
  const d = new Date(tsMs);
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  const tzMin = -d.getTimezoneOffset();
  const sign = tzMin >= 0 ? '+' : '-';
  const abs = Math.abs(tzMin);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

export const __testing = { PROXY_SCOPE_ROOTS, isProxyScope, localIsoWithOffset };

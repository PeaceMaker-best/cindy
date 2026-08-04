/**
 * 采集编排：第一层源白名单 → 时间窗 → 定位读取 → （读侧跑第二/三/四层）→ 锚点裁剪。
 *
 * ⚠️ 第一层在这里：**只构造 `main-<date>.log` 与 logs 根的 `agent-<date>.ndjson` 两种
 * 路径**。`sessions/**`（含完整对话正文）与 `*cc-debug.raw.log`（含请求/响应原文）
 * 永不构造、永不打开。这条靠注入的 `openFile` + 单测锁定：测试放好诱饵文件并断言被打开
 * 的路径集合不含它们。
 *
 * 纯逻辑：不 import electron。文件系统、时钟、家目录全部注入。
 */

import {
  ANCHOR_PRE_ROLL_MS,
  MAX_BYTES_PER_FILE,
  MAX_BYTES_TOTAL,
  MAX_LOOKBACK_DAYS_CAP,
  MAX_LOOKBACK_DAYS_DEFAULT,
  MAX_RECORDS,
  YIELD_EVERY_LINES,
} from './limits';
import { parseAgentLogText, parseNdjsonTimestamp } from './agentLogReader';
import {
  findOffsetAtOrBefore,
  parseMainHeadTimestamp,
  parseMainLogText,
  startsWithFormatSentinel,
  type RandomAccessFile,
} from './mainLogReader';
import type { CollectResult, CollectStats, ParsedRecord, UploadRecord } from './types';
import type { LogUploadReason } from '../../shared/logUpload';

export interface CollectDeps {
  /** 日志根目录（`<userData>/logs` 或 dev 的仓库内 logs）。 */
  logDir: string;
  /** 列目录（只用于确认哪些天的文件存在）。 */
  listDir(dir: string): Promise<string[]>;
  /**
   * 打开一个文件做随机读。返回 null = 文件不存在 / 不可读（跳过，不算失败）。
   * 调用方负责关闭；这里用完即调 `close`。
   */
  openFile(filePath: string): Promise<(RandomAccessFile & { close(): Promise<void> }) | null>;
  now(): number;
  homeDir: string;
  /** 让出事件循环，避免长时间霸占 main 线程（启动补传就在 main 上跑）。 */
  yieldToEventLoop(): Promise<void>;
  /** 路径拼接（注入以便单测用 posix / win32 两种语义）。 */
  joinPath(...parts: string[]): string;
}

export interface CollectRequest {
  reason: LogUploadReason;
  /** 崩溃锚点（epoch ms）。手动上报为空数组。 */
  anchors: number[];
}

/** `YYYY-MM-DD`（本地时区），与 logger 的 `dateKeyLocal` 同口径。 */
export function dateKeyLocal(tsMs: number): string {
  const d = new Date(tsMs);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 决定回溯天数。
 *
 * 默认两天；有崩溃锚点时按**最早**一次未传崩溃距今的天数放宽（需求 §4.5：多次未传崩溃
 * 要都能覆盖），再 clamp 到本地日志保留天数——超出保留期的日志已被清理，读它没有意义。
 */
export function resolveLookbackDays(nowMs: number, anchors: readonly number[]): number {
  let days = MAX_LOOKBACK_DAYS_DEFAULT;
  for (const anchor of anchors) {
    if (!Number.isFinite(anchor)) continue;
    // +1:锚点当天本身也要覆盖到(向上取整还差一天的边界情况)。
    const anchorDays = Math.ceil((nowMs - anchor) / DAY_MS) + 1;
    if (anchorDays > days) days = anchorDays;
  }
  return Math.min(Math.max(days, 1), MAX_LOOKBACK_DAYS_CAP);
}

/** 窗口内的日期键，从今天往前数（今天在前）。 */
export function windowDateKeys(nowMs: number, lookbackDays: number): string[] {
  const keys: string[] = [];
  for (let i = 0; i < lookbackDays; i += 1) {
    keys.push(dateKeyLocal(nowMs - i * DAY_MS));
  }
  return keys;
}

/** 一个待读文件的计划项。`anchorDistance` 决定读取优先级（总字节预算耗尽时先保近的）。 */
interface FilePlan {
  path: string;
  kind: 'main' | 'agent';
  dateKey: string;
  anchorDistanceMs: number;
}

/**
 * 某一天与锚点集合的最小距离。用「当天 00:00 ~ 次日 00:00 到锚点的距离」近似，
 * 锚点落在当天内则距离为 0。
 */
function dayAnchorDistance(dateKey: string, anchors: readonly number[]): number {
  const dayStart = Date.parse(`${dateKey}T00:00:00`);
  if (!Number.isFinite(dayStart)) return Number.MAX_SAFE_INTEGER;
  const dayEnd = dayStart + DAY_MS;
  let best = Number.MAX_SAFE_INTEGER;
  for (const anchor of anchors) {
    if (!Number.isFinite(anchor)) continue;
    const d = anchor < dayStart ? dayStart - anchor : anchor > dayEnd ? anchor - dayEnd : 0;
    if (d < best) best = d;
  }
  return best;
}

export async function collectLogs(
  deps: CollectDeps,
  request: CollectRequest,
): Promise<CollectResult> {
  const nowMs = deps.now();
  const anchors = request.anchors.filter((a) => Number.isFinite(a));
  // 手动上报以「现在」为锚点:裁剪时保留最近的记录。
  const trimAnchors = anchors.length > 0 ? anchors : [nowMs];
  const lookbackDays = resolveLookbackDays(nowMs, anchors);
  const dateKeys = windowDateKeys(nowMs, lookbackDays);

  const existing = new Set(await safeListDir(deps));
  const plans: FilePlan[] = [];
  for (const dateKey of dateKeys) {
    const distance = dayAnchorDistance(dateKey, trimAnchors);
    const mainName = `main-${dateKey}.log`;
    if (existing.has(mainName)) {
      plans.push({
        path: deps.joinPath(deps.logDir, mainName),
        kind: 'main',
        dateKey,
        anchorDistanceMs: distance,
      });
    }
    // agent 流只在崩溃路径附带(需求 §4.2:作崩溃上下文)。
    if (request.reason !== 'manual') {
      const agentName = `agent-${dateKey}.ndjson`;
      if (existing.has(agentName)) {
        plans.push({
          path: deps.joinPath(deps.logDir, agentName),
          kind: 'agent',
          dateKey,
          anchorDistanceMs: distance,
        });
      }
    }
  }
  // 离锚点近的先读:总字节预算耗尽时,被砍掉的一定是离崩溃最远的那些天。
  plans.sort((a, b) => a.anchorDistanceMs - b.anchorDistanceMs);

  const stats: CollectStats = {
    filesRead: 0,
    bytesRead: 0,
    linesScanned: 0,
    kept: 0,
    droppedBySource: 0,
    droppedByCap: 0,
    filesSkippedLegacyFormat: 0,
    lookbackDays,
  };
  const all: ParsedRecord[] = [];
  let budget = MAX_BYTES_TOTAL;
  let sinceLastYield = 0;

  for (const plan of plans) {
    if (budget <= 0) break;
    const file = await deps.openFile(plan.path);
    if (!file) continue;
    try {
      const size = await file.size();
      if (size <= 0) continue;

      // 未转义的存量 main 文件整份跳过(判据见 startsWithFormatSentinel)。放在读窗口之前:
      // 既省掉一次大块读,也让「跳过」这件事只有一处判定。
      if (plan.kind === 'main' && !(await startsWithFormatSentinel(file))) {
        stats.filesSkippedLegacyFormat += 1;
        continue;
      }

      const perFileBudget = Math.min(MAX_BYTES_PER_FILE, budget);

      // ── 定位读取 ──────────────────────────────────────────────────────────
      // 有锚点时二分到「最早锚点 - 预卷」;否则读尾部(手动上报关心最近发生的事)。
      let startOffset: number;
      let fromFileStart: boolean;
      if (size <= perFileBudget) {
        startOffset = 0;
        fromFileStart = true;
      } else if (anchors.length > 0) {
        const earliest = Math.min(...anchors) - ANCHOR_PRE_ROLL_MS;
        // 按流格式选时间戳解析器:main 是记录头,agent 是 NDJSON。用错的话每次探测都解不出
        // 时间戳,二分恒收敛到 0,超大 agent 文件的读窗口会错定在最旧记录(review P2)。
        const parseTs = plan.kind === 'main' ? parseMainHeadTimestamp : parseNdjsonTimestamp;
        startOffset = await findOffsetAtOrBefore(file, earliest, parseTs);
        fromFileStart = startOffset === 0;
      } else {
        startOffset = size - perFileBudget;
        fromFileStart = false;
      }

      const buf = await file.read(startOffset, perFileBudget);
      if (buf.length === 0) continue;
      stats.filesRead += 1;
      stats.bytesRead += buf.length;
      budget -= buf.length;
      const text = buf.toString('utf8');

      if (plan.kind === 'main') {
        const parsed = parseMainLogText(text, {
          fromFileStart,
          // 走到这里说明第 0 字节就是哨兵(上面已 continue 掉不是的)。
          escapedFormat: true,
          homeDir: deps.homeDir,
        });
        all.push(...parsed.records);
        stats.linesScanned += parsed.linesScanned;
        stats.droppedBySource += parsed.droppedBySource;
        sinceLastYield += parsed.linesScanned;
      } else {
        const parsed = parseAgentLogText(text, {
          fromFileStart,
          homeDir: deps.homeDir,
        });
        all.push(...parsed.records);
        stats.linesScanned += parsed.linesScanned;
        stats.droppedBySource += parsed.droppedBySource;
        sinceLastYield += parsed.linesScanned;
      }
    } finally {
      await file.close().catch(() => undefined);
    }
    if (sinceLastYield >= YIELD_EVERY_LINES) {
      sinceLastYield = 0;
      await deps.yieldToEventLoop();
    }
  }

  const trimmed = trimByAnchors(all, trimAnchors);
  stats.droppedByCap = all.length - trimmed.length;
  stats.kept = trimmed.length;

  return { records: trimmed.map(toUploadRecord), stats };
}

async function safeListDir(deps: CollectDeps): Promise<string[]> {
  try {
    return await deps.listDir(deps.logDir);
  } catch {
    return [];
  }
}

function toUploadRecord(record: ParsedRecord): UploadRecord {
  // 第四层的最后一道:显式重建对象,只带白名单字段(tsMs 是内部用的,不出网)。
  return {
    ts: record.ts,
    level: record.level,
    src: record.src,
    scope: record.scope,
    msg: record.msg,
  };
}

/**
 * 锚点裁剪：超过条数上限时，按「离**任一**锚点最近」保留。
 *
 * 为什么不能简单地保留最新 N 条：崩溃后用户会重启继续用，新日志迅速堆积。取最新 N 条
 * 会把崩溃当时的记录整段裁掉——重试传了一堆无关新日志却「成功」，崩溃现场永久丢失
 * （需求 §11 的既有教训）。
 */
export function trimByAnchors(
  records: readonly ParsedRecord[],
  anchors: readonly number[],
): ParsedRecord[] {
  const sorted = [...records].sort((a, b) => a.tsMs - b.tsMs);
  if (sorted.length <= MAX_RECORDS) return sorted;
  const scored = sorted.map((record, index) => ({
    index,
    record,
    distance: minAnchorDistance(record.tsMs, anchors),
  }));
  scored.sort((a, b) => (a.distance !== b.distance ? a.distance - b.distance : a.index - b.index));
  const keep = scored.slice(0, MAX_RECORDS);
  keep.sort((a, b) => a.index - b.index); // 还原时间顺序
  return keep.map((entry) => entry.record);
}

function minAnchorDistance(tsMs: number, anchors: readonly number[]): number {
  let best = Number.MAX_SAFE_INTEGER;
  for (const anchor of anchors) {
    const d = Math.abs(tsMs - anchor);
    if (d < best) best = d;
  }
  return best;
}

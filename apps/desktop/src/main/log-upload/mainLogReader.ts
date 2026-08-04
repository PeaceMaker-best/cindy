/**
 * `main-<date>.log` 的读侧：字节窗口 → 结构化记录。
 *
 * 三件事：
 *  1. **记录边界识别**（`MAIN_LOG_RECORD_HEAD_RE`）—— 与写侧的续行转义是同一条安全
 *     不变量的两半，见 `shared/mainLogRecordFormat.ts`；
 *  2. **哨兵之前的内容一律丢弃** —— 转义引入之前写下的日志没有转义，其中可能含伪造的
 *     记录头；哨兵把「这段内容由哪个版本写的」变成文件内可判定的事实；
 *  3. **定位读取**（`findOffsetAtOrBefore`）—— 单文件超过字节预算时不能简单读尾部，
 *     崩溃后堆积的新日志会把崩溃现场挤出窗口。main 日志按天单文件内时间严格递增且每条
 *     记录首行自带可解析时间戳，因此可以二分查找到崩溃锚点附近的字节偏移。
 *
 * 纯逻辑：不 import electron、不 import logger，文件访问由调用方注入。
 */

import {
  MAIN_LOG_RECORD_HEAD_RE,
  RECORD_FORMAT_SENTINEL_MSG,
  RECORD_FORMAT_SENTINEL_SCOPE,
} from '../../shared/mainLogRecordFormat';
import { MAX_MSG_CHARS } from './limits';
import { redact } from './redact';
import { isAllowedScope } from './sourceAllowlist';
import type { ParsedRecord } from './types';

/** 注入的随机读能力。只暴露「大小」与「按 offset 读」，读不到别的东西。 */
export interface RandomAccessFile {
  size(): Promise<number>;
  /** 读 [offset, offset + length) ；越界时返回实际读到的字节。 */
  read(offset: number, length: number): Promise<Buffer>;
}

export interface ParseMainLogOptions {
  /**
   * 本次窗口是否从文件起始处开始。false 表示窗口是从中间某个偏移切进来的，
   * 第一行可能是半行，必须丢弃。
   */
  fromFileStart: boolean;
  /**
   * 是否已经在**本文件更早的位置**见过哨兵。
   *
   * 定位读取会跳过文件开头（哨兵通常就在那里），所以偏移读取时不能要求「窗口内必须
   * 再出现一次哨兵」——那会让崩溃补传恒采到 0 条。调用方按「窗口起点之前是否存在哨兵」
   * 传入（见 `readMainLogRecords`）。
   */
  sentinelAlreadySeen: boolean;
  /** 用于抹掉真实用户名（见 redact）。 */
  homeDir?: string;
}

export interface ParseMainLogResult {
  records: ParsedRecord[];
  linesScanned: number;
  droppedBySource: number;
  /** 本窗口内是否出现过哨兵（供调用方级联判断）。 */
  sawSentinel: boolean;
}

interface PendingRecord {
  tsStr: string;
  tsMs: number;
  level: string;
  scope: string;
  lines: string[];
}

function isSentinel(scope: string, msg: string): boolean {
  return scope === RECORD_FORMAT_SENTINEL_SCOPE && msg.trim() === RECORD_FORMAT_SENTINEL_MSG;
}

/** 第四层的截断：超长正文截断并标注原长度，避免把大 blob 灌进上报。 */
export function truncateMsg(msg: string): string {
  if (msg.length <= MAX_MSG_CHARS) return msg;
  return `${msg.slice(0, MAX_MSG_CHARS)}…(truncated, ${msg.length} chars)`;
}

/**
 * 解析一段 main 日志文本。
 *
 * 一条记录 = 一个命中 head 正则的行 + 其后所有**未命中**的行（续行）。写侧保证续行
 * 永远以空格开头，因此续行不可能命中 head 正则——这正是「被封禁来源的多行内容里嵌入
 * 伪造记录头」这条逃逸路径被堵死的地方。
 */
export function parseMainLogText(
  text: string,
  options: ParseMainLogOptions,
): ParseMainLogResult {
  const records: ParsedRecord[] = [];
  let linesScanned = 0;
  let droppedBySource = 0;
  let sawSentinel = options.sentinelAlreadySeen;
  let pending: PendingRecord | null = null;

  const flush = (): void => {
    if (!pending) return;
    const current = pending;
    pending = null;
    const rawMsg = current.lines.join('\n');
    if (isSentinel(current.scope, rawMsg)) {
      sawSentinel = true;
      return; // 哨兵本身不上报
    }
    // 哨兵之前的内容一律丢弃(可能是未转义的旧格式)。
    if (!sawSentinel) return;
    // 第二层:来源白名单。deny-by-default,未知来源直接丢。
    if (!isAllowedScope(current.scope)) {
      droppedBySource += 1;
      return;
    }
    // 第三层 + 第四层:红线脱敏 → 截断。顺序不能换 —— 先截断会把一个刚好跨越截断点的
    // 凭证切成两半,后半段留在正文里逃过脱敏。
    records.push({
      ts: current.tsStr,
      tsMs: current.tsMs,
      level: current.level.trim(),
      src: 'main',
      scope: current.scope,
      msg: truncateMsg(redact(rawMsg, options.homeDir)),
    });
  };

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    // 窗口从中间切进来时,第一行可能是半行 —— 丢掉,避免把半行当完整记录或续行。
    if (i === 0 && !options.fromFileStart) continue;
    const line = lines[i].replace(/\r$/, '');
    linesScanned += 1;
    const head = MAIN_LOG_RECORD_HEAD_RE.exec(line);
    if (head) {
      flush();
      const tsMs = Date.parse(head[1]);
      pending = {
        tsStr: head[1],
        // 时间戳解析不出来的记录无法参与锚点打分与排序,按 0 处理会把它排到最前面并
        // 挤掉真实记录 —— 直接标成 NaN,由下游过滤掉。
        tsMs: Number.isFinite(tsMs) ? tsMs : Number.NaN,
        level: head[2],
        scope: head[3],
        lines: [line.slice(head[0].length)],
      };
      continue;
    }
    // 续行:并入当前记录。没有当前记录(窗口第一行就是续行,或哨兵前的残留)则丢弃。
    if (pending) pending.lines.push(line);
  }
  flush();

  return {
    records: records.filter((r) => Number.isFinite(r.tsMs)),
    linesScanned,
    droppedBySource,
    sawSentinel,
  };
}

/**
 * 二分查找：返回**第一条时间戳 ≥ targetMs 的记录**所在行的起始偏移；
 * 全文都早于 targetMs 时返回文件末尾附近；文件为空返回 0。
 *
 * 前提：单个 main 日志文件内记录时间**单调不减**（logger 按天 rotate + 追加写，
 * 同一进程内 emit 顺序即时间顺序；多实例并发追加可能出现极小的乱序，对定位无实质影响）。
 */
export async function findOffsetAtOrBefore(
  file: RandomAccessFile,
  targetMs: number,
  probeBytes = 8 * 1024,
): Promise<number> {
  const size = await file.size();
  if (size <= 0) return 0;
  let lo = 0;
  let hi = size;
  // 循环不变量:[lo, hi) 内包含答案。每轮把区间砍半,probeBytes 的读取只用于定位行首。
  while (hi - lo > probeBytes) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const found = await firstRecordTimestampAt(file, mid, probeBytes);
    if (found === null) {
      // 该探测点附近读不到完整记录头(超长续行等),保守往左收,宁可多读。
      hi = mid;
      continue;
    }
    if (found.tsMs >= targetMs) hi = mid;
    else lo = mid;
  }
  return lo;
}

/** 从 offset 起找到第一个完整行,解析其记录头时间戳。找不到返回 null。 */
async function firstRecordTimestampAt(
  file: RandomAccessFile,
  offset: number,
  probeBytes: number,
): Promise<{ tsMs: number } | null> {
  const buf = await file.read(offset, probeBytes);
  if (buf.length === 0) return null;
  const text = buf.toString('utf8');
  const nl = text.indexOf('\n');
  // offset 落在行中间:从下一行开始看。offset === 0 时当前行就是完整行。
  const body = offset === 0 ? text : nl >= 0 ? text.slice(nl + 1) : '';
  for (const line of body.split('\n')) {
    const head = MAIN_LOG_RECORD_HEAD_RE.exec(line);
    if (!head) continue;
    const tsMs = Date.parse(head[1]);
    if (Number.isFinite(tsMs)) return { tsMs };
  }
  return null;
}

/**
 * 文件内首个格式哨兵**记录**的结束字节偏移；找不到返回 null。
 *
 * 只读文件开头一小段：哨兵由 logger 在打开当天文件时立刻写入，正常情况下就在文件最前面
 * （同一天多次启动会有多个哨兵，认第一个）。读不到就按「未见过哨兵」处理，让窗口内自己
 * 去找——最坏结果是这一天采不到内容，而不是把旧格式内容放出去。
 *
 * ⚠️ 必须按**完整记录头 + 哨兵正文**校验整行，不能拿哨兵串去 `indexOf` 搜任意位置
 * （2026-08-04 review 指出的隐私逃逸路径）：升级前的未转义正文里只要出现
 * `[logger] #cindy-log-format:2` 这段文字（用户对话内容完全可以包含它），子串匹配就会把
 * 那一行认成哨兵、置位 `sentinelAlreadySeen`，于是它后面被封禁来源里伪造的放行记录头
 * 全部绕过「哨兵之前一律丢弃」这道闸被上传。
 *
 * 偏移必须按**字节**算：调用方拿它和 `startOffset`（字节）比较，而日志正文里有大量中文，
 * 字符下标与字节偏移不是一回事——用 `text.indexOf` 的字符下标当字节偏移会偏小，
 * 让「哨兵在窗口起点之前」的判断偏向误判为真。
 *
 * 只认**完整的**哨兵行（后面必须有换行符落在缓冲区内）：headBytes 边界可能把行截断，
 * 半行不该被当成哨兵。
 */
export async function sentinelOffset(
  file: RandomAccessFile,
  headBytes = 64 * 1024,
): Promise<number | null> {
  const buf = await file.read(0, headBytes);
  if (buf.length === 0) return null;
  const text = buf.toString('utf8');
  let byteOffset = 0;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    // 该行连同它的 '\n' 占多少字节;最后一段没有 '\n'(split 的产物),不计。
    const isLastSegment = i === lines.length - 1;
    const lineBytes = Buffer.byteLength(rawLine, 'utf8') + (isLastSegment ? 0 : 1);
    if (!isLastSegment && isSentinelLine(rawLine.replace(/\r$/, ''))) {
      return byteOffset + lineBytes;
    }
    byteOffset += lineBytes;
  }
  return null;
}

/** 整行是否**就是**一条哨兵记录：合法记录头 + scope 为 logger + 正文恰好是哨兵串。 */
function isSentinelLine(line: string): boolean {
  const head = MAIN_LOG_RECORD_HEAD_RE.exec(line);
  if (!head || head[3] !== RECORD_FORMAT_SENTINEL_SCOPE) return false;
  return line.slice(head[0].length).trim() === RECORD_FORMAT_SENTINEL_MSG;
}

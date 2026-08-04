/**
 * 采集编排的隐私锁与可靠性锁。
 *
 * 最重要的一条是第一个 describe：**会话目录与调试原文即使存在也不被读取**（需求 §6 隐私性
 * 第 1 条）。断言方式是「注入的 openFile 从未收到那些路径」，而不是「结果里没有对话内容」——
 * 后者在实现改成「读了但过滤掉」时照样会通过，而那已经是隐私事故（内容进过进程内存、也可能
 * 被别的日志带出去）。
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';

import {
  escapeMainLogContinuationLines,
  RECORD_FORMAT_SENTINEL_MSG,
} from '../../../shared/mainLogRecordFormat';
import { collectLogs, resolveLookbackDays, trimByAnchors, type CollectDeps } from '../collect';
import { MAX_LOOKBACK_DAYS_CAP, MAX_RECORDS } from '../limits';
import type { ParsedRecord } from '../types';

const DAY_MS = 24 * 60 * 60 * 1000;
/** 固定「现在」：2026-08-04 12:00 本地时间。测试不依赖真实时钟。 */
const NOW = new Date(2026, 7, 4, 12, 0, 0).getTime();

function isoLocal(tsMs: number): string {
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

function mainLine(tsMs: number, level: string, scope: string, msg: string): string {
  return `[${isoLocal(tsMs)}] [${level}] [${scope}] ${escapeMainLogContinuationLines(msg)}`;
}

function dayKey(tsMs: number): string {
  const d = new Date(tsMs);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 内存文件系统 harness：记录所有被打开的路径。 */
function harness(files: Record<string, string>): {
  deps: CollectDeps;
  openedPaths: string[];
} {
  const openedPaths: string[] = [];
  const logDir = path.join('/tmp', 'cindy-logs');
  const deps: CollectDeps = {
    logDir,
    listDir: async (dir) => {
      if (dir !== logDir) throw new Error(`unexpected listDir ${dir}`);
      // 只返回 logs 根的**文件名**,与真实 readdir 一致(子目录名也会出现,这里刻意包含
      // 'sessions' 来验证采集端不会顺着它往下走)。
      return Object.keys(files)
        .map((p) => p.slice(logDir.length + 1))
        .filter((rel) => !rel.includes(path.sep))
        .concat(['sessions']);
    },
    openFile: async (filePath) => {
      openedPaths.push(filePath);
      const content = files[filePath];
      if (content === undefined) return null;
      const buf = Buffer.from(content, 'utf8');
      return {
        size: async () => buf.length,
        read: async (offset: number, length: number) =>
          buf.subarray(offset, Math.min(offset + length, buf.length)),
        close: async () => undefined,
      };
    },
    now: () => NOW,
    homeDir: '/Users/tester',
    yieldToEventLoop: async () => undefined,
    joinPath: (...parts) => path.join(...parts),
  };
  return { deps, openedPaths };
}

const SENTINEL = mainLine(NOW - 60_000, 'INFO ', 'logger', RECORD_FORMAT_SENTINEL_MSG);

describe('第一层源白名单：会话目录与调试原文永不被打开', () => {
  it('诱饵文件存在也不被读取，且内容不出现在结果里', async () => {
    const logDir = path.join('/tmp', 'cindy-logs');
    const today = dayKey(NOW);
    const files: Record<string, string> = {
      [path.join(logDir, `main-${today}.log`)]: [
        SENTINEL,
        mainLine(NOW - 30_000, 'INFO ', 'lifecycle', 'before-quit received'),
      ].join('\n'),
      // ↓ 全是诱饵:采集端一旦构造这些路径,openedPaths 断言就会红。
      [path.join(logDir, 'sessions', 'abc', `${today}.ndjson`)]: JSON.stringify({
        ts: NOW,
        level: 'info',
        source: 'maker',
        scope: 'maker/s:abc',
        msg: '用户的完整对话正文',
      }),
      [path.join(logDir, 'sessions', 'abc', 'cc-debug.raw.log')]: '请求与响应原文',
      [path.join(logDir, 'cc-debug.raw.log')]: '全局请求响应原文',
    };
    const { deps, openedPaths } = harness(files);

    const result = await collectLogs(deps, { reason: 'crash-backfill', anchors: [NOW - 30_000] });

    for (const opened of openedPaths) {
      expect(opened).not.toContain(`${path.sep}sessions${path.sep}`);
      expect(opened).not.toContain('cc-debug');
    }
    const serialized = JSON.stringify(result.records);
    expect(serialized).not.toContain('对话正文');
    expect(serialized).not.toContain('原文');
    expect(result.records).toHaveLength(1);
  });

  it('手动上报不读 agent 流（只在崩溃路径作上下文）', async () => {
    const logDir = path.join('/tmp', 'cindy-logs');
    const today = dayKey(NOW);
    const files: Record<string, string> = {
      [path.join(logDir, `main-${today}.log`)]: [
        SENTINEL,
        mainLine(NOW - 30_000, 'INFO ', 'lifecycle', 'ok'),
      ].join('\n'),
      [path.join(logDir, `agent-${today}.ndjson`)]: JSON.stringify({
        ts: NOW - 20_000,
        level: 'info',
        source: 'proxy',
        scope: 'cc-proxy/req',
        msg: 'POST /v1/messages 200 812ms',
      }),
    };
    const { deps, openedPaths } = harness(files);

    await collectLogs(deps, { reason: 'manual', anchors: [] });

    expect(openedPaths.some((p) => p.includes('agent-'))).toBe(false);
  });

  it('崩溃路径读 agent 流，但只取 proxy 源', async () => {
    const logDir = path.join('/tmp', 'cindy-logs');
    const today = dayKey(NOW);
    const files: Record<string, string> = {
      [path.join(logDir, `main-${today}.log`)]: SENTINEL,
      [path.join(logDir, `agent-${today}.ndjson`)]: [
        JSON.stringify({
          ts: NOW - 20_000,
          level: 'info',
          source: 'proxy',
          scope: 'cc-proxy/req',
          msg: 'POST /v1/messages 200 812ms',
        }),
        // maker 源:可能带 agent 提示词与用户内容,必须丢。
        JSON.stringify({
          ts: NOW - 19_000,
          level: 'debug',
          source: 'maker',
          scope: 'maker/s:abc',
          msg: '用户提示词正文',
        }),
        // source 被写成 proxy 但 scope 不在 proxy 根下:双闸拦下。
        JSON.stringify({
          ts: NOW - 18_000,
          level: 'debug',
          source: 'proxy',
          scope: 'maker/s:abc',
          msg: '伪装成 proxy 的用户内容',
        }),
      ].join('\n'),
    };
    const { deps } = harness(files);

    const result = await collectLogs(deps, { reason: 'crash-backfill', anchors: [NOW - 20_000] });

    expect(result.records).toHaveLength(1);
    expect(result.records[0].src).toBe('proxy');
    const serialized = JSON.stringify(result.records);
    expect(serialized).not.toContain('提示词');
    expect(serialized).not.toContain('伪装');
  });
});

describe('第四层：上报记录只有五个白名单字段', () => {
  it('产出的对象没有 tsMs 等内部字段', async () => {
    const logDir = path.join('/tmp', 'cindy-logs');
    const today = dayKey(NOW);
    const { deps } = harness({
      [path.join(logDir, `main-${today}.log`)]: [
        SENTINEL,
        mainLine(NOW - 30_000, 'INFO ', 'lifecycle', 'ok'),
      ].join('\n'),
    });

    const result = await collectLogs(deps, { reason: 'manual', anchors: [] });

    expect(Object.keys(result.records[0]).sort()).toEqual(['level', 'msg', 'scope', 'src', 'ts']);
  });
});

describe('回溯窗口', () => {
  it('默认两天', () => {
    expect(resolveLookbackDays(NOW, [])).toBe(2);
  });

  it('崩溃在 5 天前 → 窗口覆盖到崩溃当天', () => {
    // +1 是为了覆盖锚点当天本身,所以 5 天前 → 6。
    expect(resolveLookbackDays(NOW, [NOW - 5 * DAY_MS])).toBe(6);
  });

  it('多次未传崩溃：按最早那次放宽', () => {
    expect(resolveLookbackDays(NOW, [NOW - DAY_MS, NOW - 7 * DAY_MS, NOW - 3 * DAY_MS])).toBe(8);
  });

  it('超出本地保留期时被 clamp（更远的日志已被清理，读它没意义）', () => {
    expect(resolveLookbackDays(NOW, [NOW - 400 * DAY_MS])).toBe(MAX_LOOKBACK_DAYS_CAP);
  });

  it('隔几天才重开应用时能采到崩溃当天的记录（固定窄窗口会采到 0 条）', async () => {
    const logDir = path.join('/tmp', 'cindy-logs');
    const crashAt = NOW - 5 * DAY_MS;
    const crashDay = dayKey(crashAt);
    const { deps } = harness({
      [path.join(logDir, `main-${crashDay}.log`)]: [
        mainLine(crashAt - 120_000, 'INFO ', 'logger', RECORD_FORMAT_SENTINEL_MSG),
        mainLine(crashAt, 'FATAL', 'process', 'uncaughtException: boom'),
      ].join('\n'),
    });

    const result = await collectLogs(deps, { reason: 'crash-backfill', anchors: [crashAt] });

    expect(result.records).toHaveLength(1);
    expect(result.records[0].msg).toContain('uncaughtException');
    expect(result.stats.lookbackDays).toBe(6);
  });
});

describe('锚点裁剪', () => {
  function record(tsMs: number, msg: string): ParsedRecord {
    return { ts: isoLocal(tsMs), tsMs, level: 'info', src: 'main', scope: 'lifecycle', msg };
  }

  it('未超上限时原样返回（按时间升序）', () => {
    const records = [record(NOW, 'b'), record(NOW - 1000, 'a')];
    expect(trimByAnchors(records, [NOW]).map((r) => r.msg)).toEqual(['a', 'b']);
  });

  it('崩溃后堆积大量新日志时，崩溃时刻的记录仍然被保留', () => {
    const crashAt = NOW - 3 * 60 * 60 * 1000;
    const records: ParsedRecord[] = [record(crashAt, 'CRASH-MOMENT')];
    // 崩溃之后堆 2× 上限的新日志:取「最新 N 条」会把崩溃现场整段挤掉。
    for (let i = 0; i < MAX_RECORDS * 2; i += 1) {
      records.push(record(NOW - i * 1000, `noise-${i}`));
    }

    const kept = trimByAnchors(records, [crashAt]);

    expect(kept).toHaveLength(MAX_RECORDS);
    expect(kept.some((r) => r.msg === 'CRASH-MOMENT')).toBe(true);
  });

  it('多个锚点：每次崩溃附近的记录都被保留', () => {
    const crashA = NOW - 6 * 60 * 60 * 1000;
    const crashB = NOW - 60 * 60 * 1000;
    const records: ParsedRecord[] = [record(crashA, 'CRASH-A'), record(crashB, 'CRASH-B')];
    for (let i = 0; i < MAX_RECORDS * 2; i += 1) {
      records.push(record(NOW - i * 500, `noise-${i}`));
    }

    const kept = trimByAnchors(records, [crashA, crashB]);

    expect(kept.some((r) => r.msg === 'CRASH-A')).toBe(true);
    expect(kept.some((r) => r.msg === 'CRASH-B')).toBe(true);
  });

  it('裁剪后仍按时间升序（时间线不能乱）', () => {
    const records: ParsedRecord[] = [];
    for (let i = 0; i < MAX_RECORDS + 50; i += 1) {
      records.push(record(NOW - i * 1000, `r-${i}`));
    }
    const kept = trimByAnchors(records, [NOW]);
    for (let i = 1; i < kept.length; i += 1) {
      expect(kept[i].tsMs).toBeGreaterThanOrEqual(kept[i - 1].tsMs);
    }
  });
});

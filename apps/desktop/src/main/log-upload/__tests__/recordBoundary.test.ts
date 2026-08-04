/**
 * 「记录边界不可被伪造」这条安全不变量的锁（需求 §5.5 / §6 隐私性第 2 条）。
 *
 * 攻击面：被封禁来源（会打用户内容的功能日志）的**多行**记录里，嵌入一个看起来像放行来源
 * 的记录头，让上报侧把对话正文当成基础设施日志切出来送走。
 *
 * 两侧各测一半：
 *  - 写侧：`escapeMainLogContinuationLines()` 之后，除首行外没有任何行命中 head 正则；
 *  - 读侧：即使输入里真的有伪造头（模拟未转义的存量文件），哨兵之前的内容一律不产出记录。
 */
import { describe, expect, it } from 'vitest';

import {
  escapeMainLogContinuationLines,
  MAIN_LOG_RECORD_HEAD_RE,
  RECORD_FORMAT_SENTINEL_MSG,
} from '../../../shared/mainLogRecordFormat';
import { parseMainLogText, sentinelOffset, type RandomAccessFile } from '../mainLogReader';

/** 造一条 main 日志行，格式与 logger.emit 的输出逐字符一致。 */
function line(ts: string, level: string, scope: string, msg: string): string {
  return `[${ts}] [${level}] [${scope}] ${escapeMainLogContinuationLines(msg)}`;
}

const TS1 = '2026-08-04T10:00:00.000+08:00';
const TS2 = '2026-08-04T10:00:01.000+08:00';
const TS3 = '2026-08-04T10:00:02.000+08:00';
const SENTINEL = line(TS1, 'INFO ', 'logger', RECORD_FORMAT_SENTINEL_MSG);

describe('写侧：续行转义', () => {
  const ADVERSARIAL: Array<{ name: string; msg: string }> = [
    {
      name: '正文里嵌入一个完整的放行来源记录头',
      msg: `user said hi\n[${TS2}] [INFO ] [lifecycle] fake infra record`,
    },
    {
      name: '正文里嵌入多个伪造头',
      msg: `a\n[${TS2}] [ERROR] [authManager] x\nb\n[${TS3}] [FATAL] [process] y`,
    },
    {
      name: 'CRLF 换行',
      msg: `a\r\n[${TS2}] [INFO ] [lifecycle] fake`,
    },
    {
      name: '连续空行后接伪造头',
      msg: `a\n\n\n[${TS2}] [WARN ] [updateService] fake`,
    },
    {
      name: '首行就是伪造头（记录首行本来就该被认，但续行不能）',
      msg: `[${TS2}] [INFO ] [lifecycle] first\n[${TS3}] [INFO ] [lifecycle] second`,
    },
  ];

  it.each(ADVERSARIAL)('$name：除首行外没有行命中 head 正则', ({ msg }) => {
    const rendered = line(TS1, 'DEBUG', 'voice-input', msg);
    const lines = rendered.split('\n').map((l) => l.replace(/\r$/, ''));
    expect(MAIN_LOG_RECORD_HEAD_RE.test(lines[0])).toBe(true);
    for (const continuation of lines.slice(1)) {
      expect(MAIN_LOG_RECORD_HEAD_RE.test(continuation)).toBe(false);
    }
  });

  it('单行消息不被改动（绝大多数日志走这条路，不该有额外开销或视觉变化）', () => {
    expect(escapeMainLogContinuationLines('plain message')).toBe('plain message');
  });
});

describe('读侧：伪造记录头无法把被封禁来源的内容送出去', () => {
  it('转义后的被封禁记录：伪造头被当作续行，不产出任何放行记录', () => {
    const text = [
      SENTINEL,
      line(
        TS2,
        'DEBUG',
        'voice-input:recorder',
        `draft: 我的私密对话内容\n[${TS3}] [INFO ] [lifecycle] forged infra line`,
      ),
    ].join('\n');

    const result = parseMainLogText(text, { fromFileStart: true, sentinelAlreadySeen: false });

    expect(result.records).toHaveLength(0);
    expect(result.droppedBySource).toBe(1);
    const serialized = JSON.stringify(result.records);
    expect(serialized).not.toContain('私密对话内容');
    expect(serialized).not.toContain('forged infra line');
  });

  it('未转义的存量内容（哨兵之前）整段丢弃，伪造头也拿不到放行', () => {
    // 模拟升级前写下的文件:被封禁记录的续行**没有**前置空格,因此真的命中 head 正则。
    const legacy = [
      `[${TS1}] [DEBUG] [voice-input:recorder] draft: 泄漏用的对话正文`,
      `[${TS1}] [INFO ] [lifecycle] forged head carrying 对话正文续段`,
    ].join('\n');
    const text = [legacy, SENTINEL, line(TS2, 'INFO ', 'lifecycle', 'real infra record')].join('\n');

    const result = parseMainLogText(text, { fromFileStart: true, sentinelAlreadySeen: false });

    // 只有哨兵之后那一条真记录被产出。
    expect(result.records).toHaveLength(1);
    expect(result.records[0].msg).toBe('real infra record');
    const serialized = JSON.stringify(result.records);
    expect(serialized).not.toContain('对话正文');
  });

  it('没有哨兵的文件一条也不产出（fail closed，不猜格式版本）', () => {
    const text = line(TS1, 'INFO ', 'lifecycle', 'infra record without sentinel');
    const result = parseMainLogText(text, { fromFileStart: true, sentinelAlreadySeen: false });
    expect(result.records).toHaveLength(0);
  });

  it('sentinelAlreadySeen=true（定位读取跳过了文件开头）时正常产出', () => {
    const text = line(TS2, 'INFO ', 'lifecycle', 'infra record mid-file');
    const result = parseMainLogText(text, { fromFileStart: true, sentinelAlreadySeen: true });
    expect(result.records).toHaveLength(1);
  });

  it('窗口从中间切进来时第一行（半行）被丢弃', () => {
    const text = ['record body cut in half', line(TS2, 'INFO ', 'lifecycle', 'ok')].join('\n');
    const result = parseMainLogText(text, { fromFileStart: false, sentinelAlreadySeen: true });
    expect(result.records).toHaveLength(1);
    expect(result.records[0].msg).toBe('ok');
  });

  it('多行的放行记录：续行内容被完整保留（堆栈是崩溃排查的主要证据）', () => {
    const stack = 'Error: boom\n    at foo (/app/x.js:1:1)\n    at bar (/app/y.js:2:2)';
    const text = [SENTINEL, line(TS2, 'FATAL', 'process', `uncaughtException: ${stack}`)].join('\n');
    const result = parseMainLogText(text, { fromFileStart: true, sentinelAlreadySeen: false });
    expect(result.records).toHaveLength(1);
    expect(result.records[0].msg).toContain('at foo');
    expect(result.records[0].msg).toContain('at bar');
  });

  it('渲染进程转发的日志（r: 前缀）整类丢弃', () => {
    const text = [
      SENTINEL,
      line(TS2, 'INFO ', 'r:lifecycle', 'renderer forwarded, must not pass'),
    ].join('\n');
    const result = parseMainLogText(text, { fromFileStart: true, sentinelAlreadySeen: false });
    expect(result.records).toHaveLength(0);
    expect(result.droppedBySource).toBe(1);
  });

  it('时间戳解析不出来的记录被丢弃（否则会以 0 排到最前挤掉真记录）', () => {
    const text = [
      SENTINEL,
      // 月份 99 通过了 head 正则的字符形状，但 Date.parse 给 NaN。
      '[2026-99-99T10:00:00.000+08:00] [INFO ] [lifecycle] bogus timestamp',
    ].join('\n');
    const result = parseMainLogText(text, { fromFileStart: true, sentinelAlreadySeen: false });
    expect(result.records).toHaveLength(0);
  });

  /**
   * 2026-08-04 review 指出的隐私逃逸路径：`sentinelOffset` 原先拿哨兵串去 `indexOf` 搜任意
   * 位置，于是升级前未转义的正文里只要**出现过**这段文字（用户对话内容完全可以包含它），
   * 那一行就被认成哨兵、置位 `sentinelAlreadySeen`，它后面伪造的放行记录头就全部绕过
   * 「哨兵之前一律丢弃」这道闸。必须按完整记录头 + 哨兵正文校验整行。
   */
  describe('sentinelOffset：只认完整的哨兵记录行', () => {
    function fileOf(text: string): RandomAccessFile {
      const buf = Buffer.from(text, 'utf8');
      return {
        size: async () => buf.length,
        read: async (offset: number, length: number) =>
          buf.subarray(offset, Math.min(offset + length, buf.length)),
      };
    }

    it('正常情况：哨兵在第一行，返回其行尾字节偏移', async () => {
      const text = `${SENTINEL}\n${line(TS2, 'INFO ', 'lifecycle', 'after')}\n`;
      const at = await sentinelOffset(fileOf(text));
      expect(at).toBe(Buffer.byteLength(`${SENTINEL}\n`, 'utf8'));
    });

    it('⚠️ 正文里出现哨兵串但不是完整记录行 ⇒ 不认（这是原来的逃逸口）', async () => {
      const text = [
        line(TS1, 'DEBUG', 'voice-input:recorder', `用户说: ${RECORD_FORMAT_SENTINEL_MSG} 你看`),
        line(TS2, 'DEBUG', 'voice-input:recorder', `[logger] ${RECORD_FORMAT_SENTINEL_MSG}`),
      ].join('\n');
      expect(await sentinelOffset(fileOf(text))).toBeNull();
    });

    it('scope 不是 logger 的同名正文 ⇒ 不认', async () => {
      const text = `${line(TS1, 'INFO ', 'lifecycle', RECORD_FORMAT_SENTINEL_MSG)}\n`;
      expect(await sentinelOffset(fileOf(text))).toBeNull();
    });

    it('偏移按字节算：哨兵前有中文内容时不会偏小（字符下标 ≠ 字节偏移）', async () => {
      const cjk = line(TS1, 'INFO ', 'lifecycle', '中文日志内容占多字节');
      const text = `${cjk}\n${SENTINEL}\n`;
      const at = await sentinelOffset(fileOf(text));
      expect(at).toBe(Buffer.byteLength(`${cjk}\n${SENTINEL}\n`, 'utf8'));
      // 字符长度会明显小于字节长度,用它当偏移就会偏小。
      expect(at).toBeGreaterThan(`${cjk}\n${SENTINEL}\n`.length);
    });

    it('被 headBytes 截断的半行哨兵 ⇒ 不认（宁可这一天采不到，也不放旧格式内容）', async () => {
      const text = `${SENTINEL}\n`;
      const truncated = Buffer.byteLength(SENTINEL, 'utf8') - 5;
      expect(await sentinelOffset(fileOf(text), truncated)).toBeNull();
    });

    it('空文件 ⇒ null', async () => {
      expect(await sentinelOffset(fileOf(''))).toBeNull();
    });
  });

  it('产出的记录只有五个白名单字段（第四层）', () => {
    const text = [SENTINEL, line(TS2, 'INFO ', 'lifecycle', 'hello')].join('\n');
    const result = parseMainLogText(text, { fromFileStart: true, sentinelAlreadySeen: false });
    // tsMs 是解析阶段的内部字段;上报形状由 collect 的 toUploadRecord 收口(见 collect.test)。
    expect(Object.keys(result.records[0]).sort()).toEqual(
      ['level', 'msg', 'scope', 'src', 'ts', 'tsMs'].sort(),
    );
  });
});

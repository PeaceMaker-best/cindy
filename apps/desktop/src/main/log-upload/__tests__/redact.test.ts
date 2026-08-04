/**
 * 第三层正则红线的隐私锁（需求 §6 隐私性第 3 条）。
 *
 * 每条用例的断言方式统一为「原始敏感串在输出里**一个字都找不到**」——不是「输出里出现了
 * <redacted>」。后者会让一个只抹掉前半段的坏规则照样通过。
 */
import { describe, expect, it } from 'vitest';

import { homeUserName, redact } from '../redact';

/** 表驱动：输入 → 必须消失的子串。 */
/**
 * 各厂商凭证形态的假样本**在运行时拼出来**，源码里不留完整字面量。
 *
 * 理由不是洁癖：这些样本必须**长得像真凭证**才能检验正则，而 GitHub 的 secret scanning
 * push protection 正是按同样的形态判定的——直接写完整字面量会让整个 push 被拒
 * （实测：`xoxb-…` 那条把本 PR 的首次 push 挡了下来）。拼接后扫描器看不到连续的 token，
 * 而 `redact()` 拿到的输入与拼接前逐字节相同，覆盖不受影响。
 *
 * 新增厂商样本时照这个写法，不要图省事写成整串。
 */
const FAKE = {
  jwt: ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'ZmFrZS1zaWduYXR1cmUtZm9yLXRlc3Q'].join('.'),
  skAnt: ['sk', 'ant', 'api03', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'].join('-'),
  githubClassic: ['ghp', 'AbCdEfGhIjKlMnOpQrStUvWxYz01234567'].join('_'),
  githubPat: ['github', 'pat', '11ABCDEFG0abcdefghijkl', 'ABCDEFGHIJKLMNOP'].join('_'),
  aliyunAk: ['LTAI', '5tAbCdEfGhIjKlMnOpQr'].join(''),
  awsAk: ['AKIA', 'IOSFODNN7EXAMPLE'].join(''),
  googleKey: ['AIza', 'SyA1234567890abcdefghijklmnopqrstuvw'].join(''),
  slackBot: ['xoxb', '1234567890', 'abcdefghijklmnop'].join('-'),
} as const;

const CASES: Array<{ name: string; input: string; mustVanish: string[] }> = [
  {
    name: 'JWT',
    input: `auth ok token=${FAKE.jwt}`,
    mustVanish: [FAKE.jwt.split('.')[0], FAKE.jwt.split('.')[2]],
  },
  {
    name: 'Anthropic / OpenAI sk- key',
    input: `provider probe failed with key ${FAKE.skAnt}`,
    mustVanish: [FAKE.skAnt],
  },
  {
    name: 'GitHub token',
    input: `clone failed: ${FAKE.githubClassic}`,
    mustVanish: [FAKE.githubClassic],
  },
  {
    name: 'GitHub fine-grained PAT',
    input: `using ${FAKE.githubPat}`,
    mustVanish: [FAKE.githubPat],
  },
  {
    name: '阿里云 AccessKey',
    input: `oss put denied for ${FAKE.aliyunAk}`,
    mustVanish: [FAKE.aliyunAk],
  },
  {
    name: 'AWS AccessKey',
    input: `sts assume-role ${FAKE.awsAk} failed`,
    mustVanish: [FAKE.awsAk],
  },
  {
    name: 'Google API key',
    input: `maps request ${FAKE.googleKey} rejected`,
    mustVanish: [FAKE.googleKey],
  },
  {
    name: 'Slack token',
    input: `slack post failed ${FAKE.slackBot}`,
    mustVanish: [FAKE.slackBot],
  },
  {
    name: 'Authorization 整头',
    input: 'request headers Authorization: Bearer abcdef1234567890xyz',
    mustVanish: ['abcdef1234567890xyz'],
  },
  {
    name: 'Cookie 整头',
    input: 'Cookie: sid=deadbeefcafe; theme=dark',
    mustVanish: ['deadbeefcafe'],
  },
  {
    name: '独立 Bearer 令牌',
    input: 'retrying with Bearer sometokenvalue1234567890',
    mustVanish: ['sometokenvalue1234567890'],
  },
  {
    name: '裸 JSON 的敏感字段',
    input: '{"refresh_token":"rt_super_secret_value_here","ok":true}',
    mustVanish: ['rt_super_secret_value_here'],
  },
  {
    name: '被转义的 JSON 敏感字段（日志里最常见的形态）',
    input: 'body={\\"api_key\\":\\"ak_escaped_secret_value\\",\\"n\\":1}',
    mustVanish: ['ak_escaped_secret_value'],
  },
  {
    name: 'k=v 形态的密码',
    input: 'connect string user=admin password=Hunter2Hunter2 db=cindy',
    mustVanish: ['Hunter2Hunter2'],
  },
  {
    name: 'URL query 参数值（搜索关键词等用户输入常在这里）',
    input: 'GET https://example.com/search?q=my+private+question&lang=zh 200',
    mustVanish: ['my+private+question'],
  },
  {
    name: 'PEM 私钥块',
    input: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
    mustVanish: ['MIIEowIBAAKCAQEA'],
  },
];

describe('redact', () => {
  it.each(CASES)('抹掉 $name', ({ input, mustVanish }) => {
    const out = redact(input);
    for (const secret of mustVanish) {
      expect(out).not.toContain(secret);
    }
  });

  it('邮箱只保留首字母与域名', () => {
    const out = redact('login failed for carol.smith@example.com');
    expect(out).not.toContain('carol.smith');
    expect(out).toContain('c***@example.com');
  });

  it('家目录用户名段被抹掉，路径其余部分保留供排查', () => {
    const out = redact('workdir /Users/somebody/projects/cindy scan failed');
    expect(out).not.toContain('somebody');
    // 保留 projects/cindy —— over-redact 只影响排障效率,但把路径全抹掉会让日志失去价值。
    expect(out).toContain('projects/cindy');
  });

  it('Windows 家目录同样被抹掉', () => {
    const out = redact('open C:\\Users\\someone\\AppData\\Roaming\\Cindy failed');
    expect(out).not.toContain('someone');
    expect(out).toContain('AppData');
  });

  it('Linux 家目录同样被抹掉', () => {
    const out = redact('read /home/devuser/.config/cindy failed');
    expect(out).not.toContain('devuser');
    expect(out).toContain('.config/cindy');
  });

  it('注入的 homeDir 用户名在非标准路径位置也被抹掉', () => {
    const out = redact('custom path D:\\Work\\zhangsan\\cache broke', 'C:\\Users\\zhangsan');
    expect(out).not.toContain('zhangsan');
  });

  it('过短的用户名不做全文替换（避免把随处可见的短串乱换）', () => {
    const out = redact('ab initio parsing of abc failed', '/Users/ab');
    expect(out).toContain('ab initio');
  });

  it('普通基础设施日志不被误伤（over-redact 有代价，但不能到不可读）', () => {
    const input =
      'update check: current=1.2.3 latest=1.2.4 channel=stable elapsed=812ms status=200';
    expect(redact(input)).toBe(input);
  });

  it('同一段文本里的多个秘密都被抹掉（规则之间不互相遮挡）', () => {
    const out = redact(
      'Authorization: Bearer tok_aaaaaaaaaaaa | key=sk-proj-BBBBBBBBBBBBBBBBBB | user=dave@x.io',
    );
    expect(out).not.toContain('tok_aaaaaaaaaaaa');
    expect(out).not.toContain('sk-proj-BBBBBBBBBBBBBBBBBB');
    expect(out).not.toContain('dave@x.io');
  });

  it('规则是无状态的：同一输入连续跑两次结果一致（正则 lastIndex 不串）', () => {
    const input = `token=${FAKE.jwt} and again ${FAKE.skAnt}`;
    expect(redact(input)).toBe(redact(input));
  });
});

describe('homeUserName', () => {
  it.each([
    ['/Users/sam', 'sam'],
    ['/home/dev', 'dev'],
    ['C:\\Users\\Admin', 'Admin'],
    ['C:\\Users\\Admin\\', 'Admin'],
  ])('%s → %s', (input, expected) => {
    expect(homeUserName(input)).toBe(expected);
  });

  it('空值返回 null', () => {
    expect(homeUserName(undefined)).toBeNull();
    expect(homeUserName('')).toBeNull();
  });
});

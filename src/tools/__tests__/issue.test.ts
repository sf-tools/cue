import { describe, expect, test } from 'bun:test';

import { _internal, runIssueToFixPlan, runLogTraceToCode } from '../issue';
import type { ShellResult } from '@/types';

const { extractTerms, classifyLogs, buildIssueFixPlan, shellEscape } = _internal;

function fakeShell(output: string): (cmd: string) => Promise<ShellResult> {
  return async () => ({ exitCode: 0, output });
}

function recordingShell(output: string) {
  const calls: string[] = [];
  const shell = async (cmd: string): Promise<ShellResult> => {
    calls.push(cmd);
    return { exitCode: 0, output };
  };
  return { shell, calls };
}

describe('extractTerms', () => {
  test('finds quoted phrases', () => {
    const terms = extractTerms('The "checkoutTotals" function returns wrong values');
    expect(terms).toContain('checkoutTotals');
  });

  test('finds CamelCase symbols', () => {
    const terms = extractTerms('We see CheckoutTotals returning bad numbers');
    expect(terms.some(term => /CheckoutTotals/.test(term))).toBe(true);
  });

  test('captures error phrases', () => {
    const terms = extractTerms('Error: Cannot find module "lodash" in production');
    expect(terms.some(term => /Cannot find module/i.test(term))).toBe(true);
  });

  test('skips stop words', () => {
    const terms = extractTerms('the with and from of');
    expect(terms.length).toBe(0);
  });
});

describe('classifyLogs', () => {
  test('detects OOM', () => {
    const out = classifyLogs('JavaScript heap out of memory');
    expect(out.some(line => /memory/.test(line))).toBe(true);
  });

  test('detects 5xx', () => {
    const out = classifyLogs('GET /api/v1/users 503');
    expect(out.some(line => /5xx/.test(line))).toBe(true);
  });

  test('falls back to default message when nothing matches', () => {
    const out = classifyLogs('hello world');
    expect(out.some(line => /no canonical patterns/.test(line))).toBe(true);
  });
});

describe('buildIssueFixPlan', () => {
  test('returns a complete plan with hypothesis when clusters present', () => {
    const plan = buildIssueFixPlan(
      'Crash when filtering checkout',
      [
        {
          file: 'src/checkout/filter.ts',
          hits: [{ file: 'src/checkout/filter.ts', line: 10, text: 'filter' }],
          matchedTerms: new Set(['filter']),
          score: 1.5,
        },
      ],
      'open invoice 123 then click filter',
      'staging',
    );
    expect(plan.symptoms.length).toBeGreaterThan(0);
    expect(plan.hypothesis).toMatch(/filter\.ts/);
    expect(plan.diagnose.length).toBeGreaterThan(0);
    expect(plan.test.length).toBeGreaterThan(0);
    expect(plan.reproduce.some(step => /invoice 123/.test(step))).toBe(true);
  });

  test('reports inconclusive hypothesis when no clusters', () => {
    const plan = buildIssueFixPlan('something is broken', [], null, null);
    expect(plan.hypothesis.toLowerCase()).toContain('no code overlap');
  });
});

describe('shellEscape', () => {
  test('wraps plain values in single quotes', () => {
    expect(shellEscape('hello')).toBe(`'hello'`);
  });

  test(`escapes embedded single quotes using the standard '\\'' pattern`, () => {
    expect(shellEscape("it's")).toBe(`'it'\\''s'`);
  });

  test('round-trips through a shell parser into the original string', () => {
    const parseShellWord = (escaped: string) => {
      let out = '';
      let inQuote = false;
      for (let i = 0; i < escaped.length; i += 1) {
        const c = escaped[i]!;
        if (inQuote) {
          if (c === "'") inQuote = false;
          else out += c;
        } else if (c === "'") {
          inQuote = true;
        } else if (c === '\\' && i + 1 < escaped.length) {
          out += escaped[++i];
        } else {
          out += c;
        }
      }
      return out;
    };
    const cases = ["it's", "a'b'c", "''", "no quotes", "mix it's a test"];
    for (const value of cases) {
      expect(parseShellWord(shellEscape(value))).toBe(value);
    }
  });
});

describe('STOP_WORDS', () => {
  test('does not contain duplicate entries (regression: when listed twice)', () => {
    const terms = extractTerms(
      'when when when checkoutTotals when broken bug issue when when',
    );
    expect(terms).not.toContain('when');
  });
});

describe('runIssueToFixPlan', () => {
  test('happy path with mocked rg output', async () => {
    const fake = fakeShell(
      [
        'src/checkout/filter.ts:10: filter("checkoutTotals")',
        'src/checkout/filter.ts:42: throw new Error("CheckoutTotals failed")',
      ].join('\n'),
    );
    const result = await runIssueToFixPlan('Crash with CheckoutTotals filter', {
      runUserShell: fake,
      max_files: 3,
    });
    expect(result.likely_files.length).toBeGreaterThan(0);
    expect(result.likely_files[0]!.path).toContain('filter.ts');
    expect(result.plan.symptoms.length).toBeGreaterThan(0);
  });

  test('rejects empty issue', async () => {
    await expect(
      runIssueToFixPlan('  ', { runUserShell: fakeShell('') }),
    ).rejects.toThrow();
  });

  test('passes search terms via -e and separates the path with -- (no arg injection)', async () => {
    const { shell, calls } = recordingShell('');
    await runIssueToFixPlan(
      'Crash in CheckoutTotals when filtering invoices',
      { runUserShell: shell, max_files: 2 },
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const cmd of calls) {
      expect(cmd).toMatch(/rg [^|]*-e '/);
      expect(cmd).toMatch(/-e '[^']+' -- '/);
      expect(cmd).toMatch(/grep -RIn -e '/);
    }
  });
});

describe('runLogTraceToCode', () => {
  test('uses log signals plus extracted terms', async () => {
    const fake = fakeShell('src/server/handler.ts:88: throw new TimeoutError()');
    const result = await runLogTraceToCode('TimeoutError after 30s on /api/v1/users', {
      runUserShell: fake,
      max_files: 3,
    });
    expect(result.log_signals.length).toBeGreaterThan(0);
    expect(result.likely_files.length).toBeGreaterThan(0);
    expect(result.likely_files[0]!.path).toContain('handler.ts');
  });
});

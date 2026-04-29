import { tool } from 'ai';
import { z } from 'zod';

import type { ToolFactoryOptions } from './types';

export type PolicyAction = 'command' | 'edit' | 'read' | 'network' | 'delete';

export type PolicyVerdict = 'allow' | 'warn' | 'block';

export type PolicySignal = {
  rule: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  matched: string;
  rationale: string;
};

export type PolicyGuardResult = {
  action: PolicyAction;
  verdict: PolicyVerdict;
  risk: 'low' | 'medium' | 'high' | 'critical';
  reasons: PolicySignal[];
  matched_user_rules: string[];
  mitigations: string[];
  summary: string;
};

const COMMAND_RULES: Array<{
  pattern: RegExp;
  rule: string;
  severity: PolicySignal['severity'];
  rationale: string;
}> = [
  {
    pattern: /\brm\s+-rf?\s+(\/|~|\$HOME|(?:\*|\.\/*)(?=\s|$))/,
    rule: 'destructive: rm -rf root/home/wildcard',
    severity: 'critical',
    rationale: 'Recursive force delete on root, home, or top-level wildcard wipes data.',
  },
  {
    pattern: /\b(rm|unlink)\s+-rf?\s+\S*\.git\b/,
    rule: 'destructive: rm of .git directory',
    severity: 'high',
    rationale: 'Removing .git destroys repository history and is unrecoverable.',
  },
  {
    pattern: /\b(?:dd\s+if=|mkfs\.|fdisk\b|parted\b|wipefs\b)/,
    rule: 'destructive: disk-level command',
    severity: 'critical',
    rationale: 'Disk-level commands can corrupt or wipe storage devices.',
  },
  {
    pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    rule: 'fork bomb',
    severity: 'critical',
    rationale: 'Recognized fork-bomb pattern.',
  },
  {
    pattern: /\bgit\s+push\s+(?:--force|--force-with-lease|-f)\s+\S*\s+(main|master|trunk|prod)/i,
    rule: 'force-push to protected branch',
    severity: 'high',
    rationale: 'Force-push to main/master/trunk/prod rewrites shared history.',
  },
  {
    pattern: /\bgit\s+(?:reset\s+--hard|clean\s+-fdx)/,
    rule: 'destructive: hard reset / clean -fdx',
    severity: 'medium',
    rationale: 'Discards uncommitted work without confirmation.',
  },
  {
    pattern: /\bsudo\s+/,
    rule: 'privilege: sudo invoked',
    severity: 'medium',
    rationale: 'Privileged commands escape the user/workspace sandbox.',
  },
  {
    pattern: /\bcurl\s+[^|]*\|\s*(?:bash|sh|zsh|fish)\b/i,
    rule: 'network: pipe-to-shell from network',
    severity: 'high',
    rationale: 'Piping a remote payload directly into a shell executes untrusted code.',
  },
  {
    pattern: /\b(?:wget|curl)\s+\S+\s*-O\s*-\s*\|\s*\w+/i,
    rule: 'network: untrusted download piped to interpreter',
    severity: 'medium',
    rationale: 'Piping a downloaded file into an interpreter is hard to audit.',
  },
  {
    pattern: /\b(npm|pnpm|yarn|bun|pip|uv|cargo|gem|composer|go)\s+install\b/i,
    rule: 'install: package manager invocation',
    severity: 'low',
    rationale: 'Installs new dependencies; ensure manifests are trusted.',
  },
  {
    pattern: /\b(eval|source|exec)\s+\$\(.*\)/,
    rule: 'eval / dynamic exec',
    severity: 'medium',
    rationale: 'Executing dynamically-built strings is hard to audit.',
  },
  {
    pattern: /\bchmod\s+(?:-R\s+)?(?:777|a\+rwx)\b/,
    rule: 'permissions: world-writable',
    severity: 'medium',
    rationale: 'Setting world-writable permissions exposes files to local attackers.',
  },
  {
    pattern: /\bcrontab\s+-r\b/,
    rule: 'destructive: crontab removal',
    severity: 'medium',
    rationale: 'Removes scheduled jobs that may be required for the system.',
  },
  {
    pattern: /\bkill\s+-9\s+1\b/,
    rule: 'destructive: SIGKILL pid 1',
    severity: 'high',
    rationale: 'Killing init halts the host.',
  },
];

const SENSITIVE_FILE_PATTERNS: Array<{
  pattern: RegExp;
  rule: string;
  severity: PolicySignal['severity'];
  rationale: string;
}> = [
  {
    pattern: /(^|\/)\.env(\.|$)/,
    rule: 'secrets: .env file',
    severity: 'high',
    rationale: '.env typically contains application secrets and credentials.',
  },
  {
    pattern: /(^|\/)id_(rsa|dsa|ed25519|ecdsa)(\.pub)?$/,
    rule: 'secrets: SSH private key',
    severity: 'critical',
    rationale: 'SSH private keys must never be edited or transmitted.',
  },
  {
    pattern: /\.(pem|key|crt|p12|pfx)$/i,
    rule: 'secrets: certificate / key material',
    severity: 'high',
    rationale: 'Certificates and key material control trust boundaries.',
  },
  {
    pattern: /(^|\/)credentials(\.json|\.yaml|\.yml)?$/i,
    rule: 'secrets: credentials file',
    severity: 'high',
    rationale: 'Credential files often contain access tokens.',
  },
  {
    pattern: /(^|\/)secrets?(\.|\/)/i,
    rule: 'secrets: directory or file named secret(s)',
    severity: 'high',
    rationale: 'Files named secret(s) commonly hold sensitive material.',
  },
  {
    pattern: /(^|\/)(\.aws|\.gcp|\.azure|\.kube)\//,
    rule: 'cloud: cloud credential dir',
    severity: 'high',
    rationale: 'Cloud credential directories control deployment surface.',
  },
  {
    pattern: /(^|\/)(prod|production)\.[A-Za-z]+$/i,
    rule: 'config: production config file',
    severity: 'medium',
    rationale: 'Production configs deserve extra review before edits.',
  },
  {
    pattern: /(^|\/)terraform\/.*\.tfstate(\.backup)?$/i,
    rule: 'infra: terraform state',
    severity: 'high',
    rationale: 'Terraform state can contain secrets and is the source of truth for infra.',
  },
  {
    pattern: /(^|\/)migrations?\//i,
    rule: 'data: migration directory',
    severity: 'high',
    rationale: 'Migrations are not freely reversible — review every change carefully.',
  },
  {
    pattern: /(^|\/)package-lock\.json$|(^|\/)pnpm-lock\.yaml$|(^|\/)yarn\.lock$|(^|\/)bun\.lockb?$|(^|\/)Cargo\.lock$|(^|\/)poetry\.lock$|(^|\/)uv\.lock$|(^|\/)go\.sum$/,
    rule: 'deps: lockfile edit',
    severity: 'medium',
    rationale: 'Hand-editing lockfiles drifts from manifests; let the package manager regenerate.',
  },
];

const NETWORK_HOST_RULES: Array<{
  pattern: RegExp;
  rule: string;
  severity: PolicySignal['severity'];
  rationale: string;
}> = [
  {
    pattern: /(^|\W)169\.254\.169\.254(\W|$)/,
    rule: 'network: cloud metadata service',
    severity: 'high',
    rationale: 'Reaching the metadata service is a classic SSRF target.',
  },
  {
    pattern: /(^|\W)(127\.0\.0\.1|0\.0\.0\.0|localhost)(:\d+)?(\W|$)/,
    rule: 'network: localhost',
    severity: 'low',
    rationale: 'Localhost calls are usually fine in dev; flag for awareness.',
  },
  {
    pattern: /(\.|^)(internal|local|corp|intra)\.[a-z]+/i,
    rule: 'network: internal-looking host',
    severity: 'medium',
    rationale: 'Internal hosts may not be routable from CI/sandbox.',
  },
];

const SECRET_TEXT_PATTERNS: Array<{
  pattern: RegExp;
  rule: string;
  severity: PolicySignal['severity'];
  rationale: string;
}> = [
  {
    pattern: /AKIA[0-9A-Z]{16}/,
    rule: 'secret-in-content: AWS access key',
    severity: 'critical',
    rationale: 'Looks like an AWS access key id.',
  },
  {
    pattern: /-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----/,
    rule: 'secret-in-content: PEM private key',
    severity: 'critical',
    rationale: 'Private key material in plaintext.',
  },
  {
    pattern: /\bxox[abp]-[A-Za-z0-9-]{10,}/,
    rule: 'secret-in-content: Slack token',
    severity: 'critical',
    rationale: 'Slack token format detected.',
  },
  {
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/,
    rule: 'secret-in-content: GitHub token',
    severity: 'critical',
    rationale: 'GitHub fine-grained or classic token format detected.',
  },
  {
    pattern: /\b(?:api[_-]?key|secret|password)\s*[:=]\s*["'][^"']{8,}["']/i,
    rule: 'secret-in-content: hardcoded credential',
    severity: 'high',
    rationale: 'Looks like a hardcoded credential assignment.',
  },
];

const SEVERITY_RANK: Record<PolicySignal['severity'], number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function compileUserRules(rules: string[]) {
  const out: Array<{ raw: string; pattern: RegExp; verdict: PolicyVerdict }> = [];
  for (const raw of rules) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let verdict: PolicyVerdict = 'block';
    let body = trimmed;
    const verdictMatch = /^(allow|warn|block)\s*:\s*(.+)$/i.exec(trimmed);
    if (verdictMatch) {
      verdict = verdictMatch[1]!.toLowerCase() as PolicyVerdict;
      body = verdictMatch[2]!;
    }
    try {
      const pattern = new RegExp(body, 'i');
      out.push({ raw: trimmed, pattern, verdict });
    } catch {
      out.push({
        raw: trimmed,
        pattern: new RegExp(body.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
        verdict,
      });
    }
  }
  return out;
}

function pickRisk(signals: PolicySignal[]): PolicyGuardResult['risk'] {
  if (signals.length === 0) return 'low';
  let max: PolicySignal['severity'] = 'low';
  for (const signal of signals) {
    if (SEVERITY_RANK[signal.severity] > SEVERITY_RANK[max]) max = signal.severity;
  }
  return max;
}

function pickVerdict(
  risk: PolicyGuardResult['risk'],
  userVerdict: PolicyVerdict | null,
): PolicyVerdict {
  if (userVerdict === 'block') return 'block';
  if (risk === 'critical') return 'block';
  if (risk === 'high') return 'warn';
  if (userVerdict === 'warn') return 'warn';
  return 'allow';
}

function describeVerdict(
  action: PolicyAction,
  verdict: PolicyVerdict,
  risk: PolicyGuardResult['risk'],
  signalCount: number,
) {
  const severityNote =
    signalCount === 0 ? 'no policy signals matched' : `${signalCount} signal(s) matched`;
  switch (verdict) {
    case 'block':
      return `Verdict: block. ${action} blocked at risk=${risk}; ${severityNote}.`;
    case 'warn':
      return `Verdict: warn. ${action} allowed with caution at risk=${risk}; ${severityNote}. Confirm before proceeding.`;
    case 'allow':
      return `Verdict: allow. ${action} allowed at risk=${risk}; ${severityNote}.`;
  }
}

function buildMitigations(action: PolicyAction, signals: PolicySignal[]) {
  const out = new Set<string>();
  if (signals.some(s => /sudo|world-writable|chmod/.test(s.rule))) {
    out.add('Drop privileges and re-run as the workspace user.');
  }
  if (signals.some(s => /destructive|hard reset|crontab/.test(s.rule))) {
    out.add('Run a dry-run first or back up the affected paths.');
  }
  if (signals.some(s => /secrets|credential|key|token/.test(s.rule))) {
    out.add('Move secrets out of the repository and reference them via environment variables.');
  }
  if (signals.some(s => /network|metadata|pipe-to-shell|download/i.test(s.rule))) {
    out.add('Pin the URL, verify the hash, or use a trusted package manager instead of curl-pipe.');
  }
  if (signals.some(s => /lockfile/.test(s.rule))) {
    out.add('Update the manifest and let the package manager regenerate the lockfile.');
  }
  if (signals.some(s => /migration/.test(s.rule))) {
    out.add('Pair migrations with code that tolerates both shapes; ship a down-migration too.');
  }
  if (signals.some(s => /force-push|main|master|trunk|prod/.test(s.rule))) {
    out.add('Push to a feature branch; open a PR rather than force-pushing to a protected branch.');
  }
  if (signals.some(s => /production|prod\b/i.test(s.rule))) {
    out.add('Verify on staging before applying to production.');
  }
  if (action === 'delete') {
    out.add('Confirm there are no remaining imports or references before deleting.');
  }
  if (out.size === 0 && signals.length > 0) {
    out.add('Pause and re-confirm with the user before executing.');
  }
  return Array.from(out);
}

function evaluateCommand(target: string): PolicySignal[] {
  const out: PolicySignal[] = [];
  for (const rule of COMMAND_RULES) {
    if (rule.pattern.test(target)) {
      out.push({
        rule: rule.rule,
        severity: rule.severity,
        matched: target,
        rationale: rule.rationale,
      });
    }
  }
  return out;
}

function evaluatePath(target: string): PolicySignal[] {
  const out: PolicySignal[] = [];
  for (const rule of SENSITIVE_FILE_PATTERNS) {
    if (rule.pattern.test(target)) {
      out.push({
        rule: rule.rule,
        severity: rule.severity,
        matched: target,
        rationale: rule.rationale,
      });
    }
  }
  return out;
}

function evaluateNetwork(target: string): PolicySignal[] {
  const out: PolicySignal[] = [];
  for (const rule of NETWORK_HOST_RULES) {
    if (rule.pattern.test(target)) {
      out.push({
        rule: rule.rule,
        severity: rule.severity,
        matched: target,
        rationale: rule.rationale,
      });
    }
  }
  return out;
}

function evaluateContent(content: string): PolicySignal[] {
  if (!content) return [];
  const out: PolicySignal[] = [];
  for (const rule of SECRET_TEXT_PATTERNS) {
    const match = rule.pattern.exec(content);
    if (match) {
      out.push({
        rule: rule.rule,
        severity: rule.severity,
        matched: match[0]!.slice(0, 80),
        rationale: rule.rationale,
      });
    }
  }
  return out;
}

export function evaluatePolicy(input: {
  action: PolicyAction;
  target: string;
  content?: string;
  user_rules?: string[];
}): PolicyGuardResult {
  const action = input.action;
  const target = input.target;
  const content = input.content ?? '';
  const userRules = compileUserRules(input.user_rules ?? []);

  const signals: PolicySignal[] = [];
  if (action === 'command') signals.push(...evaluateCommand(target));
  if (action === 'edit' || action === 'read' || action === 'delete') {
    signals.push(...evaluatePath(target));
    signals.push(...evaluateContent(content));
  }
  if (action === 'network') signals.push(...evaluateNetwork(target));

  const matchedUserRules: string[] = [];
  let userVerdict: PolicyVerdict | null = null;
  for (const rule of userRules) {
    const subject = `${target}\n${content}`;
    if (rule.pattern.test(subject)) {
      matchedUserRules.push(rule.raw);
      const order: Record<PolicyVerdict, number> = { allow: 1, warn: 2, block: 3 };
      if (userVerdict === null || order[rule.verdict] > order[userVerdict]) {
        userVerdict = rule.verdict;
      }
      if (rule.verdict === 'block') {
        signals.push({
          rule: 'user-rule: block',
          severity: 'high',
          matched: rule.raw,
          rationale: 'Blocked by user-supplied workspace policy.',
        });
      } else if (rule.verdict === 'warn') {
        signals.push({
          rule: 'user-rule: warn',
          severity: 'medium',
          matched: rule.raw,
          rationale: 'Marked sensitive by user-supplied workspace policy.',
        });
      }
    }
  }

  const risk = pickRisk(signals);
  const verdict = pickVerdict(risk, userVerdict);
  const mitigations = buildMitigations(action, signals);

  return {
    action,
    verdict,
    risk,
    reasons: signals,
    matched_user_rules: matchedUserRules,
    mitigations,
    summary: describeVerdict(action, verdict, risk, signals.length),
  };
}

export function createPolicyGuardTool(_: ToolFactoryOptions) {
  return tool({
    description:
      'Classify a proposed action (command/edit/read/network/delete) against built-in safety policies and optional user rules. Returns risk level, verdict, and mitigations.',
    inputSchema: z.object({
      action: z.enum(['command', 'edit', 'read', 'network', 'delete']),
      target: z.string().min(1),
      content: z.string().nullable().optional(),
      user_rules: z.array(z.string()).max(50).nullable().optional(),
    }),
    execute: async ({ action, target, content, user_rules }) =>
      evaluatePolicy({
        action,
        target,
        content: content ?? undefined,
        user_rules: user_rules ?? undefined,
      }),
  });
}

import { describe, expect, test } from 'bun:test';

import { planChange } from '../plan-change';

describe('planChange', () => {
  test('infers fix intent and high risk when migrations are touched', () => {
    const plan = planChange({
      goal: 'Fix bug in checkout that causes wrong totals',
      target_files: ['src/checkout/total.ts', 'migrations/2025_01_total.sql'],
    });
    expect(plan.intent).toBe('fix');
    expect(plan.risk).toBe('high');
    expect(plan.risk_drivers.some(driver => /migration/.test(driver))).toBe(true);
    expect(plan.test_files).toContain('src/checkout/total.test.ts');
    expect(plan.steps.length).toBeGreaterThanOrEqual(5);
  });

  test('infers feature intent and suggests flag-based rollback', () => {
    const plan = planChange({
      goal: 'Add export to CSV button on the invoices page',
      target_files: ['src/invoices/Invoices.tsx'],
    });
    expect(plan.intent).toBe('feature');
    expect(plan.rollback_strategy.toLowerCase()).toContain('flag');
    expect(plan.test_files).toContain('src/invoices/Invoices.test.tsx');
  });

  test('classifies wide-scope refactors and includes characterization-test step', () => {
    const plan = planChange({
      goal: 'Refactor the payments module to extract the gateway interface',
      target_files: [
        'src/payments/a.ts',
        'src/payments/b.ts',
        'src/payments/c.ts',
        'src/payments/d.ts',
        'src/payments/e.ts',
      ],
    });
    expect(plan.intent).toBe('refactor');
    expect(plan.scope === 'medium' || plan.scope === 'wide').toBe(true);
    expect(plan.steps.some(step => /characteriz/i.test(step.action))).toBe(true);
  });

  test('rejects empty goals', () => {
    expect(() => planChange({ goal: '   ' })).toThrow();
  });

  test('flags rename + delete in open questions', () => {
    const plan = planChange({
      goal: 'cleanup unused module',
      target_files: ['src/old/legacy.ts'],
      hint_files: ['src/old/index.ts'],
    });
    plan.files[0]!.edit_kind = 'delete';
    const recomputed = planChange({
      goal: 'cleanup unused module',
      target_files: ['src/old/legacy.ts'],
    });
    expect(recomputed.intent).toBe('cleanup');
  });

  test('respects scope_hint override', () => {
    const plan = planChange({
      goal: 'Add a new logger',
      target_files: ['src/logger.ts'],
      scope_hint: 'wide',
    });
    expect(plan.scope).toBe('wide');
  });
});

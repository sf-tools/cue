const REVIEW_MY_CODEBASE_PATTERN = /^\s*review my codebase(?:[.!?]+)?\s*$/i;

export function isCodebaseReviewShortcut(text: string) {
  return REVIEW_MY_CODEBASE_PATTERN.test(text);
}

export function buildCodebaseReviewPrompt(focus?: string) {
  const normalizedFocus = focus?.trim();

  return [
    'Review my codebase.',
    'Stay read-only: inspect the repository, but do not edit files or run mutating commands.',
    normalizedFocus
      ? `Focus especially on: ${normalizedFocus}.`
      : 'Review it broadly and prioritize the highest-leverage issues first.',
    'Report the most important correctness risks, maintainability or architecture issues, missing tests or verification gaps, and the best next improvements.'
  ].join('\n');
}

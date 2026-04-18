import dedent from 'dedent';

import type { Formatters } from '@/xml/formatters/types';

export const isString = (v: unknown): boolean => typeof v === 'string';

export const formatString = (
  value: unknown,
  _llml: (data: unknown, formatters: Formatters) => string,
  _formatters: Formatters,
): string => dedent((value as string).trim());

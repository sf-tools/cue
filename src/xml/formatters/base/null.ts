import type { Formatters } from '@/xml/formatters/types';

export const isNull = (v: unknown): boolean => v === null;

export const formatNull = (
  _value: unknown,
  _llml: (data: unknown, formatters: Formatters) => string,
  _formatters: Formatters,
): string => 'null';

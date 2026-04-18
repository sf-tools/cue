import { vibeXML } from '@/xml/formatters';
import type { Formatters } from '@/xml/types';

export const xml = (data: unknown, formatters?: Formatters): string => {
  if (data === undefined) return '';
  const activeFormatters = formatters || vibeXML();

  for (const [predicate, formatFunction] of activeFormatters) {
    if (predicate(data)) return formatFunction(data, xml, activeFormatters);
  }

  return String(data);
};

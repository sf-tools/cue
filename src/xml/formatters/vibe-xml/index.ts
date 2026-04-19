import { formatAny, isAny } from '@/xml/formatters/base/any';
import { formatBoolean, isBoolean } from '@/xml/formatters/base/boolean';
import { formatDate, isDate } from '@/xml/formatters/base/date';
import { formatNull, isNull } from '@/xml/formatters/base/null';
import { formatNumber, isNumber } from '@/xml/formatters/base/number';
import { formatString, isString } from '@/xml/formatters/base/string';
import { formatUndefined, isUndefined } from '@/xml/formatters/base/undefined';
import { formatArray, isArray } from '@/xml/formatters/vibe-xml/array';
import { formatObject, isObject } from '@/xml/formatters/vibe-xml/object';
import type { Formatter, Formatters, Predicate } from '@/xml/formatters/types';

const defaultVibeXML: Formatters = new Map([
  [isString, formatString],
  [isNumber, formatNumber],
  [isBoolean, formatBoolean],
  [isUndefined, formatUndefined],
  [isNull, formatNull],
  [isDate, formatDate],
  [isArray, formatArray],
  [isObject, formatObject],
  [isAny, formatAny],
]);

interface VibeXMLOptions {
  formatters?: Formatters;
}

export const vibeXML = (options?: VibeXMLOptions): Formatters => {
  if (!options) return defaultVibeXML;

  if (options.formatters) {
    const mergedFormatters = new Map<Predicate, Formatter>();

    for (const [predicate, formatter] of options.formatters)
      mergedFormatters.set(predicate, formatter);
    for (const [predicate, formatter] of defaultVibeXML) mergedFormatters.set(predicate, formatter);

    return mergedFormatters;
  }

  return defaultVibeXML;
};

export { isArray, isBoolean, isDate, isNull, isNumber, isObject, isString, isUndefined };

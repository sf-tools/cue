import { isAny } from '@/xml/formatters/base/any';
import type { Formatters } from '@/xml/formatters/types';

export const json = (
  replacer?: (number | string)[] | ((this: any, key: string, value: any) => any) | null,
  space?: string | number,
): Formatters => [[isAny, (value: unknown) => JSON.stringify(value, replacer as any, space)]];

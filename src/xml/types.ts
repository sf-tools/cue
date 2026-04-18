import type { Formatters } from '@/xml/formatters/types';

export interface Renderer {
  render(data: unknown): string;
}

export interface VibeXMLOptions {
  indent?: string;
  prefix?: string;
  formatters?: Formatters;
}

export interface LLMLOptions {
  renderer?: Renderer;
}

export type { Formatter, Formatters, Predicate } from '@/xml/formatters/types';

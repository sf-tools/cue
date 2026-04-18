export type Predicate = (value: unknown) => boolean;

export type Formatter = (
  value: unknown,
  llml: (data: unknown, formatters: Formatters) => string,
  formatters: Formatters,
) => string;

export type Formatters = Iterable<[Predicate, Formatter]>;

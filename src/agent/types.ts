export enum EntryKind {
  User = 'user',
  Assistant = 'assistant',
  Tool = 'tool',
  Shell = 'shell',
  Error = 'error',
  Meta = 'meta'
}

export type LogUpdate = ((...text: string[]) => void) & {
  clear(): void;
  done(): void;
  persist(...text: string[]): void;
};

export type ShellResult = {
  exitCode: number;
  output: string;
};

export type Rgb = {
  r: number;
  g: number;
  b: number;
};

export type Keypress = {
  ctrl?: boolean;
  meta?: boolean;
  name?: string;
};

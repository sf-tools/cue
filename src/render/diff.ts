import type { Frame, FrameDiff } from './types';

export function diffFrames(previous: Frame | null, next: Frame): FrameDiff {
  if (!previous) {
    const changedRows = next.lines.map((_, index) => index);
    return {
      changed: next.lines.length > 0,
      changedRows,
      changedRanges: changedRows.length ? [{ start: 0, end: changedRows.length - 1 }] : [],
      previousLineCount: 0,
      nextLineCount: next.lines.length
    };
  }

  const maxLines = Math.max(previous.lines.length, next.lines.length);
  const changedRows: number[] = [];

  for (let index = 0; index < maxLines; index += 1) {
    if ((previous.lines[index] ?? '') !== (next.lines[index] ?? '')) changedRows.push(index);
  }

  const changedRanges = changedRows.reduce<Array<{ start: number; end: number }>>((ranges, row) => {
    const last = ranges.at(-1);
    if (last && row === last.end + 1) {
      last.end = row;
      return ranges;
    }

    ranges.push({ start: row, end: row });
    return ranges;
  }, []);

  return {
    changed: changedRows.length > 0,
    changedRows,
    changedRanges,
    previousLineCount: previous.lines.length,
    nextLineCount: next.lines.length
  };
}

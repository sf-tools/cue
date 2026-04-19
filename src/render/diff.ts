import type { Frame, FrameDiff } from './types';

export function diffFrames(previous: Frame | null, next: Frame): FrameDiff {
  if (!previous) {
    return {
      changed: next.lines.length > 0,
      changedRanges: next.lines.length > 0 ? [{ start: 0, end: next.lines.length - 1 }] : [],
      previousLineCount: 0,
      nextLineCount: next.lines.length
    };
  }

  const maxLines = Math.max(previous.lines.length, next.lines.length);
  const changedRanges: Array<{ start: number; end: number }> = [];
  let rangeStart = -1;

  for (let index = 0; index < maxLines; index += 1) {
    const changed = (previous.lines[index] ?? '') !== (next.lines[index] ?? '');

    if (changed) {
      if (rangeStart === -1) rangeStart = index;
      continue;
    }

    if (rangeStart !== -1) {
      changedRanges.push({ start: rangeStart, end: index - 1 });
      rangeStart = -1;
    }
  }

  if (rangeStart !== -1) changedRanges.push({ start: rangeStart, end: maxLines - 1 });

  return {
    changed: changedRanges.length > 0,
    changedRanges,
    previousLineCount: previous.lines.length,
    nextLineCount: next.lines.length
  };
}

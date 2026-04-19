import chalk from 'chalk';

import { APP_NAME, APP_VERSION } from '@/config';
import { LEFT_MARGIN } from '../layout';
import { blankLine, line, span } from '../primitives';

import type { Block, RenderContext } from '../types';

export function renderHeader(ctx: RenderContext): Block {
  return [
    blankLine(),
    line(span(LEFT_MARGIN), span(APP_NAME, ctx.theme.foreground)),
    line(span(LEFT_MARGIN), span(APP_VERSION, ctx.theme.dimmed)),
    line(span(LEFT_MARGIN), span('hint: /auto-run to skip all approvals', ctx.theme.subtle)),
    blankLine()
  ];
}

import chalk from 'chalk';
import MarkdownIt from 'markdown-it';

import { repeat, widthOf } from '@/text';
import { indent, prefixWidth } from './layout';
import { blankLine, line, span } from './primitives';
import type { Block, RenderContext, Segment, Style, StyledLine } from './types';

const md = new MarkdownIt({
  linkify: true
});

type MarkdownToken = ReturnType<MarkdownIt['parse']>[number];
type InlinePiece = { type: 'segment'; segment: Segment } | { type: 'break' };

type RenderEnv = {
  ctx: RenderContext;
  width: number;
};

function composeStyles(...styles: Array<Style | undefined>): Style | undefined {
  const active = styles.filter(Boolean) as Style[];
  if (active.length === 0) return undefined;
  return value => active.reduce((out, style) => style(out), value);
}

function appendSegment(pieces: InlinePiece[], text: string, style?: Style) {
  if (!text) return;

  const last = pieces[pieces.length - 1];
  if (last?.type === 'segment' && last.segment.style === style) {
    last.segment.text += text;
    return;
  }

  pieces.push({ type: 'segment', segment: span(text, style) });
}

function appendBreak(pieces: InlinePiece[]) {
  const last = pieces[pieces.length - 1];
  if (last?.type === 'break') return;
  pieces.push({ type: 'break' });
}

function getAttr(token: MarkdownToken, name: string) {
  return typeof token.attrGet === 'function' ? token.attrGet(name) : null;
}

function plainText(pieces: InlinePiece[]) {
  return pieces.map(piece => (piece.type === 'break' ? '\n' : piece.segment.text)).join('');
}

function wrapInlinePieces(pieces: InlinePiece[], width: number): StyledLine[] {
  const safeWidth = Math.max(1, width);
  const lines: StyledLine[] = [];
  let segments: Segment[] = [];
  let currentWidth = 0;

  const pushText = (text: string, style?: Style) => {
    if (!text) return;
    const last = segments[segments.length - 1];
    if (last && last.style === style) {
      last.text += text;
      return;
    }
    segments.push(span(text, style));
  };

  const flushLine = (allowEmpty = false) => {
    if (segments.length === 0 && !allowEmpty) return;
    lines.push(line(...segments));
    segments = [];
    currentWidth = 0;
  };

  for (const piece of pieces) {
    if (piece.type === 'break') {
      flushLine(true);
      continue;
    }

    for (const ch of Array.from(piece.segment.text)) {
      const chWidth = Math.max(1, widthOf(ch));
      if (segments.length > 0 && currentWidth + chWidth > safeWidth) flushLine();
      pushText(ch, piece.segment.style);
      currentWidth += chWidth;
    }
  }

  flushLine(true);
  return lines;
}

function collectInlineRange(
  tokens: MarkdownToken[],
  env: RenderEnv,
  start = 0,
  endType?: string,
  inheritedStyle?: Style
): { pieces: InlinePiece[]; next: number } {
  const pieces: InlinePiece[] = [];
  let index = start;

  while (index < tokens.length) {
    const token = tokens[index];
    if (endType && token.type === endType) return { pieces, next: index + 1 };

    switch (token.type) {
      case 'text':
        appendSegment(pieces, token.content, inheritedStyle);
        index += 1;
        break;

      case 'code_inline':
        appendSegment(
          pieces,
          token.content,
          composeStyles(inheritedStyle, value => chalk.bgHex(env.ctx.theme.composerBg())(chalk.yellow(value)))
        );
        index += 1;
        break;

      case 'softbreak':
      case 'hardbreak':
        appendBreak(pieces);
        index += 1;
        break;

      case 'strong_open': {
        const inner = collectInlineRange(
          tokens,
          env,
          index + 1,
          'strong_close',
          composeStyles(inheritedStyle, value => chalk.bold(value))
        );
        pieces.push(...inner.pieces);
        index = inner.next;
        break;
      }

      case 'em_open': {
        const inner = collectInlineRange(
          tokens,
          env,
          index + 1,
          'em_close',
          composeStyles(inheritedStyle, value => chalk.italic(value))
        );
        pieces.push(...inner.pieces);
        index = inner.next;
        break;
      }

      case 's_open': {
        const inner = collectInlineRange(
          tokens,
          env,
          index + 1,
          's_close',
          composeStyles(inheritedStyle, value => chalk.strikethrough(value))
        );
        pieces.push(...inner.pieces);
        index = inner.next;
        break;
      }

      case 'link_open': {
        const href = getAttr(token, 'href');
        const inner = collectInlineRange(
          tokens,
          env,
          index + 1,
          'link_close',
          composeStyles(inheritedStyle, value => chalk.cyan.underline(value))
        );
        pieces.push(...inner.pieces);

        const label = plainText(inner.pieces).trim();
        const normalizedHref = href?.trim();
        if (normalizedHref && normalizedHref !== label) appendSegment(pieces, ` <${normalizedHref}>`, env.ctx.theme.dimmed);

        index = inner.next;
        break;
      }

      case 'image': {
        const alt = token.content || getAttr(token, 'alt') || 'image';
        const src = getAttr(token, 'src');
        appendSegment(
          pieces,
          `[image: ${alt}]`,
          composeStyles(inheritedStyle, value => chalk.magenta(value))
        );
        if (src) appendSegment(pieces, ` <${src}>`, env.ctx.theme.dimmed);
        index += 1;
        break;
      }

      case 'html_inline':
        appendSegment(pieces, token.content, composeStyles(inheritedStyle, env.ctx.theme.dimmed));
        index += 1;
        break;

      default:
        appendSegment(pieces, token.content, inheritedStyle);
        index += 1;
        break;
    }
  }

  return { pieces, next: index };
}

function renderInline(children: MarkdownToken[] | null | undefined, env: RenderEnv, baseStyle?: Style) {
  return wrapInlinePieces(collectInlineRange(children ?? [], env, 0, undefined, baseStyle).pieces, env.width);
}

function renderParagraph(children: MarkdownToken[] | null | undefined, env: RenderEnv): Block {
  return renderInline(children, env);
}

function renderHeading(token: MarkdownToken, children: MarkdownToken[] | null | undefined, env: RenderEnv): Block {
  const level = Number.parseInt(token.tag.slice(1), 10) || 1;
  const prefix = `${'#'.repeat(Math.max(1, Math.min(level, 6)))} `;
  const headingStyle: Style = value => {
    if (level === 1) return chalk.bold.cyanBright(value);
    if (level === 2) return chalk.bold.blueBright(value);
    return chalk.bold(value);
  };

  const lines = renderInline(children, env, headingStyle);
  if (lines.length === 0) return [line(span(prefix, env.ctx.theme.subtle))];

  const [first, ...rest] = lines;
  return [line(span(prefix, env.ctx.theme.subtle), ...first.segments), ...rest];
}

function renderCodeBlock(token: MarkdownToken, env: RenderEnv): Block {
  const language = token.info.trim().split(/\s+/)[0] || null;
  const codeStyle: Style = value => chalk.yellow(value);
  const content = token.content.replace(/\n$/, '');
  const lines = (content ? content.split('\n') : ['']).flatMap(codeLine =>
    wrapInlinePieces([{ type: 'segment', segment: span(codeLine, codeStyle) }], Math.max(1, env.width - 2))
  );
  const body = indent(lines, [span('│ ', env.ctx.theme.subtle)]);

  if (!language) return body;
  return [line(span(`code · ${language}`, env.ctx.theme.subtle)), ...body];
}

function appendBlock(out: Block, block: Block, withSpacing = true) {
  if (block.length === 0) return;
  if (withSpacing && out.length > 0) out.push(blankLine());
  out.push(...block);
}

function renderRange(tokens: MarkdownToken[], env: RenderEnv, start = 0, endType?: string): { block: Block; next: number } {
  const out: Block = [];
  let index = start;

  while (index < tokens.length) {
    const token = tokens[index];
    if (endType && token.type === endType) return { block: out, next: index + 1 };

    switch (token.type) {
      case 'paragraph_open':
        appendBlock(out, renderParagraph(tokens[index + 1]?.children, env));
        index += 3;
        break;

      case 'heading_open':
        appendBlock(out, renderHeading(token, tokens[index + 1]?.children, env));
        index += 3;
        break;

      case 'bullet_list_open': {
        const rendered = renderList(tokens, env, index, false);
        appendBlock(out, rendered.block);
        index = rendered.next;
        break;
      }

      case 'ordered_list_open': {
        const rendered = renderList(tokens, env, index, true);
        appendBlock(out, rendered.block);
        index = rendered.next;
        break;
      }

      case 'blockquote_open': {
        const inner = renderRange(tokens, { ...env, width: Math.max(1, env.width - 2) }, index + 1, 'blockquote_close');
        appendBlock(out, indent(inner.block, [span('▎ ', env.ctx.theme.subtle)]));
        index = inner.next;
        break;
      }

      case 'fence':
      case 'code_block':
        appendBlock(out, renderCodeBlock(token, env));
        index += 1;
        break;

      case 'hr':
        appendBlock(out, [line(span(repeat('─', Math.max(1, env.width)), env.ctx.theme.subtle))]);
        index += 1;
        break;

      case 'inline':
        appendBlock(out, renderInline(token.children, env));
        index += 1;
        break;

      case 'html_block':
        appendBlock(out, wrapInlinePieces([{ type: 'segment', segment: span(token.content.trimEnd(), env.ctx.theme.dimmed) }], env.width));
        index += 1;
        break;

      default:
        index += 1;
        break;
    }
  }

  return { block: out, next: index };
}

function renderList(tokens: MarkdownToken[], env: RenderEnv, start: number, ordered: boolean): { block: Block; next: number } {
  const listToken = tokens[start];
  const closeType = ordered ? 'ordered_list_close' : 'bullet_list_close';
  const out: Block = [];
  let index = start + 1;
  let order = Number.parseInt(getAttr(listToken, 'start') ?? '1', 10);

  while (index < tokens.length) {
    const token = tokens[index];
    if (token.type === closeType) return { block: out, next: index + 1 };
    if (token.type !== 'list_item_open') {
      index += 1;
      continue;
    }

    const bullet = ordered ? `${order}. ` : '• ';
    const continuation = repeat(' ', prefixWidth(bullet));
    const innerEnv = { ...env, width: Math.max(1, env.width - prefixWidth(bullet)) };
    const item = renderRange(tokens, innerEnv, index + 1, 'list_item_close');

    if (out.length > 0) out.push(blankLine());
    out.push(...indent(item.block, [span(bullet)], [span(continuation)]));

    index = item.next;
    order += 1;
  }

  return { block: out, next: index };
}

export function renderMarkdown(text: string, ctx: RenderContext, width = Math.max(1, ctx.width - 2)): Block {
  const tokens = md.parse(text, {});
  return renderRange(tokens, { ctx, width }).block;
}

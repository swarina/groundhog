import { formatCount } from './format.js';
import { sha256, shortHash } from './hash.js';

/**
 * Rendering the span where two prefixes differ.
 *
 * Three things a naive diff gets wrong and this one does not. A divergent span
 * can be far larger than anything worth printing, so it is capped and the size
 * is reported instead. Content is not always text, so unprintable bytes go
 * through a digest rather than into the terminal. And the difference is very
 * often whitespace, which is invisible in a plain diff and is therefore made
 * visible here.
 */

export interface DiffWindow {
  /** Context before the divergence, shared by both sides. */
  before: string;
  left: string;
  right: string;
  /** Context after, taken from the left side. */
  after: string;
  /** Set when the divergent span was too large to render in full. */
  truncatedBytes?: number;
  /** Set when the content is not safely printable. */
  binary?: { leftDigest: string; rightDigest: string; leftBytes: number; rightBytes: number };
}

const BEFORE = 160;
const AFTER = 240;
const MAX_SPAN = 2048;

/** Portion of unprintable characters above which text is treated as binary. */
const BINARY_RATIO = 0.1;

function isPrintable(text: string): boolean {
  if (text.length === 0) return true;
  let unprintable = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    if (code < 0x20 || code === 0x7f) unprintable += 1;
  }
  return unprintable / text.length < BINARY_RATIO;
}

/**
 * Makes whitespace visible.
 *
 * A trailing space and a carriage return are among the most common reasons a
 * prefix stops matching, and both are invisible in a plain diff. This runs only
 * inside the window, never over surrounding context, so ordinary text stays
 * readable.
 */
export function revealWhitespace(text: string): string {
  return text.replace(/\r/g, '\\r').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/ /g, '\u00b7');
}

/** Longest run of identical trailing characters, used to trim a shared suffix. */
function commonSuffix(a: string, b: string, limit: number): number {
  let i = 0;
  while (i < limit && i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1;
  return i;
}

export interface DiffInput {
  /** Full content of the diverging part on each side. */
  left: string;
  right: string;
  /** Offset into both, where they stop matching. */
  offset: number;
}

export function buildDiffWindow(input: DiffInput): DiffWindow {
  const { left, right, offset } = input;

  const leftTail = left.slice(offset);
  const rightTail = right.slice(offset);

  // Trim the part of the tails that matches again, so the window shows the
  // change rather than everything that follows it.
  const shared = commonSuffix(leftTail, rightTail, Math.min(leftTail.length, rightTail.length));
  let leftSpan = leftTail.slice(0, leftTail.length - shared);
  let rightSpan = rightTail.slice(0, rightTail.length - shared);

  const before = left.slice(Math.max(0, offset - BEFORE), offset);
  const after = leftTail.slice(leftTail.length - shared, leftTail.length - shared + AFTER);

  if (!isPrintable(leftSpan) || !isPrintable(rightSpan)) {
    return {
      before: '',
      left: '',
      right: '',
      after: '',
      binary: {
        leftDigest: digest(leftSpan),
        rightDigest: digest(rightSpan),
        leftBytes: Buffer.byteLength(leftSpan, 'utf8'),
        rightBytes: Buffer.byteLength(rightSpan, 'utf8'),
      },
    };
  }

  const spanBytes = Math.max(Buffer.byteLength(leftSpan, 'utf8'), Buffer.byteLength(rightSpan, 'utf8'));
  let truncatedBytes: number | undefined;
  if (spanBytes > MAX_SPAN) {
    truncatedBytes = spanBytes;
    leftSpan = leftSpan.slice(0, 120);
    rightSpan = rightSpan.slice(0, 120);
  }

  return {
    before,
    left: revealWhitespace(leftSpan),
    right: revealWhitespace(rightSpan),
    after,
    ...(truncatedBytes != null ? { truncatedBytes } : {}),
  };
}

function digest(text: string): string {
  return shortHash(sha256(text));
}

/** Renders a window as indented lines, ready for the report. */
export function renderDiffWindow(window: DiffWindow): string[] {
  if (window.binary) {
    return [
      `content is not printable, so it is shown by digest`,
      `- ${window.binary.leftDigest}, ${formatCount(window.binary.leftBytes)} bytes`,
      `+ ${window.binary.rightDigest}, ${formatCount(window.binary.rightBytes)} bytes`,
    ];
  }

  const lines: string[] = [];
  if (window.truncatedBytes != null) {
    lines.push(`divergent span is ${formatCount(window.truncatedBytes)} bytes, showing the first 120 characters of each side`);
  }
  if (window.before) lines.push(`  ...${collapse(window.before)}`);
  lines.push(`- ${window.left}`);
  lines.push(`+ ${window.right}`);
  if (window.after) lines.push(`  ${collapse(window.after)}...`);
  return lines;
}

/** Context is shown on one line, so newlines inside it are made explicit. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

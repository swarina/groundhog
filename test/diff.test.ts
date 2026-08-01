import { describe, expect, it } from 'vitest';
import { buildDiffWindow, renderDiffWindow, revealWhitespace } from '../src/core/diff.js';

describe('diff window', () => {
  it('shows only the span that changed, not everything after it', () => {
    const window = buildDiffWindow({
      left: 'the time is 09:14:22 and the rest is identical',
      right: 'the time is 09:14:55 and the rest is identical',
      offset: 18,
    });
    expect(window.left).toBe('22');
    expect(window.right).toBe('55');
    expect(window.after).toContain('and the rest is identical');
  });

  it('keeps context before the divergence so the span can be placed', () => {
    const window = buildDiffWindow({ left: 'a stable preamble then A', right: 'a stable preamble then B', offset: 23 });
    expect(window.before).toContain('stable preamble');
  });

  it('makes a trailing space visible', () => {
    // A plain diff renders these two lines identically, which is why this is
    // one of the failures people spend a day on.
    const window = buildDiffWindow({ left: 'instructions end here ', right: 'instructions end here', offset: 21 });
    expect(window.left).toBe('·');
    expect(window.right).toBe('');
  });

  it('makes a carriage return visible', () => {
    const window = buildDiffWindow({ left: 'line one\r\nline two', right: 'line one\nline two', offset: 8 });
    expect(window.left).toContain('\\r');
  });

  it('caps a large span and says how large it was', () => {
    const window = buildDiffWindow({ left: 'x'.repeat(9000), right: 'y'.repeat(9000), offset: 0 });
    expect(window.truncatedBytes).toBe(9000);
    expect(window.left.length).toBe(120);
    expect(renderDiffWindow(window)[0]).toContain('9,000 bytes');
  });

  it('never writes unprintable bytes to a terminal', () => {
    const controls = '\u0001\u0002\u0003\u0004\u0005\u0006\u0007\u0010';
    const window = buildDiffWindow({ left: controls, right: '\u0011\u0012\u0013\u0014', offset: 0 });

    expect(window.binary).toBeDefined();
    expect(window.left).toBe('');

    const rendered = renderDiffWindow(window).join('\n');
    expect(rendered).toContain('not printable');
    expect(rendered).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
  });

  it('treats ordinary text with newlines and tabs as printable', () => {
    // Negative case for the binary detector. Whitespace control characters are
    // normal prompt content and must not send text down the digest path.
    const window = buildDiffWindow({ left: 'a\n\tb\tc\n', right: 'a\n\tb\tX\n', offset: 5 });
    expect(window.binary).toBeUndefined();
  });

  it('renders a minus for the left side and a plus for the right', () => {
    const rendered = renderDiffWindow(buildDiffWindow({ left: 'value A', right: 'value B', offset: 6 }));
    expect(rendered.some((line) => line.startsWith('- '))).toBe(true);
    expect(rendered.some((line) => line.startsWith('+ '))).toBe(true);
  });
});

describe('whitespace reveal', () => {
  it('leaves ordinary characters alone', () => {
    expect(revealWhitespace('plain text')).toBe('plain·text');
  });

  it('marks every whitespace kind distinctly', () => {
    expect(revealWhitespace('\r\n\t ')).toBe('\\r\\n\\t·');
  });
});

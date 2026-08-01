import { describe, expect, it } from 'vitest';
import { checkPrefixChainOf, expectPrefixChain, BrokenChainError } from '../src/assert/chain.js';
import { renderChainReport } from '../src/report/chain.js';

/**
 * These build the turns of a conversation as anthropic request bodies and check
 * that each turn extends the one before it. The system prompt is long so the
 * turns share a real prefix, the way an agent loop does.
 */

const sys = 'You are a coding agent with tools. Follow the instructions exactly. '.repeat(30);

function turn(messages: unknown[]) {
  return { model: 'claude-sonnet-4-5', system: [{ type: 'text', text: sys, cache_control: { type: 'ephemeral' } }], messages };
}

const opts = { model: 'claude-sonnet-4-5', discover: false } as const;

const u1 = { role: 'user', content: 'list the files in the project root' };
const a1 = { role: 'assistant', content: 'The project has src, test, and package.json.' };
const u2 = { role: 'user', content: 'read the package.json' };
const a2 = { role: 'assistant', content: 'It declares the groundhog package.' };

describe('a well behaved conversation', () => {
  it('reuses the prefix when each turn only appends', () => {
    const report = checkPrefixChainOf([turn([u1]), turn([u1, a1, u2]), turn([u1, a1, u2, a2])], opts);
    expect(report.ok).toBe(true);
    expect(report.steps.every((step) => step.holds)).toBe(true);
  });

  it('returns quietly from the assertion', () => {
    expect(() => expectPrefixChain([turn([u1]), turn([u1, a1, u2])], opts)).not.toThrow();
  });
});

describe('a conversation that re-renders an earlier turn', () => {
  const a1Replayed = { role: 'assistant', content: 'The project has src, test, and package.json. ' }; // trailing space

  it('breaks at the turn where the earlier message changed', () => {
    const report = checkPrefixChainOf([turn([u1, a1]), turn([u1, a1Replayed, u2])], opts);
    expect(report.ok).toBe(false);
    const finding = report.findings[0];
    expect(finding?.code).toBe('GH130');
    expect(finding?.title).toContain('turn 1');
  });

  it('reports only the first break, not its consequences', () => {
    const report = checkPrefixChainOf(
      [turn([u1, a1]), turn([u1, a1Replayed, u2]), turn([u1, a1Replayed, u2, a2])],
      opts,
    );
    // The second step holds because both later turns agree on the replayed
    // message, so exactly one finding is reported for the one real break.
    expect(report.findings).toHaveLength(1);
    expect(report.steps[0]?.holds).toBe(false);
    expect(report.steps[1]?.holds).toBe(true);
  });

  it('shows the re-rendered content in the diff', () => {
    const report = checkPrefixChainOf([turn([u1, a1]), turn([u1, a1Replayed, u2])], opts);
    expect(report.findings[0]?.diff).toBeDefined();
  });

  it('throws a rendered report from the assertion', () => {
    try {
      expectPrefixChain([turn([u1, a1]), turn([u1, a1Replayed, u2])], opts);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(BrokenChainError);
      expect((error as Error).message).toContain('stops reusing its prefix');
    }
  });
});

describe('other ways a chain breaks', () => {
  it('flags a history that was summarised in place', () => {
    // The second turn replaces two earlier messages with one summary, so it is
    // not an extension of the first turn.
    const summary = { role: 'user', content: 'Earlier: the assistant listed the files and read the manifest.' };
    const report = checkPrefixChainOf([turn([u1, a1, u2, a2]), turn([summary, { role: 'user', content: 'now build it' }])], opts);
    expect(report.ok).toBe(false);
    expect(report.findings[0]?.code).toBe('GH130');
  });

  it('flags tool definitions rebuilt in a different order between turns', () => {
    const toolsForward = [
      { name: 'read_file', description: 'read a file from disk', input_schema: { type: 'object' } },
      { name: 'write_file', description: 'write a file to disk', input_schema: { type: 'object' } },
      { name: 'list_dir', description: 'list a directory on disk', input_schema: { type: 'object' } },
    ];
    const toolsReordered = [toolsForward[2], toolsForward[0], toolsForward[1]];
    const withTools = (tools: unknown[], messages: unknown[]) => ({
      model: 'claude-sonnet-4-5',
      tools,
      system: [{ type: 'text', text: sys, cache_control: { type: 'ephemeral' } }],
      messages,
    });
    const report = checkPrefixChainOf(
      [withTools(toolsForward, [u1]), withTools(toolsReordered, [u1, a1, u2])],
      opts,
    );
    expect(report.ok).toBe(false);
    expect(report.findings[0]?.fix.toLowerCase()).toContain('sort');
  });
});

describe('guards', () => {
  it('refuses a chain of fewer than two turns', () => {
    expect(() => checkPrefixChainOf([turn([u1])], opts)).toThrow(/at least two turns/);
  });

  it('renders a passing chain without decorative characters', () => {
    const report = checkPrefixChainOf([turn([u1]), turn([u1, a1, u2])], opts);
    const output = renderChainReport(report, { color: false, width: 80 });
    expect(output).toContain('reuse');
    for (const line of output.split('\n')) expect(line.length).toBeLessThanOrEqual(84);
    expect(output).not.toMatch(/[─│┌┐└┘]/);
    expect(output).not.toMatch(/[–—]/);
  });
});

import { analysePartition } from '../core/partition.js';
import { firstDivergence, sharedPrefix } from '../core/diverge.js';
import { prefixHash } from '../core/canonical.js';
import { formatCount } from '../core/format.js';
import { buildDiffWindow, renderDiffWindow } from '../core/diff.js';
import { classifyCause } from '../classify/cause/classify.js';
import { costOfUncachedTokens } from '../classify/cost.js';
import { estimateBlocks } from '../tokens/estimate.js';
import type { MatrixResult } from '../runner/matrix.js';
import type { CanonicalPrefix, CanonicalRequest, ChainReport, ChainStep, Finding, ProviderProfile } from '../types.js';

export type { ChainReport, ChainStep } from '../types.js';

/**
 * Checking that a conversation reuses its own prefix as it grows.
 *
 * An agent loop sends the whole conversation every turn: turn two is turn one
 * plus a tool result and a reply, turn three is turn two plus more. For the
 * cache to pay, each turn has to be a byte for byte extension of the one before
 * it, so the entire prior context is a cache hit and only the new turn is paid
 * for.
 *
 * The chain breaks when an earlier turn is re-rendered on replay: a tool result
 * serialised differently the second time, an assistant message normalised on
 * the way back in, history summarised or truncated, tools rebuilt from a
 * registry. Once it breaks at a turn, every later turn pays full price on a
 * context that is still growing, which is where the largest cache bills come
 * from.
 */

function toResult(prev: CanonicalRequest, curr: CanonicalRequest): MatrixResult {
  const runs = [
    { descriptor: { index: 0, inputIndex: 0, repeatIndex: 0, axis: 'earlier-turn', hash: prefixHash(prev.blocks) }, request: prev, prefix: prev.blocks },
    { descriptor: { index: 1, inputIndex: 1, repeatIndex: 0, axis: 'later-turn', hash: prefixHash(curr.blocks) }, request: curr, prefix: curr.blocks },
  ];
  const shared = sharedPrefix([prev.blocks, curr.blocks]);
  return {
    runs,
    partition: analysePartition(runs.map((run) => run.descriptor)),
    shared: { blocks: shared.blocks, contentBytes: shared.contentBytes, prefix: shared.prefix, complete: shared.complete },
    divergence: firstDivergence(prev.blocks, curr.blocks),
    axes: [{ label: 'earlier-turn', description: '' }, { label: 'later-turn', description: '' }],
  };
}

/** True when the earlier turn's blocks are a byte for byte prefix of the later turn. */
function isStrictPrefix(prev: CanonicalPrefix, curr: CanonicalPrefix): boolean {
  if (curr.length <= prev.length) return false;
  const divergence = firstDivergence(prev, curr);
  if (divergence === null) return false; // identical, so nothing was added
  return divergence.isTruncation && divergence.sharedBlocks === prev.length;
}

function diffLines(result: MatrixResult): string[] | null {
  const div = result.divergence;
  if (!div || div.partIndex == null || div.offsetInPart == null) return null;
  const [first, other] = result.runs;
  if (!first || !other) return null;
  const leftPart = first.prefix.find((b) => b.index === div.blockIndex)?.parts[div.partIndex];
  const rightPart = other.prefix.find((b) => b.index === div.blockIndex)?.parts[div.partIndex];
  if (!leftPart || !rightPart) return null;
  const left = leftPart.type === 'text' ? leftPart.text : leftPart.type === 'json' ? leftPart.canonical : '';
  const right = rightPart.type === 'text' ? rightPart.text : rightPart.type === 'json' ? rightPart.canonical : '';
  return renderDiffWindow(buildDiffWindow({ left, right, offset: div.offsetInPart }));
}

export function checkChain(requests: CanonicalRequest[], profile: ProviderProfile, model: string): ChainReport {
  const steps: ChainStep[] = [];
  const findings: Finding[] = [];

  for (let i = 0; i + 1 < requests.length; i += 1) {
    const prev = requests[i] as CanonicalRequest;
    const curr = requests[i + 1] as CanonicalRequest;

    const shared = sharedPrefix([prev.blocks, curr.blocks]);
    const holds = isStrictPrefix(prev.blocks, curr.blocks);
    const sharedTokens = estimateBlocks(shared.prefix, profile.tokenizer).value;
    const toTurnTokens = estimateBlocks(curr.blocks, profile.tokenizer).value;

    steps.push({ fromTurn: i, toTurn: i + 1, holds, sharedTokens, toTurnTokens });

    if (!holds && findings.length === 0) {
      // Only the first break is reported. Everything after it is a consequence
      // of it, so naming later breaks would be noise on top of the real one.
      const result = toResult(prev, curr);
      const cause = classifyCause(result);
      const lost = toTurnTokens - sharedTokens;
      const cost = costOfUncachedTokens(lost, profile);
      const diff = diffLines(result);
      const div = result.divergence;

      findings.push({
        code: 'GH130',
        severity: 'fail',
        confidence: cause.confidence,
        title: `the conversation stops reusing its prefix at turn ${formatCount(i + 1)}`,
        detail: [
          `Turn ${formatCount(i + 1)} is not an extension of turn ${formatCount(i)}: it re-renders content the earlier turn ` +
            `already sent, so the provider can reuse only ${formatCount(sharedTokens)} of its ${formatCount(toTurnTokens)} tokens.`,
          capitalise(cause.observation) + '.',
          'From this turn on, every turn pays full price on a context that is still growing, which is where the largest cache bills come from.',
          ...(div && !div.isStructural
            ? [`The turns first differ at byte ${formatCount(div.offsetInPart ?? div.contentByteOffset)} of block ${formatCount(div.blockIndex)} (${div.blockKind}).`]
            : ['The turns differ in structure: a block was added, removed, or retyped between them.']),
        ],
        fix: chainFix(cause.kind),
        ...(div
          ? {
              location: {
                blockIndex: div.blockIndex,
                blockKind: div.blockKind,
                ...(div.role ? { role: div.role } : {}),
                ...(div.partIndex != null ? { partIndex: div.partIndex } : {}),
                ...(div.offsetInPart != null ? { byteOffset: div.offsetInPart } : {}),
              },
            }
          : {}),
        ...(diff ? { diff } : {}),
        ...(cost ? { cost } : {}),
      });
    }
  }

  return {
    reportVersion: 1,
    ok: findings.length === 0,
    certain: !findings.some((finding) => finding.uncertain),
    provider: profile.id,
    model,
    fidelity: requests[0]?.fidelity ?? 'builder',
    turns: requests.length,
    steps,
    findings,
  };
}

function chainFix(kind: string): string {
  if (kind === 'ordering') {
    return 'Render the repeated part of the conversation the same way every turn. Sort anything assembled from a set, such as tool definitions, before it enters the prompt.';
  }
  if (kind === 'structural') {
    return 'Keep the block structure of earlier turns identical on replay. Append new turns rather than rebuilding the history, so the earlier blocks are byte for byte the same.';
  }
  return (
    'Serialise earlier turns the same way on every request. The usual cause is a tool result or an assistant message that is ' +
    'rebuilt from parsed state on replay rather than carried forward verbatim, or a history that is summarised in place. Carry ' +
    'the earlier turns forward unchanged.'
  );
}

function capitalise(text: string): string {
  return text.length === 0 ? text : (text[0]?.toUpperCase() ?? '') + text.slice(1);
}

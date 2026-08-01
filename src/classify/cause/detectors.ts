import type { Variant } from './extract.js';
import { isEpoch, isHighEntropyToken, isInteger, isIso8601, isOpaqueId, isUuid } from './patterns.js';
import type { Cause, CauseContext, CauseDetector } from './types.js';

/**
 * The detectors, each independent and each defending its own claim.
 *
 * Every value class detector requires every distinct value to match, not just
 * one, so a single coincidental match cannot carry a wrong label. The clock
 * axis is used to promote a time shaped value from probable to certain, because
 * a value that tracks the clock is demonstrated to depend on it rather than
 * merely looking like a date.
 */

function every(context: CauseContext, test: (value: string) => boolean): boolean {
  return context.distinct.length >= 2 && context.distinct.every(test);
}

function example(context: CauseContext): { left: string; right: string } {
  return { left: context.distinct[0] ?? '', right: context.distinct[1] ?? '' };
}

/** True when the value changes cleanly with the clock, not with anything else. */
function tracksClock(context: CauseContext): boolean {
  return context.partition.dimension === 'environment' && clockAxisIsolatesValue(context.variants);
}

function clockAxisIsolatesValue(variants: Variant[]): boolean {
  const byAxis = new Map<string, Set<string>>();
  for (const variant of variants) {
    const values = byAxis.get(variant.axis) ?? new Set<string>();
    values.add(variant.value);
    byAxis.set(variant.axis, values);
  }
  const moved = byAxis.get('clock-moved');
  const pinned = byAxis.get('clock-pinned');
  if (!moved || !pinned) return false;
  // The value under a moved clock differs from the value under a pinned one.
  return [...moved][0] !== [...pinned][0];
}

const timestamp: CauseDetector = {
  kind: 'timestamp',
  precedence: 20,
  detect(context) {
    if (context.spanExtendsBeyondToken) return null;
    if (every(context, isIso8601)) {
      return finding('timestamp', 'certain', 'every differing value parses as an ISO 8601 date or time', context);
    }
    if (every(context, isEpoch)) {
      const confidence = tracksClock(context) ? 'certain' : 'probable';
      const note = confidence === 'certain'
        ? 'every differing value is a unix epoch, and it tracks the clock axis'
        : 'every differing value is a ten or thirteen digit unix epoch';
      return finding('timestamp', confidence, note, context);
    }
    return null;
  },
};

const uuid: CauseDetector = {
  kind: 'uuid',
  precedence: 30,
  detect(context) {
    if (context.spanExtendsBeyondToken) return null;
    if (every(context, isUuid)) {
      return finding('uuid', 'certain', 'every differing value is a uuid', context);
    }
    if (every(context, isOpaqueId)) {
      return finding('uuid', 'probable', 'every differing value is an opaque identifier such as a ulid or nanoid', context);
    }
    return null;
  },
};

const counter: CauseDetector = {
  kind: 'counter',
  precedence: 40,
  detect(context) {
    if (context.spanExtendsBeyondToken) return null;
    if (context.distinct.length < 3) return null;
    if (!context.distinct.every(isInteger)) return null;
    if (!strictlyIncreasingInSomeAxis(context.variants)) return null;
    return finding('counter', 'certain', 'the value is an integer that increases on each call', context);
  },
};

const random: CauseDetector = {
  kind: 'random',
  precedence: 60,
  detect(context) {
    if (context.spanExtendsBeyondToken) return null;
    if (!every(context, isHighEntropyToken)) return null;
    // Same length across values is what a generated token looks like. A content
    // hash of changed content also looks like this, so it stays a possibility.
    const lengths = new Set(context.distinct.map((value) => value.length));
    if (lengths.size !== 1) return null;
    return finding('random', 'possible', 'every differing value is a high entropy token of the same length, which may be a generated id or a content hash', context);
  },
};

/** Integers that strictly increase in repeat order within at least one axis. */
function strictlyIncreasingInSomeAxis(variants: Variant[]): boolean {
  const byAxisInput = new Map<string, Variant[]>();
  for (const variant of variants) {
    const key = variant.axis + '\t' + variant.inputIndex;
    const group = byAxisInput.get(key) ?? [];
    group.push(variant);
    byAxisInput.set(key, group);
  }
  for (const group of byAxisInput.values()) {
    if (group.length < 3) continue;
    const ordered = [...group].sort((a, b) => a.repeatIndex - b.repeatIndex);
    let increasing = true;
    for (let i = 1; i < ordered.length; i += 1) {
      if (Number(ordered[i]?.value) <= Number(ordered[i - 1]?.value)) {
        increasing = false;
        break;
      }
    }
    if (increasing) return true;
  }
  return false;
}

function finding(kind: Cause['kind'], confidence: Cause['confidence'], observation: string, context: CauseContext): Cause {
  return { kind, confidence, observation, example: example(context) };
}

export const VALUE_DETECTORS: CauseDetector[] = [timestamp, uuid, counter, random];

/**
 * Environment axes.
 *
 * Running a builder twice and hoping a hidden dependency fires is a weak test.
 * A timestamp read once at module load, a date that only rolls over at
 * midnight, or a value formatted against the machine timezone will all repeat
 * happily inside one process and differ everywhere else.
 *
 * These axes force the question instead. Each one changes exactly one variable
 * against a common base, so when a prefix differs between two of them the cause
 * is demonstrated rather than guessed at. Everything here is restored
 * afterwards, and only changes that cannot corrupt a caller are included: the
 * clock, the timezone and the random stream. Nothing patches a filesystem, a
 * socket, or promise scheduling.
 */

export interface Perturbation {
  label: string;
  /** Shown in output so the reader knows what was and was not exercised. */
  description: string;
  apply(): () => void;
}

/** Deterministic stream, so a failure under this axis reproduces exactly. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // Numerical Recipes linear congruential generator.
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

function freezeClock(instantMs: number): () => void {
  const RealDate = globalThis.Date;

  class FrozenDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(instantMs);
      else super(...(args as ConstructorParameters<typeof Date>));
    }

    static override now(): number {
      return instantMs;
    }
  }

  globalThis.Date = FrozenDate as unknown as DateConstructor;
  return () => {
    globalThis.Date = RealDate;
  };
}

function setTimezone(zone: string): () => void {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  return () => {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  };
}

function setRandom(seed: number): () => void {
  const previous = Math.random;
  Math.random = seededRandom(seed);
  return () => {
    Math.random = previous;
  };
}

function combine(restorers: Array<() => void>): () => void {
  return () => {
    // Reverse order, so each restore sees the state its apply saw.
    for (const restore of restorers.reverse()) restore();
  };
}

export const BASELINE_LABEL = 'baseline';

/**
 * The axes run by default.
 *
 * Every axis but the baseline pins the clock and the random stream, so within
 * an axis a repeat is deterministic unless something else varies. Each then
 * moves one variable away from the base, which is what makes a difference
 * between two axes attributable to that variable and nothing else.
 */
export function safePerturbations(baseInstantMs: number): Perturbation[] {
  const DAY_AND_TWO_HOURS = 26 * 60 * 60 * 1000;

  return [
    {
      label: BASELINE_LABEL,
      description: 'nothing patched, so repeats here reveal anything that changes on every call',
      apply: () => () => undefined,
    },
    {
      label: 'clock-pinned',
      description: 'clock held at a fixed instant, timezone UTC, random stream seeded',
      apply: () => combine([freezeClock(baseInstantMs), setTimezone('UTC'), setRandom(1)]),
    },
    {
      label: 'clock-moved',
      description: 'as clock-pinned but 26 hours later, which crosses a date boundary',
      apply: () => combine([freezeClock(baseInstantMs + DAY_AND_TWO_HOURS), setTimezone('UTC'), setRandom(1)]),
    },
    {
      label: 'timezone-shifted',
      description: 'as clock-pinned but in a timezone with a half hour offset',
      apply: () => combine([freezeClock(baseInstantMs), setTimezone('Asia/Kolkata'), setRandom(1)]),
    },
    {
      label: 'random-reseeded',
      description: 'as clock-pinned but with a different random stream',
      apply: () => combine([freezeClock(baseInstantMs), setTimezone('UTC'), setRandom(99)]),
    },
  ];
}

/** What the default axes deliberately do not cover, stated rather than implied. */
export const NOT_PERTURBED = [
  'locale, which node does not reliably reload at runtime',
  'filesystem read order, which cannot be changed without patching the filesystem',
  'promise resolution order, which cannot be changed without patching the scheduler',
  'identifier generators that do not go through Math.random, such as crypto uuids',
];

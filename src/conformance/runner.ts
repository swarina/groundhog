import { wasHit } from '../audit/types.js';
import type { Observation, Probe, ProbeRun, Sender } from './types.js';

/**
 * Running the probes against a sender.
 *
 * Steps run in order, since a probe's later requests depend on its earlier ones
 * warming the cache. A wait between steps is honoured through an injected sleep,
 * so a test can run the time to live probes instantly while a real run waits the
 * real minutes.
 */

export type Sleep = (seconds: number) => Promise<void>;

const realSleep: Sleep = (seconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, seconds * 1000);
  });

export interface RunOptions {
  sleep?: Sleep;
  /** Called before each request, so a run can show progress. */
  onStep?: (probeId: string, label: string, index: number, total: number) => void;
}

export async function runProbe(probe: Probe, sender: Sender, options: RunOptions = {}): Promise<ProbeRun> {
  const sleep = options.sleep ?? realSleep;
  const observations: Observation[] = [];

  for (let i = 0; i < probe.steps.length; i += 1) {
    const step = probe.steps[i];
    if (!step) continue;
    if (step.waitSecondsBefore && step.waitSecondsBefore > 0) await sleep(step.waitSecondsBefore);
    options.onStep?.(probe.id, step.label, i, probe.steps.length);

    const result = await sender(step.body);
    observations.push({ label: step.label, usage: result.usage, hit: wasHit(result.usage) });
  }

  return { probe, observations, conclusion: probe.interpret(observations) };
}

export async function runProbes(probes: Probe[], sender: Sender, options: RunOptions = {}): Promise<ProbeRun[]> {
  const runs: ProbeRun[] = [];
  // Probes run one after another, not concurrently, so their cache writes do not
  // interfere with each other's reads.
  for (const probe of probes) runs.push(await runProbe(probe, sender, options));
  return runs;
}

export interface RunPlan {
  totalRequests: number;
  maxWaitSeconds: number;
}

/** What a run will cost, so it can be shown before anything is sent. */
export function planRun(probes: Probe[]): RunPlan {
  return {
    totalRequests: probes.reduce((sum, probe) => sum + probe.requestCount, 0),
    maxWaitSeconds: probes.reduce((max, probe) => Math.max(max, probe.maxWaitSeconds), 0),
  };
}

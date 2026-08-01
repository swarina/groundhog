import { execFileSync } from 'node:child_process';
import type { Lockfile } from './lockfile.js';

/**
 * Finding the commit where a prefix hash last changed.
 *
 * The baseline is committed, so its history is the history of the prefix. This
 * walks the commits that touched the lockfile, reads the stored hash at each,
 * and reports the commit where the current hash first appeared. That commit is
 * the deploy that cold started the cache.
 *
 * Everything here shells out to git with fixed arguments and no shell, so no
 * input reaches a command line. It is the only part of the tool that runs an
 * external process, and it runs only git.
 */

export interface Commit {
  hash: string;
  /** Unix seconds, from git, so nothing here reads the clock. */
  timestamp: number;
  subject: string;
}

export interface BlameResult {
  id: string;
  currentHash: string;
  /** The commit that introduced the current hash, when one was found. */
  introducedBy: Commit | null;
  /** The hash the prefix had before that commit, when known. */
  previousHash: string | null;
  /** Total commits that have touched this entry. */
  touchingCommits: number;
}

export class NotAGitRepoError extends Error {
  constructor() {
    super('This is not a git repository, so there is no history to blame. Run this from a repository where the baseline is committed.');
    this.name = 'NotAGitRepoError';
  }
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function isRepo(cwd: string): boolean {
  try {
    git(['rev-parse', '--git-dir'], cwd);
    return true;
  } catch {
    return false;
  }
}

/** Commits that changed the lockfile, newest first. */
function commitsTouching(path: string, cwd: string): Commit[] {
  let out: string;
  try {
    out = git(['log', '--format=%H%x09%ct%x09%s', '--', path], cwd);
  } catch {
    return [];
  }
  const commits: Commit[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [hash, ts, ...rest] = line.split('\t');
    if (!hash) continue;
    commits.push({ hash, timestamp: Number(ts), subject: rest.join('\t') });
  }
  return commits;
}

/** The stored hash for one entry at a given commit, or null when absent. */
function hashAt(commit: string, path: string, id: string, cwd: string): string | null {
  let content: string;
  try {
    content = git(['show', `${commit}:${path}`], cwd);
  } catch {
    return null;
  }
  try {
    const lockfile = JSON.parse(content) as Lockfile;
    return lockfile.entries.find((entry) => entry.id === id)?.prefixHash ?? null;
  } catch {
    return null;
  }
}

export function blame(path: string, id: string, currentHash: string, cwd: string = process.cwd()): BlameResult {
  if (!isRepo(cwd)) throw new NotAGitRepoError();

  const commits = commitsTouching(path, cwd);
  const base: BlameResult = { id, currentHash, introducedBy: null, previousHash: null, touchingCommits: commits.length };
  if (commits.length === 0) return base;

  // Walk newest to oldest. The commit that introduced the current hash is the
  // oldest one in the unbroken run of commits that already carry it.
  let introducedBy: Commit | null = null;
  let previousHash: string | null = null;

  for (const commit of commits) {
    const hash = hashAt(commit.hash, path, id, cwd);
    if (hash === currentHash) {
      introducedBy = commit;
      continue;
    }
    // The first commit whose hash differs is the state before the change.
    previousHash = hash;
    break;
  }

  return { ...base, introducedBy, previousHash };
}

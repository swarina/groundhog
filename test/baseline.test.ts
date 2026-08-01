import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blame } from '../src/baseline/blame.js';
import { compareEntry, computePrefix, readLockfile, upsertEntry, writeLockfile, type BaselineEntry } from '../src/baseline/lockfile.js';

const sys = 'You are a support agent. Answer from the knowledge base. '.repeat(40);
function request(systemText: string) {
  return { model: 'claude-sonnet-4-5', system: [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: 'hi' }] };
}

describe('computing a prefix', () => {
  it('is stable for the same request', () => {
    const a = computePrefix(request(sys), { discover: false });
    const b = computePrefix(request(sys), { discover: false });
    expect(a.prefixHash).toBe(b.prefixHash);
  });

  it('changes when the cached prompt changes', () => {
    const a = computePrefix(request(sys), { discover: false });
    const b = computePrefix(request(sys + ' and cite sources'), { discover: false });
    expect(a.prefixHash).not.toBe(b.prefixHash);
  });

  it('ignores the final user turn, which is meant to vary', () => {
    const a = computePrefix({ ...request(sys), messages: [{ role: 'user', content: 'where is my order' }] }, { discover: false });
    const b = computePrefix({ ...request(sys), messages: [{ role: 'user', content: 'reset my password' }] }, { discover: false });
    expect(a.prefixHash).toBe(b.prefixHash);
  });
});

describe('lockfile round trip', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'groundhog-lock-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function entry(id: string, hash: string): BaselineEntry {
    return { id, provider: 'anthropic', model: 'claude-sonnet-4-5', prefixHash: hash, tokens: 100, recordedAt: '2026-08-02T00:00:00Z' };
  }

  it('writes and reads back an entry', () => {
    const path = join(dir, 'baseline.json');
    writeLockfile(path, upsertEntry({ version: 1, entries: [] }, entry('a', 'hash-a')));
    expect(readLockfile(path).entries[0]?.prefixHash).toBe('hash-a');
  });

  it('replaces an entry with the same id rather than duplicating it', () => {
    let lock = upsertEntry({ version: 1, entries: [] }, entry('a', 'hash-a'));
    lock = upsertEntry(lock, entry('a', 'hash-b'));
    expect(lock.entries).toHaveLength(1);
    expect(lock.entries[0]?.prefixHash).toBe('hash-b');
  });

  it('sorts entries so the committed file is stable', () => {
    const path = join(dir, 'baseline.json');
    let lock = upsertEntry({ version: 1, entries: [] }, entry('zebra', 'z'));
    lock = upsertEntry(lock, entry('apple', 'a'));
    writeLockfile(path, lock);
    const text = readFileSync(path, 'utf8');
    expect(text.indexOf('apple')).toBeLessThan(text.indexOf('zebra'));
  });

  it('reports drift by comparing hashes', () => {
    const drift = compareEntry(entry('a', 'old'), { prefixHash: 'new', tokens: 120 });
    expect(drift.changed).toBe(true);
    expect(drift.before).toBe('old');
    expect(drift.after).toBe('new');
  });
});

describe('blame over a real git history', () => {
  let dir: string;

  function git(args: string[]) {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  }

  function commitLock(hash: string, message: string) {
    const lock = { version: 1, entries: [{ id: 'prompt', provider: 'anthropic', model: 'claude-sonnet-4-5', prefixHash: hash, tokens: 100, recordedAt: '2026-08-02T00:00:00Z' }] };
    writeFileSync(join(dir, 'baseline.json'), JSON.stringify(lock, null, 2) + '\n');
    git(['add', '-A']);
    git(['commit', '-m', message]);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'groundhog-blame-'));
    git(['init']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'test']);
    commitLock('hash-one', 'initial prompt');
    commitLock('hash-two', 'edit the system prompt');
    // An unrelated commit that does not touch the lockfile, so blame has to walk
    // history that is not all about the prefix.
    writeFileSync(join(dir, 'notes.txt'), 'unrelated\n');
    git(['add', '-A']);
    git(['commit', '-m', 'unrelated change']);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds the commit that introduced the current hash', () => {
    const result = blame('baseline.json', 'prompt', 'hash-two', dir);
    expect(result.introducedBy?.subject).toBe('edit the system prompt');
    expect(result.previousHash).toBe('hash-one');
  });

  it('reports the previous hash from before the change', () => {
    const result = blame('baseline.json', 'prompt', 'hash-two', dir);
    expect(result.previousHash).toBe('hash-one');
    // Two commits touched the lockfile; the unrelated one did not.
    expect(result.touchingCommits).toBe(2);
  });

  it('reports no earlier hash when the prefix has never changed', () => {
    // A fresh repo where the lockfile only ever held one hash. Blaming its
    // current value finds the commit that first set it, with nothing before.
    const fresh = mkdtempSync(join(tmpdir(), 'groundhog-blame-stable-'));
    try {
      const g = (args: string[]) => execFileSync('git', args, { cwd: fresh, stdio: 'ignore' });
      g(['init']);
      g(['config', 'user.email', 'test@example.com']);
      g(['config', 'user.name', 'test']);
      const lock = { version: 1, entries: [{ id: 'prompt', provider: 'anthropic', model: 'claude-sonnet-4-5', prefixHash: 'steady', tokens: 100, recordedAt: '2026-08-02T00:00:00Z' }] };
      writeFileSync(join(fresh, 'baseline.json'), JSON.stringify(lock, null, 2) + '\n');
      g(['add', '-A']);
      g(['commit', '-m', 'record the baseline']);

      const result = blame('baseline.json', 'prompt', 'steady', fresh);
      expect(result.introducedBy?.subject).toBe('record the baseline');
      expect(result.previousHash).toBeNull();
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});

/** Platform-specific safety: Windows separators, ampersands, atomic replace and permissions. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { atomicWrite } from '../build/storage.js';
import { exportMarkdown, exportOptions } from '../build/export.js';
import { safeSid } from '../build/paths.js';

const win = process.platform === 'win32';

test('a path containing an ampersand and native separators survives quoting', () => {
  const raw = ['C:', 'research & notes', 'State.md'].join(String.fromCharCode(92));
  const parsed = exportOptions(`--format markdown --output "${raw}"`);
  assert.equal(parsed.output, raw, 'backslashes are literal, not escapes');
  const spaced = exportOptions("--output 'a b/State.md'");
  assert.equal(spaced.output, 'a b/State.md');
  assert.throws(() => exportOptions('--output "unterminated'), /Unbalanced/);
  assert.throws(() => exportOptions('--format html'), /Usage/);
});

test('atomic replacement overwrites in place and cleans its temporary file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sbb-plat-'));
  try {
    const target = join(dir, 'boards', 'cache.json');
    atomicWrite(target, '{"v":1}');
    atomicWrite(target, '{"v":2}');
    assert.equal(readFileSync(target, 'utf8'), '{"v":2}');
    assert.deepEqual(readdirSync(join(dir, 'boards')), ['cache.json'], 'no temp litter');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an atomic replace that cannot complete leaves the previous content intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sbb-plat2-'));
  try {
    const asDirectory = join(dir, 'target');
    mkdirSync(asDirectory);
    writeFileSync(join(asDirectory, 'inner'), 'keep');
    assert.throws(() => atomicWrite(asDirectory, 'data'));
    assert.equal(readFileSync(join(asDirectory, 'inner'), 'utf8'), 'keep');
    assert.deepEqual(readdirSync(dir), ['target']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an export never overwrites by default and reports a collision', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sbb-plat3-'));
  try {
    const target = join(dir, 'snapshot.md');
    exportMarkdown(target, 'first');
    assert.throws(() => exportMarkdown(target, 'second'), /EEXIST/);
    assert.equal(readFileSync(target, 'utf8'), 'first');
    exportMarkdown(target, 'second', true);
    assert.equal(readFileSync(target, 'utf8'), 'second');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('session ids cannot escape the board directory', () => {
  for (const raw of ['../../etc/passwd', 'a/b', 'C:' + sep + 'abs', '..']) {
    const safe = safeSid(raw);
    assert(!safe.includes('/') && !safe.includes(String.fromCharCode(92)) && safe !== '.' && safe !== '..');
  }
});

test('a read-only directory failure is reported, never silently swallowed', { skip: win ? 'chmod is not authoritative on Windows' : false }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'sbb-plat4-'));
  try {
    const locked = join(dir, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    assert.throws(() => atomicWrite(join(locked, 'file'), 'x'));
    chmodSync(locked, 0o700);
    assert.equal(statSync(locked).isDirectory(), true);
  } finally {
    try { chmodSync(join(dir, 'locked'), 0o700); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

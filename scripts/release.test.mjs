import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateVersion, compareVersions, registry, assertRegistryMatch, validateManifest, verifyArtifacts, packages, uploadPackages, promotePackages } from './release.mjs';

const version = '1.2.3', commit = 'a'.repeat(40);
function fixture() {
  return { version, commit, packages: packages.map(n => ({ name: `@varveai/adit-${n}`, version, file: `varveai-adit-${n}-${version}.tgz`, integrity: 'sha512-YWJj' })) };
}
test('release version must be explicit and stable', () => {
  for (const invalid of ['', undefined, 'v1.2.3', '1.2.3-beta.1', '1.2.3+build', '01.2.3', '1.2', '1.2.3\n', '$(echo x)']) assert.throws(() => validateVersion(invalid));
  assert.equal(validateVersion(version), version);
  assert.equal(compareVersions('1.10.0', '1.9.99'), 1);
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
  assert.equal(compareVersions('1.2.3', '2.0.0'), -1);
});
test('only registry 404 permits treating a version as absent', async () => {
  assert.equal(await registry('name', version, async () => ({ status: 404 })), null);
  for (const status of [401, 403, 429, 500, 503]) await assert.rejects(registry('name', version, async () => ({ status, ok: false })), /lookup failed/);
  await assert.rejects(registry('name', version, async () => { throw new Error('offline'); }), /offline/);
});
test('resume verifies package identity and exact archive digest', () => {
  const p = fixture().packages[0];
  assertRegistryMatch(p, { ...p, dist: { integrity: p.integrity } });
  for (const remote of [{ ...p, version: '1.2.2' }, { ...p, name: 'other' }, { ...p, dist: { integrity: 'sha512-other' } }]) assert.throws(() => assertRegistryMatch(p, remote));
});
test('manifest prevents resuming from a different commit or unsafe archive path', () => {
  assert.equal(validateManifest(fixture(), version, commit).packages.length, 4);
  assert.throws(() => validateManifest(fixture(), version, 'b'.repeat(40)));
  const bad = fixture(); bad.packages[0].file = '../outside.tgz';
  assert.throws(() => validateManifest(bad, version, commit));
  const missing = fixture(); missing.packages.pop();
  assert.throws(() => validateManifest(missing, version, commit));
});
test('artifact verification detects changed bytes before publication', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adit-release-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const m = fixture();
  for (const p of m.packages) {
    const bytes = Buffer.from(p.name);
    p.integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
    writeFileSync(path.join(dir, p.file), bytes);
  }
  writeFileSync(path.join(dir, 'release-manifest.json'), JSON.stringify(m));
  verifyArtifacts(dir, version, commit);
  writeFileSync(path.join(dir, m.packages[0].file), 'corrupt');
  assert.throws(() => verifyArtifacts(dir, version, commit), /integrity mismatch/);
});
function fakeRegistry() {
  const saved = new Map(), uploaded = [];
  return { saved, uploaded, lookup: async name => saved.get(name) || null, delay: async () => {}, upload: async p => { uploaded.push(p.name); saved.set(p.name, { ...p, dist: { integrity: p.integrity } }); } };
}
test('partial upload resumes without reuploading successful packages, CLI last', async () => {
  const m = fixture(), io = fakeRegistry(), upload = io.upload;
  io.upload = async p => { if (p.name.endsWith('-cloud')) throw new Error('connection lost'); await upload(p); };
  await assert.rejects(uploadPackages(m, io), /connection lost/);
  assert.deepEqual(io.uploaded, m.packages.slice(0, 2).map(p => p.name));
  io.upload = upload;
  await uploadPackages(m, io);
  assert.deepEqual(io.uploaded, m.packages.map(p => p.name));
  await uploadPackages(m, io);
  assert.equal(io.uploaded.length, 4);
});
test('an existing conflicting package stops the entire batch before any upload', async () => {
  const m = fixture(), io = fakeRegistry(), last = m.packages.at(-1);
  io.saved.set(last.name, { ...last, dist: { integrity: 'sha512-other' } });
  await assert.rejects(uploadPackages(m, io), /Published content differs/);
  assert.equal(io.uploaded.length, 0);
});
test('upload success without registry visibility must not be reported as release success', async () => {
  const io = fakeRegistry(); io.upload = async () => {};
  await assert.rejects(uploadPackages(fixture(), io), /not visible/);
});

test('remote-writing commands refuse rehearsal mode before touching remote services', () => {
  for (const command of ['stage', 'publish', 'finish']) {
    const result = spawnSync(process.execPath, ['scripts/release.mjs', command], {
      encoding: 'utf8', env: { ...process.env, RELEASE_VERSION: version, GITHUB_SHA: commit,
        GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'VARVE-ai/adit-core', GITHUB_REF: 'refs/heads/main', DRY_RUN: 'true' },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Remote writes disabled/);
  }
});
test('latest promotion rejects downgrade before changing any package', async () => {
  const m = fixture(), changed = [];
  await assert.rejects(promotePackages(m, {
    lookup: async (name, v) => v === 'latest' ? { version: '9.0.0' } : { ...m.packages.find(p => p.name === name), dist: { integrity: 'sha512-YWJj' } },
    promote: async p => changed.push(p.name), delay: async () => {},
  }), /roll latest back/);
  assert.deepEqual(changed, []);
});
test('a partially promoted release can be retried with the CLI promoted last', async () => {
  const m = fixture(), latest = new Map(), changes = [];
  let fail = true;
  const io = {
    lookup: async (name, v) => v === 'latest' ? { version: latest.get(name) || '1.2.2' } : { ...m.packages.find(p => p.name === name), dist: { integrity: 'sha512-YWJj' } },
    promote: async p => { if (fail && p.name.endsWith('-cloud')) throw new Error('interrupted'); latest.set(p.name, p.version); changes.push(p.name); },
    delay: async () => {},
  };
  await assert.rejects(promotePackages(m, io), /interrupted/);
  assert.equal(latest.size, 2);
  fail = false;
  await promotePackages(m, io);
  assert.equal(latest.size, 4);
  assert.equal(changes.at(-1), '@varveai/adit-cli');
});

test('a real publish request from a development branch is rejected before remote access', () => {
  const result = spawnSync(process.execPath, ['scripts/release.mjs', 'publish'], {
    encoding: 'utf8', env: { ...process.env, RELEASE_VERSION: version, GITHUB_SHA: commit,
      GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'VARVE-ai/adit-core', GITHUB_REF: 'refs/heads/develop', DRY_RUN: 'false' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Release only from main/);
});

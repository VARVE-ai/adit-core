import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repository = 'VARVE-ai/adit-core';
export const packages = ['core', 'engine', 'cloud', 'cli']; // Dependency order; CLI is last.
const root = fileURLToPath(new URL('../', import.meta.url));
export const run = (command, args, options = {}) => (execFileSync(command, args, {
  cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 180000, ...options,
}) || '').trim();
export function npm(args, options = {}) {
  // Invoke npm's JS entry on Windows as well, without shell quoting or .cmd shims.
  const candidates = [
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(realpathSync(process.execPath)), '../lib/node_modules/npm/bin/npm-cli.js'),
    ...(process.env.PATH || '').split(path.delimiter).flatMap(directory => {
      const executable = path.join(directory, 'npm');
      return existsSync(executable) && process.platform !== 'win32' ? [realpathSync(executable)] : [];
    }),
  ];
  const entry = candidates.find(file => file.endsWith('npm-cli.js') && existsSync(file));
  if (!entry) throw new Error('Cannot locate npm-cli.js next to Node.js');
  return run(process.execPath, [entry, ...args], options);
}
export function validateVersion(version) {
  assert.match(version ?? '', /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'An explicit stable version is required');
  return version;
}
export function compareVersions(a, b) {
  const aa = validateVersion(a).split('.').map(BigInt), bb = validateVersion(b).split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i] ? 1 : -1;
  return 0;
}
export function assertRegistryMatch(local, remote) {
  assert.ok(remote, `Published version is missing: ${local.name}@${local.version}`);
  assert.equal(remote.name, local.name, 'Registry package name mismatch');
  assert.equal(remote.version, local.version, 'Registry package version mismatch');
  assert.equal(remote.dist?.integrity, local.integrity, `Published content differs: ${local.name}`);
}
export async function registry(name, version, fetcher = fetch) {
  const response = await fetcher(`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`, { signal: AbortSignal.timeout(30000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Registry lookup failed: ${name}@${version} (${response.status})`);
  return response.json();
}
function github(args) { return run('gh', args); }
function githubRelease(tag) {
  const result = github(['api', '--include', `repos/${repository}/releases/tags/${tag}`]);
  return JSON.parse(result.slice(result.indexOf('{')));
}
export function findRelease(tag) {
  // REST's tag lookup only finds published releases. Resolve drafts via GraphQL,
  // then fetch the same REST shape (including assets) by release ID.
  const [owner, name] = repository.split('/');
  const result = JSON.parse(github(['api', 'graphql', '-f',
    'query=query($owner:String!,$name:String!,$tag:String!){repository(owner:$owner,name:$name){release(tagName:$tag){databaseId}}}',
    '-f', `owner=${owner}`, '-f', `name=${name}`, '-f', `tag=${tag}`]));
  assert.ok(!result.errors?.length, 'Release lookup failed');
  const release = result.data?.repository?.release;
  // Only an explicit missing release is safe to create; lookup failures must stop.
  assert.notEqual(release, undefined, 'Release lookup did not return a repository');
  if (release === null) return null;
  return JSON.parse(github(['api', `repos/${repository}/releases/${release.databaseId}`]));
}
function assertPublishContext() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Remote writes are allowed only in GitHub Actions');
  assert.equal(process.env.GITHUB_REPOSITORY, repository);
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main', 'Release only from main');
  assert.equal(process.env.DRY_RUN, 'false', 'Remote writes disabled in rehearsal mode');
}
export function validateManifest(manifest, version, commit) {
  assert.equal(manifest.version, version);
  assert.equal(manifest.commit, commit, 'Release belongs to a different source commit');
  assert.deepEqual(manifest.packages.map(p => p.name), packages.map(n => `@varveai/adit-${n}`));
  for (const p of manifest.packages) {
    assert.equal(p.version, version);
    assert.equal(p.file, `${p.name.replace('@', '').replace('/', '-')}-${version}.tgz`);
    assert.match(p.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
  }
  return manifest;
}
export function verifyArtifacts(directory, version, commit) {
  const manifest = validateManifest(JSON.parse(readFileSync(path.join(directory, 'release-manifest.json'), 'utf8')), version, commit);
  for (const p of manifest.packages) {
    const actual = 'sha512-' + createHash('sha512').update(readFileSync(path.join(directory, p.file))).digest('base64');
    assert.equal(actual, p.integrity, `Archive integrity mismatch: ${p.name}`);
  }
  return manifest;
}
function verifyTag(tag, commit) {
  const lines = run('git', ['ls-remote', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`]).split('\n').filter(Boolean);
  if (!lines.length) return false;
  const refs = new Map(lines.map(line => line.split(/\s+/).reverse()));
  assert.equal(refs.get(`refs/tags/${tag}^{}`) || refs.get(`refs/tags/${tag}`), commit, 'Tag points to another commit');
  return true;
}
async function validate(version, commit) {
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main', 'Release only from main');
  assert.equal(process.env.GITHUB_REPOSITORY, repository);
  assert.equal(run('git', ['rev-parse', 'HEAD']), commit);
  assert.ok(process.env.RELEASE_NOTES?.trim(), 'Release notes are required');
  verifyTag(`v${version}`, commit);
  for (const name of packages) {
    const latest = await registry(`@varveai/adit-${name}`, 'latest');
    assert.ok(!latest || compareVersions(version, latest.version) >= 0, 'Cannot release behind latest');
    const existing = await registry(`@varveai/adit-${name}`, version);
    if (existing) {
      const release = findRelease(`v${version}`);
      assert.ok(release, 'Existing npm version has no release record; refuse to adopt it');
    }
  }
}
function pack(version, commit, directory) {
  mkdirSync(directory, { recursive: true });
  const manifests = packages.map(name => {
    const file = path.join(root, 'packages', name, 'package.json');
    return { file, original: readFileSync(file, 'utf8') };
  });
  try {
    for (const { file, original } of manifests) {
      const value = JSON.parse(original);
      value.version = version;
      for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
        for (const name of Object.keys(value[section] || {})) {
          if (packages.some(n => name === `@varveai/adit-${n}`)) value[section][name] = version;
        }
      }
      writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
    }
    const artifacts = [];
    for (const name of packages) {
      const cwd = path.join(root, 'packages', name);
      // Build has already completed. Do not rebuild between testing and publication.
      const [result] = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', directory], { cwd }));
      const paths = new Set(result.files.map(f => f.path));
      for (const required of ['package.json', 'LICENSE', 'dist/index.js', 'dist/index.d.ts']) assert.ok(paths.has(required), `Missing ${required} in ${name}`);
      if (name === 'cli') for (const required of ['README.md', 'install-skill.cjs', 'dist/install-skills.js', 'local-assets/web/index.html', 'local-assets/web/share-reader.html', 'local-assets/share/render.mjs']) assert.ok(paths.has(required), `Missing ${required}`);
      assert.ok(!result.files.some(f => /(^|\/)\.env($|\.)|(^|\/)node_modules\//.test(f.path)), 'Unexpected private/dependency files');
      artifacts.push({ name: result.name, version, file: result.filename, integrity: result.integrity });
    }
    writeFileSync(path.join(directory, 'release-manifest.json'), JSON.stringify({ version, commit, packages: artifacts }, null, 2) + '\n');
    verifyArtifacts(directory, version, commit);
  } finally {
    for (const { file, original } of manifests) writeFileSync(file, original);
  }
}
export function stage(version, commit, directory) {
  assertPublishContext();
  const tag = `v${version}`;
  const local = verifyArtifacts(directory, version, commit);
  let release = findRelease(tag);
  if (release) {
    assert.ok(verifyTag(tag, commit), 'Release tag is missing');
    const saved = release.assets.some(a => a.name === 'release-manifest.json');
    if (saved) {
      // Reuse the exact original archives on retries, even if rebuilding would differ.
      const cached = mkdtempSync(path.join(tmpdir(), 'adit-release-resume-'));
      github(['release', 'download', tag, '--repo', repository, '--dir', cached, '--pattern', 'release-manifest.json']);
      const manifest = validateManifest(JSON.parse(readFileSync(path.join(cached, 'release-manifest.json'), 'utf8')), version, commit);
      for (const p of manifest.packages) github(['release', 'download', tag, '--repo', repository, '--dir', cached, '--pattern', p.file]);
      verifyArtifacts(cached, version, commit);
      for (const f of ['release-manifest.json', ...manifest.packages.map(p => p.file)]) writeFileSync(path.join(directory, f), readFileSync(path.join(cached, f)));
      return;
    }
    assert.ok(release.draft, 'Published release is missing its manifest');
  } else {
    if (!verifyTag(tag, commit)) {
      run('git', ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com', 'tag', '-a', tag, commit, '-m', `ADIT ${tag}`]);
      run('git', ['push', 'origin', `refs/tags/${tag}`]);
    }
    const notes = path.join(directory, 'release-notes.md');
    writeFileSync(notes, `${process.env.RELEASE_NOTES.trim()}\n\n## Installation\n\nRequires Node.js 22 or later.\n\n\`\`\`sh\nnpm install -g @varveai/adit-cli@${version}\n\`\`\`\n\nSource: https://github.com/${repository}/commit/${commit}\n\nValidation: https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}\n`);
    github(['release', 'create', tag, '--repo', repository, '--verify-tag', '--draft', '--title', tag, '--notes-file', notes]);
    release = findRelease(tag);
    assert.ok(release, 'Created draft release is not visible; retry the same release');
  }
  // A partial asset upload is safe to retry only when existing bytes match.
  for (const p of local.packages) {
    if (release.assets.some(a => a.name === p.file)) {
      const cached = mkdtempSync(path.join(tmpdir(), 'adit-release-asset-'));
      github(['release', 'download', tag, '--repo', repository, '--dir', cached, '--pattern', p.file]);
      assert.equal('sha512-' + createHash('sha512').update(readFileSync(path.join(cached, p.file))).digest('base64'), p.integrity, 'Partial upload differs; do not overwrite');
    } else github(['release', 'upload', tag, path.join(directory, p.file), '--repo', repository]);
  }
  // Manifest is the completion marker; upload it only after all archives exist.
  github(['release', 'upload', tag, path.join(directory, 'release-manifest.json'), '--repo', repository]);
}
export async function uploadPackages(manifest, io) {
  const now = io.now ?? (() => performance.now());
  // Validate every existing version before any new registry write.
  for (const p of manifest.packages) {
    const remote = await io.lookup(p.name, p.version);
    if (remote) assertRegistryMatch(p, remote);
  }
  for (const p of manifest.packages) {
    const remote = await io.lookup(p.name, p.version);
    if (remote) assertRegistryMatch(p, remote);
    else await io.upload(p);
    // npm may accept the archive but take several minutes to expose it.
    // Bound elapsed time, including slow lookups, and check once at the deadline.
    const deadline = now() + 5 * 60 * 1000;
    let visible;
    while (true) {
      visible = await io.lookup(p.name, p.version);
      if (visible) break;
      const remaining = deadline - now();
      if (remaining <= 0) break;
      await io.delay(Math.min(5000, remaining));
    }
    assert.ok(visible, `Published package not visible after 5 minutes: ${p.name}; retry the same release`);
    assertRegistryMatch(p, visible);
  }
}
async function publish(version, commit, directory) {
  assertPublishContext();
  assert.ok(verifyTag(`v${version}`, commit));
  const manifest = verifyArtifacts(directory, version, commit);
  await uploadPackages(manifest, {
    lookup: registry,
    upload: p => npm(['publish', path.join(directory, p.file), '--access', 'public', '--tag', 'candidate', '--ignore-scripts']),
    delay: ms => new Promise(resolve => setTimeout(resolve, ms)),
  });
}
export async function promotePackages(manifest, io) {
  for (const p of manifest.packages) {
    assertRegistryMatch(p, await io.lookup(p.name, p.version));
    const latest = await io.lookup(p.name, 'latest');
    assert.ok(!latest || compareVersions(p.version, latest.version) >= 0, 'Refuse to roll latest back');
  }
  // Promotion is not atomic across packages. Retry completes the same release.
  for (const p of manifest.packages) {
    await io.promote(p);
    let current;
    for (let attempt = 0; attempt < 6; attempt++) {
      current = await io.lookup(p.name, 'latest');
      if (current?.version === p.version) break;
      await io.delay();
    }
    assert.equal(current?.version, p.version, `Default version not confirmed: ${p.name}`);
  }
}
async function finish(version, commit, directory) {
  assertPublishContext();
  assert.ok(verifyTag(`v${version}`, commit));
  const manifest = verifyArtifacts(directory, version, commit);
  await promotePackages(manifest, {
    lookup: registry,
    promote: p => npm(['dist-tag', 'add', `${p.name}@${version}`, 'latest']),
    delay: () => new Promise(resolve => setTimeout(resolve, 5000)),
  });
  github(['release', 'edit', `v${version}`, '--repo', repository, '--draft=false', '--latest']);
  assert.equal(githubRelease(`v${version}`).draft, false, 'Release is still a draft');
}
async function main() {
  const [command, target = '.cache/release'] = process.argv.slice(2);
  const version = validateVersion(process.env.RELEASE_VERSION);
  const commit = process.env.GITHUB_SHA || run('git', ['rev-parse', 'HEAD']);
  const directory = path.resolve(root, target);
  if (command === 'validate') await validate(version, commit);
  else if (command === 'pack') pack(version, commit, directory);
  else if (command === 'stage') stage(version, commit, directory);
  else if (command === 'publish') await publish(version, commit, directory);
  else if (command === 'finish') await finish(version, commit, directory);
  else throw new Error(`Unknown release command: ${command}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });

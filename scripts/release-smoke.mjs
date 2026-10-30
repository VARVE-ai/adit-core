import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { npm, run, packages, validateVersion, verifyArtifacts } from './release.mjs';

const version = validateVersion(process.env.RELEASE_VERSION);
const directory = path.resolve(process.argv[2] || '.cache/release');
const mode = process.argv[3] || 'archives';
assert.ok(['archives', 'registry'].includes(mode));
const manifest = verifyArtifacts(directory, version, process.env.GITHUB_SHA || run('git', ['rev-parse', 'HEAD']));
const temporary = mkdtempSync(path.join(tmpdir(), 'adit-package-smoke-'));
try {
  const home = path.join(temporary, 'home');
  mkdirSync(home);
  writeFileSync(path.join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  const env = { ...process.env, CI: 'true', ADIT_LOCAL_DATA_DIR: path.join(temporary, 'data'), APPDATA: path.join(temporary, 'appdata'), XDG_CONFIG_HOME: path.join(temporary, 'config') };
  const specs = mode === 'archives' ? manifest.packages.map(p => path.join(directory, p.file)) : [`@varveai/adit-cli@${version}`];
  npm(['install', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', '--cache', path.join(temporary, 'cache'), ...specs], { cwd: temporary, env, timeout: 300000, stdio: 'inherit' });
  for (const name of packages) {
    const pkg = JSON.parse(readFileSync(path.join(temporary, 'node_modules/@varveai', `adit-${name}`, 'package.json'), 'utf8'));
    assert.equal(pkg.version, version);
    assert.equal(pkg.license, 'MIT');
    for (const [key, value] of Object.entries(pkg.dependencies || {})) {
      assert.ok(!value.startsWith('workspace:'), 'Unresolved workspace dependency');
      if (key.startsWith('@varveai/adit-')) assert.equal(value, version);
    }
  }
  const cli = path.join(temporary, 'node_modules/@varveai/adit-cli');
  const preload = path.join(temporary, 'isolated-home.cjs');
  writeFileSync(preload, `require('node:os').homedir = () => ${JSON.stringify(home)}; require('node:module').syncBuiltinESMExports();`);
  const check = path.join(temporary, 'check.mjs');
  writeFileSync(check, `
    import assert from 'node:assert/strict';
    import { startLocalServer } from ${JSON.stringify(pathToFileURL(path.join(cli, 'dist/local/server.js')).href)};
    await import(${JSON.stringify(pathToFileURL(path.join(cli, 'local-assets/share/render.mjs')).href)});
    // No instance: no login registration, background workers or metadata refresh.
    const app = await startLocalServer({ directory: ${JSON.stringify(env.ADIT_LOCAL_DATA_DIR)} });
    try {
      const get = url => fetch(url, { signal: AbortSignal.timeout(10000) });
      const health = await (await get(app.origin + '/health')).json();
      assert.equal(health.version, ${JSON.stringify(version)});
      const response = await get(app.origin);
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.ok(html.includes('<html'));
      const assets = [...html.matchAll(/(?:src|href)="([^" ]+\\.(?:js|css))"/g)].map(m => m[1]);
      assert.ok(assets.length > 0, 'No built web assets');
      for (const asset of assets) {
        const result = await get(new URL(asset, app.origin));
        assert.equal(result.status, 200);
        assert.ok(!result.headers.get('content-type').includes('text/html'), 'Missing asset returned HTML fallback');
      }
      console.log('Installed package, native database, web assets and share renderer verified.');
    } finally { await app.close(); }
  `);
  run(process.execPath, ['--require', preload, check], { cwd: temporary, env, stdio: 'inherit', timeout: 90000 });
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

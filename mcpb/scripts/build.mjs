// Build: bundle the server with esbuild -> dist/bundle, package the Ruby bridge (.rbz from source), then create the .mcpb file.
//   npm run build
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { unzipSync, zipSync } from 'fflate';
import { checkVersions } from './versions.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.join(ROOT, '..');
const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(DIST, 'bundle');
const EXT = path.join(REPO, 'extension');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const loaderRb = fs.readFileSync(path.join(EXT, 'su_mcp.rb'));
const mainRb = fs.readFileSync(path.join(EXT, 'su_mcp', 'main.rb'));
const version = checkVersions(pkg.version, manifest.version, mainRb.toString('utf8'), loaderRb.toString('utf8'));

fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(path.join(STAGE, 'server'), { recursive: true });

const built = await esbuild.build({
  entryPoints: [path.join(ROOT, 'src', 'index.mjs')],
  outfile: path.join(STAGE, 'server', 'index.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  metafile: true,
  define: {
    __SKETCHUP_MCP_VERSION__: JSON.stringify(version),
    __BRIDGE_VERSION__: JSON.stringify(version),
  },
  logLevel: 'warning',
});

// License notices of the libraries bundled into server/index.mjs (MIT/ISC/BSD require keeping the copyright notice).
const pkgs = new Map();
for (const input of Object.keys(built.metafile.inputs)) {
  const m = /node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(input);
  if (!m) continue;
  const dir = path.join(ROOT, 'node_modules', m[1]);
  if (pkgs.has(m[1]) || !fs.existsSync(path.join(dir, 'package.json'))) continue;
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const lic = fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  pkgs.set(m[1], { version: meta.version, license: meta.license, text: lic ? fs.readFileSync(path.join(dir, lic), 'utf8').trim() : '(no LICENSE file in the package)' });
}
const notices = ['Third-party libraries bundled in server/index.mjs of SketchUp MCP ' + version, ''];
for (const [name, p] of [...pkgs].sort()) notices.push('='.repeat(72), `${name} ${p.version} - ${p.license}`, '-'.repeat(72), p.text, '');
const NOTICES = notices.join('\n');

const write = (rel, data) => {
  fs.mkdirSync(path.dirname(path.join(STAGE, rel)), { recursive: true });
  fs.writeFileSync(path.join(STAGE, rel), data);
};
if (!fs.existsSync(path.join(ROOT, 'icon.png'))) {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-icon.mjs')], { stdio: 'inherit' });
}
write('manifest.json', fs.readFileSync(path.join(ROOT, 'manifest.json')));
write('icon.png', fs.readFileSync(path.join(ROOT, 'icon.png')));
write('server/THIRD_PARTY_NOTICES.txt', NOTICES);
write('LICENSE', fs.readFileSync(path.join(REPO, 'LICENSE')));
fs.writeFileSync(path.join(DIST, 'THIRD_PARTY_NOTICES.txt'), NOTICES);
write('bridge/su_mcp.rb', loaderRb);
write('bridge/su_mcp/main.rb', mainRb);

// .rbz = zip with exactly 2 files and '/' paths, built from source, then reopened to verify every byte.
const rbz = Buffer.from(zipSync({ 'su_mcp.rb': loaderRb, 'su_mcp/main.rb': mainRb }, { level: 9 }));
const check = unzipSync(rbz);
const names = Object.keys(check).sort();
if (names.join(',') !== 'su_mcp.rb,su_mcp/main.rb'
  || !Buffer.from(check['su_mcp.rb']).equals(loaderRb) || !Buffer.from(check['su_mcp/main.rb']).equals(mainRb)) {
  throw new Error(`.rbz has unexpected contents: ${names.join(', ')}`);
}
write('bridge/su_mcp.rbz', rbz);
fs.writeFileSync(path.join(DIST, `su_mcp-${version}.rbz`), rbz);

const mcpbDir = path.join(ROOT, 'node_modules', '@anthropic-ai', 'mcpb');
const mcpbBin = path.join(mcpbDir, JSON.parse(fs.readFileSync(path.join(mcpbDir, 'package.json'), 'utf8')).bin);
const out = path.join(DIST, `${manifest.name}-${version}.mcpb`);
const mcpb = (...args) => execFileSync(process.execPath, [mcpbBin, ...args], { stdio: 'inherit' });

mcpb('validate', path.join(STAGE, 'manifest.json'));
fs.rmSync(out, { force: true });
mcpb('pack', STAGE, out);
console.log(`\n=> ${out}\n=> ${path.join(DIST, `su_mcp-${version}.rbz`)}`);

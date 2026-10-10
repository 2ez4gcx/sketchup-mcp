// Unit tests that need no SketchUp: run the built server against a "fake bridge" (TCP) and check each behaviour.
//   node scripts/unit-test.mjs [path-to-server.mjs]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkVersions } from './versions.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = process.argv[2] || path.join(ROOT, 'dist', 'bundle', 'server', 'index.mjs');
// Version of the build under test (build.mjs bakes package.json's version into the bundle as the bundled bridge version).
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let failed = 0;
let passed = 0;
function check(name, cond, detail = '') {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `\n      -> ${detail}`}`);
}

// ---------------------------------------------------------------- fake bridge
const received = [];
const behaviours = new Map(); // cmd -> array of behaviours used in order; default: reply ok + echo params
const fake = net.createServer((sock) => {
  let buf = '';
  sock.on('error', () => {});
  sock.on('data', (d) => {
    buf += d;
    if (!buf.includes('\n')) return;
    const req = JSON.parse(buf.split('\n')[0]);
    received.push(req);
    const queue = behaviours.get(req.cmd) || [];
    const b = queue.length ? queue.shift() : { reply: { echo: req.params } };
    if (b.hang) return; // never reply
    if (b.destroy) { sock.destroy(); return; }
    if (b.raw !== undefined) { sock.end(b.raw); return; }
    if (b.writePng) fs.writeFileSync(req.params.path, PNG_1PX);
    const resp = b.error !== undefined
      ? { id: req.id, ok: false, error: b.error, backtrace: b.backtrace }
      : { id: req.id, ok: true, result: typeof b.reply === 'function' ? b.reply(req) : b.reply };
    sock.end(JSON.stringify(resp) + '\n');
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const FAKE_PORT = fake.address().port;

// ---------------------------------------------------------------- MCP client over stdio
function startServer(env) {
  const child = spawn(process.execPath, [ENTRY], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  child.stderr.on('data', () => {});
  let out = '';
  const pending = new Map();
  let id = 0;
  child.stdout.on('data', (d) => {
    out += d;
    let i;
    while ((i = out.indexOf('\n')) >= 0) {
      const line = out.slice(0, i);
      out = out.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      pending.get(m.id)?.(m);
      pending.delete(m.id);
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const rid = ++id;
    const t = setTimeout(() => reject(new Error(`rpc timeout ${method}`)), 30_000);
    pending.set(rid, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }) + '\n');
  });
  const tool = async (name, args = {}) => {
    const m = await rpc('tools/call', { name, arguments: args });
    const content = (m.result && m.result.content) || [];
    const txt = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    return { m, content, txt, isError: !!(m.result && m.result.isError) };
  };
  return {
    child, rpc, tool,
    async init() {
      const r = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'unit', version: '1' } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      return r;
    },
  };
}

const appdata = fs.mkdtempSync(path.join(os.tmpdir(), 'sumcp-unit-'));
fs.mkdirSync(path.join(appdata, 'SketchUp', 'SketchUp 2026', 'SketchUp'), { recursive: true });
const S = startServer({ SKETCHUP_MCP_PORT: String(FAKE_PORT), SKETCHUP_MCP_TIMEOUT: '1', APPDATA: appdata });
await S.init();

// 1-3: "may have already run" messages
behaviours.set('create_box', [{ hang: true }]);
let r = await S.tool('create_box', { width: 100, depth: 100, height: 100 });
check('edit command timeout -> "MAY HAVE ALREADY RUN"', r.isError && r.txt.includes('MAY HAVE ALREADY RUN'), r.txt);
behaviours.set('model_info', [{ hang: true }]);
r = await S.tool('model_info');
check('read command timeout -> "does not modify the model", no warning', r.isError && r.txt.includes('does not modify the model') && !r.txt.includes('MAY HAVE ALREADY RUN'), r.txt);
behaviours.set('set_tag', [{ destroy: true }]);
r = await S.tool('set_tag', { tag: 'A', entity_ids: [1] });
check('bridge closes the connection after receiving an edit command -> "MAY HAVE ALREADY RUN"', r.isError && r.txt.includes('MAY HAVE ALREADY RUN'), r.txt);

// 5-6: run_ruby backtrace, upgrade hint
behaviours.set('run_ruby', [{ error: 'NameError: undefined local variable x', backtrace: ['mcp_run_ruby:3:in `<main>`', 'x.rb:1'] }]);
r = await S.tool('run_ruby', { code: 'x' });
check('run_ruby error -> "Location in run_ruby code" with mcp_run_ruby:3, without x.rb', r.isError && r.txt.includes('Location in run_ruby code') && r.txt.includes('mcp_run_ruby:3') && !r.txt.includes('x.rb'), r.txt);
behaviours.set('list_tags', [{ error: 'ArgumentError: Unsupported command: list_tags. Available commands: ping' }]);
r = await S.tool('list_tags');
check('unsupported command -> suggests install_sketchup_bridge', r.isError && r.txt.includes('install_sketchup_bridge'), r.txt);
behaviours.set('list_materials', [{ error: '' }]);
r = await S.tool('list_materials');
check('empty error -> "Unknown error from SketchUp"', r.isError && r.txt.includes('Unknown error from SketchUp'), r.txt);
behaviours.set('list_components', [{ raw: 'not json\n' }]);
r = await S.tool('list_components');
check('non-JSON response -> isError "Invalid JSON"', r.isError && r.txt.includes('Invalid JSON'), r.txt);

// 7-8: the queue keeps working, compact JSON
behaviours.set('ping', [{ reply: { bridge: PKG_VERSION, sketchup: '23.0', model: 'x' } }]);
r = await S.tool('ping');
check('after the errors, ping still works (queue not stuck)', !r.isError && r.txt.includes('"mcp_server"'), r.txt);
behaviours.set('list_tags', [{ reply: [{ name: 'A' }, { name: 'B' }] }]);
r = await S.tool('list_tags');
check('result is compact JSON (no indentation)', !r.isError && !r.txt.includes('\n  ') && r.txt === '[{"name":"A"},{"name":"B"}]', r.txt);

// 10: version check via ping
const pingWith = async (bridge) => {
  behaviours.set('ping', [{ reply: bridge === undefined ? { sketchup: '23.0' } : { bridge, sketchup: '23.0' } }]);
  return S.tool('ping');
};
r = await pingWith('1.0.0');
check('ping: older bridge -> warning + install_sketchup_bridge', !r.isError && r.txt.includes('"warning"') && r.txt.includes('install_sketchup_bridge'), r.txt);
r = await pingWith(PKG_VERSION);
check(`ping: same bridge version (${PKG_VERSION}) -> no warning`, !r.isError && !r.txt.includes('warning') && !r.txt.includes('"note"'), r.txt);
r = await pingWith('9.9.9');
check('ping: newer bridge -> note, no error', !r.isError && r.txt.includes('"note"'), r.txt);
r = await pingWith(undefined);
check('ping: no bridge field -> no error', !r.isError, r.txt);

// 11-12: ids as strings, scale <= 0
received.length = 0;
r = await S.tool('delete_entities', { entity_ids: ['123', 45] });
const del = received.find((q) => q.cmd === 'delete_entities');
check('string id "123" -> sent as number 123', !r.isError && del && JSON.stringify(del.params.entity_ids) === '[123,45]', JSON.stringify(del && del.params));
received.length = 0;
r = await S.tool('transform_entities', { entity_ids: [1], scale: 0 });
check('scale=0 -> parameter validation error, not sent to the bridge', r.isError && !received.some((q) => q.cmd === 'transform_entities'), r.txt);
r = await S.tool('transform_entities', { entity_ids: [1], scale: 2 });
check('scale=2 -> sent normally', !r.isError && received.some((q) => q.cmd === 'transform_entities' && q.params.scale === 2), r.txt);
r = await S.tool('create_shape', { points: '[[0,0,0],[1000,0,0],[1000,1000,0]]' });
const shape = received.find((q) => q.cmd === 'create_shape');
check('points as a JSON string -> sent as a real array', !r.isError && shape && Array.isArray(shape.params.points) && shape.params.points.length === 3, r.txt);

// 13: screenshot restores the view
received.length = 0;
behaviours.set('export_png', [{ writePng: true, reply: (q) => ({ ok: true, width: 1024, height: 576, restored: q.params.restore_view === true && !!q.params.view }) }]);
r = await S.tool('screenshot', { view: 'iso' });
let ex = received.find((q) => q.cmd === 'export_png');
const img = r.content.find((c) => c.type === 'image');
check('screenshot: sends restore_view=true, max_size=1024, no width', ex && ex.params.restore_view === true && ex.params.max_size === 1024 && ex.params.width === undefined, JSON.stringify(ex && ex.params));
check('screenshot: returns image + info', !r.isError && img && img.mimeType === 'image/png' && r.txt.includes('"restored":true'), r.txt);
check('screenshot: deletes the temp file', ex && !fs.existsSync(ex.params.path));
received.length = 0;
behaviours.set('export_png', [{ writePng: true, reply: { ok: true, width: 640, height: 400 } }]);
r = await S.tool('screenshot', { width: 640, height: 400 });
ex = received.find((q) => q.cmd === 'export_png');
check('screenshot width/height -> sends width/height, no max_size', ex && ex.params.width === 640 && ex.params.height === 400 && ex.params.max_size === undefined, JSON.stringify(ex && ex.params));

// 14: set_material update_existing
received.length = 0;
await S.tool('set_material', { material: 'Wood', color: '#ff0000', entity_ids: [1] });
await S.tool('set_material', { material: 'Wood', color: '#00ff00', entity_ids: [1], update_existing: true });
const sm = received.filter((q) => q.cmd === 'set_material');
check('set_material: does not send update_existing unless requested', sm[0] && !('update_existing' in sm[0].params), JSON.stringify(sm[0] && sm[0].params));
check('set_material: sends update_existing=true when requested', sm[1] && sm[1].params.update_existing === true, JSON.stringify(sm[1] && sm[1].params));

// 16: hint per command type, old bridge does not restore the view, width only, negative limit
behaviours.set('export_png', [{ hang: true }]);
r = await S.tool('screenshot', {});
check('screenshot timeout -> safe to retry, named "screenshot"', r.isError && r.txt.includes("'screenshot'") && r.txt.includes('does not modify the model') && !r.txt.includes('MAY HAVE ALREADY RUN'), r.txt);
behaviours.set('undo', [{ hang: true }]);
r = await S.tool('undo');
check('undo timeout -> "MAY HAVE ALREADY RUN" + "do NOT use undo"', r.isError && r.txt.includes('MAY HAVE ALREADY RUN') && r.txt.includes('do NOT use undo'), r.txt);
behaviours.set('create_box', [{ raw: '{"id":1,"ok":tru' }]);
r = await S.tool('create_box', { width: 1, depth: 1, height: 1 });
check('truncated response to an edit command -> "Invalid JSON" + "MAY HAVE ALREADY RUN"', r.isError && r.txt.includes('Invalid JSON') && r.txt.includes('MAY HAVE ALREADY RUN'), r.txt);
behaviours.set('export_png', [{ writePng: true, reply: { ok: true, path: 'x' } }]);
r = await S.tool('screenshot', { view: 'top' });
check('old bridge (no restored field) + view -> warning to update the bridge', !r.isError && r.txt.includes('"warning"') && r.txt.includes('install_sketchup_bridge'), r.txt);
received.length = 0;
behaviours.set('export_png', [{ writePng: true, reply: { ok: true, restored: false } }]);
await S.tool('screenshot', { width: 800 });
ex = received.find((q) => q.cmd === 'export_png');
check('screenshot with width only -> max_size = width', ex && ex.params.max_size === 800 && ex.params.width === undefined, JSON.stringify(ex && ex.params));
r = await S.tool('selection_info', { limit: -1 });
check('selection_info negative limit -> parameter validation error', r.isError, r.txt);

// 9: bridge install tool on a temporary APPDATA
const inst = async (args) => JSON.parse((await S.tool('install_sketchup_bridge', args)).txt);
let j = await inst({ dry_run: true });
check('install dry_run -> would_install, no files written', j.results[0] && j.results[0].status === 'would_install'
  && !fs.existsSync(path.join(appdata, 'SketchUp', 'SketchUp 2026', 'SketchUp', 'Plugins')), JSON.stringify(j));
j = await inst({});
const plug = path.join(appdata, 'SketchUp', 'SketchUp 2026', 'SketchUp', 'Plugins');
check('install -> installed, files have the right content', j.results[0] && j.results[0].status === 'installed'
  && fs.readFileSync(path.join(plug, 'su_mcp', 'main.rb')).equals(fs.readFileSync(path.join(ROOT, '..', 'extension', 'su_mcp', 'main.rb'))), JSON.stringify(j));
j = await inst({});
check('install a second time -> unchanged', j.results[0] && j.results[0].status === 'unchanged', JSON.stringify(j));
j = await inst({ versions: ['2019'] });
check('install versions=[2019] -> skipped', j.results[0] && j.results[0].status === 'skipped', JSON.stringify(j));
check('install: has rbz path', typeof j.rbz_path === 'string' && fs.existsSync(j.rbz_path), JSON.stringify(j.rbz_path));

// 4: closed port -> cannot-connect message (no "may have already run" warning)
const closed = net.createServer();
await new Promise((res) => closed.listen(0, '127.0.0.1', res));
const CLOSED_PORT = closed.address().port;
await new Promise((res) => closed.close(res));
const S2 = startServer({ SKETCHUP_MCP_PORT: String(CLOSED_PORT), SKETCHUP_MCP_TIMEOUT: '1' });
await S2.init();
r = await S2.tool('create_box', { width: 1, depth: 1, height: 1 });
check('closed port -> "Cannot connect to SketchUp" + install_sketchup_bridge, no "MAY HAVE ALREADY RUN"', r.isError && r.txt.includes('Cannot connect to SketchUp') && r.txt.includes('install_sketchup_bridge') && !r.txt.includes('MAY HAVE ALREADY RUN'), r.txt);
S2.child.kill();

// 15: version check at build time
const ok = (() => { try { checkVersions('1.2.0', '1.2.0', "VERSION      = '1.2.0'", "ext.version     = '1.2.0'"); return true; } catch { return false; } })();
const bad = ['1.1.0', null].map((v) => {
  try { checkVersions('1.2.0', '1.2.0', v ? `VERSION = '${v}'` : 'no version', "ext.version = '1.2.0'"); return false; } catch { return true; }
});
check('checkVersions: matching -> ok; mismatched/missing -> error', ok && bad.every(Boolean));

S.child.kill();
fake.close();
fs.rmSync(appdata, { recursive: true, force: true });
console.log(`\n${passed} PASS, ${failed} FAIL`);
process.exit(failed ? 1 : 0);

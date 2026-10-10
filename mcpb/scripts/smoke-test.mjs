// Smoke test: runs the server over stdio, sends initialize + tools/list, then (optionally) calls READ-ONLY tools.
//   node scripts/smoke-test.mjs [path-to-server.mjs] [--live]
// --live: calls ping/model_info/... against the open SketchUp. Never calls a model-editing tool.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const live = args.includes('--live');
const entry = args.find((a) => !a.startsWith('--')) || path.join(ROOT, 'dist', 'bundle', 'server', 'index.mjs');

const READ_ONLY_CALLS = [
  ['ping', {}],
  ['model_info', {}],
  ['list_tags', {}],
  ['list_materials', {}],
  ['list_components', {}],
  ['selection_info', { limit: 5 }],
  ['screenshot', { width: 640, height: 400 }],
];

const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
child.stderr.on('data', (d) => process.stderr.write(`  [stderr] ${d}`));

let buf = '';
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  }
});

let id = 0;
function rpc(method, params) {
  const reqId = ++id;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: reqId, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${method}`)), 150_000);
    pending.set(reqId, (m) => { clearTimeout(t); resolve(m); });
  });
}

const t0 = Date.now();
const init = await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'smoke-test', version: '1.0.0' },
});
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
console.log(`initialize: ${init.result.serverInfo.name} v${init.result.serverInfo.version}, protocol ${init.result.protocolVersion} (${Date.now() - t0} ms)`);

const list = await rpc('tools/list', {});
const tools = list.result.tools;
console.log(`tools/list: ${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`);

if (live) {
  for (const [name, a] of READ_ONLY_CALLS) {
    const r = await rpc('tools/call', { name, arguments: a });
    if (r.error) { console.log(`- ${name}: JSON-RPC error ${JSON.stringify(r.error)}`); continue; }
    const c = r.result.content[0];
    const summary = c.type === 'image' ? `image ${c.mimeType}, ${Math.round(c.data.length * 0.75 / 1024)} KB` : c.text.replace(/\s+/g, ' ').slice(0, 160);
    console.log(`- ${name}${r.result.isError ? ' [isError]' : ''}: ${summary}`);
  }
}

child.stdin.end();
child.kill();

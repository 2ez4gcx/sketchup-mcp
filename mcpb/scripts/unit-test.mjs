// Unit tests that need no SketchUp: run the built server against a "fake bridge" (TCP) and check each behaviour.
//   node scripts/unit-test.mjs [path-to-server.mjs]
import { spawn, spawnSync } from 'node:child_process';
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
const BOM = String.fromCharCode(0xfeff);
const PNG_1PX =Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

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

// 17: interior tag standard (setup_tags, tag_style on create_*/set_tag)
received.length = 0;
r = await S.tool('setup_tags', { tags: ['FL-01 Engineered oak floor 12mm', 'FL-02 Porcelain tile 600x600', 'CL-01 Trần thạch cao phẳng',
  'Walls', { name: 'LT-01 Downlight', folder: 'Lighting plan', color: '#ff0000' }] });
let ct = received.find((q) => q.cmd === 'create_tags');
const ctTags = ct ? ct.params.tags : [];
check('setup_tags: FL-01 -> folder "FL Floor finishes", folder_code FL, RGB color', ctTags[0] && ctTags[0].folder === 'FL Floor finishes'
  && ctTags[0].folder_code === 'FL' && Array.isArray(ctTags[0].color) && ctTags[0].color.length === 3, JSON.stringify(ctTags[0]));
check('setup_tags: FL-02 gets another shade than FL-01', ctTags[1] && JSON.stringify(ctTags[1].color) !== JSON.stringify(ctTags[0].color), JSON.stringify(ctTags.slice(0, 2)));
check('setup_tags: Vietnamese name -> Vietnamese folder "CL Trần"', ctTags[2] && ctTags[2].folder === 'CL Trần', JSON.stringify(ctTags[2]));
check('setup_tags: tag without a code -> no folder, no color', ctTags[3] && ctTags[3].name === 'Walls' && !ctTags[3].folder && !ctTags[3].color, JSON.stringify(ctTags[3]));
check('setup_tags: explicit folder/color win, no folder_code', ctTags[4] && ctTags[4].folder === 'Lighting plan' && ctTags[4].color === '#ff0000'
  && !ctTags[4].folder_code, JSON.stringify(ctTags[4]));
check('setup_tags: update_existing defaults to false', ct && ct.params.update_existing === false, JSON.stringify(ct && ct.params));
received.length = 0;
await S.tool('setup_tags', { tags: ['WL-01 Sơn nước'], language: 'en' });
ct = received.find((q) => q.cmd === 'create_tags');
check('setup_tags: language=en overrides the guess', ct && ct.params.tags[0].folder === 'WL Wall finishes', JSON.stringify(ct && ct.params));
received.length = 0;
await S.tool('create_box', { width: 10, depth: 10, height: 10, tag: 'WL-03 Ốp gỗ veneer' });
await S.tool('create_box', { width: 10, depth: 10, height: 10, tag: 'Walls' });
await S.tool('set_tag', { tag: 'sk-1 skirting', entity_ids: [1] });
const boxes = received.filter((q) => q.cmd === 'create_box');
const st = received.find((q) => q.cmd === 'set_tag');
check('create_box with a standard tag -> tag_style with its category folder', boxes[0] && boxes[0].params.tag_style
  && boxes[0].params.tag_style.folder === 'WL Tường hoàn thiện', JSON.stringify(boxes[0] && boxes[0].params));
check('create_box with a non-standard tag -> no tag_style', boxes[1] && !('tag_style' in boxes[1].params), JSON.stringify(boxes[1] && boxes[1].params));
check('set_tag "sk-1 ..." -> code is case-insensitive (SK folder)', st && st.params.tag_style && st.params.tag_style.folder === 'SK Skirting', JSON.stringify(st && st.params));

// 18: interior_takeoff (units per category, warnings, totals, CSV)
const mt = (tag, o = {}) => ({ tag, count: 0, items: {}, nested_components: {}, plan_area_m2: 0, wall_area_m2: 0, sheet_area_m2: 0,
  side_area_m2: 0, length_m: 0, elevation_area_m2: 0, volume_m3: 0, not_solid: 0, not_thin: [], not_upright: [], uneven_sides: [],
  loose_faces: 0, ids: [], ...o });
const MT_REPLY = { tags: [
  mt('FL-01 Engineered oak floor 12mm', { count: 2, plan_area_m2: 24.3456, sheet_area_m2: 24.3456, side_area_m2: 0.2 }),
  mt('FL-02 Porcelain tile 600x600', { count: 1, plan_area_m2: 5.5 }),
  mt('WL-01 Paint, white', { count: 3, wall_area_m2: 30.126, sheet_area_m2: 34.126, side_area_m2: 61,
    not_thin: [{ id: 77, name: 'Room box', size_mm: [4000, 3000, 2800] }], not_upright: [{ id: 88, name: 'Shelf', size_mm: [2000, 2000, 18] }],
    uneven_sides: [{ id: 90, name: 'Wall C', size_mm: [4000, 2800, 100], sides_m2: [11.2, 9.31] }],
    not_straight: [{ id: 91, name: 'Curved wall', size_mm: [3000, 2800, 400] }],
    nested_components: { Socket: 2, '(opening) Door D1': 1 } }),
  mt('SK-01 Oak skirting 80mm', { count: 4, length_m: 15.234 }),
  mt('FN-01 Sofa', { count: 2, items: { Sofa: 2 } }),
  mt('Kitchen', { count: 1, plan_area_m2: 3 }),
  mt('Untagged', { plan_area_m2: 1 }),
], untagged: [{ id: 5, name: 'Table', room: 'Living room', faces: 6 }, { id: null, name: '(top level)', room: '', faces: 2 }],
rooms: [
  { ...mt('FL-01 Engineered oak floor 12mm', { plan_area_m2: 20.004 }), room: 'Living room' },
  { ...mt('FL-01 Engineered oak floor 12mm', { plan_area_m2: 4.3416 }), room: 'Level 2 / Bedroom 1' },
  { ...mt('FN-01 Sofa', { count: 2 }), room: 'Living room' },
  { ...mt('SK-01 Oak skirting 80mm', { length_m: 15.234 }), room: '' },
  { ...mt('Untagged', { plan_area_m2: 1 }), room: '' },
  { ...mt('FN-01 Sofa', { count: 1 }), room: 'Bedroom 10' },
  { ...mt('FN-01 Sofa', { count: 1 }), room: 'Bedroom 2' },
], hidden: [{ tag: 'CL-01 Gypsum', objects: 3, hidden_tag: true, names: [] },
  { tag: 'Untagged', objects: 1, hidden_tag: false, names: [{ id: 321, name: 'Tầng 2' }] }], excluded: { 'RF-01 CAD plan': 1 }, selection_only: false };
received.length = 0;
behaviours.set('measure_tags', [{ reply: MT_REPLY }]);
r = await S.tool('interior_takeoff', {});
let boq = JSON.parse(r.txt);
const row = (tag) => boq.rows.find((x) => x.tag === tag);
const mq = received.find((q) => q.cmd === 'measure_tags');
check('interior_takeoff: asks the bridge to skip RF tags', mq && JSON.stringify(mq.params.exclude_codes) === '["RF"]', JSON.stringify(mq && mq.params));
check('interior_takeoff: FL -> plan area m2, rounded to 2 decimals', row('FL-01 Engineered oak floor 12mm').quantity === 24.35
  && row('FL-01 Engineered oak floor 12mm').unit === 'm2' && row('FL-01 Engineered oak floor 12mm').code === 'FL-01', r.txt);
const wlw = (row('WL-01 Paint, white').warnings || []).join(' ');
check('interior_takeoff: WL -> wall area (one side) m2', row('WL-01 Paint, white').quantity === 30.13 && row('WL-01 Paint, white').measured_as === 'wall_area', r.txt);
check('interior_takeoff: WL warnings: not thin, lying flat, uneven sides, nested components, untagged openings', /Not thin.*Room box/.test(wlw)
  && /Curved or segmented.*Curved wall/.test(wlw) && /lying flat.*Shelf/.test(wlw) && /sides differ/.test(wlw) && wlw.includes('11.2 / 9.31') && wlw.includes('Socket x2') && wlw.includes('Door D1 x1'), wlw);
check('interior_takeoff: hidden objects are reported, not silently dropped', (boq.warnings || []).some((w) => w.includes('Hidden, so NOT measured: CL-01 Gypsum (3 object(s), tag or tag folder hidden)'))
  && boq.hidden && boq.hidden.length === 2, JSON.stringify(boq.warnings));
check('interior_takeoff: a hidden untagged group holding tagged objects (hidden room/level) is named in the warnings', (boq.warnings || []).some((w) => w.includes('Hidden groups without a tag') && w.includes('Tầng 2 (id 321)')), JSON.stringify(boq.warnings));
check('interior_takeoff: SK -> length m', row('SK-01 Oak skirting 80mm').quantity === 15.23 && row('SK-01 Oak skirting 80mm').unit === 'm', r.txt);
check('interior_takeoff: FN -> count pcs', row('FN-01 Sofa').quantity === 2 && row('FN-01 Sofa').unit === 'pcs', r.txt);
check('interior_takeoff: tag without a code -> no unit + warning', row('Kitchen').quantity === null && /known code/.test((row('Kitchen').warnings || []).join(' ')), r.txt);
check('interior_takeoff: no Untagged row; warning names the untagged geometry with id and room', !boq.rows.some((x) => x.tag === 'Untagged')
  && /no tagged object/.test((boq.warnings || []).join(' ')) && boq.warnings[0].includes("Table (id 5) in Living room"), r.txt);
check('interior_takeoff: by_room not requested -> no by_room data in the answer (the bridge is still asked, for the cross-checks)', !boq.rooms && !row('FN-01 Sofa').by_room
  && mq && mq.params.by_room === true, r.txt);
check('interior_takeoff: totals per category (FL = 24.35 + 5.5)', boq.totals.FL && boq.totals.FL.quantity === 29.85 && boq.totals.FL.lines === 2
  && boq.totals.FL.category === 'Floor finishes', JSON.stringify(boq.totals));
behaviours.set('measure_tags', [{ reply: MT_REPLY }]);
r = await S.tool('interior_takeoff', { measures: { Kitchen: 'plan_area', fn: 'elevation_area', 'ZZ-09': 'count' }, language: 'vi' });
boq = JSON.parse(r.txt);
check('interior_takeoff: measures override by tag name and by code (case-insensitive code key)', row('Kitchen').quantity === 3 && row('FN-01 Sofa').measured_as === 'elevation_area', r.txt);
check('interior_takeoff: a measures key that matches no tag is reported', (boq.warnings || []).some((w) => w.includes('matching no tag: ZZ-09')), JSON.stringify(boq.warnings));
check('interior_takeoff: language=vi -> Vietnamese category names', boq.totals.FL && boq.totals.FL.category === 'Sàn', JSON.stringify(boq.totals));
received.length = 0;
behaviours.set('measure_tags', [{ reply: MT_REPLY }]);
r = await S.tool('interior_takeoff', { by_room: true });
boq = JSON.parse(r.txt);
const mq2 = received.find((q) => q.cmd === 'measure_tags');
check('interior_takeoff by_room: asks the bridge for rooms', mq2 && mq2.params.by_room === true, JSON.stringify(mq2 && mq2.params));
check('interior_takeoff by_room: FL-01 split per room in its unit, the rooms adding up to the row (20.004 + 4.3416 -> 20.01 + 4.34 = 24.35)', row('FL-01 Engineered oak floor 12mm').by_room
  && row('FL-01 Engineered oak floor 12mm').by_room['Living room'] === 20.01 && row('FL-01 Engineered oak floor 12mm').by_room['Level 2 / Bedroom 1'] === 4.34
  && row('FL-01 Engineered oak floor 12mm').quantity === 24.35, r.txt);
check('interior_takeoff by_room: counts per room, objects outside rooms under "(no room)" listed last', row('FN-01 Sofa').by_room['Living room'] === 2
  && row('SK-01 Oak skirting 80mm').by_room['(no room)'] === 15.23 && boq.rooms[boq.rooms.length - 1] === '(no room)', JSON.stringify(boq.rooms) + r.txt);
check('interior_takeoff by_room: rooms in natural order (Bedroom 2 before Bedroom 10)', boq.rooms.indexOf('Bedroom 2') >= 0
  && boq.rooms.indexOf('Bedroom 2') < boq.rooms.indexOf('Bedroom 10'), JSON.stringify(boq.rooms));
check('interior_takeoff: max_thickness_mm sent to the bridge (default 600)', mq2 && mq2.params.max_thickness_mm === 600, JSON.stringify(mq2 && mq2.params));
behaviours.set('measure_tags', [{ reply: { ...MT_REPLY, rooms: undefined } }]);
r = await S.tool('interior_takeoff', { by_room: true });
check('interior_takeoff by_room with an old bridge (no rooms) -> asks to update the bridge', r.isError && r.txt.includes('install_sketchup_bridge'), r.txt);
const roomCsv = path.join(appdata, 'boq', 'rooms.csv');
behaviours.set('measure_tags', [{ reply: MT_REPLY }]);
r = await S.tool('interior_takeoff', { by_room: true, csv_path: roomCsv, language: 'vi' });
const rc = fs.existsSync(roomCsv) ? fs.readFileSync(roomCsv, 'utf8').split('\r\n') : [];
check('interior_takeoff by_room csv: one column per room after Tổng, then Cách đo, Diễn giải and Cảnh báo; last line says it comes from software', !r.isError
  && rc[0] === BOM + 'Mã,Tag,Hạng mục,Đơn vị,Tổng,Bedroom 2,Bedroom 10,Level 2 / Bedroom 1,Living room,(chưa có phòng),Cách đo,Diễn giải,Cảnh báo'
  && rc.some((l) => l.startsWith('FL-01,') && l.includes(',24.35,,,4.34,20.01,,')) && rc.some((l) => l.startsWith('Khối lượng đo bằng phần mềm')), rc.slice(0, 3).join(' | '));
const csvCells = (line) => { let n = 1; let q = false; for (const ch of line) { if (ch === '"') q = !q; else if (ch === ',' && !q) n++; } return n; };
check('interior_takeoff by_room csv: every line has as many cells as the header', rc.filter(Boolean).every((l) => csvCells(l) === csvCells(rc[0])),
  rc.map(csvCells).join(','));
received.length = 0;
await S.tool('make_group', { entity_ids: [3, '4'], name: 'Living room' });
await S.tool('make_group', { entity_ids: [3], name: 'Skirting', tag: 'SK-01 Oak skirting' });
const mg = received.filter((q) => q.cmd === 'make_group');
check('make_group: room without tag -> no tag_style; with a standard tag -> tag_style', mg[0] && JSON.stringify(mg[0].params.entity_ids) === '[3,4]'
  && !('tag_style' in mg[0].params) && mg[1] && mg[1].params.tag_style && mg[1].params.tag_style.folder === 'SK Skirting', JSON.stringify(mg.map((q) => q.params)));
r = await S.tool('make_group', { name: 'x' });
check('make_group without entity_ids -> validation error', r.isError, r.txt);
const csvFile = path.join(appdata, 'boq', 'takeoff.csv');
behaviours.set('measure_tags', [{ reply: MT_REPLY }]);
r = await S.tool('interior_takeoff', { csv_path: csvFile, csv_format: 'semicolon', language: 'vi' });
const csv = fs.existsSync(csvFile) ? fs.readFileSync(csvFile, 'utf8') : '';
check('interior_takeoff csv: written with BOM, Vietnamese headers, ";" and decimal comma', !r.isError && csv.startsWith(BOM + 'Mã;Tag;')
  && csv.includes(';24,35;') && csv.includes('\r\n'), r.txt + ' | ' + csv.slice(0, 120));
received.length = 0;
r = await S.tool('interior_takeoff', { csv_path: csvFile });
check('interior_takeoff csv: existing file is not replaced without overwrite, and the bridge is not asked first', r.isError
  && r.txt.includes('overwrite=true') && !received.some((q) => q.cmd === 'measure_tags'), r.txt);
behaviours.set('measure_tags', [{ reply: MT_REPLY }]);
r = await S.tool('interior_takeoff', { csv_path: csvFile, overwrite: true });
check('interior_takeoff csv: overwrite=true replaces it (comma format)', !r.isError && fs.readFileSync(csvFile, 'utf8').startsWith(BOM + 'Code,Tag,'), r.txt);
r = await S.tool('interior_takeoff', { csv_path: 'boq.csv' });
check('interior_takeoff csv: relative path -> error', r.isError && r.txt.includes('absolute path'), r.txt);
r = await S.tool('interior_takeoff', { csv_path: path.join(appdata, 'boq', 'takeoff.skp') });
check('interior_takeoff csv: only .csv files are written', r.isError && r.txt.includes('.csv'), r.txt);
if (process.platform === 'win32') {
  r = await S.tool('interior_takeoff', { csv_path: '/BOQ/takeoff.csv' });
  check('interior_takeoff csv: Windows path without a drive letter -> error', r.isError && r.txt.includes('drive letter'), r.txt);
  behaviours.set('measure_tags', [{ reply: MT_REPLY }]);
  r = await S.tool('interior_takeoff', { csv_path: '//no-such-server-sumcp/share/boq.csv' });
  check('interior_takeoff csv: UNC path accepted; a write failure keeps the BOQ and reports csv.error', !r.isError
    && JSON.parse(r.txt).rows.length > 0 && JSON.parse(r.txt).csv && JSON.parse(r.txt).csv.error, r.txt.slice(0, 300));
}

// 19: create_room (tag styles, language guess, labels)
received.length = 0;
r = await S.tool('create_room', {
  name: 'Phòng khách', points: [[0, 0], [5000, 0], [5000, 4000], [0, 4000]], height: 2800,
  floor: { tag: 'FL-01 Sàn gỗ' }, walls: { tag: 'WL-01 Sơn trắng', by_edge: { 2: { tag: 'WL-02 Ốp gỗ' } } },
  openings: [{ edge: 1, offset: 500, width: 900, height: 2100, tag: 'DR-01 Cửa gỗ' }],
});
let cr = received.find((q) => q.cmd === 'create_room');
check('create_room: tag_styles for every standard tag (also by_edge and openings)', cr && cr.params.tag_styles
  && ['FL-01 Sàn gỗ', 'WL-01 Sơn trắng', 'WL-02 Ốp gỗ', 'DR-01 Cửa gỗ'].every((t) => cr.params.tag_styles[t] && cr.params.tag_styles[t].folder_code),
  JSON.stringify(cr && cr.params.tag_styles));
check('create_room: Vietnamese room name -> language vi; defaults level 0', cr && cr.params.language === 'vi' && cr.params.level === 0
  && cr.params.openings[0].sill === 0, JSON.stringify(cr && cr.params));
received.length = 0;
await S.tool('create_room', { name: 'Wohnzimmer', points: [[0, 0], [3000, 0], [3000, 3000]], labels: { wall: 'Wand' } });
cr = received.find((q) => q.cmd === 'create_room');
check('create_room: other languages -> en + custom labels passed', cr && cr.params.language === 'en' && cr.params.labels.wall === 'Wand', JSON.stringify(cr && cr.params));
r = await S.tool('create_room', { name: 'x', points: [[0, 0], [1, 0]] });
check('create_room: fewer than 3 points -> validation error', r.isError, r.txt);
r = await S.tool('create_room', { name: 'x', points: [[0, 0], [1000, 0], [0, 1000]], openings: [{ edge: 0, width: 900, height: 2100 }] });
check('create_room: edge numbers start at 1', r.isError, r.txt);

// 20: check_model messages
behaviours.set('check_model', [{ reply: {
  summary: { length_unit: 'inch', saved: false, max_nesting: 8, file_mb: null },
  raw_top_faces: 12,
  untagged_geometry: { count: 1, in: [{ id: 5, name: 'Table', faces: 6 }] },
  raw_tagged: { count: 3, in: [{ id: 7, name: 'Wall', count: 3 }] },
  inside_out: { count: 1, items: [{ id: 8, name: 'Box', definition: 'Box' }] },
  duplicates: { count: 1, items: [{ id: 9, same_as: 4, name: 'Chair', in: '(top level)' }] },
  stray_edges: { count: 4, in: [{ id: null, name: '(top level)', edges: 4 }] }, tiny_edges: 2,
  unused: { definitions: ['Old'], definitions_n: 1, materials: [], materials_n: 0, tags: ['Temp'], tags_n: 1 },
  heavy_textures: [{ name: 'Marble', px: [8000, 8000] }], heavy_definitions: [],
  hidden: { objects: 2, tags: ['CL-01 Ceiling'] },
  tags_in_use: ['FL-01 Oak', 'Walls', 'ZZ-01 Odd'], purged: null,
} }]);
r = await S.tool('check_model', {});
const hm = JSON.parse(r.txt);
const hid = (id) => hm.issues.find((i) => i.id === id);
check('check_model: warnings first, with messages naming ids', !r.isError && hm.issues[0].severity === 'warning' && hid('duplicates')
  && hid('duplicates').message.includes('copy of id 4') && hid('inside_out').message.includes('Box (id 8)'), r.txt);
check('check_model: tag naming and unknown codes from the tag standard', hid('tag_names') && hid('tag_names').message.includes('Walls')
  && hid('unknown_codes') && hid('unknown_codes').message.includes('ZZ-01 Odd') && !hid('tag_names').message.includes('FL-01'), r.txt);
check('check_model: units, nesting, never saved, unused, textures reported as info', ['units', 'nesting', 'not_saved', 'unused', 'heavy_textures', 'hidden']
  .every((k) => hid(k) && hid(k).severity === 'info') && hm.counts.warning === 5, JSON.stringify(hm.counts));
check('check_model: is read only (no purge parameter is sent)', received.some((q) => q.cmd === 'check_model' && !('purge' in q.params)
  && !('purge_only' in q.params)), JSON.stringify(received.map((q) => q.params)));
received.length = 0;
behaviours.set('check_model', [{ reply: { purged: { definitions: 1, materials: 0, tags: 1 } } }]);
r = await S.tool('purge_unused', {});
check('purge_unused: sends purge_only to the bridge and reports what was removed', received.some((q) => q.cmd === 'check_model'
  && q.params.purge_only === true) && JSON.parse(r.txt).purged.tags === 1, r.txt);
behaviours.set('check_model', [{ hang: true }]);
r = await S.tool('purge_unused', {});
check('purge_unused timeout -> "MAY HAVE ALREADY RUN" (not the read-only hint)', r.isError && r.txt.includes('MAY HAVE ALREADY RUN')
  && !r.txt.includes('does not modify the model'), r.txt);
const listed = await S.rpc('tools/list', {});
const ann = (n) => (listed.result.tools.find((t) => t.name === n) || {}).annotations || {};
check('annotations: check_model read only; purge_unused and create_scenes destructive', ann('check_model').readOnlyHint === true
  && ann('purge_unused').destructiveHint === true && ann('create_scenes').destructiveHint === true, JSON.stringify([ann('check_model'), ann('create_scenes')]));

// 20b: strict schemas, by_edge keys, language
r = await S.tool('create_room', { name: 'x', points: [[0, 0], [3000, 0], [3000, 3000]], openings: [{ edge: 1, width: 900, height: 1200, sill_mm: 900 }] });
check('create_room: a misspelt key (sill_mm) is an error, not silently dropped', r.isError && /sill_mm/.test(r.txt), r.txt);
r = await S.tool('create_room', { name: 'x', points: [[0, 0], [3000, 0], [3000, 3000]], walls: { tag: 'WL-01', by_edge: { north: { tag: 'WL-02' } } } });
check('create_room: by_edge keys must be edge numbers', r.isError, r.txt);
r = await S.tool('create_room', { name: 'x', points: [[0, 0], [3000, 0], [3000, 3000]], floor: { thickness_mm: 20 } });
check('create_room: floor.thickness_mm (unknown key) -> error', r.isError, r.txt);
received.length = 0;
await S.tool('create_room', { name: 'Bucătărie', points: [[0, 0], [3000, 0], [3000, 3000]], floor: { tag: 'FL-01 Gresie' } });
await S.tool('create_room', { name: 'Living', points: [[0, 0], [3000, 0], [3000, 3000]], floor: { tag: 'FL-01 Oak' }, language: 'vi' });
const crs = received.filter((q) => q.cmd === 'create_room');
check('create_room: Romanian "Bucătărie" is not taken for Vietnamese', crs[0] && crs[0].params.language === 'en'
  && crs[0].params.tag_styles['FL-01 Gresie'].folder === 'FL Floor finishes', JSON.stringify(crs[0] && crs[0].params));
check('create_room: explicit language=vi also names the tag folders in Vietnamese', crs[1] && crs[1].params.tag_styles['FL-01 Oak'].folder === 'FL Sàn',
  JSON.stringify(crs[1] && crs[1].params.tag_styles));

// 21: create_scenes forwarding
received.length = 0;
await S.tool('create_scenes', { kinds: ['plan', 'elevations'], labels: { plan: 'Grundriss', elevation: 'Ansicht' } });
const cs = received.find((q) => q.cmd === 'create_scenes');
check('create_scenes: kinds, cut height, standard codes and labels (elevation -> elev)', cs && JSON.stringify(cs.params.kinds) === '["plan","elevations"]'
  && cs.params.cut_height === 1200 && cs.params.codes.ceiling_show.includes('CL') && cs.params.labels.elev === 'Ansicht'
  && cs.params.labels.plan === 'Grundriss' && cs.params.replace === true, JSON.stringify(cs && cs.params));

// 22: check_design messages and limits
received.length = 0;
behaviours.set('check_design', [{ reply: {
  issues: [
    { check: 'ceiling_height', severity: 'error', room: 'Bedroom', value_mm: 2350, limit_mm: 2400, objects: [] },
    { check: 'clash', severity: 'warning', room: 'Living', value_mm: 120, limit_mm: 10,
      objects: [{ id: 1, name: 'Sofa', tag: 'FN-01 Sofa' }, { id: 2, name: 'Living - wall 1', tag: 'WL-01 Paint' }] },
  ], objects_checked: 12, rooms: ['Bedroom', 'Living', 'Kitchen'], hidden: [],
  kitchen_items: [
    { id: 21, name: 'Piano cottura 60', def: 'Hob IT', tag: 'EQ-01 Hob', code: 'EQ', room: 'Kitchen', x_mm: 0, y_mm: 0 },
    { id: 22, name: 'Abwasch links', def: 'x', tag: 'SN-01 Sink', code: 'SN', room: 'Kitchen', x_mm: 3000, y_mm: 0 },
    { id: 23, name: 'TỦ LẠNH Samsung', def: 'x', tag: 'EQ-02 Fridge', code: 'EQ', room: 'Kitchen', x_mm: 3000, y_mm: 6000 },
    { id: 24, name: 'Placard', def: 'Wardrobe', tag: 'JN-01', code: 'JN', room: 'Kitchen', x_mm: 50, y_mm: 50 },
  ],
} }]);
r = await S.tool('check_design', { limits: { min_passage_mm: 900 }, kitchen_words: { sink: ['Abwasch'] } });
const dsg = JSON.parse(r.txt);
const cd = received.find((q) => q.cmd === 'check_design');
check('check_design: default limits merged with overrides; generic ceiling default 2400', cd && cd.params.limits.min_passage_mm === 900
  && cd.params.limits.min_ceiling_height_mm === 2400 && dsg.limits.min_passage_mm === 900, JSON.stringify(cd && cd.params.limits));
const tri = dsg.issues.find((i) => i.check === 'kitchen_triangle');
check('check_design: kitchen triangle from whole words in any language ("Piano cottura" = hob, not sink "pia"; "TỦ LẠNH"; extra word "Abwasch")',
  tri && tri.objects.map((o) => o.id).join() === '22,21,23' && tri.value_mm === 3000 + 6708 + 6000, JSON.stringify(tri));
check('check_design: messages and counts', dsg.issues[1].message === 'Sofa (FN-01 Sofa, id 1) and Living - wall 1 (WL-01 Paint, id 2) overlap by 120 mm.'
  && dsg.issues[0].message.includes('2350 mm') && tri && tri.message.includes('3600-7900') && dsg.counts.clash === 1, r.txt);
r = await S.tool('check_design', { limits: { kitchen_triangle_mm: [7900, 3600] } });
check('check_design: kitchen_triangle_mm min > max -> validation error', r.isError, r.txt);
r = await S.tool('check_design', { limits: { min_ceiling_height: 2600 } });
check('check_design: misspelt limit (no _mm) -> error, not ignored', r.isError, r.txt);

// 22b: sliding words, kitchen sink preference, open sides, purge keep codes, section tag label
received.length = 0;
behaviours.set('check_design', [{ reply: {
  issues: [], objects_checked: 5, rooms: ['Kitchen'], hidden: [],
  kitchen_items: [
    { id: 31, name: 'Sink cabinet 800', def: 'x', tag: 'JN-01 Base units', code: 'JN', room: 'Kitchen', x_mm: 0, y_mm: 0 },
    { id: 32, name: 'Kitchen sink', def: 'x', tag: 'SN-01 Sink', code: 'SN', room: 'Kitchen', x_mm: 1000, y_mm: 0 },
    { id: 33, name: 'Hob', def: 'x', tag: 'EQ-01 Hob', code: 'EQ', room: 'Kitchen', x_mm: 9000, y_mm: 0 },
    { id: 34, name: 'Fridge', def: 'x', tag: 'EQ-02 Fridge', code: 'EQ', room: 'Kitchen', x_mm: 9000, y_mm: 9000 },
    { id: 35, name: 'Sink', def: 'x', tag: 'SN-02', code: 'SN', room: '', x_mm: 0, y_mm: 0 },
    { id: 36, name: 'Hob', def: 'x', tag: 'EQ-01', code: 'EQ', room: '', x_mm: 0, y_mm: 0 },
    { id: 37, name: 'Fridge', def: 'x', tag: 'EQ-02', code: 'EQ', room: '', x_mm: 0, y_mm: 0 },
  ],
} }]);
r = await S.tool('check_design', { sliding_words: ['Hebeschiebetür'] });
const dsg2 = JSON.parse(r.txt);
const cd2 = received.find((q) => q.cmd === 'check_design');
check('check_design: sliding words (built-in + extra, lower case) are sent to the bridge', cd2 && cd2.params.sliding_words.includes('lùa')
  && cd2.params.sliding_words.includes('hebeschiebetür'), JSON.stringify(cd2 && cd2.params.sliding_words));
const tri2 = dsg2.issues.filter((i) => i.check === 'kitchen_triangle');
check('check_design: the SN-tagged sink is preferred over a cabinet named "sink"; items with no room are skipped',
  tri2.length === 1 && tri2[0].objects[0].id === 32, JSON.stringify(tri2));
received.length = 0;
await S.tool('create_room', { name: 'Hall', points: [[0, 0], [3000, 0], [3000, 3000], [0, 3000]], walls: { tag: 'WL-01 Paint', by_edge: { 4: { none: true } } } });
cr = received.find((q) => q.cmd === 'create_room');
check('create_room: by_edge {"4": {"none": true}} is forwarded (open side)', cr && cr.params.walls.by_edge['4'].none === true, JSON.stringify(cr && cr.params.walls));
received.length = 0;
behaviours.set('check_model', [{ reply: { purged: { definitions: 0, materials: 0, tags: 0 } } }, { reply: { purged: { definitions: 0, materials: 0, tags: 0 } } }]);
await S.tool('purge_unused', {});
await S.tool('purge_unused', { keep_standard_tags: false });
const pu = received.filter((q) => q.cmd === 'check_model');
check('purge_unused: keeps the standard codes by default, none with keep_standard_tags=false', pu.length === 2
  && ['FL', 'WL', 'CL', 'RF'].every((c) => pu[0].params.keep_codes.includes(c)) && pu[1].params.keep_codes.length === 0, JSON.stringify(pu.map((q) => q.params)));
received.length = 0;
await S.tool('create_scenes', { labels: { section_tag: 'Schnitte' } });
const cs2 = received.find((q) => q.cmd === 'create_scenes');
check('create_scenes: labels.section_tag -> sections', cs2 && cs2.params.labels.sections === 'Schnitte' && !('elev' in cs2.params.labels), JSON.stringify(cs2 && cs2.params));
r = await S.tool('create_scenes', { labels: { sections: 'Schnitte' } });
check('create_scenes: unknown label key -> error', r.isError, r.txt);

// 22c: kitchen matching (compounds, digits, tags, hoods), not-checked notes, Vietnamese word list, check_model kept tags
const kitchenRoom = (room, list) => list.map(([id, name, tag, code, x, y]) => ({ id, name, def: '', tag, code, room, x_mm: x, y_mm: y }));
behaviours.set('check_design', [{ reply: {
  issues: [], objects_checked: 9, rooms: ['Küche', 'Kitchen', 'Bath', 'Galley'], hidden: [], not_checked: ['Ceiling height not checked in Bath: no FL object.'],
  kitchen_items: [
    ...kitchenRoom('Küche', [[41, 'Edelstahlspüle', 'SN-01', 'SN', 0, 0], [42, 'Induktionskochfeld', 'EQ-01', 'EQ', 9000, 0], [43, 'Einbaukühlschrank', 'EQ-02', 'EQ', 9000, 9000]]),
    ...kitchenRoom('Kitchen', [[51, 'Franke 123', 'SN-01 Kitchen sink', 'SN', 0, 0], [52, 'Range hood', 'EQ-03 Hood', 'EQ', 100, 100],
      [53, 'Hob2', 'EQ-01', 'EQ', 9000, 0], [54, 'Fridge1', 'EQ-02', 'EQ', 9000, 9000]]),
    ...kitchenRoom('Bath', [[61, 'Sink', 'SN-05 Basin', 'SN', 0, 0]]),
    ...kitchenRoom('Galley', [[71, 'Sink', 'SN-01', 'SN', 0, 0], [72, 'Stove', 'EQ-01', 'EQ', 900, 0]]),
  ],
} }]);
r = await S.tool('check_design', {});
const dsg3 = JSON.parse(r.txt);
const triOf = (room) => dsg3.issues.find((i) => i.check === 'kitchen_triangle' && i.room === room);
check('kitchen: German compounds (Edelstahlspüle, Induktionskochfeld, Einbaukühlschrank)', triOf('Küche')
  && triOf('Küche').objects.map((o) => o.id).join() === '41,42,43', JSON.stringify(dsg3.issues));
check('kitchen: sink found by its tag, "Range hood" is not the hob, digits split words (Hob2, Fridge1)', triOf('Kitchen')
  && triOf('Kitchen').objects.map((o) => o.id).join() === '51,53,54', JSON.stringify(triOf('Kitchen')));
check('kitchen: a hob without a fridge -> not_checked note; a bathroom sink alone -> nothing; bridge notes kept',
  dsg3.not_checked && dsg3.not_checked.some((n) => n.includes('Galley') && n.includes('no fridge')) && !dsg3.not_checked.some((n) => n.startsWith('Kitchen work triangle not checked in Bath'))
  && dsg3.not_checked.includes('Ceiling height not checked in Bath: no FL object.') && /not_checked/.test(dsg3.notes[0]), JSON.stringify(dsg3.not_checked));
received.length = 0;
await S.tool('create_room', { name: 'Phòng khách', points: [[0, 0], [3000, 0], [3000, 3000]], floor: { tag: 'FL-01 Oak' } });
cr = received.find((q) => q.cmd === 'create_room');
check('create_room: "Phòng khách" alone (no Vietnamese-only letters) -> vi by the word list', cr && cr.params.language === 'vi', JSON.stringify(cr && cr.params));
received.length = 0;
await S.tool('setup_tags', { tags: ['LT-01 Đèn downlight', 'FL-03 Sàn đá'] });
ct = received.find((q) => q.cmd === 'create_tags');
check('setup_tags: "Đèn", "đá" -> Vietnamese folders', ct && ct.params.tags[0].folder === 'LT Đèn' && ct.params.tags[1].folder === 'FL Sàn',
  JSON.stringify(ct && ct.params.tags));
received.length = 0;
behaviours.set('check_model', [{ reply: { unused: { definitions: [], definitions_n: 0, materials: [], materials_n: 0, tags: ['FL-01 Oak', 'Temp'], tags_n: 2, tags_standard_n: 1 } } }]);
r = await S.tool('check_model', {});
const um = JSON.parse(r.txt).issues.find((i) => i.id === 'unused');
check('check_model: standard codes sent; empty standard tags that purge keeps are counted apart', received.some((q) => q.cmd === 'check_model'
  && q.params.keep_codes && q.params.keep_codes.includes('FL')) && um && um.message.includes('1 of them empty standard tags'), JSON.stringify(um));

// 23 (1.4.1): opening types, run_ruby options, export options, decomposed (NFD) tag names
received.length = 0;
await S.tool('create_room', { name: 'Lobby', points: [[0, 0], [6000, 0], [6000, 4000], [0, 4000]], height: 2800,
  openings: [{ edge: 3, offset: 900, width: 4600, height: 2800, tag: 'GL-01 Glass wall' }, { edge: 1, width: 900, height: 2100, type: 'opening' }],
  labels: { glass: 'Glaswand' } });
cr = received.find((q) => q.cmd === 'create_room');
check('create_room: opening type and GL tag forwarded (glass folder style, labels.glass)', cr && cr.params.openings[1].type === 'opening'
  && cr.params.tag_styles['GL-01 Glass wall'] && cr.params.tag_styles['GL-01 Glass wall'].folder_code === 'GL' && cr.params.labels.glass === 'Glaswand',
JSON.stringify(cr && cr.params));
r = await S.tool('create_room', { name: 'x', points: [[0, 0], [3000, 0], [3000, 3000]], openings: [{ edge: 1, width: 900, height: 2100, type: 'arch' }] });
check('create_room: unknown opening type -> validation error', r.isError, r.txt);
const listed2 = await S.rpc('tools/list', {});
const toolDesc = (n) => (listed2.result.tools.find((t) => t.name === n) || {}).description || '';
check('create_room: description says edges count from 1 and the parts have their own axes', /numbered from 1: edge 1 runs from point 1 to point 2/.test(toolDesc('create_room'))
  && /own axes/.test(toolDesc('create_room')), toolDesc('create_room'));
received.length = 0;
behaviours.set('run_ruby', [{ reply: { result: '1', stdout: '' } }, { reply: { deferred: true, id: 1 } }]);
await S.tool('run_ruby', { code: '1' });
await S.tool('run_ruby', { code: 'render', deferred: true, undo_step: false });
const rr = received.filter((q) => q.cmd === 'run_ruby');
check('run_ruby: undo_step true / deferred false by default; both forwarded', rr.length === 2 && rr[0].params.undo_step === true
  && rr[0].params.deferred === false && rr[1].params.deferred === true && rr[1].params.undo_step === false, JSON.stringify(rr.map((q) => q.params)));
received.length = 0;
behaviours.set('export_file', [{ reply: { ok: true } }]);
await S.tool('export_file', { path: 'D:/x/model.obj', options: { swap_yz: true, units: 'm' } });
const ef = received.find((q) => q.cmd === 'export_file');
check('export_file: bake_materials on by default, exporter options forwarded', ef && ef.params.bake_materials === true
  && ef.params.options.swap_yz === true && ef.params.options.units === 'm', JSON.stringify(ef && ef.params));
const nfdTag = 'CL-01 Tấm trần'.normalize('NFD');
behaviours.set('measure_tags', [{ reply: { tags: [mt(nfdTag, { count: 4, plan_area_m2: 2, length_m: 9 })], untagged: [], rooms: [], hidden: [], excluded: {}, selection_only: false } }]);
r = await S.tool('interior_takeoff', { measures: { ['CL-01 Tấm trần'.normalize('NFC')]: 'length' } });
const nb = JSON.parse(r.txt);
check('interior_takeoff: a measures key typed in NFC matches a tag stored decomposed (NFD)', nb.rows[0] && nb.rows[0].measured_as === 'length'
  && !(nb.warnings || []).some((w) => /matching no tag/.test(w)), JSON.stringify([nb.rows[0], nb.warnings]));

// 24 (1.5.0): insert_furniture, export_for_render
received.length = 0;
behaviours.set('insert_furniture', [{ reply: { id: 9, type: 'potted_tree_ficus' } }]);
await S.tool('insert_furniture', { type: 'potted_tree_ficus', position: [500, 400, 0], size: { height: 1800 }, tag: 'DE-01 Cây ficus',
  materials: { leaf: 'Lá xanh đậm' } });
const fu = received.find((q) => q.cmd === 'insert_furniture');
check('insert_furniture: type, size, materials forwarded; Vietnamese names -> vi and a DE tag style', fu && fu.params.type === 'potted_tree_ficus'
  && fu.params.size.height === 1800 && fu.params.materials.leaf === 'Lá xanh đậm' && fu.params.language === 'vi'
  && fu.params.tag_style && fu.params.tag_style.folder_code === 'DE' && fu.params.rotation_deg === 0 && fu.params.decor === false,
JSON.stringify(fu && fu.params));
r = await S.tool('insert_furniture', { type: 'sofa_track_arm', size: { length: 2000 } });
check('insert_furniture: unknown size key -> validation error', r.isError, r.txt);
r = await S.tool('insert_furniture', { type: 'armchair' });
check('insert_furniture: unknown type -> validation error', r.isError, r.txt);
const rdir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumcp-render-'));
behaviours.set('export_for_render', [{ reply: {
  folder: rdir, name: 'Show room', obj: path.join(rdir, 'Show room.obj'), mtl: path.join(rdir, 'Show room.mtl'), units: 'm', up_axis: 'Y',
  faces_given_inherited_material: 12, size_bytes: 100,
  cameras: [{ name: '01 Lối vào', eye: [900, 180, 1600], target: [3800, 5200, 950], up: [0, 0, 1], fov: 72, perspective: true, height_mm: null, aspect: 1.7778, hidden_tags: [] },
    { name: 'Plan', eye: [0, 0, 9000], target: [0, 0, 0], up: [0, 1, 0], fov: null, perspective: false, height_mm: 8000, aspect: 1.5, hidden_tags: ['CL-01'] }],
  lights: [{ name: 'Downlight', tag: 'LT-01 Downlight', room: 'Lobby', center: [1000, 1000, 2790], plan_size: [90, 90], yaw: 0, bottom: 2785, top: 2800 }],
  missing_scenes: ['Old'],
} }]);
r = await S.tool('export_for_render', { folder: rdir, scenes: ['01 Lối vào', 'Plan', 'Old'] });
const exr = JSON.parse(r.txt);
const camsFile = JSON.parse(fs.readFileSync(path.join(rdir, 'Show room_cameras.json'), 'utf8'));
const lightsFile = JSON.parse(fs.readFileSync(path.join(rdir, 'Show room_lights.json'), 'utf8'));
const py = fs.readFileSync(path.join(rdir, 'Show room_blender.py'), 'utf8');
check('export_for_render: <name>_cameras.json and <name>_lights.json written; script points at the OBJ and the .blend', !r.isError && camsFile.length === 2
  && camsFile[0].name === '01 Lối vào' && lightsFile[0].tag === 'LT-01 Downlight' && py.includes(JSON.stringify(path.join(rdir, 'Show room.obj')))
  && py.includes(JSON.stringify(path.join(rdir, 'Show room.blend'))) && exr.run.includes('Show room_blender.py') && exr.missing_scenes[0] === 'Old', r.txt);
const pyc = spawnSync('python', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read())', path.join(rdir, 'Show room_blender.py')], { encoding: 'utf8' });
check('export_for_render: the Blender script is valid Python (skipped when python is missing)', pyc.error ? true : pyc.status === 0, pyc.stderr || String(pyc.error));
fs.rmSync(rdir, { recursive: true, force: true });
r = await S.tool('export_for_render', { folder: 'render/out' });
check('export_for_render: a relative folder is refused (SketchUp and the server would not agree on it)', r.isError, r.txt);

// 25 (1.6.0): interior_takeoff on real surfaces - breakdown, openings, rule sets, warnings, cross-checks
const op = (n, a, sn, sa) => ({ n, area_m2: a, small_n: sn, small_area_m2: sa });
const none = { plan: op(0, 0, 0, 0), wall: op(0, 0, 0, 0), sheet: op(0, 0, 0, 0) };
const mt16 = (tag, o = {}) => mt(tag, { up_area_m2: 0, down_area_m2: 0, rise_up_m2: 0, rise_down_m2: 0, sides_low_m2: 0, sides_tall_m2: 0,
  reveal_m2: 0, openings: none, wrapped: [], overlaps: [], overlap_n: 0, uncut: [], uncut_n: 0, ...o });
const R16 = {
  tags: [
    mt16('FL-02 Stone stair', { count: 1, plan_area_m2: 4.37, up_area_m2: 4.05, down_area_m2: 4.75, rise_up_m2: 2.72, sides_low_m2: 0.3,
      sides_tall_m2: 5.5, wall_area_m2: 0.5, sheet_area_m2: 0.5, uneven_sides: [{ id: 3, name: 'Tread', size_mm: [1000, 270, 30], sides_m2: [0.27, 0.2] }] }),
    mt16('CL-01 Gypsum ceiling', { count: 1, plan_area_m2: 20, up_area_m2: 20, down_area_m2: 20, rise_down_m2: 3.96, sides_tall_m2: 1,
      overlap_n: 1, overlaps: [{ id: 9, name: 'Board B', size_mm: [4000, 5000, 9], on: { id: 8, name: 'Board A' } }] }),
    mt16('WL-01 Paint', { count: 4, wall_area_m2: 13.51, sheet_area_m2: 14.01, reveal_m2: 1.12,
      openings: { ...none, wall: op(2, 2.09, 1, 0.2) }, uncut_n: 1,
      uncut: [{ id: 30, name: 'Door D2', tag: 'DR-02 Door', wall: { id: 31, name: 'Wall 4', size_mm: [4000, 2800, 10] } }] }),
    mt16('PA-01 Partition', { count: 1, wall_area_m2: 10, sheet_area_m2: 10, reveal_m2: 2 }),
    mt16('FN-01 Sofa', { count: 2 }),
  ],
  rooms: [
    { ...mt16('FL-02 Stone stair', { up_area_m2: 4.05, plan_area_m2: 4.37, rise_up_m2: 2.72, sides_low_m2: 0.3, wall_area_m2: 0.5 }), room: 'Hall' },
    { ...mt16('CL-01 Gypsum ceiling', { down_area_m2: 20, plan_area_m2: 20, rise_down_m2: 3.96, sides_tall_m2: 1 }), room: 'Hall' },
    { ...mt16('WL-01 Paint', { wall_area_m2: 13.51, sheet_area_m2: 14.01, reveal_m2: 1.12, openings: { ...none, wall: op(2, 2.09, 1, 0.2) } }), room: 'Hall' },
  ],
  room_records: [{ room: 'Hall', floor_area_m2: 4.05, ceiling_area_m2: 20, wall_area_net_m2: 46.71 }],
  untagged: [], hidden: [], excluded: {}, selection_only: false,
};
received.length = 0;
behaviours.set('measure_tags', [{ reply: R16 }]);
r = await S.tool('interior_takeoff', {});
boq = JSON.parse(r.txt);
let mq16 = received.find((q) => q.cmd === 'measure_tags');
check('takeoff 1.6: the bridge gets the deduction threshold (0), the door codes and the area/length codes (not FN)', mq16
  && mq16.params.min_deduction_m2 === 0 && JSON.stringify(mq16.params.opening_codes) === '["DR","WN"]'
  && mq16.params.real_codes.includes('FL') && mq16.params.real_codes.includes('SK') && !mq16.params.real_codes.includes('FN')
  && mq16.params.detail === false, JSON.stringify(mq16 && mq16.params));
const fl2 = row('FL-02 Stone stair');
check('takeoff 1.6: floor = surfaces looking up + risers + low fronts + upright boards (4.05 + 2.72 + 0.3 + 0.5 = 7.57)', fl2.quantity === 7.57
  && fl2.main_m2 === 4.05 && fl2.vertical_m2 === 3.52 && /4\.05 \+ vertical parts 3\.52/.test(fl2.workings), JSON.stringify(fl2));
check('takeoff 1.6: tall exposed sides of a floor piece are not included, and said so; uneven sides warned on floors too',
  (fl2.warnings || []).some((w) => /5\.5 m² of exposed vertical sides taller than 400 mm/.test(w)) && (fl2.warnings || []).some((w) => /two sides differ/.test(w)), JSON.stringify(fl2.warnings));
const cl1 = row('CL-01 Gypsum ceiling');
check('takeoff 1.6: ceiling = undersides + drops + exposed fascias (20 + 3.96 + 1 = 24.96); a finish drawn twice is warned', cl1.quantity === 24.96
  && cl1.vertical_m2 === 4.96 && (cl1.warnings || []).some((w) => /counted twice/.test(w) && w.includes('Board B (id 9) on Board A (id 8)')), JSON.stringify(cl1));
const wl1 = row('WL-01 Paint');
check('takeoff 1.6: wall finish = one side + returns/reveals + flat pieces (13.51 + 1.12 + 0.5 = 15.13); gross 15.6 - 2.09 deducted', wl1.quantity === 15.13
  && wl1.main_m2 === 13.51 && wl1.reveals_m2 === 1.62 && wl1.gross_m2 === 15.6 && wl1.deducted_m2 === 2.09 && wl1.openings === 2
  && wl1.not_deducted_m2 === undefined && /gross 15\.6 - openings 2\.09 \(2\) = 13\.51 \+ returns and reveals 1\.62/.test(wl1.workings), JSON.stringify(wl1));
check('takeoff 1.6: a door standing in an uncut wall is warned', (wl1.warnings || []).some((w) => /NOT deducted/.test(w) && w.includes('Door D2 (DR-02 Door, id 30) in Wall 4 (id 31)')), JSON.stringify(wl1.warnings));
check('takeoff 1.6: partitions stay one side only (reveals not added)', row('PA-01 Partition').quantity === 10 && row('PA-01 Partition').reveals_m2 === undefined, JSON.stringify(row('PA-01 Partition')));
check('takeoff 1.6: cross-checks - floor against ceiling, and what create_room built against what is measured', (boq.checks || []).some((c) => /Hall: floor 4\.05 m², ceiling 20 m²/.test(c))
  && (boq.checks || []).some((c) => /Hall: create_room built 46\.71 m² of wall finish, the model now measures 13\.51 m²/.test(c))
  && !(boq.checks || []).some((c) => /of floor finish/.test(c)), JSON.stringify(boq.checks));
check('takeoff 1.6: says the quantities come from software, and which rules were used', /measured by software/.test(boq.notes[0])
  && boq.rules.surfaces === 'real' && boq.rules.min_deduction_m2 === 0 && boq.rules.decimals === 2, JSON.stringify([boq.notes[0], boq.rules]));
received.length = 0;
behaviours.set('measure_tags', [{ reply: R16 }]);
r = await S.tool('interior_takeoff', { rules: 'vn', by_room: true, detail: true });
boq = JSON.parse(r.txt);
mq16 = received.find((q) => q.cmd === 'measure_tags');
const wlv = row('WL-01 Paint');
check('takeoff 1.6 rules=vn: threshold 0.25 sent; the small opening stays in (13.51 + 0.2 + 1.62 = 15.33), 1.89 deducted, 3 decimals', mq16
  && mq16.params.min_deduction_m2 === 0.25 && mq16.params.detail === true && wlv.quantity === 15.33 && wlv.deducted_m2 === 1.89
  && wlv.not_deducted_m2 === 0.2 && wlv.not_deducted === 1 && boq.rules.decimals === 3 && boq.rules.set === 'vn'
  && /small openings not deducted 0\.2 \(1\)/.test(wlv.workings), JSON.stringify([mq16 && mq16.params, wlv, boq.rules]));
check('takeoff 1.6 by_room: the room value uses the same rules as the row', wlv.by_room && wlv.by_room.Hall === 15.33, JSON.stringify(wlv.by_room));
behaviours.set('measure_tags', [{ reply: R16 }]);
r = await S.tool('interior_takeoff', { surfaces: 'main', decimals: 3 });
boq = JSON.parse(r.txt);
check('takeoff 1.6 surfaces=main: the quantities of 1.5 (plan area, one side), no vertical parts or reveals', row('FL-02 Stone stair').quantity === 4.37
  && row('CL-01 Gypsum ceiling').quantity === 20 && row('WL-01 Paint').quantity === 13.51 && row('WL-01 Paint').reveals_m2 === undefined, r.txt.slice(0, 600));
received.length = 0;
behaviours.set('measure_tags', [{ reply: R16 }]);
await S.tool('interior_takeoff', { measures: { FN: 'plan_area' } });
mq16 = received.find((q) => q.cmd === 'measure_tags');
check('takeoff 1.6: a tag given an area unit by hand -> surfaces worked out for every tag', mq16 && !('real_codes' in mq16.params), JSON.stringify(mq16 && mq16.params));
const csv16 = path.join(appdata, 'boq', 'v16.csv');
behaviours.set('measure_tags', [{ reply: R16 }]);
r = await S.tool('interior_takeoff', { csv_path: csv16, csv_format: 'semicolon', rules: 'vn', language: 'vi' });
const c16 = fs.existsSync(csv16) ? fs.readFileSync(csv16, 'utf8').split('\r\n') : [];
check('takeoff 1.6 csv: workings, gross, deducted, openings, not deducted columns; decimal commas in the workings; footer as wide as the table',
  c16[0] && c16[0].includes(';Diễn giải;') && c16[0].includes(';Tổng trước khi trừ (m²);Đã trừ (m²);Số ô mở;Không trừ (m²);')
  && c16.some((l) => l.startsWith('WL-01;') && l.includes('tổng 15,6 - ô mở 2,09 (2) = 13,51') && l.includes(';15,6;1,89;2;0,2;1,62;'))
  && c16.filter(Boolean).every((l) => l.split(';').length === c16[0].split(';').length) && c16.some((l) => l.startsWith('Khối lượng đo bằng phần mềm')),
  c16.slice(0, 5).join(' | '));
received.length = 0;
await S.tool('create_room', { name: 'Study', points: [[0, 0], [3000, 0], [3000, 3000], [0, 3000]], walls: { tag: 'WL-01 Paint' },
  openings: [{ edge: 1, width: 900, height: 2100, reveal: 200, tag: 'DR-01 Door' }], labels: { reveal: 'Laibung' } });
cr = received.find((q) => q.cmd === 'create_room');
check('create_room: opening reveal depth and its label forwarded', cr && cr.params.openings[0].reveal === 200 && cr.params.labels.reveal === 'Laibung', JSON.stringify(cr && cr.params));

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

// Live test against a running SketchUp (Windows). It only runs in a NEW, EMPTY, UNSAVED model and removes everything it
// creates (entities, tags, folders, materials, components, scenes, styles); it never uses undo on your model.
//   1. Open SketchUp with a new empty model (File > New), do not save it.
//   2. npm run build, then: node scripts/live-test.mjs [out-dir]
// It installs the bridge of this build into SketchUp and loads it without a restart. Blender (optional, for the
// export_for_render check): set BLENDER to blender.exe, else %LOCALAPPDATA%/Programs/Blender/*/blender.exe is used.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, '..', 'dist', 'bundle', 'server', 'index.mjs');
const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'sumcp-live-'));
fs.mkdirSync(OUT, { recursive: true });
const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version;

// ---------------------------------------------------------------- MCP client over stdio
function startServer(entry) {
  const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, SKETCHUP_MCP_TIMEOUT: '300' } });
  child.stderr.on('data', () => {});
  let buf = '';
  const pending = new Map();
  let id = 0;
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      pending.get(m.id)?.(m);
      pending.delete(m.id);
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const rid = ++id;
    const t = setTimeout(() => reject(new Error(`rpc timeout ${method}`)), 400_000);
    pending.set(rid, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }) + '\n');
  });
  const tool = async (name, args = {}) => {
    const m = await rpc('tools/call', { name, arguments: args });
    const content = (m.result && m.result.content) || [];
    const txt = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    let json;
    try { json = JSON.parse(txt); } catch { json = undefined; }
    return { content, txt, json, isError: !!(m.result && m.result.isError) || !!m.error };
  };
  return { child, rpc, tool };
}

const S = startServer(ENTRY);
await S.rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'live-test', version: '1' } });
S.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${String(detail).slice(0, 900)}`}`);
};
const near = (a, b, tol) => typeof a === 'number' && Math.abs(a - b) <= tol;
const must = async (name, args) => {
  const r = await S.tool(name, args);
  if (r.isError) throw new Error(`${name} failed: ${r.txt}`);
  return r.json;
};
const ruby = async (code, extra = {}) => must('run_ruby', { code, ...extra });
const rubyJson = async (code) => JSON.parse((await ruby(code)).stdout.trim().split(/\r?\n/).pop());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name) => {
  const s = await S.tool('screenshot', { max_size: 900 });
  const img = s.content.find((c) => c.type === 'image');
  if (img) fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(img.data, 'base64'));
};

// A tiny PNG (8x8 checker) to give a material a texture.
function png(file) {
  const w = 8;
  const raw = Buffer.alloc((w * 3 + 1) * w);
  for (let y = 0; y < w; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const v = (x + y) % 2 ? 200 : 60;
      raw.set([v, v, 120], y * (w * 3 + 1) + 1 + x * 3);
    }
  }
  const crc = (b) => {
    let c = ~0;
    for (const x of b) {
      c ^= x;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(w, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

// ---------------------------------------------------------------- guard, install, snapshot
const info0 = await must('model_info');
const ping0 = await must('ping');
console.log('model:', JSON.stringify({ title: info0.title, path: info0.path, total: info0.top_level.total, bridge: ping0.bridge, sketchup: ping0.sketchup }));
if (info0.path || info0.top_level.total > 0 || (info0.scenes || []).length) {
  console.log('ABORT: the open model is not a new, empty, unsaved model - nothing was changed.');
  S.child.kill();
  process.exit(2);
}
await must('install_sketchup_bridge', { versions: ['20' + String(ping0.sketchup).split('.')[0]] });
await ruby(`old = $VERBOSE; $VERBOSE = nil
begin
  load File.join(Sketchup.find_support_file('Plugins'), 'su_mcp', 'main.rb')
ensure
  $VERBOSE = old
end
KhuongDoan::SuMcp::VERSION`);
const ping1 = await must('ping');
check(`bridge ${VERSION} loaded`, ping1.bridge === VERSION && !ping1.warning, JSON.stringify(ping1));
const before = await rubyJson(`m = Sketchup.active_model
puts({ 'tags' => m.layers.map(&:name), 'folders' => (m.layers.respond_to?(:folders) ? m.layers.folders.map(&:name) : []),
  'mats' => m.materials.map(&:name), 'defs' => m.definitions.map(&:name), 'styles' => m.styles.map(&:name),
  'style' => m.styles.selected_style.name, 'trans' => m.options['PageOptions']['ShowTransition'] }.to_json)`);

try {
  // ---------------------------------------------------------------- create_room: full-height glass wall, types
  const lobby = await must('create_room', {
    name: 'Lobby', points: [[0, 0], [6000, 0], [6000, 4000], [0, 4000]], height: 2800,
    floor: { tag: 'FL-01 Live floor' }, walls: { tag: 'WL-01 Live paint' }, ceiling: { tag: 'CL-01 Live ceiling' },
    skirting: { tag: 'SK-01 Live skirting' },
    openings: [
      { edge: 3, offset: 900, width: 4600, height: 2800, tag: 'GL-01 Live glass wall' },
      { edge: 1, offset: 500, width: 900, height: 2100, tag: 'DR-01 Live door' },
      { edge: 2, offset: 500, width: 1200, height: 2800, type: 'opening' },
    ],
  });
  const kinds = lobby.parts.map((x) => x.kind);
  check('create_room: GL tag -> glass pane, DR -> door, type opening -> no part', kinds.filter((k) => k === 'glass').length === 1
    && kinds.filter((k) => k === 'door').length === 1 && kinds.filter((k) => k === 'opening').length === 0, JSON.stringify(lobby.parts));
  const boq = await must('interior_takeoff', {});
  const row = (t) => boq.rows.find((x) => x.tag === t) || {};
  // 2 x (6 + 4) x 2.8 = 56; minus 4.6 x 2.8 (glass, full height), 0.9 x 2.1 (door), 1.2 x 2.8 (opening) = 37.87
  check('create_room: full-height openings are cut through the wall finish (WL-01 = 37.87 m2)', near(row('WL-01 Live paint').quantity, 37.87, 0.05),
    JSON.stringify(row('WL-01 Live paint')));
  check('takeoff: one glass pane and one door counted', row('GL-01 Live glass wall').quantity !== undefined && row('DR-01 Live door').quantity === 1,
    JSON.stringify([row('GL-01 Live glass wall'), row('DR-01 Live door')]));
  // a room reported from a real project, moved 20 m along X: door 0-900 and a glass wall 900-5500
  // floor to ceiling on edge 3 leave only the strip above the door
  const fx = (p) => [p[0] + 20000, p[1]];
  const fw = await must('create_room', {
    name: 'Phòng trưng bày', height: 2800, language: 'vi', walls: { tag: 'WL-05 Live showroom paint' },
    points: [[0, 200], [200, 200], [200, 0], [5700, 0], [5700, 200], [6200, 200], [6200, 0], [6800, 0], [6800, 5750], [0, 5750]].map(fx),
    openings: [
      { edge: 3, offset: 0, width: 900, height: 2100, sill: 0, tag: 'DR-01 Live door', name: 'D4A' },
      { edge: 3, offset: 900, width: 4600, height: 2800, sill: 0, tag: 'GL-01 Live glass wall', name: 'Vách kính Nam' },
      { edge: 9, offset: 2850, width: 2000, height: 1500, sill: 900, tag: 'WN-01 Live window', name: 'S1' },
    ],
  });
  const glassPart = fw.parts.find((x) => x.name.includes('Vách kính Nam'));
  const boqF = await must('interior_takeoff', {});
  const wl5 = (boqF.rows.find((x) => x.tag === 'WL-05 Live showroom paint') || {}).quantity;
  // 25.5 m x 2.8 = 71.4, minus door 1.89, glass 12.88, window 3.0, plus 3 reflex-corner runs of 10 mm = 53.71
  check('create_room (reported case): door + floor-to-ceiling glass on one wall both cut (WL-05 = 53.71 m2)', near(wl5, 53.71, 0.1), String(wl5));
  const gm = await rubyJson(`e = Sketchup.active_model.find_entity_by_id(${glassPart ? glassPart.id : 0})
puts({ 'mat' => e && e.material ? e.material.display_name : nil, 'alpha' => e && e.material ? e.material.alpha.round(2) : nil }.to_json)`);
  const walls = [...lobby.parts, ...fw.parts].filter((x) => x.kind === 'wall').map((x) => x.id);
  const solid = await rubyJson(`m = Sketchup.active_model
bad = [${walls.join(', ')}].map { |id| g = m.find_entity_by_id(id); [g.name, g.definition.entities.grep(Sketchup::Edge).count { |e| e.faces.size != 2 }] }.reject { |_, n| n.zero? }
puts({ 'bad' => bad }.to_json)`);
  check('create_room: every wall panel is a clean solid (window in the middle, full-height openings)', solid.bad.length === 0, JSON.stringify(solid.bad));
  check('create_room: the glass wall is a glass pane with a see-through glass material', glassPart && glassPart.kind === 'glass'
    && gm.mat === 'Kính trong' && gm.alpha < 0.5, JSON.stringify([glassPart, gm]));
  await must('set_view', { view: 'iso' });
  await shot('room_glass_wall');

  // ---------------------------------------------------------------- names in another Unicode form (NFD)
  const nfd = await rubyJson(`m = Sketchup.active_model
mat = m.materials.add('CL-01 Tấm trần tiêu âm'.unicode_normalize(:nfd))
tag = m.layers.add('CL-02 Trần gỗ'.unicode_normalize(:nfd))
puts({ 'mats' => m.materials.size, 'tags' => m.layers.size, 'nfd' => mat.name.bytesize }.to_json)`);
  const box = await must('create_box', { width: 300, depth: 300, height: 300, origin: [8000, 0, 0],
    material: 'CL-01 Tấm trần tiêu âm'.normalize('NFC'), tag: 'CL-02 Trần gỗ'.normalize('NFC') });
  const st = await must('setup_tags', { tags: ['CL-02 Trần gỗ'.normalize('NFC')] });
  const nfd2 = await rubyJson(`m = Sketchup.active_model; puts({ 'mats' => m.materials.size, 'tags' => m.layers.size }.to_json)`);
  check('names stored decomposed (NFD) are found when typed composed (NFC): no duplicate material or tag', nfd2.mats === nfd.mats && nfd2.tags === nfd.tags
    && st.tags[0].created === false && box.tag && box.tag.normalize('NFC') === 'CL-02 Trần gỗ'.normalize('NFC'), JSON.stringify([nfd, nfd2, st, box.tag]));

  // ---------------------------------------------------------------- run_ruby: no Undo step, deferred
  const nu = await ruby('Sketchup.active_model.entities.size', { undo_step: false });
  check('run_ruby undo_step=false runs and returns', /\d+/.test(nu.result), JSON.stringify(nu));
  const df = await ruby('sleep 1; 6 * 7', { deferred: true });
  let ds;
  for (let i = 0; i < 20; i++) {
    await wait(500);
    ds = await rubyJson('puts KhuongDoan::SuMcp.deferred_status.to_json');
    if (ds && ds.state !== 'scheduled' && ds.state !== 'running') break;
  }
  check('run_ruby deferred=true answers at once, runs afterwards, result in deferred_status', df.deferred === true && ds && ds.state === 'done' && ds.result === '42',
    JSON.stringify([df, ds]));

  // ---------------------------------------------------------------- export_file: inherited textures, model unchanged
  const tex = path.join(OUT, 'checker.png');
  png(tex);
  await rubyJson(`m = Sketchup.active_model
mt = m.materials.add('Live checker'); mt.texture = ${JSON.stringify(tex)}; mt.texture.size = [200.mm, 200.mm]
red = m.materials.add('Live red'); red.color = Sketchup::Color.new(200, 30, 30)
g = m.entities.add_group; f = g.entities.add_face([10000.mm, 0, 0], [11000.mm, 0, 0], [11000.mm, 1000.mm, 0], [10000.mm, 1000.mm, 0])
f.reverse! if f.normal.z < 0; f.pushpull(500.mm); g.material = mt; g.name = 'Live textured box'
c = m.entities.add_group; c.entities.add_face([12000.mm, 0, 0], [12500.mm, 0, 0], [12500.mm, 500.mm, 0]).pushpull(-300.mm)
inst = c.to_component; inst.definition.name = 'Live comp'; inst.material = mt
i2 = m.entities.add_instance(inst.definition, Geom::Transformation.new(Geom::Point3d.new(1000.mm, 0, 0)) * inst.transformation); i2.material = red
puts({ 'ok' => true }.to_json)`);
  const state0 = await rubyJson(`m = Sketchup.active_model; d = m.definitions['Live comp']
puts({ 'defs' => m.definitions.size, 'painted' => d.entities.grep(Sketchup::Face).count { |f| f.material } }.to_json)`);
  const objPath = path.join(OUT, 'export', 'live.obj');
  const ex = await must('export_file', { path: objPath, options: { units: 'm', swap_yz: true } });
  const mtl = fs.readFileSync(objPath.replace(/\.obj$/, '.mtl'), 'utf8');
  const obj = fs.readFileSync(objPath, 'utf8');
  const state1 = await rubyJson(`m = Sketchup.active_model; d = m.definitions['Live comp']
puts({ 'defs' => m.definitions.size, 'painted' => d.entities.grep(Sketchup::Face).count { |f| f.material } }.to_json)`);
  check('export_file OBJ: a texture inherited from a group is exported (map_Kd, UVs)', /newmtl Live_checker[\s\S]*?map_Kd/.test(mtl) && /\nvt /.test(obj)
    && ex.faces_given_inherited_material > 0, mtl.slice(0, 600));
  check('export_file OBJ: two instances of one component with different materials keep both', /usemtl Live_red/.test(obj) && (obj.match(/usemtl Live_checker/g) || []).length >= 1,
    obj.match(/usemtl .*/g)?.slice(0, 20).join(' '));
  check('export_file: the model is unchanged afterwards (no new component, faces not painted)', JSON.stringify(state0) === JSON.stringify(state1),
    JSON.stringify([state0, state1]));
  const fbx = await S.tool('export_file', { path: path.join(OUT, 'export', 'live.fbx') });
  console.log('fbx:', fbx.isError ? fbx.txt.slice(0, 200) : JSON.stringify({ size: fbx.json.size_bytes, warning: fbx.json.warning || null }));

  // ---------------------------------------------------------------- export_png: locked file -> clear error
  const locked = path.join(OUT, 'locked.png');
  fs.writeFileSync(locked, 'x');
  const lock = spawn('powershell', ['-NoProfile', '-Command',
    `$f=[System.IO.File]::Open('${locked.replace(/'/g, "''")}','Open','ReadWrite','None'); Start-Sleep -Seconds 30; $f.Close()`]);
  await wait(2500);
  const lk = await S.tool('export_png', { path: locked, width: 200, height: 150, overwrite: true });
  lock.kill();
  check('export_png: a file locked by another program gives a clear error', lk.isError && /could not write/i.test(lk.txt), lk.txt.slice(0, 400));
  const nolk = await S.tool('export_png', { path: path.join(OUT, 'locked.png'), width: 200, height: 150 });
  check('1.6.1 export_png: an existing file is not replaced without overwrite=true', nolk.isError && /already exists/.test(nolk.txt), nolk.txt.slice(0, 300));

  // ---------------------------------------------------------------- insert_furniture
  const fu = {};
  fu.sofa = await must('insert_furniture', { type: 'sofa_track_arm', position: [3000, 3300, 0], rotation_deg: 180, tag: 'FN-01 Live sofa' });
  fu.chair = await must('insert_furniture', { type: 'swivel_lounge_chair', position: [1200, 1500, 0], tag: 'FN-02 Live chair' });
  fu.table = await must('insert_furniture', { type: 'round_glass_coffee_table', position: [3000, 2000, 0], tag: 'FN-03 Live table', decor: true });
  fu.plant = await must('insert_furniture', { type: 'potted_tree_ficus', position: [5400, 3400, 0], tag: 'DE-01 Live ficus' });
  fu.pillow = await must('insert_furniture', { type: 'pillow', position: [8000, 2000, 0], tag: 'DE-02 Live pillow', size: { width: 500 } });
  const sz = (k) => fu[k].bounds_mm.size.map((v) => Math.round(v));
  check('insert_furniture: sofa 2200 x 950, back 820 high with the pillows a little above (turned 180 degrees)', near(sz('sofa')[0], 2200, 40) && near(sz('sofa')[1], 950, 60) && near(sz('sofa')[2], 904, 30),
    JSON.stringify(sz('sofa')));
  check('insert_furniture: coffee table 900 across and about 430 high (magazines on top)', near(sz('table')[0], 900, 30) && near(sz('table')[2], 448, 25), JSON.stringify(sz('table')));
  check('insert_furniture: ficus about 2 m high with about 360 leaves of one component', near(sz('plant')[2], 2050, 250) && fu.plant.leaves > 300,
    JSON.stringify([sz('plant'), fu.plant.leaves]));
  check('insert_furniture: chair 780 across, pillow 500 wide', near(sz('chair')[0], 780, 10) && near(sz('pillow')[0], 500, 20), JSON.stringify([sz('chair'), sz('pillow')]));
  const boq2 = await must('interior_takeoff', {});
  const r2 = (t) => (boq2.rows.find((x) => x.tag === t) || {}).quantity;
  check('insert_furniture: each piece is one item in the takeoff', r2('FN-01 Live sofa') === 1 && r2('FN-03 Live table') === 1 && r2('DE-01 Live ficus') === 1,
    JSON.stringify(boq2.rows.map((x) => [x.tag, x.quantity])));
  const loose = await rubyJson(`m = Sketchup.active_model
n = 0; m.definitions.each { |d| n += d.entities.grep(Sketchup::Edge).count { |e| e.faces.empty? } unless d.image? }
puts({ 'loose_edges' => n }.to_json)`);
  check('insert_furniture: meshes leave no loose edges', loose.loose_edges === 0, JSON.stringify(loose));
  await must('set_view', { view: 'iso' });
  await shot('furniture');

  // ---------------------------------------------------------------- export_for_render (+ Blender when present)
  await must('setup_tags', { tags: ['LT-01 Live downlight'] });
  await rubyJson(`m = Sketchup.active_model
g = m.entities.add_group; f = g.entities.add_face([2900.mm, 1900.mm, 2780.mm], [3100.mm, 1900.mm, 2780.mm], [3100.mm, 2100.mm, 2780.mm], [2900.mm, 2100.mm, 2780.mm])
f.pushpull(15.mm); g.layer = m.layers.find { |l| l.name == 'LT-01 Live downlight' }; g.name = 'Live light'
v = m.active_view; c = Sketchup::Camera.new([500.mm, 300.mm, 1600.mm], [4500.mm, 3500.mm, 1200.mm], [0, 0, 1]); c.fov = 60; v.camera = c
m.pages.add('Live cam')
puts({ 'ok' => true }.to_json)`);
  // moved drawing axes: the OBJ must stay in world coordinates, as the cameras and lights are
  const minX = (file) => Math.min(...fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.startsWith('v ')).map((l) => Number(l.split(/\s+/)[1])));
  const axA = path.join(OUT, 'export', 'axes_a.obj');
  const axB = path.join(OUT, 'export', 'axes_b.obj');
  await must('export_file', { path: axA, options: { units: 'm', swap_yz: true } });
  await ruby(`Sketchup.active_model.axes.set([1000.mm, 2000.mm, 0], X_AXIS, Y_AXIS, Z_AXIS); true`);
  await must('export_file', { path: axB, options: { units: 'm', swap_yz: true } });
  await ruby(`Sketchup.active_model.axes.set(ORIGIN, X_AXIS, Y_AXIS, Z_AXIS); true`);
  check('export_file: OBJ coordinates do not move with the drawing axes (cameras and lights match)', near(minX(axA), minX(axB), 0.001),
    JSON.stringify([minX(axA), minX(axB)]));
  const rdir = path.join(OUT, 'render');
  const er = await must('export_for_render', { folder: rdir, name: 'live' });
  const cams = JSON.parse(fs.readFileSync(path.join(rdir, 'live_cameras.json'), 'utf8'));
  const lights = JSON.parse(fs.readFileSync(path.join(rdir, 'live_lights.json'), 'utf8'));
  check('export_for_render: OBJ, live_cameras.json (the scene), live_lights.json (the LT fitting), live_blender.py',
    fs.existsSync(path.join(rdir, 'live.obj')) && cams.length === 1 && cams[0].name === 'Live cam' && near(cams[0].fov, 60, 0.5)
    && JSON.stringify(cams[0].eye) === '[500,300,1600]' && lights.length === 1 && near(lights[0].bottom, 2780, 1) && fs.existsSync(er.files.blender_script),
  JSON.stringify([er, cams, lights]));
  const again = await S.tool('export_for_render', { folder: rdir, name: 'live' });
  check('export_for_render: refuses to overwrite without overwrite=true', again.isError && /overwrite/.test(again.txt), again.txt.slice(0, 200));
  const local = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Blender') : '';
  let blender = process.env.BLENDER;
  if (!blender && local && fs.existsSync(local)) {
    const d = fs.readdirSync(local).find((x) => fs.existsSync(path.join(local, x, 'blender.exe')));
    if (d) blender = path.join(local, d, 'blender.exe');
  }
  if (blender) {
    const b = spawnSync(blender, ['-b', '-P', er.files.blender_script], { encoding: 'utf8', timeout: 300_000 });
    check('Blender builds the scene from the export (cameras, light, .blend saved)', /SKETCHUP_MCP_BLENDER_OK .* 1 cameras 1 lights/.test(b.stdout)
      && fs.existsSync(path.join(rdir, 'live.blend')), (b.stdout || '').slice(-600) + (b.stderr || '').slice(-600));
  } else {
    console.log('SKIP  Blender not found (set BLENDER to blender.exe to check the import script)');
  }

  // ---------------------------------------------------------------- 1.6: quantities on the real surfaces
  // every case on its own tag, 20 m away along Y, built by hand so that the expected figures are known
  await ruby(`m = Sketchup.active_model
y0 = 20000
tg = lambda { |n| m.layers[n] || m.layers.add(n) }
pt = lambda { |x, y, z| Geom::Point3d.new(x.mm, y.mm, z.mm) }
grp = lambda { |ents, name, tag| g = ents.add_group; g.name = name; g.layer = tag ? tg.call(tag) : m.layers[0]; g }
rect = lambda { |ents, x0, ya, x1, yb, z| ents.add_face(pt.call(x0, ya, z), pt.call(x1, ya, z), pt.call(x1, yb, z), pt.call(x0, yb, z)) }
box = lambda do |ents, x0, ya, z0, w, d, h|
  f = rect.call(ents, x0, ya, x0 + w, ya + d, z0)
  f.reverse! if f.normal.z < 0
  f.pushpull(h.mm)
end
out = lambda { |f, d| f.pushpull(f.normal.y > 0 ? d.mm : -d.mm) } # a face in an XZ plane, pushed towards +Y
stepped = lambda do |e, x0|
  # a solid 600 deep, flat on top, its underside stepped: band 600 wide at 2500, centre at 2800
  box.call(e, x0, y0, 2500, 4000, 5000, 600)
  rect.call(e, x0 + 600, y0 + 600, x0 + 3400, y0 + 4400, 2500)
  c = e.grep(Sketchup::Face).find { |f| f.normal.z.abs > 0.9 && f.bounds.max.z.to_mm.round == 2500 && (f.area - 2800.mm * 3800.mm).abs < 1 }
  c.pushpull(c.normal.z < 0 ? -300.mm : 300.mm)
end

# T1 a stepped ceiling drawn as a single skin (faces not all turned the same way)
e = grp.call(m.entities, 'T1 stepped skin', 'CL-11 T skin').entities
rect.call(e, 0, y0, 4000, y0 + 5000, 2500)
rect.call(e, 600, y0 + 600, 3400, y0 + 4400, 2500).erase!
rect.call(e, 600, y0 + 600, 3400, y0 + 4400, 2800).reverse!
[[600, 600, 3400, 600], [3400, 600, 3400, 4400], [3400, 4400, 600, 4400], [600, 4400, 600, 600]].each do |xa, ya, xb, yb|
  e.add_face(pt.call(xa, y0 + ya, 2500), pt.call(xb, y0 + yb, 2500), pt.call(xb, y0 + yb, 2800), pt.call(xa, y0 + ya, 2800))
end
# T2 the same ceiling as a solid
stepped.call(grp.call(m.entities, 'T2 stepped solid', 'CL-12 T solid').entities, 5000)
# T3 a stair of boards (15 treads 270 x 1000, 16 risers 170 high) and T3b the stair as one solid (15 treads, 15 risers)
g = grp.call(m.entities, 'T3 stair boards', 'FL-11 T stair boards')
15.times { |k| box.call(g.entities.add_group.entities, 10000 + k * 270, y0, (k + 1) * 170 - 25, 270, 1000, 25) }
16.times { |k| box.call(g.entities.add_group.entities, 10000 + k * 270 - 20, y0, k * 170, 20, 1000, 170) }
prof = [[0, 0]]
15.times { |k| prof << [k * 270, (k + 1) * 170] << [(k + 1) * 270, (k + 1) * 170] }
prof << [15 * 270, 15 * 170 - 300] << [300, 0]
out.call(grp.call(m.entities, 'T3b stair solid', 'FL-12 T stair solid').entities.add_face(prof.map { |x, z| pt.call(16000 + x, y0, z) }), 1000)
# the floor it stands on (not behind its top end): its first riser and its flanks look into the room
box.call(grp.call(m.entities, 'T3b floor', 'FL-19 T stair floor').entities, 15500, y0 - 500, -12, 4550, 2000, 12)
# T4 a wall drawn as a skin with a niche 1000 x 1500, 250 deep
e = grp.call(m.entities, 'T4 wall niche', 'WL-11 T niche').entities
e.add_face(pt.call(22000, y0, 0), pt.call(26000, y0, 0), pt.call(26000, y0, 2700), pt.call(22000, y0, 2700))
e.add_face(pt.call(23000, y0, 600), pt.call(24000, y0, 600), pt.call(24000, y0, 2100), pt.call(23000, y0, 2100)).erase!
e.add_face(pt.call(23000, y0 + 250, 600), pt.call(24000, y0 + 250, 600), pt.call(24000, y0 + 250, 2100), pt.call(23000, y0 + 250, 2100))
[[23000, 600, 24000, 600], [24000, 600, 24000, 2100], [24000, 2100, 23000, 2100], [23000, 2100, 23000, 600]].each do |xa, za, xb, zb|
  e.add_face(pt.call(xa, y0, za), pt.call(xb, y0, zb), pt.call(xb, y0 + 250, zb), pt.call(xa, y0 + 250, za))
end
# T5 a wall board 4000 x 2700 with a door notch 900 x 2100 and a hole 400 x 500
e = grp.call(m.entities, 'T5 wall holes', 'WL-12 T holes').entities
e.add_face([[0, 0], [1000, 0], [1000, 2100], [1900, 2100], [1900, 0], [4000, 0], [4000, 2700], [0, 2700]].map { |x, z| pt.call(27000 + x, y0, z) })
e.add_face(pt.call(29500, y0, 1000), pt.call(29900, y0, 1000), pt.call(29900, y0, 1500), pt.call(29500, y0, 1500)).erase!
out.call(e.grep(Sketchup::Face).first, 10)
# T6 a door standing in a wall board that is not cut
out.call(grp.call(m.entities, 'T6 uncut wall', 'WL-13 T uncut').entities.add_face(pt.call(32000, y0, 0), pt.call(35000, y0, 0), pt.call(35000, y0, 2700), pt.call(32000, y0, 2700)), 10)
box.call(grp.call(m.entities, 'T6 door', 'DR-11 T door').entities, 33000, y0 - 15, 0, 900, 40, 2100)
# T7 a skirting board running up a stair: 4000 going, 2500 rise
out.call(grp.call(m.entities, 'T7 raked skirting', 'SK-11 T raked').entities.add_face(pt.call(36000, y0, 0), pt.call(40000, y0, 2500), pt.call(40000, y0, 2580), pt.call(36000, y0, 80)), 12)
# T8 a skirting run 4000 long with two 200 returns, one solid; T8b three boards round a wall end 600 x 100; T8c a board and its cap
f = grp.call(m.entities, 'T8 skirting returns', 'SK-12 T returns').entities.add_face(
  [[0, -200], [12, -200], [12, 0], [3988, 0], [3988, -200], [4000, -200], [4000, 12], [0, 12]].map { |x, y| pt.call(41000 + x, y0 + y, 0) })
f.reverse! if f.normal.z < 0
f.pushpull(80.mm)
g = grp.call(m.entities, 'T8b skirting nib', 'SK-13 T nib')
[[46000, 0, 600, 12], [46000, 112, 600, 12], [46600, 12, 12, 100]].each { |x, dy, w, d| box.call(g.entities.add_group.entities, x, y0 + dy, 0, w, d, 80) }
g = grp.call(m.entities, 'T8c skirting cap', 'SK-14 T cap')
box.call(g.entities.add_group.entities, 48000, y0, 0, 3000, 12, 80)
box.call(g.entities.add_group.entities, 48000, y0, 80, 3000, 20, 10)
# T9 a casing wrapped round a column 400 x 400 (a skin, open top and bottom)
e = grp.call(m.entities, 'T9 column casing', 'WL-16 T casing').entities
[[0, 0, 400, 0], [400, 0, 400, 400], [400, 400, 0, 400], [0, 400, 0, 0]].each do |xa, ya, xb, yb|
  e.add_face(pt.call(52000 + xa, y0 + ya, 0), pt.call(52000 + xb, y0 + yb, 0), pt.call(52000 + xb, y0 + yb, 2700), pt.call(52000 + xa, y0 + ya, 2700))
end
# T10 the same floor board drawn twice
2.times { |k| box.call(grp.call(m.entities, 'T10 board ' + (k + 1).to_s, 'FL-13 T twice').entities, 53500, y0, -12, 2000, 2000, 12) }
# T room: floor, a 300 high platform, the stepped solid ceiling and a box bulkhead along one side
room = m.entities.add_group
room.name = 'T room'
box.call(grp.call(room.entities, 'floor', 'FL-14 T floor').entities, 57000, y0, -12, 4000, 5000, 12)
box.call(grp.call(room.entities, 'platform', 'FL-14 T floor').entities, 58500, y0 + 1500, 0, 1000, 1000, 300)
stepped.call(grp.call(room.entities, 'ceiling', 'CL-13 T ceiling').entities, 57000)
box.call(grp.call(room.entities, 'bulkhead', 'CL-14 T box').entities, 57000, y0, 2200, 600, 5000, 300)
true`);
  const rv = await must('create_room', { name: 'T reveal', points: [[63000, 20000], [67000, 20000], [67000, 23000], [63000, 23000]], height: 2700,
    walls: { tag: 'WL-15 T reveal', thickness: 12 },
    openings: [{ edge: 1, offset: 1000, width: 900, height: 2100, reveal: 200, tag: 'DR-12 T door' },
      { edge: 3, offset: 1000, width: 1200, height: 1200, sill: 900, reveal: 150, tag: 'WN-11 T window' }] });
  const t16 = await must('interior_takeoff', {});
  const q16 = (t) => t16.rows.find((x) => x.tag === t) || {};
  const warn16 = (t) => (q16(t).warnings || []).join(' ');
  check('1.6 stepped ceiling as a single skin: 20.00 flat (was 9.36) + 3.96 of drops = 23.96', near(q16('CL-11 T skin').main_m2, 20, 0.01)
    && near(q16('CL-11 T skin').vertical_m2, 3.96, 0.01) && near(q16('CL-11 T skin').quantity, 23.96, 0.01) && near(q16('CL-11 T skin').plan_area_m2, 20, 0.01),
  JSON.stringify(q16('CL-11 T skin')));
  check('1.6 the same ceiling as a solid: 20.00 + 3.96; its outer sides (no room around) are not counted', near(q16('CL-12 T solid').quantity, 23.96, 0.01)
    && near(q16('CL-12 T solid').main_m2, 20, 0.01), JSON.stringify(q16('CL-12 T solid')));
  check('1.6 stair of boards: treads 4.05 + risers 2.72 = 6.77', near(q16('FL-11 T stair boards').main_m2, 4.05, 0.01) && near(q16('FL-11 T stair boards').quantity, 6.77, 0.01),
    JSON.stringify(q16('FL-11 T stair boards')));
  check('1.6 stair as one solid: treads 4.05 + risers 2.55 = 6.60 (soffit left out; the flanks reported, not included)', near(q16('FL-12 T stair solid').main_m2, 4.05, 0.01)
    && near(q16('FL-12 T stair solid').quantity, 6.6, 0.01) && /exposed vertical sides taller than 400 mm/.test(warn16('FL-12 T stair solid')), JSON.stringify(q16('FL-12 T stair solid')));
  check('1.6 wall skin with a niche: 10.80 (was 1.50) + niche sides 1.25 = 12.05, the niche is not an opening', near(q16('WL-11 T niche').main_m2, 10.8, 0.01)
    && near(q16('WL-11 T niche').reveals_m2, 1.25, 0.01) && near(q16('WL-11 T niche').quantity, 12.05, 0.01) && q16('WL-11 T niche').openings === 0, JSON.stringify(q16('WL-11 T niche')));
  check('1.6 wall with a door and a small hole: gross 10.80 - 2.09 (2 openings) = 8.71', near(q16('WL-12 T holes').gross_m2, 10.8, 0.01) && near(q16('WL-12 T holes').deducted_m2, 2.09, 0.01)
    && q16('WL-12 T holes').openings === 2 && near(q16('WL-12 T holes').quantity, 8.71, 0.01), JSON.stringify(q16('WL-12 T holes')));
  check('1.6 a door standing in an uncut wall is reported', /NOT deducted/.test(warn16('WL-13 T uncut')) && /T6 door/.test(warn16('WL-13 T uncut')), warn16('WL-13 T uncut'));
  check('1.6 skirting up a stair: 4.72 m along the slope (was 4.00)', near(q16('SK-11 T raked').quantity, 4.72, 0.01), JSON.stringify(q16('SK-11 T raked')));
  check('1.6 skirting with two 200 mm returns: 4.40 m (was 4.00)', near(q16('SK-12 T returns').quantity, 4.4, 0.01), JSON.stringify(q16('SK-12 T returns')));
  check('1.6 skirting on both faces of a wall end: 0.6 + 0.6 + 0.1 = 1.30 m (was 0.70); a board and its cap still count once (3.00)',
    near(q16('SK-13 T nib').quantity, 1.3, 0.01) && near(q16('SK-14 T cap').quantity, 3, 0.01), JSON.stringify([q16('SK-13 T nib').quantity, q16('SK-14 T cap').quantity]));
  check('1.6 casing wrapped round a column: every face once, 4.32 m2 (was left out)', near(q16('WL-16 T casing').quantity, 4.32, 0.01) && /wrapped surface/.test(warn16('WL-16 T casing')),
    JSON.stringify(q16('WL-16 T casing')));
  check('1.6 the same board drawn twice is reported', /counted twice/.test(warn16('FL-13 T twice')), warn16('FL-13 T twice'));
  check('1.6 floor with a platform: 20 + 1 on top, + its 4 fronts 300 high = 22.20', near(q16('FL-14 T floor').main_m2, 21, 0.01) && near(q16('FL-14 T floor').quantity, 22.2, 0.01),
    JSON.stringify(q16('FL-14 T floor')));
  check('1.6 box bulkhead in a room: underside 3.00 + the one side looking into the room 1.50 = 4.50', near(q16('CL-14 T box').quantity, 4.5, 0.01), JSON.stringify(q16('CL-14 T box')));
  check('1.6 stepped solid ceiling inside the room: 23.96 (sides against the room edge not counted)', near(q16('CL-13 T ceiling').quantity, 23.96, 0.01), JSON.stringify(q16('CL-13 T ceiling')));
  // reveals of create_room: door 2 x 0.2 x 2.1 + 0.2 x 0.876; window 2 x 0.15 x 1.2 + 2 x 0.15 x 1.176 = 1.728; wall 14 x 2.7 - 1.89 - 1.44 = 34.47
  check('1.6 create_room reveals: jambs, head and sill built and measured (wall 34.47 + reveals 1.73 = 36.20), same as its own figures',
    near(rv.quantities.reveal_area_m2, 1.728, 0.002) && near(q16('WL-15 T reveal').main_m2, 34.47, 0.01) && near(q16('WL-15 T reveal').reveals_m2, 1.73, 0.01)
    && near(q16('WL-15 T reveal').quantity, 36.2, 0.01) && !(t16.checks || []).some((c) => c.includes('T reveal')), JSON.stringify([rv.quantities, q16('WL-15 T reveal'), t16.checks]));
  check('1.6 the rooms create_room built measure what it reported (no difference in the cross-checks)', !(t16.checks || []).some((c) => /create_room built/.test(c)), JSON.stringify(t16.checks));
  const tvn = await must('interior_takeoff', { rules: 'vn' });
  const wvn = tvn.rows.find((x) => x.tag === 'WL-12 T holes') || {};
  check('1.6 rules=vn: the 0.2 m2 hole is not deducted (8.910), the door is (1.890), 3 decimals', near(wvn.quantity, 8.91, 0.001) && near(wvn.deducted_m2, 1.89, 0.001)
    && wvn.not_deducted === 1 && tvn.rules.decimals === 3, JSON.stringify(wvn));
  const tmain = await must('interior_takeoff', { surfaces: 'main' });
  check('1.6 surfaces=main: the flat figures only (ceiling 20.00, stair boards 4.05 + board edges)', near((tmain.rows.find((x) => x.tag === 'CL-11 T skin') || {}).quantity, 20, 0.01)
    && (tmain.rows.find((x) => x.tag === 'FL-11 T stair boards') || {}).quantity < 5, JSON.stringify(tmain.rows.filter((x) => /T skin|T stair boards/.test(x.tag)).map((x) => [x.tag, x.quantity])));
  const cd16 = await must('check_design', { checks: ['ceiling_height'] });
  check('1.6 ceiling height from the real levels: the platform does not raise the floor, the bulkhead does not lower the main ceiling (no issue in T room)',
    !cd16.issues.some((i) => i.room === 'T room'), JSON.stringify(cd16.issues.filter((i) => i.room === 'T room')));
  const cd17 = await must('check_design', { checks: ['ceiling_height'], limits: { min_ceiling_height_mm: 2900, min_local_height_mm: 2300 } });
  const tr = cd17.issues.filter((i) => i.room === 'T room');
  check('1.6 ceiling height: main ceiling 2800 against 2900, lowest part (the box bulkhead) 2200 against 2300', tr.some((i) => i.check === 'ceiling_height' && i.value_mm === 2800)
    && tr.some((i) => i.check === 'ceiling_height_local' && i.value_mm === 2200), JSON.stringify(tr));
  await must('set_view', { view: 'iso' });
  await shot('real_surfaces');

  // ---------------------------------------------------------------- regression: scenes and checks still work
  const sc = await must('create_scenes', { kinds: ['plan', 'ceiling', 'elevations'] });
  check('create_scenes: plan, ceiling plan and the 4 elevations of the four rooms', sc.scenes.length === 18 && sc.ceiling_style, JSON.stringify(sc.scenes.map((x) => x.name)));
  const cm = await must('check_model', {});
  check('check_model runs', Array.isArray(cm.issues), cm && JSON.stringify(cm.counts));
  const cd = await must('check_design', {});
  check('check_design runs', Array.isArray(cd.issues), JSON.stringify(cd.counts));

  // ---------------------------------------------------------------- 1.6.1: cases from the audit of 1.6.0
  await ruby(`m = Sketchup.active_model
y0 = 32000
tg = lambda { |n| m.layers[n] || m.layers.add(n) }
pt = lambda { |x, y, z| Geom::Point3d.new(x.mm, y.mm, z.mm) }
grp = lambda { |name, tag| g = m.entities.add_group; g.name = name; g.layer = tg.call(tag); g }
box = lambda do |ents, x0, ya, z0, w, d, h|
  f = ents.add_face(pt.call(x0, ya, z0), pt.call(x0 + w, ya, z0), pt.call(x0 + w, ya + d, z0), pt.call(x0, ya + d, z0))
  f.reverse! if f.normal.z < 0
  f.pushpull(h.mm)
end
# U1 a bulkhead drawn as an L skin: fascia 4000 x 400, soffit 4000 x 300; U1b with a 150 soffit; U1c a platform skin
[['U1 L bulkhead', 'CL-21 T L skin', 0, 300], ['U1b L bulkhead thin', 'CL-22 T L thin', 5000, 150]].each do |name, tag, x0, d|
  e = grp.call(name, tag).entities
  e.add_face(pt.call(x0, y0, 2300), pt.call(x0 + 4000, y0, 2300), pt.call(x0 + 4000, y0, 2700), pt.call(x0, y0, 2700))
  e.add_face(pt.call(x0, y0, 2300), pt.call(x0 + 4000, y0, 2300), pt.call(x0 + 4000, y0 + d, 2300), pt.call(x0, y0 + d, 2300))
end
e = grp.call('U1c platform skin', 'FL-21 T platform skin').entities
e.add_face(pt.call(10000, y0, 0), pt.call(12000, y0, 0), pt.call(12000, y0, 450), pt.call(10000, y0, 450))
e.add_face(pt.call(10000, y0, 450), pt.call(12000, y0, 450), pt.call(12000, y0 + 300, 450), pt.call(10000, y0 + 300, 450))
# U2 a splayed bay as one skin, 2700 high: 600 at 30 degrees, 2000, 600 at 30 degrees
e = grp.call('U2 splayed bay', 'WL-21 T bay').entities
dx = 600 * Math.cos(30.degrees)
[[0, 300, dx, 0], [dx, 0, dx + 2000, 0], [dx + 2000, 0, 2 * dx + 2000, 300]].each do |xa, ya, xb, yb|
  e.add_face(pt.call(13000 + xa, y0 + ya, 0), pt.call(13000 + xb, y0 + yb, 0), pt.call(13000 + xb, y0 + yb, 2700), pt.call(13000 + xa, y0 + ya, 2700))
end
# U3 a box bulkhead over a floor, and across the room a wall drawn as one face looking away from the room
box.call(grp.call('U3 bulkhead', 'CL-23 T box reversed').entities, 17000, y0, 2400, 4000, 300, 300)
box.call(grp.call('U3 floor', 'FL-29 T floor u3').entities, 17000, y0 + 300, -12, 4000, 3000, 12)
f = grp.call('U3 shell', 'EX-21 T shell').entities.add_face(pt.call(17000, y0 + 3300, 0), pt.call(21000, y0 + 3300, 0), pt.call(21000, y0 + 3300, 2700), pt.call(17000, y0 + 3300, 2700))
f.reverse! if f.normal.y < 0
# U4 a floor finish 50 thick lying on a larger slab (its edges are not steps); U4b a platform 80 high on a floor finish (they are)
box.call(grp.call('U4 thick floor', 'FL-24 T thick').entities, 22500, y0, 0, 4000, 3000, 50)
box.call(grp.call('U4 slab', 'EX-22 T slab').entities, 22000, y0 - 500, -200, 5000, 4000, 200)
box.call(grp.call('U4b floor', 'FL-26 T floor u4').entities, 28000, y0, -12, 3000, 3000, 12)
box.call(grp.call('U4b platform', 'FL-25 T low platform').entities, 29000, y0 + 1000, 0, 1000, 1000, 80)
# U7 a nib of skirting 60 long, 80 high; U8 a threshold strip 2000 x 25 x 10
box.call(grp.call('U7 skirting nib', 'SK-21 T short').entities, 32000, y0, 0, 60, 12, 80)
box.call(grp.call('U8 threshold', 'FL-27 T strip').entities, 33000, y0, 0, 2000, 25, 10)
# U9 a wall board 2000 x 2700 with an opening of exactly 0.25 m2
e = grp.call('U9 wall', 'WL-22 T quarter').entities
e.add_face(pt.call(36000, y0, 0), pt.call(38000, y0, 0), pt.call(38000, y0, 2700), pt.call(36000, y0, 2700))
e.add_face(pt.call(36500, y0, 1000), pt.call(37000, y0, 1000), pt.call(37000, y0, 1500), pt.call(36500, y0, 1500)).erase!
f = e.grep(Sketchup::Face).first
f.pushpull(f.normal.y > 0 ? 10.mm : -10.mm)
true`);
  const wn = await must('create_room', { name: 'T wainscot', points: [[40000, 32000], [43000, 32000], [43000, 35000], [40000, 35000]], height: 2700,
    walls: { tag: 'WL-23 T wainscot', thickness: 12, height: 1200 },
    openings: [{ edge: 1, offset: 1000, width: 900, height: 2100, reveal: 100, tag: 'DR-21 T door' }] });
  const linings = await rubyJson(`n = 0
walk = lambda { |ents| ents.grep(Sketchup::Group).each { |g| n += 1 if g.get_attribute('su_mcp', 'part') == 'reveal'; walk.call(g.entities) } }
walk.call(Sketchup.active_model.entities.grep(Sketchup::Group).find { |g| g.name == 'T wainscot' }.entities)
puts n.to_json`);
  const t161 = await must('interior_takeoff', {});
  const q161 = (t) => t161.rows.find((x) => x.tag === t) || {};
  check('1.6.1 bulkhead as an L skin: soffit 1.20 + fascia 1.60 = 2.80 (was 4.40)', near(q161('CL-21 T L skin').quantity, 2.8, 0.01), JSON.stringify(q161('CL-21 T L skin')));
  check('1.6.1 the same with a 150 soffit: 0.60 + 1.60 = 2.20', near(q161('CL-22 T L thin').quantity, 2.2, 0.01), JSON.stringify(q161('CL-22 T L thin')));
  check('1.6.1 platform as a skin: top 0.60 + front 0.90 = 1.50 (was 2.40)', near(q161('FL-21 T platform skin').quantity, 1.5, 0.01), JSON.stringify(q161('FL-21 T platform skin')));
  check('1.6.1 splayed bay as one skin: 3.2 x 2.7 = 8.64 (was 4.32), not reported as halved', near(q161('WL-21 T bay').quantity, 8.64, 0.01)
    && !/half/.test((q161('WL-21 T bay').warnings || []).join(' ')), JSON.stringify(q161('WL-21 T bay')));
  check('1.6.1 box bulkhead facing a wall drawn inside out: underside 1.20 + fascia 1.20 = 2.40 (was 1.20)', near(q161('CL-23 T box reversed').quantity, 2.4, 0.01), JSON.stringify(q161('CL-23 T box reversed')));
  check('1.6.1 floor finish 50 thick on a larger slab: 12.00, its edges are not steps (was 12.70)', near(q161('FL-24 T thick').quantity, 12, 0.01), JSON.stringify(q161('FL-24 T thick')));
  check('1.6.1 platform 80 high on a floor finish: 1.00 + 4 x 0.08 = 1.32', near(q161('FL-25 T low platform').quantity, 1.32, 0.01), JSON.stringify(q161('FL-25 T low platform')));
  check('1.6.1 skirting nib 60 long, 80 high: 0.06 m (was 0.08)', near(q161('SK-21 T short').quantity, 0.06, 0.005), JSON.stringify(q161('SK-21 T short')));
  check('1.6.1 threshold strip 2000 x 25: 0.05 m2 (was 0)', near(q161('FL-27 T strip').quantity, 0.05, 0.005), JSON.stringify(q161('FL-27 T strip')));
  check('1.6.1 wainscot 1200 with a door 2100 high: two jamb linings, no head board across the doorway (0.24 m2 of reveals)', linings === 2
    && near(wn.quantities.reveal_area_m2, 0.24, 0.005) && !(t161.checks || []).some((c) => c.includes('T wainscot')), JSON.stringify([linings, wn.quantities, t161.checks]));
  // ---------------------------------------------------------------- 1.7: rooms with the same name, run_ruby switch, access token
  await ruby(`m = Sketchup.active_model
2.times do |k|
  room = m.entities.add_group
  room.name = 'T twin'
  g = room.entities.add_group
  g.layer = m.layers['FL-31 T twin'] || m.layers.add('FL-31 T twin')
  f = g.entities.add_face([45000 + k * 3000, 32000, 0].map(&:mm), [47000 + k * 3000, 32000, 0].map(&:mm), [47000 + k * 3000, 34000, 0].map(&:mm), [45000 + k * 3000, 34000, 0].map(&:mm))
  f.reverse! if f.normal.z < 0
end
true`);
  const t17 = await must('interior_takeoff', { by_room: true });
  const twin = t17.rows.find((x) => x.tag === 'FL-31 T twin') || {};
  check('1.7 two room groups with the same name: added together (8.00) and reported', near(twin.quantity, 8, 0.01)
    && (t17.warnings || []).some((w) => w.startsWith('2 room groups are named "T twin"')), JSON.stringify([twin.quantity, t17.warnings]));
  const off = await rubyJson(`b = KhuongDoan::SuMcp
Sketchup.write_default('SuMcp', 'run_ruby', false)
r = begin
  b.cmd_run_ruby('code' => '1 + 1')
  'ran'
rescue ArgumentError => e
  e.message
ensure
  Sketchup.write_default('SuMcp', 'run_ruby', true)
end
puts [r, b.ruby_on?].to_json`);
  check('1.7 run_ruby turned off in SketchUp: refused with a clear message (and turned on again)', /turned off in SketchUp/.test(off[0]) && off[1] === true, JSON.stringify(off));
  const raw = (req) => new Promise((resolve) => {
    const sock = net.createConnection({ host: '127.0.0.1', port: Number(process.env.SKETCHUP_MCP_PORT || 9876) });
    let buf = '';
    sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'));
    sock.on('data', (d) => { buf += d; });
    sock.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve({ ok: false, error: buf }); } });
    sock.on('error', (e) => resolve({ ok: false, error: e.message }));
  });
  const tok = await rubyJson("puts((KhuongDoan::SuMcp.make_token ? true : false).to_json)");
  const noTok = await raw({ id: 1, cmd: 'model_info', params: {} });
  const badTok = await raw({ id: 2, cmd: 'model_info', params: {}, token: 'x' });
  const pingNoTok = await raw({ id: 3, cmd: 'ping', params: {} });
  const withTok = await S.tool('model_info', {});
  check('1.7 access token: a command without the token (or with a wrong one) is refused, ping still answers, the server reads the token and goes on',
    tok === true && !noTok.ok && noTok.code === 'BAD_TOKEN' && badTok.code === 'BAD_TOKEN' && pingNoTok.ok && pingNoTok.result.access_token === true
    && !withTok.isError, JSON.stringify([tok, noTok, badTok, pingNoTok, withTok.txt.slice(0, 200)]));
  const q25 = (await must('interior_takeoff', { rules: 'vn' })).rows.find((x) => x.tag === 'WL-22 T quarter') || {};
  check('1.6.1 rules=vn: an opening of exactly 0.25 m2 is deducted (5.400 - 0.250 = 5.150)', near(q25.quantity, 5.15, 0.001) && near(q25.deducted_m2, 0.25, 0.001) && !q25.not_deducted_m2, JSON.stringify(q25));
} catch (e) {
  fail++;
  console.log('ERROR during the test:', e.message);
} finally {
  // ---------------------------------------------------------------- explicit cleanup (no undo)
  const cleanup = await S.tool('run_ruby', { code: `m = Sketchup.active_model
before = JSON.parse(<<'JSONEND')
${JSON.stringify(before)}
JSONEND
m.active_layer = m.layers[0]
m.pages.to_a.each { |pg| m.pages.erase(pg) }
m.entities.active_section_plane = nil
m.entities.erase_entities(m.entities.to_a)
m.layers.to_a.each { |l| m.layers.remove(l) unless before['tags'].include?(l.name) }
if m.layers.respond_to?(:folders)
  m.layers.folders.to_a.each { |f| m.layers.remove_folder(f) unless before['folders'].include?(f.name) }
end
3.times { m.definitions.to_a.each { |d| m.definitions.remove(d) if !before['defs'].include?(d.name) && d.count_used_instances == 0 } }
m.materials.to_a.each { |x| m.materials.remove(x) unless before['mats'].include?(x.name) }
orig = m.styles.find { |x| x.name == before['style'] }
m.styles.selected_style = orig if orig
m.styles.purge_unused
m.options['PageOptions']['ShowTransition'] = before['trans']
m.axes.set(ORIGIN, X_AXIS, Y_AXIS, Z_AXIS) if m.respond_to?(:axes)
puts({ 'entities' => m.entities.size, 'tags' => m.layers.size, 'pages' => m.pages.size, 'mats' => m.materials.size,
  'defs' => m.definitions.size, 'styles' => m.styles.map(&:name) }.to_json)` });
  const c = JSON.parse(cleanup.json.stdout.trim().split(/\r?\n/).pop());
  check('cleanup: the model is back to the start', c.entities === 0 && c.pages === 0 && c.tags === before.tags.length && c.mats <= before.mats.length
    && c.defs <= before.defs.length && JSON.stringify(c.styles) === JSON.stringify(before.styles), JSON.stringify([c, before]));
  console.log(`\n${pass} PASS, ${fail} FAIL   (images and exports in ${OUT})`);
  S.child.kill();
  process.exit(fail ? 1 : 0);
}

// Live test against a running SketchUp (Windows). It only runs in a NEW, EMPTY, UNSAVED model and removes everything it
// creates (entities, tags, folders, materials, components, scenes, styles); it never uses undo on your model.
//   1. Open SketchUp with a new empty model (File > New), do not save it.
//   2. npm run build, then: node scripts/live-test.mjs [out-dir]
// It installs the bridge of this build into SketchUp and loads it without a restart. Blender (optional, for the
// export_for_render check): set BLENDER to blender.exe, else %LOCALAPPDATA%/Programs/Blender/*/blender.exe is used.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
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
  const lk = await S.tool('export_png', { path: locked, width: 200, height: 150 });
  lock.kill();
  check('export_png: a file locked by another program gives a clear error', lk.isError && /could not write/i.test(lk.txt), lk.txt.slice(0, 400));

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

  // ---------------------------------------------------------------- regression: scenes and checks still work
  const sc = await must('create_scenes', { kinds: ['plan', 'ceiling', 'elevations'] });
  check('create_scenes: plan, ceiling plan and the 4 elevations of the two rooms', sc.scenes.length === 10 && sc.ceiling_style, JSON.stringify(sc.scenes.map((x) => x.name)));
  const cm = await must('check_model', {});
  check('check_model runs', Array.isArray(cm.issues), cm && JSON.stringify(cm.counts));
  const cd = await must('check_design', {});
  check('check_design runs', Array.isArray(cd.issues), JSON.stringify(cd.counts));
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

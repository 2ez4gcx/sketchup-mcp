/**
 * SketchUp MCP server (Node.js), packaged as a Claude Desktop Extension (.mcpb).
 *
 * Claude <-(stdio/MCP)-> this file <-(TCP 127.0.0.1:9876, one-line JSON)-> "SU MCP Bridge" extension in SketchUp.
 *
 * Units: lengths in mm, areas in m2, volumes in m3. Coordinates [x, y, z] are in mm.
 * SketchUp (with the extension installed) must be open before using the tools.
 *
 * Notes for running inside Claude Desktop (built-in Node):
 *  - cwd is NOT the extension folder -> every path is resolved from import.meta.url.
 *  - Claude starts the server twice (once as a "probe") -> do nothing at startup, only connect to SketchUp when a tool is called.
 *  - An uncaught error makes the server exit -> every socket/promise has its errors caught.
 *  - stdout is reserved for the MCP protocol -> log to stderr.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';

/* global __SKETCHUP_MCP_VERSION__, __BRIDGE_VERSION__ */
const VERSION = typeof __SKETCHUP_MCP_VERSION__ !== 'undefined' ? __SKETCHUP_MCP_VERSION__ : '0.0.0-dev';
// Version of the bundled Ruby bridge (build.mjs requires it to match VERSION).
const BRIDGE_VERSION = typeof __BRIDGE_VERSION__ !== 'undefined' ? __BRIDGE_VERSION__ : '0.0.0-dev';
const HERE = path.dirname(fileURLToPath(import.meta.url));

// Hint shown when a command was sent but no valid reply came back (SketchUp may still be running it):
//  - read-only / view / selection commands: safe to retry;
//  - model-editing commands (one Undo step): may already have run, check first, undo if duplicated;
//  - commands without an Undo step (undo, save/open/export file): may already have run, check first, do NOT use undo.
const READ_ONLY_CMDS = new Set(['ping', 'model_info', 'list_tags', 'list_components', 'list_materials',
  'selection_info', 'quantity_takeoff', 'measure_tags', 'check_model', 'check_design', 'screenshot', 'set_view', 'select_entities']);
const NO_UNDO_CMDS = new Set(['undo', 'save_model', 'open_model', 'new_model', 'export_file', 'export_png']);

function afterSendHint(cmd) {
  if (READ_ONLY_CMDS.has(cmd)) {
    return " This command does not modify the model and can be retried; for large models increase the timeout first " +
      "(Claude Desktop: Settings > Extensions > SketchUp MCP > Configure; other clients: the SKETCHUP_MCP_TIMEOUT environment variable).";
  }
  if (NO_UNDO_CMDS.has(cmd)) {
    return ` Command '${cmd}' MAY HAVE ALREADY RUN (SketchUp keeps working on it). Do NOT retry right away and do NOT use undo: ` +
      'wait for SketchUp, then check (ping, model_info, or whether the file was created).';
  }
  return ` Command '${cmd}' MAY HAVE ALREADY RUN (SketchUp keeps working on it). Do NOT retry right away: wait for SketchUp, ` +
    'then call model_info or selection_info to check; only re-run if it clearly did not apply, and use undo if it was duplicated.';
}

// Numeric comparison of "a.b.c": < 0 if a is older than b.
function compareVersions(a, b) {
  const pa = String(a).match(/^(\d+)\.(\d+)\.(\d+)/);
  const pb = String(b).match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!pa || !pb) return 0;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return d;
  }
  return 0;
}

// ---------------------------------------------------------------- interior tag standard
// Tag name "<CODE>-<NN> <description>": one tag = one specification (material + size/thickness + finish) = one line of
// the bill of quantities. measure = unit interior_takeoff uses for the category; color = category color for
// Tags panel > Color by tag (each number gets a lighter/darker shade); en/vi = category folder name (SketchUp 2021+).
const TAG_STANDARD = {
  FL: { en: 'Floor finishes', vi: 'Sàn', measure: 'plan_area', color: '#b5835a' },
  SK: { en: 'Skirting', vi: 'Len chân tường', measure: 'length', color: '#7a5230' },
  WL: { en: 'Wall finishes', vi: 'Tường hoàn thiện', measure: 'wall_area', color: '#d9c39a' },
  PA: { en: 'Partitions', vi: 'Vách ngăn', measure: 'wall_area', color: '#a6a6a6' },
  CL: { en: 'Ceilings', vi: 'Trần', measure: 'plan_area', color: '#9cc3e6' },
  CO: { en: 'Cornices and trims', vi: 'Phào chỉ', measure: 'length', color: '#5b8fc7' },
  DR: { en: 'Doors', vi: 'Cửa đi', measure: 'count', color: '#8e5ea2' },
  WN: { en: 'Windows', vi: 'Cửa sổ', measure: 'count', color: '#4f86c6' },
  GL: { en: 'Glass partitions', vi: 'Vách kính', measure: 'wall_area', color: '#7fd1d8' },
  JN: { en: 'Built-in joinery', vi: 'Đồ gỗ đóng tại chỗ', measure: 'count', color: '#d9822b' },
  FN: { en: 'Loose furniture', vi: 'Nội thất rời', measure: 'count', color: '#e3a857' },
  LT: { en: 'Lighting', vi: 'Đèn', measure: 'count', color: '#f2d43d' },
  SN: { en: 'Sanitary ware', vi: 'Thiết bị vệ sinh', measure: 'count', color: '#3fb6a8' },
  EQ: { en: 'Equipment and appliances', vi: 'Thiết bị', measure: 'count', color: '#7f8c8d' },
  CU: { en: 'Curtains and blinds', vi: 'Rèm', measure: 'elevation_area', color: '#c0504d' },
  DE: { en: 'Decor and accessories', vi: 'Trang trí', measure: 'count', color: '#5aa55a' },
  EX: { en: 'Existing structure', vi: 'Kết cấu hiện trạng', measure: 'volume', color: '#595959' },
  RF: { en: 'Reference (not measured)', vi: 'Tham chiếu (không tính)', measure: null, color: '#c8c8c8' },
};
const EXCLUDED_CODES = ['RF'];
// Letters only Vietnamese uses (not French/Spanish/Portuguese accents such as é, à, ã, ô), checked on the NFC form.
// (ă and đ alone are not enough: Romanian and Croatian use them too)
const VI_CHARS = /[ơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i;

/** "FL-01 Floor" -> {code: 'FL', num: 1, codeNN: 'FL-01'}; "LT Lighting" -> {code: 'LT'}; "Walls" -> {} (same rule as the bridge). */
function tagCode(name) {
  const m = String(name ?? '').replace(/^[ \t\r\n\f\v]+|[ \t\r\n\f\v]+$/g, '')
    .match(/^([A-Za-z]{2,3})(?:[-_ ]?(\d{1,3}))?(?=[ \t\r\n\f\v\-_.:]|$)/);
  if (!m) return {};
  const code = m[1].toUpperCase();
  return m[2] ? { code, num: Number(m[2]), codeNN: `${code}-${m[2].padStart(2, '0')}` } : { code };
}

/** Category color, alternately lighter/darker for each tag number (1 = base color). */
function shade(hex, n) {
  const f = [0, 0.3, -0.25, 0.5, -0.4, 0.15, -0.12, 0.65][(Math.max(1, n) - 1) % 8];
  return [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16);
    return Math.round(f >= 0 ? v + (255 - v) * f : v * (1 + f));
  });
}

/** Folder + color of a tag that follows the standard, else undefined. language: 'en' | 'vi' | undefined (= guess from the name). */
function tagStyle(name, language) {
  const { code, num } = tagCode(name);
  const cat = code && TAG_STANDARD[code];
  if (!cat) return undefined;
  const lang = language || (looksVietnamese([name]) ? 'vi' : 'en');
  return { folder: `${code} ${cat[lang]}`, folder_code: code, color: shade(cat.color, num || 1) };
}

// Env values coming from the manifest user_config are always strings; if not configured they may still be the literal "${user_config.x}".
function envValue(key) {
  const v = process.env[key];
  if (v === undefined) return undefined;
  const s = v.trim();
  return s === '' || /^\$\{[^}]*\}$/.test(s) ? undefined : s;
}

function envNumber(key, def, min, max) {
  const raw = envValue(key);
  if (raw === undefined) return def;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

const HOST = envValue('SKETCHUP_MCP_HOST') ?? '127.0.0.1';
const PORT = Math.round(envNumber('SKETCHUP_MCP_PORT', 9876, 1, 65535));
const TIMEOUT = envNumber('SKETCHUP_MCP_TIMEOUT', 120, 1, 3600);
const CONNECT_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

let nextId = 1;

class SketchUpError extends Error {}

function log(msg) {
  // Write to stderr only; stdout is reserved for the MCP protocol.
  process.stderr.write(`[sketchup-mcp] ${msg}\n`);
}

// The Ruby bridge serves only one client at a time (other connections wait in the backlog), so commands are
// queued here: each command's timeout only starts when its turn comes, like the Python version running tools sequentially.
let bridgeTail = Promise.resolve();
function exclusive(fn) {
  const run = bridgeTail.then(fn, fn);
  bridgeTail = run.then(() => {}, () => {});
  return run;
}

/** Send one command to SketchUp (waiting for its turn) and return 'result'. */
function call(cmd, params = {}, label = cmd) {
  return exclusive(() => sendNow(cmd, params, label));
}

/** Send one command immediately, without queueing. Only call inside exclusive(). */
function sendNow(cmd, params = {}, label = cmd) {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null));
  const data = JSON.stringify({ id: nextId++, cmd, params: clean }) + '\n';

  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    let connected = false;
    let sent = false;
    let settled = false;
    const sock = net.createConnection({ host: HOST, port: PORT });

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      sock.destroy();
      if (err) reject(err);
      else resolve(value);
    };

    const connectTimer = setTimeout(() => {
      finish(new SketchUpError(`Cannot connect to SketchUp at ${HOST}:${PORT} (connection timed out after ${CONNECT_TIMEOUT_MS / 1000}s).`));
    }, CONNECT_TIMEOUT_MS);

    sock.on('connect', () => {
      connected = true;
      clearTimeout(connectTimer);
      sock.setTimeout(TIMEOUT * 1000);
      sock.write(data, 'utf8');
      sent = true;
    });

    sock.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_RESPONSE_BYTES) {
        finish(new SketchUpError(`Response from SketchUp is too large (> ${MAX_RESPONSE_BYTES / 1024 / 1024} MB).${afterSendHint(label)}`));
        return;
      }
      chunks.push(chunk);
      if (chunk.includes(0x0a)) parseResponse();
    });

    sock.on('end', parseResponse);

    sock.on('timeout', () => {
      finish(new SketchUpError(`SketchUp did not respond within ${Math.round(TIMEOUT)}s (command '${label}').${afterSendHint(label)}`));
    });

    sock.on('error', (e) => {
      if (!connected && (e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET' || e.code === 'EADDRNOTAVAIL')) {
        finish(new SketchUpError(
          `Cannot connect to SketchUp at ${HOST}:${PORT}. Open SketchUp and check ` +
          'Extensions > SU MCP Bridge > Status (start the server if it is off). ' +
          'If the bridge is not installed, run the install_sketchup_bridge tool and restart SketchUp.'
        ));
      } else {
        finish(new SketchUpError(`SketchUp connection error (${e.code || e.name}): ${e.message}.${sent ? afterSendHint(label) : ''}`));
      }
    });

    sock.on('close', () => {
      if (!settled) parseResponse();
    });

    // Runs inside socket handlers: every error must be caught here, otherwise the server exits.
    function parseResponse() {
      if (settled) return;
      try {
        const buf = Buffer.concat(chunks);
        if (buf.length === 0) {
          finish(new SketchUpError(`SketchUp closed the connection without replying.${sent ? afterSendHint(label) : ''}`));
          return;
        }
        const nl = buf.indexOf(0x0a);
        if (nl < 0 && !sock.readableEnded && !sock.destroyed) return; // not a full line yet, keep waiting
        let resp;
        try {
          resp = JSON.parse(buf.subarray(0, nl < 0 ? buf.length : nl).toString('utf8'));
        } catch (e) {
          finish(new SketchUpError(`Invalid JSON response from SketchUp: ${e.message}.${afterSendHint(label)}`));
          return;
        }
        if (!resp || !resp.ok) {
          const err = resp && resp.error;
          let msg = err == null || err === '' ? 'Unknown error from SketchUp' : typeof err === 'string' ? err : JSON.stringify(err);
          // Error lines inside the run_ruby code itself (eval file name is 'mcp_run_ruby') so Claude can fix it.
          const bt = Array.isArray(resp && resp.backtrace)
            ? resp.backtrace.map(String).filter((l) => l.startsWith('mcp_run_ruby:')).slice(0, 3)
            : [];
          if (bt.length) msg += `\n(Location in run_ruby code: ${bt.join(' | ')})`;
          if (/Unsupported command/.test(msg)) {
            msg += ` The bridge in SketchUp may be older than MCP server v${VERSION} (bundled bridge v${BRIDGE_VERSION}): ` +
              'run install_sketchup_bridge, then fully quit and reopen SketchUp.';
          }
          finish(new SketchUpError(msg));
          return;
        }
        finish(null, resp.result);
      } catch (e) {
        finish(new SketchUpError(`Invalid response from SketchUp: ${e && e.message}`));
      }
    }
  });
}

// ---------------------------------------------------------------- tool registration helpers
const server = new McpServer(
  { name: 'sketchup', version: VERSION },
  {
    instructions: [
      'Controls the open SketchUp model through the "SU MCP Bridge" extension (127.0.0.1). Working rules:',
      '1. Units: lengths in mm, areas in m², volumes in m³, angles in degrees; Z is up; coordinates [x,y,z] in mm.',
      '2. Before working, call model_info (plus selection_info when the user says "the selected ..."). On a connection error: call ping; if the bridge is not installed, call install_sketchup_bridge.',
      '3. Prefer the dedicated tools; use run_ruby only when no tool can do the job.',
      '4. After every edit, read bounds_mm in the result; after a large change, take a screenshot to check.',
      '5. If the result is wrong, call undo right away and redo it with corrected parameters; do not stack fixes on wrong geometry.',
      '6. Ids are only valid in the current SketchUp session (they change after open_model or a restart); take ids from tool results, never guess.',
      '7. If a modelling command times out it may already have run: check before repeating. Every model-editing tool is one Undo step.',
      '8. Tag like a professional: call list_tags first and keep a tag scheme the model already has. Otherwise name tags ' +
        '"<CODE>-<NN> <description>" (codes: see setup_tags), e.g. "FL-01 Engineered oak floor 12mm": one tag = one specification ' +
        '(material, size/thickness, finish) = one BOQ line; same spec, same tag; a new spec takes the next number. Write the description ' +
        'in the user\'s language. Create the tags with setup_tags, then pass tag= to every create_*/insert_component call. Tag groups and ' +
        'components, not raw faces/edges; nothing new stays untagged except room groups.',
      '9. Model for takeoff: build rooms with create_room; otherwise each finish is its own group (one thin group per wall run, ' +
        'one per straight skirting run), not paint on a shared box, named "<code> <room> - <location>"; furniture and lights one ' +
        'group/component each. Rooms: a named group without a tag (make_group), nested for levels.',
      '10. interior_takeoff gives the bill of quantities (by_room splits it by room); check_model and check_design find model ' +
        'and design problems; report their warnings.',
    ].join('\n'),
  },
);

const READ = { readOnlyHint: true, openWorldHint: false };
const EDIT = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const EDIT_IDEMPOTENT = { ...EDIT, idempotentHint: true };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

function text(result) {
  return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] };
}

/** Register a tool that forwards its arguments (after prep) to the SketchUp command of the same name. */
function bridgeTool(name, description, inputSchema, annotations, prep = (a) => a) {
  server.registerTool(name, { description, inputSchema, annotations }, async (args) => text(await call(name, prep(args))));
}

// A NEW tag that follows the standard is created in its category folder with its category color (the bridge never
// restyles an existing tag; older bridges ignore tag_style).
const withTagStyle = (a) => (a && a.tag ? { ...a, tag_style: tagStyle(a.tag) } : a);

// Optional[...] = None in the Python version: accepts null too, omitted when sent to SketchUp.
const opt = (schema) => schema.nullish();
// Clients sometimes send nested arrays as a JSON string ("[[0,0,0],...]"); the Python version (FastMCP) accepts that, so do we.
const jsonish = (schema) => z.preprocess((v) => {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}, schema);
const Point = jsonish(z.array(z.number()).min(2).max(3));
// Id: also accepts numeric strings ("123") because clients sometimes send ids as strings.
const Id = z.preprocess((v) => (typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : v), z.number().int());
const IDS_DESC = 'Ids from tool results (selection_info, create_*...); only valid in the current SketchUp session.';
const Ids = jsonish(z.array(Id));
const ViewName = z.enum(['iso', 'top', 'bottom', 'front', 'back', 'left', 'right']);
const Str = z.string();
const RETURNS = ' Returns: {id, persistent_id, type, name, tag, material, bounds_mm{min,max,size}}.';

// ---------------------------------------------------------------- read / statistics
server.registerTool('ping', {
  description: 'Check the connection to SketchUp: returns the SketchUp and Ruby versions, the open model name, ' +
    'and the versions of the bridge in SketchUp and of the MCP server (warns if the bridge is older than the bundled one).',
  inputSchema: {},
  annotations: READ,
}, async () => {
  const r = (await call('ping')) || {};
  const out = { ...r, mcp_server: VERSION, bundled_bridge: BRIDGE_VERSION };
  if (r.bridge && !BRIDGE_VERSION.includes('-dev')) {
    const c = compareVersions(r.bridge, BRIDGE_VERSION);
    if (c < 0) {
      out.warning = `The bridge in SketchUp ${r.sketchup} is v${r.bridge}, older than the bundled v${BRIDGE_VERSION}: ` +
        'run install_sketchup_bridge, then fully quit and reopen SketchUp.';
    } else if (c > 0) {
      out.note = 'The bridge is newer than the MCP server: install the latest .mcpb.';
    }
  }
  return text(out);
});

bridgeTool('model_info',
  'Overview of the open model: path, units, bounding box size (mm), number of top-level groups/components/\n' +
  'faces/edges, and number of tags, materials, definitions, scenes and selected entities.',
  {}, READ);

bridgeTool('list_tags',
  'List tags (layers): name, visible/hidden, color, folder (SketchUp 2021+) and number of entities using the tag (including inside definitions).',
  {}, READ);

bridgeTool('list_components',
  'List component definitions and their instance counts (sorted descending) - use it to count\n' +
  'equipment/furniture. include_groups=true also lists groups.',
  { include_groups: z.boolean().default(false) }, READ);

bridgeTool('list_materials',
  'List the materials in the model: name, RGB color, transparency, texture file.',
  {}, READ);

bridgeTool('selection_info',
  'Info on the selected entities: id, type, name, tag, material, bounding box (mm),\n' +
  'face area (m2), solid volume (m3). The ids are used by the edit/delete tools.',
  { limit: z.number().int().min(0).default(200).describe('Maximum number of entities returned in detail') }, READ);

bridgeTool('quantity_takeoff',
  'Quantity takeoff: walks the whole model recursively (or only the selection) and totals by tag or material:\n' +
  'face area (m2, one side), face count, total edge length (m), solid volume (m3) and\n' +
  'instance count per component. Untagged/unpainted entities inherit from their parent group.\n' +
  'Raw totals only (face area counts every face of a solid): for a bill of quantities use interior_takeoff.',
  {
    group_by: z.enum(['tag', 'material']).default('tag').describe('Group by "tag" (layer) or by "material"'),
    selection_only: z.boolean().default(false),
    include_hidden: z.boolean().default(false),
  }, READ);

// ---------------------------------------------------------------- interior bill of quantities
const MEASURES = ['plan_area', 'wall_area', 'sheet_area', 'side_area', 'length', 'elevation_area', 'count', 'volume'];
const MEASURE_FIELD = {
  plan_area: 'plan_area_m2', wall_area: 'wall_area_m2', sheet_area: 'sheet_area_m2', side_area: 'side_area_m2', length: 'length_m',
  elevation_area: 'elevation_area_m2', count: 'count', volume: 'volume_m3',
};
const MEASURE_UNIT = {
  plan_area: 'm2', wall_area: 'm2', sheet_area: 'm2', side_area: 'm2', elevation_area: 'm2', length: 'm', count: 'pcs', volume: 'm3',
};
const AREA_MEASURES = new Set(['plan_area', 'wall_area', 'sheet_area', 'side_area']);
const CSV_TEXT = {
  en: {
    head: ['Code', 'Tag', 'Category', 'Quantity', 'Unit', 'Measured as', 'Count', 'Floor/ceiling area (m²)', 'Wall area, one side (m²)',
      'Sheet area, one side (m²)', 'Vertical faces (m²)', 'Length (m)', 'Width x height (m²)', 'Volume (m³)', 'Items', 'Warnings'],
    unit: { m2: 'm²', m: 'm', pcs: 'pcs', m3: 'm³' },
    total: 'Total', no_room: '(no room)',
    measure: { plan_area: 'floor/ceiling area', wall_area: 'wall area, one side', sheet_area: 'one side', side_area: 'vertical faces',
      length: 'length', elevation_area: 'width x height', count: 'count', volume: 'volume' },
  },
  vi: {
    head: ['Mã', 'Tag', 'Hạng mục', 'Khối lượng', 'Đơn vị', 'Cách đo', 'Số lượng', 'Diện tích sàn/trần (m²)', 'Diện tích tường, một mặt (m²)',
      'Diện tích tấm, một mặt (m²)', 'Tổng mặt đứng (m²)', 'Chiều dài (m)', 'Rộng x cao (m²)', 'Thể tích (m³)', 'Chi tiết', 'Cảnh báo'],
    unit: { m2: 'm²', m: 'md', pcs: 'cái', m3: 'm³' },
    total: 'Tổng', no_room: '(chưa có phòng)',
    measure: { plan_area: 'diện tích sàn/trần', wall_area: 'diện tích tường một mặt', sheet_area: 'diện tích một mặt',
      side_area: 'tổng mặt đứng', length: 'chiều dài', elevation_area: 'rộng x cao', count: 'đếm', volume: 'thể tích' },
  },
};
const round = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : v);
const BOM = String.fromCharCode(0xfeff); // UTF-8 byte order mark: makes Excel read the CSV as UTF-8

/** Unit overrides normalized: keys are tag names (as given) or codes ("lt-5" -> "LT-05", "lt" -> "LT").
 *  A short key that is the exact name of a tag in the model (e.g. a tag named "TV") stays a tag name. */
function normalizeMeasures(measures, tagNames = []) {
  const byTag = new Map();
  const byCode = new Map();
  const names = new Set(tagNames.map((n) => String(n).trim()));
  for (const [k, v] of Object.entries(measures || {})) {
    const key = String(k).trim();
    if (!names.has(key) && /^[A-Za-z]{2,3}(?:[-_ ]?\d{1,3})?$/.test(key)) {
      const tc = tagCode(key);
      byCode.set(tc.codeNN || tc.code, { key: k, v });
    } else {
      byTag.set(key, { key: k, v });
    }
  }
  return { byTag, byCode, used: new Set() };
}

/** Unit picked for a tag: overrides by tag name, then "LT-05", then "LT"; else the category default. */
function boqMeasure(tag, over) {
  const { code, codeNN } = tagCode(tag);
  const hit = over.byTag.get(String(tag).trim()) || (codeNN && over.byCode.get(codeNN)) || (code && over.byCode.get(code));
  if (hit) {
    over.used.add(hit.key);
    return hit.v;
  }
  return (code && TAG_STANDARD[code] && TAG_STANDARD[code].measure) || null;
}

/** Quantity of a bridge measurement row in a unit (rounded like a BOQ: 2 decimals, m³ 3, count as is). */
function boqQuantity(t, measure) {
  const raw = measure ? t[MEASURE_FIELD[measure]] : null;
  return raw == null ? null : measure === 'count' ? raw : round(raw, measure === 'volume' ? 3 : 2);
}

/** One BOQ row from the bridge's per-tag measurements; overrides = {tag | "LT-05" | "LT": measure}. */
function boqRow(t, overrides, lang) {
  const { code, codeNN } = tagCode(t.tag);
  const cat = code ? TAG_STANDARD[code] : undefined;
  const measure = boqMeasure(t.tag, overrides);
  const list = (k) => (Array.isArray(t[k]) ? t[k] : []);
  const parts = (a) => `${a.length}${a.length >= 10 ? '+' : ''} part(s): ` +
    a.map((o) => `${[o.name, o.id != null ? `(id ${o.id})` : ''].filter(Boolean).join(' ') || '?'} ${(o.size_mm || []).join(' x ')} mm` +
      `${o.sides_m2 ? ` [sides ${o.sides_m2.join(' / ')} m²]` : ''}`).join('; ');
  const warnings = [];
  if (!measure) {
    warnings.push('No unit: the tag name does not start with a known code (e.g. "FL-01 ..."). Rename the tag, or pass ' +
      `measures {"${t.tag}": "plan_area" | "wall_area" | "length" | "count" | ...}.`);
  }
  if ((measure === 'wall_area' || measure === 'sheet_area') && list('not_thin').length) {
    warnings.push(`Not thin, so NOT included: ${parts(list('not_thin'))}. Model each wall/partition/cladding as a thin group ` +
      'per straight wall run; side_area_m2 (all vertical faces) is given for reference.');
  }
  if (measure === 'wall_area' && list('not_upright').length) {
    warnings.push(`Thin but lying flat (not a wall), so NOT included: ${parts(list('not_upright'))}.`);
  }
  if ((measure === 'wall_area' || measure === 'sheet_area') && list('not_straight').length) {
    warnings.push(`Curved or segmented, measured approximately as half of its vertical faces: ${parts(list('not_straight'))}. ` +
      'Split it into straight runs for an exact figure.');
  }
  if ((measure === 'wall_area' || measure === 'sheet_area') && list('uneven_sides').length) {
    warnings.push(`The two sides differ (an opening cut in one side only, or a pilaster/niche on one side?), the smaller side was used: ${parts(list('uneven_sides'))}.`);
  }
  if (measure === 'plan_area' && !t.plan_area_m2 && t.count) {
    warnings.push('No horizontal or sloped faces found: check that these objects are floors/ceilings.');
  }
  const nested = Object.entries(t.nested_components || {});
  if (AREA_MEASURES.has(measure) && nested.length) {
    const openings = nested.filter(([n]) => n.startsWith('(opening) '));
    const others = nested.filter(([n]) => !n.startsWith('(opening) '));
    if (others.length) {
      warnings.push(`Contains components without a tag of their own, measured as part of this line: ` +
        `${others.map(([n, c]) => `${n} x${c}`).join(', ')}. Tag them (e.g. DR-01, FN-01) if they are separate items.`);
    }
    if (openings.length) {
      warnings.push(`Untagged doors/windows inside (not measured here, tag them DR/WN to count them): ` +
        `${openings.map(([n, c]) => `${n.slice(10)} x${c}`).join(', ')}.`);
    }
  }
  if (measure === 'volume' && t.not_solid) warnings.push(`${t.not_solid} object(s) are not solid: their volume is missing.`);
  if (measure === 'count' && !t.count && t.loose_faces) {
    warnings.push('Only loose faces carry this tag: make each item a group or component so it can be counted.');
  }
  return {
    code: codeNN || code || null,
    tag: t.tag,
    category: cat ? cat[lang] : null,
    quantity: boqQuantity(t, measure),
    unit: measure ? MEASURE_UNIT[measure] : null,
    measured_as: measure,
    count: t.count,
    items: t.items,
    plan_area_m2: round(t.plan_area_m2, 2),
    wall_area_m2: round(t.wall_area_m2, 2),
    sheet_area_m2: round(t.sheet_area_m2, 2),
    side_area_m2: round(t.side_area_m2, 2),
    length_m: round(t.length_m, 2),
    elevation_area_m2: round(t.elevation_area_m2, 2),
    volume_m3: round(t.volume_m3, 3),
    ...(warnings.length ? { warnings } : {}),
  };
}

/** CSV text for Excel: UTF-8 with BOM, CRLF; semicolon format = ";" separator and decimal comma.
 *  With rooms: one column per room (quantity in the row's unit) after the total. */
function boqCsv(rows, lang, format, rooms) {
  const L = CSV_TEXT[lang];
  const sep = format === 'semicolon' ? ';' : ',';
  const num = (v) => (v == null ? '' : format === 'semicolon' ? String(v).replace('.', ',') : String(v));
  const cell = (v) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // never let Excel read a cell as a formula
    return /["\r\n;,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const unit = (r) => cell(r.unit ? L.unit[r.unit] : '');
  const lines = [];
  if (rooms) {
    const last = L.head.length - 1; // Warnings
    lines.push([L.head[0], L.head[1], L.head[2], L.head[4], L.total, ...rooms.map((rm) => rm || L.no_room), L.head[5], L.head[last]]
      .map(cell).join(sep));
    for (const r of rows) {
      lines.push([cell(r.code), cell(r.tag), cell(r.category), unit(r), num(r.quantity),
        ...rooms.map((rm) => num(r.by_room ? r.by_room[rm || L.no_room] : null)),
        cell(r.measured_as ? L.measure[r.measured_as] : ''), cell((r.warnings || []).join(' '))].join(sep));
    }
  } else {
    lines.push(L.head.map(cell).join(sep));
    for (const r of rows) {
      lines.push([
        cell(r.code), cell(r.tag), cell(r.category), num(r.quantity), unit(r),
        cell(r.measured_as ? L.measure[r.measured_as] : ''), num(r.count), num(r.plan_area_m2), num(r.wall_area_m2),
        num(r.sheet_area_m2), num(r.side_area_m2), num(r.length_m), num(r.elevation_area_m2), num(r.volume_m3),
        cell(Object.entries(r.items || {}).map(([n, c]) => `${n} x${c}`).join('; ')), cell((r.warnings || []).join(' ')),
      ].join(sep));
    }
  }
  return BOM + lines.join('\r\n') + '\r\n';
}

const TagSpec = z.union([Str, z.object({ name: Str, color: opt(Str), folder: opt(Str) })]);

server.registerTool('setup_tags', {
  description:
    'Create tags in one Undo step, following the interior tag standard "<CODE>-<NN> <description>", codes: ' +
    Object.entries(TAG_STANDARD).map(([c, v]) => `${c} ${v.en.toLowerCase()}`).join(', ') + '. ' +
    'Each tag goes into its category folder (SketchUp 2021+, e.g. "FL Floor finishes") and gets its category color ' +
    '(Tags panel > Color by tag). Use it to create every tag of a finish schedule at once, before modelling. Existing tags keep ' +
    'their folder and color unless update_existing=true. Tags without a known code get no folder/color unless given.',
  inputSchema: {
    tags: jsonish(z.array(TagSpec).min(1)).describe(
      'Tag names, e.g. ["FL-01 Engineered oak floor 12mm", "WL-01 Paint, white matt"], or objects {name, color "#RRGGBB", folder}'),
    language: opt(z.enum(['en', 'vi'])).describe(
      'Language of NEW category folder names; default: Vietnamese when the tag name has Vietnamese diacritics, else English'),
    update_existing: z.boolean().default(false).describe('true = also move EXISTING tags into their category folder and recolor them'),
  },
  annotations: EDIT_IDEMPOTENT,
}, async ({ tags, language, update_existing }) => {
  const list = tags.map((t) => {
    const spec = typeof t === 'string' ? { name: t } : t;
    const name = String(spec.name).trim();
    const std = tagStyle(name, language || undefined) || {};
    return {
      name,
      folder: spec.folder || std.folder,
      folder_code: spec.folder ? undefined : std.folder_code,
      color: spec.color || std.color,
    };
  });
  return text(await call('create_tags', { tags: list, update_existing }));
});

server.registerTool('interior_takeoff', {
  description:
    'Bill of quantities (BOQ) for interior work: one row per tag (= one specification), with the unit its category needs:\n' +
    'FL floors and CL ceilings -> area m², once per board whatever its face orientation, sloped parts at their real area; WL wall finishes, ' +
    'PA partitions, GL glass -> area of ONE side of each thin upright piece (openings cut in one side deducted), m²; SK skirting, ' +
    'CO cornices -> length m (runs made with Follow Me too); ' +
    'CU curtains -> width x height m²; EX existing structure -> volume m³; DR, WN, JN, FN, LT, SN, EQ, DE -> count ' +
    '(outermost group/component per tag, by definition). Every row also has all the other measures, and the totals per category. ' +
    'by_room=true adds the quantity of every row per room (a room = a named group WITHOUT a tag, e.g. "Living room"; ' +
    'otherwise taken from object names "<code> <room> - <location>"). RF reference tags are skipped. Warnings list geometry ' +
    'that is in no tagged object and parts that could not be measured (e.g. a wall that is not a thin object). ' +
    'csv_path also writes the table to a CSV file for Excel (with by_room: one column per room).',
  inputSchema: {
    selection_only: z.boolean().default(false).describe('Only the selected objects (e.g. one room)'),
    include_hidden: z.boolean().default(false).describe('Also measure hidden objects and objects on hidden tags/folders (they are listed in warnings otherwise)'),
    by_room: z.boolean().default(false).describe('Also split every row by room (rooms = named groups without a tag)'),
    measures: opt(jsonish(z.record(Str, z.enum(MEASURES)))).describe(
      'Unit override per tag name, per code-number ("LT-05") or per code ("JN"), e.g. {"LT-05": "length", "JN": "elevation_area"}'),
    thin_ratio: z.number().gt(0).lt(1).default(0.5).describe('A piece is thin when its thickness <= thin_ratio x its smaller in-plane size'),
    max_thickness_mm: z.number().positive().default(600).describe('Thicker pieces are never taken for a wall/board (e.g. a corridor drawn as one box)'),
    language: z.enum(['en', 'vi']).default('en').describe('Language of category names, room placeholder and CSV headers/units'),
    csv_path: opt(Str).describe("Absolute path of a .csv file to write, e.g. 'D:/BOQ/takeoff.csv' (UTF-8, opens in Excel)"),
    csv_format: z.enum(['comma', 'semicolon']).default('comma').describe(
      'semicolon = ";" separators and decimal commas, for Excel with Vietnamese/European regional settings'),
    overwrite: z.boolean().default(false).describe('Replace csv_path if it already exists'),
  },
  // destructive: with overwrite=true it replaces an existing .csv file
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
}, async ({ selection_only, include_hidden, by_room, measures, thin_ratio, max_thickness_mm, language, csv_path, csv_format, overwrite }) => {
  const csvFile = csv_path ? await checkCsvPath(csv_path, overwrite) : null; // before measuring: fail fast
  const r = (await call('measure_tags', {
    selection_only, include_hidden, by_room, thin_ratio, max_thickness_mm, exclude_codes: EXCLUDED_CODES,
  })) || {};
  const over = normalizeMeasures(measures, (Array.isArray(r.tags) ? r.tags : []).map((t) => t.tag));
  const L = CSV_TEXT[language];
  const rows = (Array.isArray(r.tags) ? r.tags : []).filter((t) => t.tag !== 'Untagged').map((t) => boqRow(t, over, language));

  let rooms;
  if (by_room) {
    if (!Array.isArray(r.rooms)) {
      throw new SketchUpError('The bridge in SketchUp does not split quantities by room (it is older than this MCP server): ' +
        'run install_sketchup_bridge, then fully quit and reopen SketchUp.');
    }
    const byTag = new Map(rows.map((row) => [row.tag, row]));
    const seen = new Set();
    const raw = new Map(); // row -> {room: unrounded quantity}
    for (const t of r.rooms) {
      const row = byTag.get(t.tag);
      if (!row || !row.measured_as) continue;
      seen.add(t.room || '');
      const v = t[MEASURE_FIELD[row.measured_as]];
      if (typeof v !== 'number') continue;
      const m = raw.get(row) || raw.set(row, {}).get(row);
      const room = t.room || L.no_room;
      m[room] = (m[room] || 0) + v;
    }
    for (const [row, m] of raw) {
      row.by_room = {};
      for (const [room, v] of Object.entries(m)) row.by_room[room] = row.measured_as === 'count' ? v : round(v, row.measured_as === 'volume' ? 3 : 2);
    }
    // natural order ("Bedroom 2" before "Bedroom 10"), objects outside any room last
    rooms = [...seen].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })));
  }

  const totals = {};
  for (const row of rows) {
    const code = tagCode(row.tag).code;
    if (!code || !TAG_STANDARD[code] || row.quantity == null) continue;
    const tot = totals[code] || (totals[code] = { category: TAG_STANDARD[code][language], quantity: 0, unit: row.unit, lines: 0 });
    tot.lines += 1;
    if (tot.unit === row.unit) tot.quantity = round(tot.quantity + row.quantity, 3);
    else tot.unit = 'mixed';
  }
  for (const t of Object.values(totals)) if (t.unit === 'mixed') delete t.quantity;

  const warnings = [];
  const untagged = Array.isArray(r.untagged) ? r.untagged : [];
  if (untagged.length) {
    warnings.push(`Geometry in no tagged object, so it is in no BOQ line (${untagged.length}${untagged.length >= 50 ? '+' : ''} place(s)): ` +
      untagged.slice(0, 15).map((u) => `${u.name || '?'}${u.id ? ` (id ${u.id})` : ''}${u.room ? ` in ${u.room}` : ''}: ${u.faces} faces`).join('; ') +
      '. Put it in groups/components with a tag (set_tag), or ignore it if it is not part of the work.');
  }
  if (by_room && rooms && rooms.length === 1 && rooms[0] === '') {
    warnings.push('No rooms found: put each room\'s objects in a named group without a tag (make_group), or name objects ' +
      '"<code> <room> - <location>".');
  }
  const hiddenAll = Array.isArray(r.hidden) ? r.hidden : [];
  const hidden = hiddenAll.filter((h) => h.tag !== 'Untagged');
  for (const h of hiddenAll.filter((x) => x.tag === 'Untagged')) {
    warnings.push(`Hidden groups without a tag (a hidden room or level?), nothing inside them was measured: ` +
      `${(h.names || []).map((x) => `${x.name} (id ${x.id})`).join(', ') || `${h.objects} group(s)`}. Pass include_hidden=true to include them.`);
  }
  if (hidden.length) {
    warnings.push(`Hidden, so NOT measured: ${hidden.map((h) => `${h.tag} (${h.objects} object(s)${h.hidden_tag ? ', tag or tag folder hidden' : ''})`).join('; ')}. ` +
      'Pass include_hidden=true to include them (e.g. a ceiling hidden only to look at the plan).');
  }
  const unused = Object.keys(measures || {}).filter((k) => !over.used.has(k));
  if (unused.length) warnings.push(`measures key(s) matching no tag: ${unused.join(', ')} (use a full tag name, "LT-05" or "LT").`);
  const out = {
    rows, totals,
    ...(rooms ? { rooms: rooms.map((rm) => rm || L.no_room) } : {}),
    ...(warnings.length ? { warnings } : {}),
    ...(untagged.length ? { untagged } : {}),
    ...(hiddenAll.length ? { hidden: hiddenAll } : {}),
    excluded: r.excluded && Object.keys(r.excluded).length ? r.excluded : undefined,
    selection_only: r.selection_only === true,
    notes: [
      'plan_area: non-vertical faces at their real area, once per closed board/slab. wall_area: one side of thin upright pieces ' +
        '(the smaller side when they differ). sheet_area: one side of thin pieces in any orientation.',
      'side_area: all vertical faces (e.g. the returns of a stepped ceiling). length: straight runs by their length, runs that turn ' +
        '(Follow Me) by their swept length; parallel parts of one run (board + cap) count once. elevation_area: width x height of each object.',
    ],
  };
  if (csvFile) {
    try {
      await fs.mkdir(path.dirname(csvFile), { recursive: true });
      // 'wx' fails if the file appeared meanwhile, so it is never replaced without overwrite=true
      await fs.writeFile(csvFile, boqCsv(rows, language, csv_format, rooms), { encoding: 'utf8', flag: overwrite ? 'w' : 'wx' });
      out.csv = { path: csvFile, rows: rows.length, format: csv_format, by_room: !!rooms };
    } catch (e) {
      // keep the bill of quantities: only the file could not be written
      out.csv = { path: csvFile, error: e.code === 'EEXIST' ? 'The file already exists: ask the user before replacing it (overwrite=true), or use another file name.' : `${e.code || ''} ${e.message}`.trim() };
    }
  }
  return text(out);
});

/** Validated absolute .csv path (Windows: drive letter or UNC), checked before the takeoff runs. */
async function checkCsvPath(csvPath, overwrite) {
  const p = String(csvPath).trim();
  // Windows: a drive letter (D:/... or D:\...) or a UNC share (\\server\share\... or //server/share/...)
  const absolute = process.platform === 'win32'
    ? /^([A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/])/.test(p)
    : path.isAbsolute(p);
  if (!absolute) {
    throw new Error(`csv_path must be an absolute path with a drive letter or a network share (e.g. D:/BOQ/takeoff.csv), got: ${p}`);
  }
  if (!/\.csv$/i.test(p)) throw new Error(`csv_path must end with .csv, got: ${p}`);
  const full = path.resolve(p);
  if (!overwrite && (await exists(full))) {
    throw new Error(`${full} already exists: ask the user before replacing it (overwrite=true), or choose another file name.`);
  }
  return full;
}

// ---------------------------------------------------------------- rooms, checks and documentation scenes
// Objects are strict: a misspelt key (sill_mm, thickness_mm...) is an error instead of being silently ignored.
const TAG_DESC = 'Tag "<CODE>-<NN> <description>" (see setup_tags)';
const PART = { tag: opt(Str).describe(TAG_DESC), material: opt(Str), color: opt(Str) };
const mmOpt = (d) => opt(z.number().positive()).describe(`mm, default ${d}`);
const FloorSpec = z.strictObject({ ...PART, thickness: mmOpt(12) });
const CeilingSpec = z.strictObject({ ...PART, thickness: mmOpt(9) });
const SkirtingSpec = z.strictObject({ ...PART, height: mmOpt(80), thickness: mmOpt(12) });
const WallSpec = z.strictObject({
  ...PART, thickness: mmOpt(10), height: mmOpt('the room height'),
  by_edge: opt(z.record(z.string().regex(/^[1-9]\d*$/, 'edge numbers start at 1'), z.strictObject({
    ...PART, none: opt(z.boolean()).describe('true = no wall finish and no skirting on this edge (an open side)'),
  }))).describe('Per edge, e.g. {"2": {"tag": "WL-02 Oak panel"}} for a feature wall, {"4": {"none": true}} for an open side'),
});
const OpeningSpec = z.strictObject({
  edge: z.number().int().min(1).describe('Edge number (edge 1 = from point 1 to point 2)'),
  offset: z.number().min(0).default(0).describe('mm from the START of that edge to the opening'),
  width: z.number().positive().describe('mm'),
  height: z.number().positive().describe('Opening height in mm, from the sill up to the head (not the head height above the floor)'),
  sill: z.number().min(0).default(0).describe('mm above the finished floor; a DR tag makes it a door, a WN tag a window, else sill < 50 mm = door'),
  tag: opt(Str).describe('e.g. "DR-01 Oak door 900x2100" or "WN-01 ...": adds a door leaf / glass pane counted as an item; empty = opening only'),
  material: opt(Str), color: opt(Str), name: opt(Str),
});

/** Vietnamese text? Letters only Vietnamese uses, or a few common words whose letters other languages share ("Phòng khách"). */
function looksVietnamese(texts) {
  return texts.some((t) => {
    const s = String(t || '').normalize('NFC');
    return VI_CHARS.test(s) || /(^|[\s,.-])(phòng|khách|nhà|đá|đèn)(?=$|[\s,.-])/i.test(s);
  });
}

/** Folder/color for every standard tag a create_room call mentions (new tags only, see get_tag in the bridge). */
function roomTagStyles(a, language) {
  const tags = [a.floor, a.walls, a.ceiling, a.skirting, ...(a.openings || []),
    ...Object.values((a.walls && a.walls.by_edge) || {})].map((x) => x && x.tag).filter(Boolean);
  return Object.fromEntries(tags.map((t) => [t, tagStyle(t, language)]).filter(([, s]) => s));
}

server.registerTool('create_room', {
  description:
    'Build a finished interior room in one Undo step, ready for interior_takeoff. The outline is the bare inner face of the ' +
    'walls, [x,y] in mm, either winding (z is ignored: use level). Edge k runs from point k to point k+1; the last edge closes ' +
    'the outline. Creates an untagged group named after the room holding: the floor finish (top = level), one wall-finish ' +
    'panel per edge built inward from the outline with the openings cut through, the ceiling board (underside = level + ' +
    'height), skirting inside the wall finish (interrupted at doors), and a door leaf / glass pane for each opening with a tag ' +
    '(tag a door shared by two rooms in one of them only). ' +
    'Each part is a group with its tag, named "<code> <room> - <location>". Leave a part out to skip it. Returns {room, ' +
    'parts:[{id, kind, name, tag}], quantities:{floor_area_m2, perimeter_m, wall_area_gross_m2, wall_area_net_m2, ' +
    'ceiling_area_m2, skirting_m}}.',
  inputSchema: {
    name: Str.describe('Room name, e.g. "Living room"'),
    points: jsonish(z.array(Point).min(3)).describe('Outline [[x,y],...] mm, in order around the room'),
    level: z.number().default(0).describe('Finished floor level (mm)'),
    height: z.number().positive().default(2700).describe('Clear height from the finished floor to the ceiling (mm)'),
    floor: opt(jsonish(FloorSpec)),
    walls: opt(jsonish(WallSpec)),
    ceiling: opt(jsonish(CeilingSpec)),
    skirting: opt(jsonish(SkirtingSpec)),
    openings: opt(jsonish(z.array(OpeningSpec))).describe('Doors and windows cut through the wall finish'),
    language: opt(z.enum(['en', 'vi'])).describe('Built-in part names; default: Vietnamese when the names look Vietnamese, else English'),
    labels: opt(jsonish(z.strictObject({
      floor: opt(Str), wall: opt(Str), ceiling: opt(Str), skirting: opt(Str), door: opt(Str), window: opt(Str),
    }))).describe('Part names in any language, e.g. {"wall": "Wand", "floor": "Boden"}'),
  },
  annotations: EDIT,
}, async (a) => {
  const language = a.language || (looksVietnamese([a.name, ...Object.keys(roomTagStyles(a, 'en'))]) ? 'vi' : 'en');
  return text(await call('create_room', { ...a, language, tag_styles: roomTagStyles(a, language) }));
});

function places(list, unit) {
  const items = list || [];
  return items.slice(0, 15).map((x) => `${x.name}${x.id != null ? ` (id ${x.id})` : ''}${unit && x[unit] != null ? `: ${x[unit]} ${unit}` : ''}`)
    .join('; ') + (items.length > 15 ? `; +${items.length - 15} more` : '');
}
const more = (shown, total) => (total > shown ? ` (+${total - shown} more)` : '');
const HEALTH_TEXT = {
  raw_top: (r) => `${r.raw_top_faces} face(s) drawn directly at the top level, not in a group: group them and tag the group.`,
  untagged: (x) => `Geometry in ${x.count} group(s)/component(s) without a tag, so it is in no BOQ line: ${places(x.in, 'faces')}.`,
  raw_tagged: (x) => `${x.count} raw face(s)/edge(s) carry a tag themselves (raw geometry should stay Untagged; tag its group ` +
    `instead): ${places(x.in, 'count')}.`,
  inside_out: (x) => `${x.count} solid(s) are inside out (faces point inwards): ${places(x.items)}. Reverse their faces (Orient Faces).`,
  mixed: (x) => `Faces turned different ways in ${x.in.length} group(s)/component(s) (${x.count} edges between a front and a back face): ` +
    `${places(x.in, 'edges')}. Use Orient Faces so the white front faces point outwards.`,
  duplicates: (x) => `${x.count} object(s) are exact copies stacked on another one (same component, same place) - they double ` +
    `the quantities: ${x.items.map((d) => `${d.name} (id ${d.id}, copy of id ${d.same_as})`).join('; ')}${more(x.items.length, x.count)}.`,
  stray: (x) => `${x.count} loose edge(s) with no face: ${places(x.in, 'edges')}.`,
  tiny: (n) => `${n} edge(s) shorter than 1 mm (they can leave holes or missing faces).`,
  unused: (u) => `Unused: ${u.definitions_n} component definition(s), ${u.materials_n} material(s), ${u.tags_n} tag(s)` +
    (u.tags_standard_n ? ` (${u.tags_standard_n} of them empty standard tags, e.g. from setup_tags, which purge_unused keeps)` : '') +
    ' - purge_unused removes them (one Undo step).',
  textures: (l) => `Large textures (over 2048 x 2048 px) slow the model: ${l.map((t) => `${t.name} ${t.px.join('x')}`).join(', ')}.`,
  heavy: (l) => `Heaviest components (faces x copies): ${l.map((d) => `${d.name} ${d.faces} x ${d.instances}`).join(', ')}.`,
  units: (u) => `Model units are ${u}. The MCP tools work in mm whatever the model units; check that drawings and labels use the units you expect.`,
  hidden: (h) => `${h.objects} hidden object(s)${h.tags.length ? `; hidden tags: ${h.tags.join(', ')}` : ''} - hidden things are easy to forget.`,
  nesting: (d) => `Groups are nested ${d} levels deep: hard to edit and to check.`,
  tag_names: (l, n) => `Tags without a standard code (interior_takeoff gives them no unit): ${l.join(', ')}${more(l.length, n)}.`,
  unknown_codes: (l, n) => `Tags with a code that is not in the standard: ${l.join(', ')}${more(l.length, n)}.`,
  not_saved: () => 'The model has never been saved.',
  big_file: (mb) => `The file is ${mb} MB.`,
};

/** Problems found by the bridge's check_model, warnings first. */
function healthIssues(r) {
  const out = [];
  const add = (id, severity, message, extra = {}) => out.push({ id, severity, message, ...extra });
  if (r.raw_top_faces) add('raw_top', 'warning', HEALTH_TEXT.raw_top(r));
  if (r.untagged_geometry && r.untagged_geometry.count) add('untagged_geometry', 'warning', HEALTH_TEXT.untagged(r.untagged_geometry));
  if (r.duplicates && r.duplicates.count) add('duplicates', 'warning', HEALTH_TEXT.duplicates(r.duplicates));
  if (r.inside_out && r.inside_out.count) add('inside_out', 'warning', HEALTH_TEXT.inside_out(r.inside_out));
  if (r.raw_tagged && r.raw_tagged.count) add('raw_tagged', 'warning', HEALTH_TEXT.raw_tagged(r.raw_tagged));
  if (r.mixed_orientation && r.mixed_orientation.count) add('mixed_orientation', 'info', HEALTH_TEXT.mixed(r.mixed_orientation));
  const used = Array.isArray(r.tags_in_use) ? r.tags_in_use : [];
  const standard = (t) => { const c = tagCode(t).code; return !!(c && TAG_STANDARD[c]); };
  // an unknown CODE only when written like one (upper case or with a number), so "New walls" is just a tag without a code
  const unknown = used.filter((t) => !standard(t) && /^[A-Z]{2,3}(?:[-_ ]?\d{1,3})?(?=[\s\-_.:]|$)/.test(String(t).trim()));
  const noCode = used.filter((t) => !standard(t) && !unknown.includes(t));
  if (noCode.length) add('tag_names', 'info', HEALTH_TEXT.tag_names(noCode.slice(0, 30), noCode.length));
  if (unknown.length) add('unknown_codes', 'info', HEALTH_TEXT.unknown_codes(unknown.slice(0, 30), unknown.length));
  if (r.stray_edges && r.stray_edges.count) add('stray_edges', 'info', HEALTH_TEXT.stray(r.stray_edges));
  if (r.tiny_edges) add('tiny_edges', 'info', HEALTH_TEXT.tiny(r.tiny_edges));
  const u = r.unused || {};
  if (u.definitions_n || u.materials_n || u.tags_n) add('unused', 'info', HEALTH_TEXT.unused(u), { names: u });
  if (Array.isArray(r.heavy_textures) && r.heavy_textures.length) add('heavy_textures', 'info', HEALTH_TEXT.textures(r.heavy_textures));
  const heavy = (Array.isArray(r.heavy_definitions) ? r.heavy_definitions : []).filter((d) => d.total >= 20000);
  if (heavy.length) add('heavy_definitions', 'info', HEALTH_TEXT.heavy(heavy));
  const s = r.summary || {};
  if (s.length_unit && s.length_unit !== 'mm') add('units', 'info', HEALTH_TEXT.units(s.length_unit));
  if (r.hidden && (r.hidden.objects || (r.hidden.tags || []).length)) add('hidden', 'info', HEALTH_TEXT.hidden(r.hidden));
  if (s.max_nesting > 6) add('nesting', 'info', HEALTH_TEXT.nesting(s.max_nesting));
  if (s.saved === false) add('not_saved', 'info', HEALTH_TEXT.not_saved());
  if (s.file_mb > 100) add('big_file', 'info', HEALTH_TEXT.big_file(s.file_mb));
  return out;
}

server.registerTool('check_model', {
  description:
    'Health check of the open model (read only), e.g. before sending it or taking off quantities: geometry outside groups or ' +
    'without a tag, raw faces carrying tags, inside-out solids, stacked duplicate copies (they double quantities), loose and ' +
    'tiny edges, unused components/materials/tags (purge_unused removes them), heavy textures and components, units, hidden ' +
    'objects, tags without a standard code. Issues name the objects, with their ids where they apply (select_entities shows them).',
  inputSchema: {},
  annotations: READ,
}, async () => {
  const r = (await call('check_model', { keep_codes: Object.keys(TAG_STANDARD) })) || {};
  const issues = healthIssues(r);
  return text({
    summary: r.summary,
    issues,
    counts: { warning: issues.filter((i) => i.severity === 'warning').length, info: issues.filter((i) => i.severity === 'info').length },
  });
});

server.registerTool('purge_unused', {
  description: 'Remove the component definitions, materials and tags that nothing in the model uses (like SketchUp Purge ' +
    'Unused), in one Undo step. Empty tags of the tag standard (made by setup_tags and not used yet) are kept unless ' +
    'keep_standard_tags=false. Returns how many of each were removed.',
  inputSchema: { keep_standard_tags: z.boolean().default(true) },
  annotations: DESTRUCTIVE,
}, async ({ keep_standard_tags }) => text(await call('check_model', {
  purge_only: true, keep_codes: keep_standard_tags ? Object.keys(TAG_STANDARD) : [],
}, 'purge_unused')));

// Tags shown or hidden in each kind of documentation scene (codes of the tag standard).
const SCENE_CODES = {
  plan_hide: ['CL', 'CO', 'RF'],
  floor_show: ['FL', 'SK', 'WL', 'PA', 'GL', 'DR', 'WN', 'EX'],
  ceiling_show: ['CL', 'CO', 'LT', 'EQ', 'WL', 'PA', 'GL', 'EX', 'DR', 'WN'],
  view_hide: ['RF'],
};
const SCENE_KINDS = ['plan', 'ceiling', 'floor', 'elevations', 'perspectives'];

server.registerTool('create_scenes', {
  description:
    'Create documentation scenes in one Undo step from the tag standard and the rooms (named groups without a tag): furniture ' +
    'plan (cut at cut_height_mm above the finished floor, ceilings hidden), reflected ceiling plan (ceilings, lights, equipment, ' +
    'walls and openings, seen from above in X-ray so it keeps the plan\'s orientation; the scene gets a style of its own with ' +
    'the current display settings and X-ray), floor finish plan (FL/SK with walls and doors), 4 elevations per room ' +
    '(A looks towards +Y, B +X, C -Y, D -X; cut just inside the room) and an eye-level perspective per room. With levels (named ' +
    'groups that hold rooms) the plans are made per level. Re-running replaces the scenes (and their section planes) an earlier ' +
    'call made for the same kinds and rooms, and keeps the others and the user\'s own scenes (replace=false keeps all). The section planes stay in the model on a hidden tag of their own (they still cut); ' +
    'the current view, style and tag visibility are restored.',
  inputSchema: {
    kinds: opt(jsonish(z.array(z.enum(SCENE_KINDS)))).describe(`Which scenes; default all: ${SCENE_KINDS.join(', ')}`),
    rooms: opt(jsonish(z.array(Str))).describe('Only these rooms (elevations and perspectives); default all'),
    cut_height_mm: z.number().positive().default(1200).describe('Plan section height above the finished floor'),
    language: opt(z.enum(['en', 'vi'])).describe('Built-in scene names; default: Vietnamese when the room names look Vietnamese, else English'),
    labels: opt(jsonish(z.strictObject({
      plan: opt(Str), ceiling: opt(Str), floor: opt(Str), elevation: opt(Str), perspective: opt(Str), looking: opt(Str),
      section_tag: opt(Str),
    }))).describe('Scene names (and the section planes tag) in any language, e.g. {"plan": "Grundriss", "elevation": "Ansicht"}'),
    replace: z.boolean().default(true).describe('Remove the scenes and section planes an earlier create_scenes call made for the same kinds and rooms'),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
}, async ({ kinds, rooms, cut_height_mm, language, labels, replace }) => {
  const l = labels || {};
  const map = {
    plan: l.plan, ceiling: l.ceiling, floor: l.floor, elev: l.elevation, persp: l.perspective, look: l.looking, sections: l.section_tag,
  };
  return text(await call('create_scenes', {
    kinds, rooms, cut_height: cut_height_mm, language, replace, codes: SCENE_CODES,
    labels: Object.fromEntries(Object.entries(map).filter(([, v]) => v)),
  }));
});

const DESIGN_CHECKS = ['ceiling_height', 'doors', 'clashes', 'passages', 'door_clearance', 'kitchen'];
const DESIGN_LIMITS = {
  min_ceiling_height_mm: 2400, min_local_height_mm: 2100, min_door_width_mm: 700, min_door_height_mm: 1950,
  min_passage_mm: 600, min_passage_low_mm: 300, ignore_gap_mm: 100, clash_tolerance_mm: 10, max_wall_thickness_mm: 600,
  kitchen_triangle_mm: [3600, 7900], kitchen_leg_mm: [1200, 2700],
};
// Doors with these words in their name, component or tag slide and are not checked for a swing zone.
const SLIDING_WORDS = ['slid', 'pocket', 'barn door', 'trượt', 'truot', 'lùa', 'lua', 'schiebe', 'coulissant', 'corredera', 'scorrevole', 'раздвиж', '推拉', '引き戸'];
// Words naming the kitchen work-triangle items: whole words; Chinese, Japanese, Korean and Thai as substrings; "*word" also
// matches the end of a compound word (German "Edelstahlspüle"). Extend with kitchen_words.
const KITCHEN_WORDS = {
  sink: ['sink', 'chậu rửa', 'chau rua', 'bồn rửa', 'bon rua', '*spüle', '*spuele', 'évier', 'evier', 'fregadero', 'lavello',
    'pia', 'gootsteen', 'spoelbak', 'zlew', 'zlewozmywak', 'wastafel', 'мойка', '水槽', 'シンク', '싱크', 'ซิงค์'],
  hob: ['hob', 'cooktop', 'stove', 'range', 'cooker', 'bếp từ', 'bep tu', 'bếp ga', 'bep ga', 'bếp điện', 'bep dien', '*kochfeld',
    '*herd', 'plaque de cuisson', 'cuisinière', 'cuisiniere', 'placa de cocina', 'vitrocerámica', 'piano cottura', 'fogão', 'fogao',
    'kookplaat', 'fornuis', 'kuchenka', 'płyta indukcyjna', 'płyta grzewcza', 'kompor', 'плита', '灶', '电磁炉', 'コンロ', '쿡탑',
    '가스레인지', '인덕션', 'เตา'],
  fridge: ['fridge', 'refrigerator', 'tủ lạnh', 'tu lanh', '*kühlschrank', '*kuehlschrank', 'réfrigérateur', 'refrigerateur',
    'frigo', 'nevera', 'frigorífico', 'frigorifero', 'geladeira', 'koelkast', 'lodówka', 'kulkas', 'холодильник', '冰箱',
    '冷蔵庫', '냉장고', 'ตู้เย็น'],
};
// A name with one of these words is not that item ("Range hood" is not a hob).
const KITCHEN_NOT = {
  hob: ['hood', 'extractor', 'hút mùi', 'hut mui', '*haube', 'dunstabzug', 'hotte', 'cappa', 'campana', 'afzuigkap', 'okap',
    'exaustor', 'coifa', 'вытяжка', '油烟机', 'レンジフード', '후드'],
};
const SUBSTR_SCRIPTS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;
// Words are runs of letters (with their combining marks); digits split words ("Sink1" = "sink").
const tokens = (s) => s.split(/[^\p{L}\p{M}]+/u).filter(Boolean);
// Locale-independent folding (toLocaleLowerCase would turn "SINK" into "sınk" on a Turkish system).
const fold = (s) => String(s == null ? '' : s).normalize('NFC').toLowerCase();

/** Does a name contain one of the words (see KITCHEN_WORDS for the rules)? */
function nameHas(name, words) {
  const s = fold(name);
  const ts = tokens(s);
  return (words || []).some((w0) => {
    let w = fold(w0).trim();
    const compound = w.startsWith('*');
    if (compound) w = w.slice(1).trim();
    if (!w) return false;
    if (SUBSTR_SCRIPTS.test(w)) return s.includes(w);
    const wt = tokens(w);
    if (!wt.length) return false;
    if (compound && wt.length === 1) return ts.some((t) => t.endsWith(wt[0]));
    for (let i = 0; i + wt.length <= ts.length; i++) if (wt.every((x, k) => ts[i + k] === x)) return true;
    return false;
  });
}

/** The tag's description without its code ("SN-01 Kitchen sink" -> "Kitchen sink"). */
const tagWords = (t) => String(t || '').replace(/^\s*[A-Za-z]{2}-\d+\s*/, '');

/** Kitchen work triangle per room from the candidates the bridge returns (sink, hob, fridge found by name, else by tag).
 *  Returns the issues and a note for each room where only some of the three were found. */
function kitchenIssues(items, words, range, legRange) {
  const out = [];
  const notes = [];
  const byRoom = new Map();
  for (const o of items || []) if (o.room) byRoom.set(o.room, [...(byRoom.get(o.room) || []), o]);
  for (const [room, list] of byRoom) {
    const used = new Set();
    const pick = (k, prefer) => {
      const ok = (txt) => nameHas(txt, words[k]) && !nameHas(txt, KITCHEN_NOT[k]);
      let cands = list.filter((x) => !used.has(x.id) && ok(`${x.name} ${x.def}`));
      if (!cands.length) cands = list.filter((x) => !used.has(x.id) && ok(tagWords(x.tag)));
      const o = cands.find((x) => x.code === prefer) || cands[0];
      if (o) used.add(o.id);
      return o;
    };
    const sink = pick('sink', 'SN');
    const hob = pick('hob', 'EQ');
    const fridge = pick('fridge', 'EQ');
    if (!sink || !hob || !fridge) {
      const missing = [['sink', sink], ['hob', hob], ['fridge', fridge]].filter(([, o]) => !o).map(([k]) => k);
      // a hob, or two of the three, make it a kitchen (a sink alone is a bathroom, a fridge alone a mini bar)
      if (hob || missing.length === 1) {
        notes.push(`Kitchen work triangle not checked in ${room}: no ${missing.join(' or ')} found by name or tag ` +
          '(name it, or add your word with kitchen_words).');
      }
      continue;
    }
    const d = (a, b) => Math.round(Math.hypot(a.x_mm - b.x_mm, a.y_mm - b.y_mm));
    const legs = [d(sink, hob), d(hob, fridge), d(fridge, sink)];
    const sum = legs[0] + legs[1] + legs[2];
    if (sum >= range[0] && sum <= range[1] && legs.every((l) => l >= legRange[0] && l <= legRange[1])) continue;
    out.push({
      check: 'kitchen_triangle', severity: 'info', room, value_mm: sum, limit_mm: range, leg_mm: legRange, legs_mm: legs,
      objects: [sink, hob, fridge].map((o) => ({ id: o.id, name: o.name, tag: o.tag })),
    });
  }
  return { issues: out, notes };
}

const DESIGN_TEXT = {
  ceiling_height: (i) => `Room ${i.room}: clear ceiling height ${i.value_mm} mm (main ceiling), below ${i.limit_mm} mm.`,
  ceiling_height_local: (i) => `Room ${i.room}: only ${i.value_mm} mm under ${who(i, 0)} (a bulkhead or lowered part), below ${i.limit_mm} mm.`,
  door_width: (i) => `${who(i, 0)}: overall door width ${i.value_mm} mm, below ${i.limit_mm} mm.`,
  door_height: (i) => `${who(i, 0)}: overall door height ${i.value_mm} mm, below ${i.limit_mm} mm.`,
  clash: (i) => `${who(i, 0)} and ${who(i, 1)} overlap by ${i.value_mm} mm${i.severity === 'info' ? ' (two pieces of furniture: may be intended, e.g. a chair under a table)' : ''}.`,
  passage: (i) => `Only ${i.value_mm} mm between ${who(i, 0)} and ${who(i, 1)} (passage below ${i.limit_mm} mm).`,
  door_clearance: (i) => `${who(i, 1)} stands in the swing zone of ${who(i, 0)}` +
    (i.severity === 'warning' ? ': both sides of the door are blocked.' : ': check the side the door opens to.'),
  kitchen_triangle: (i) => `Kitchen work triangle${i.room ? ` in ${i.room}` : ''}: ${i.value_mm} mm (sink-hob ${i.legs_mm[0]}, ` +
    `hob-fridge ${i.legs_mm[1]}, fridge-sink ${i.legs_mm[2]}); guideline: total ${i.limit_mm[0]}-${i.limit_mm[1]} mm, ` +
    `each leg ${i.leg_mm[0]}-${i.leg_mm[1]} mm.`,
};
function who(i, k) {
  const o = (i.objects || [])[k];
  return o ? `${o.name} (${o.tag}, id ${o.id})` : '?';
}

server.registerTool('check_design', {
  description:
    'Design checks on the tagged objects (read only), with limits you can change: clear ceiling height per room (FL top to CL ' +
    'underside, and the lowest point under bulkheads), overall door size (DR), clashes between furniture/joinery/equipment/sanitary ware (FN, JN, EQ, SN) and walls ' +
    '(WL, PA, GL, EX; furniture against furniture is info only, built-in EQ/SN in JN are allowed), tight passages between large ' +
    'pieces and walls in a room, furniture in a door swing zone (sliding doors skipped), and the kitchen work triangle (sink, ' +
    'hob and fridge found by name in several languages). ' +
    'Limits are common reference values, not a building-code check: set them to the project\'s rules. Every issue lists the ' +
    'object ids (select_entities + screenshot to show it). Objects are compared by their bounding boxes.',
  inputSchema: {
    checks: opt(jsonish(z.array(z.enum(DESIGN_CHECKS)))).describe(`Default all: ${DESIGN_CHECKS.join(', ')}`),
    limits: opt(jsonish(z.strictObject({
      min_ceiling_height_mm: opt(z.number().positive()), min_door_width_mm: opt(z.number().positive()),
      min_door_height_mm: opt(z.number().positive()), min_passage_mm: opt(z.number().positive()),
      min_local_height_mm: opt(z.number().positive()).describe('Lowest point under a bulkhead or lowered ceiling'),
      min_passage_low_mm: opt(z.number().positive()).describe('Passage when one piece is low (under 550 mm, e.g. a coffee table or bed)'),
      max_wall_thickness_mm: opt(z.number().positive()).describe('Thicker wall objects (a whole flat in one group) are listed, not checked'),
      kitchen_leg_mm: opt(z.array(z.number().positive()).length(2).refine((v) => v[0] <= v[1], 'min must be <= max')),
      ignore_gap_mm: opt(z.number().min(0)).describe('Gaps smaller than this are taken as "placed against" (not a passage)'),
      clash_tolerance_mm: opt(z.number().min(0)),
      kitchen_triangle_mm: opt(z.array(z.number().positive()).length(2).refine((v) => v[0] <= v[1], 'min must be <= max')),
    }))).describe(`Defaults: ${JSON.stringify(DESIGN_LIMITS)}`),
    kitchen_words: opt(jsonish(z.strictObject({ sink: opt(z.array(Str)), hob: opt(z.array(Str)), fridge: opt(z.array(Str)) })))
      .describe('Extra words naming the sink, hob and fridge in your component names (any language)'),
    sliding_words: opt(jsonish(z.array(Str))).describe('Extra words naming sliding/pocket doors (no swing zone check)'),
    include_hidden: z.boolean().default(false).describe('Also check hidden objects and objects on hidden tags'),
  },
  annotations: READ,
}, async ({ checks, limits, kitchen_words, sliding_words, include_hidden }) => {
  const lim = { ...DESIGN_LIMITS, ...Object.fromEntries(Object.entries(limits || {}).filter(([, v]) => v != null)) };
  const wanted = checks && checks.length ? checks : DESIGN_CHECKS;
  const r = (await call('check_design', {
    checks: wanted, limits: lim, include_hidden, exclude_codes: EXCLUDED_CODES,
    sliding_words: [...SLIDING_WORDS, ...(sliding_words || [])].map(fold),
    groups: { furniture: ['FN', 'JN', 'EQ', 'SN'], walls: ['WL', 'PA', 'GL', 'EX'], built_in: ['EQ', 'SN'] },
  })) || {};
  const words = Object.fromEntries(Object.entries(KITCHEN_WORDS).map(([k, v]) => [k, [...v, ...((kitchen_words && kitchen_words[k]) || [])]]));
  const kitchen = wanted.includes('kitchen') ? kitchenIssues(r.kitchen_items, words, lim.kitchen_triangle_mm, lim.kitchen_leg_mm)
    : { issues: [], notes: [] };
  const all = [...(Array.isArray(r.issues) ? r.issues : []), ...kitchen.issues];
  const issues = all.map((i) => ({ ...i, message: (DESIGN_TEXT[i.check] || ((x) => `${x.check}: ${x.value_mm} mm`))(i) }));
  const counts = {};
  for (const i of issues) counts[i.check] = (counts[i.check] || 0) + 1;
  const hidden = (Array.isArray(r.hidden) ? r.hidden : []).filter((h) => h.objects);
  // what could not be checked, so that no issue is not read as "all compliant"
  const notChecked = [...(Array.isArray(r.not_checked) ? r.not_checked : []), ...kitchen.notes];
  return text({
    issues, counts, objects_checked: r.objects_checked, rooms: r.rooms, limits: lim,
    ...(notChecked.length ? { not_checked: notChecked } : {}),
    ...(hidden.length ? { hidden_not_checked: hidden } : {}),
    ...(Array.isArray(r.walls_not_checked) && r.walls_not_checked.length ? { walls_not_checked: r.walls_not_checked } : {}),
    notes: ['Limits are reference values; set them to the project\'s rules (e.g. 900 mm for a comfortable or accessible passage). ' +
      'Objects are compared by their bounding boxes in their own axes, so results for round or L-shaped pieces are approximate.' +
      (notChecked.length ? ' not_checked lists checks that could not run: report them, no issue there does not mean compliant.' : '') +
      (Array.isArray(r.walls_not_checked) && r.walls_not_checked.length ? ' walls_not_checked: wall groups thicker than ' +
        `${lim.max_wall_thickness_mm} mm (several walls in one group) were not used for clashes and passages.` : '')],
  });
});

// ---------------------------------------------------------------- modelling
bridgeTool('create_box',
  'Create a rectangular box (group). width along X, depth along Y, height along Z, in mm.\n' +
  "origin [x,y,z] mm is the lower-left corner. Missing tags/materials are created; color is '#RRGGBB' or a color name " +
  '(only applied when the material is newly created; an existing material keeps its color).' + RETURNS,
  {
    width: z.number().describe('Size along the X axis (mm), > 0'),
    depth: z.number().describe('Size along the Y axis (mm), > 0'),
    height: z.number().describe('Size along the Z axis (mm), > 0'),
    origin: opt(Point).describe('MIN corner (bottom-left-front) [x,y,z] mm, NOT the center; default [0,0,0]'),
    name: opt(Str), tag: opt(Str), material: opt(Str), color: opt(Str),
  }, EDIT, withTagStyle);

bridgeTool('create_shape',
  'Draw a flat face from a polygon (list of [x,y,z] mm points, >= 3 coplanar points) in a new group.\n' +
  'pushpull (mm) extrudes it into a solid (e.g. draw a floor outline, then pull it up to the slab thickness).' + RETURNS,
  {
    points: jsonish(z.array(Point)).describe('Polygon vertices [[x,y,z],...] mm, >= 3 coplanar points, in order around the perimeter'),
    pushpull: opt(z.number()).describe('Extrusion thickness (mm); a horizontal face is pulled up along +Z'),
    name: opt(Str), tag: opt(Str), material: opt(Str), color: opt(Str),
  }, EDIT, withTagStyle);

bridgeTool('create_lines',
  'Draw a polyline through [x,y,z] mm points in a new group. close_face=true: closes back to the first point and creates a face (the result has face_created).',
  {
    points: jsonish(z.array(Point)), close_face: z.boolean().default(false),
    name: opt(Str), tag: opt(Str),
  }, EDIT, withTagStyle);

bridgeTool('insert_component',
  "Insert a component: from a .skp file (path, e.g. 'D:/Library/table.skp') or from a definition already in\n" +
  'the model (definition = name). position [x,y,z] mm, rotation_deg rotates about the Z axis.',
  {
    path: opt(Str), definition: opt(Str),
    position: opt(Point).describe('Insertion point (component origin) [x,y,z] mm'),
    rotation_deg: z.number().default(0),
    name: opt(Str), tag: opt(Str), material: opt(Str),
  }, EDIT, withTagStyle);

bridgeTool('transform_entities',
  'Move / rotate / scale entities. Empty entity_ids = use the current selection.\n' +
  'translate [dx,dy,dz] mm; rotate_deg about axis (default Z) at pivot (mm, default entity center);\n' +
  'scale is a uniform factor. Order applied: scale -> rotate -> translate.',
  {
    entity_ids: opt(Ids).describe(`${IDS_DESC} Empty = current selection.`),
    translate: opt(Point).describe('RELATIVE offset [dx,dy,dz] mm, not a target position'),
    rotate_deg: opt(z.number()).describe('Rotation angle (degrees), positive = counterclockwise when viewed from the axis tip'),
    axis: opt(jsonish(z.array(z.number()).length(3))).describe('Rotation axis [x,y,z]; default [0,0,1]'),
    scale: opt(z.number().positive()).describe('Uniform scale factor, > 0 (e.g. 1.5)'),
    pivot: opt(Point).describe('Rotation/scale center [x,y,z] mm; default = bounding box center of the FIRST entity'),
  }, EDIT);

bridgeTool('set_material',
  'Apply a material to entities (entity_ids or the current selection). A missing material is created with color; ' +
  'an EXISTING material keeps its color (unless update_existing=true).',
  {
    material: Str, color: opt(Str),
    entity_ids: opt(Ids).describe(`${IDS_DESC} Empty = current selection.`),
    back_too: z.boolean().default(false),
    update_existing: opt(z.boolean()).describe('true = also recolor an EXISTING material (affects EVERY entity that uses it)'),
  }, EDIT_IDEMPOTENT);

bridgeTool('set_tag',
  'Assign a tag to entities (entity_ids or the current selection). A missing tag is created (in its category folder with its ' +
  'category color when it follows the tag standard). Tag groups/components, not raw faces or edges.',
  { tag: Str, entity_ids: opt(Ids).describe(`${IDS_DESC} Empty = current selection.`) }, EDIT_IDEMPOTENT, withTagStyle);

bridgeTool('make_group',
  'Put existing entities into a new group (they must be at the level being edited, e.g. the top level). Use it for rooms: ' +
  'a named group WITHOUT a tag (e.g. name "Living room") holding the finishes and items of that room, so interior_takeoff ' +
  'can split quantities by room. With tag, it makes an assembly (e.g. several skirting runs).' + RETURNS,
  {
    entity_ids: Ids.describe(IDS_DESC),
    name: opt(Str).describe('Group name, e.g. the room name "Living room" or "Level 2 / Bedroom 1" is built from nested rooms'),
    tag: opt(Str).describe('Leave empty for a room'),
  }, EDIT, withTagStyle);

bridgeTool('delete_entities',
  'Delete entities by id (ids are required; never deletes by selection). Can be undone.',
  { entity_ids: Ids.describe(IDS_DESC) }, DESTRUCTIVE);

bridgeTool('select_entities',
  'Select entities by id in SketchUp (so the user can see them, or for later tools to use).',
  { entity_ids: Ids.describe(IDS_DESC), clear: z.boolean().default(true) }, EDIT_IDEMPOTENT);

bridgeTool('undo',
  'Undo the last step in SketchUp (every model-editing tool is one Undo step).',
  {}, DESTRUCTIVE);

bridgeTool('run_ruby',
  'Run arbitrary Ruby code in SketchUp (Ruby API). Use it when the other tools are not enough.\n' +
  'Useful objects: Sketchup.active_model, model.entities, model.selection. Internal units are inches:\n' +
  'use 1000.mm, x.to_mm. The whole snippet is one Undo step. Returns the last value (inspect) and the puts output.\n' +
  'Rules: do NOT call start_operation/commit_operation (the bridge already wraps the code in one Undo step); find entities with ' +
  'Sketchup.active_model.find_entity_by_id(id); check face.normal before pushpull; vertex coordinates inside a group are ' +
  'local (multiply by the parent group transformation); end with a value or puts; never call exit.',
  { code: Str }, DESTRUCTIVE);

// ---------------------------------------------------------------- view / export / file
bridgeTool('set_view',
  'Set a standard view and zoom extents. iso defaults to perspective, the other views to parallel projection.',
  { view: ViewName.default('iso'), perspective: opt(z.boolean()), zoom_extents: z.boolean().default(true) },
  EDIT_IDEMPOTENT);

server.registerTool('screenshot', {
  description:
    'Capture the SketchUp viewport and return the image so Claude can see it directly (to check modelling results).\n' +
    'Empty view = keep the current view. With view, the camera changes only temporarily for the capture and the previous view is restored afterwards.',
  inputSchema: {
    view: opt(ViewName).describe("Temporary capture view; empty = the user's current view"),
    max_size: z.number().int().min(64).max(4096).default(1024).describe('Longest image side (px), keeps the viewport aspect ratio'),
    width: opt(z.number().int().min(16).max(4096)).describe('Fixed size (use together with height); if only width or height is given it is treated as the longest side'),
    height: opt(z.number().int().min(16).max(4096)),
  },
  annotations: READ,
}, ({ view, max_size, width, height }) => exclusive(async () => {
  const file = path.join(os.tmpdir(), `sketchup_mcp_${process.pid}_${randomUUID()}.png`);
  // Only width or only height given: treat it as the longest side.
  const size = width && height ? { width, height } : { max_size: width || height || max_size };
  try {
    const r = await sendNow('export_png', { path: file, view, restore_view: true, ...size }, 'screenshot');
    let data;
    try {
      data = await fs.readFile(file);
    } catch {
      throw new SketchUpError(`SketchUp could not export the image (${JSON.stringify(r)}).`);
    }
    const info = { width: r && r.width, height: r && r.height, view: view ?? 'current', restored: r ? r.restored === true : false };
    if (view && r && r.restored === undefined) {
      // Old bridge (1.0.0) does not know restore_view: the user's view has been changed.
      info.warning = 'The SketchUp bridge is outdated and did not restore the view after the capture (the view was changed): ' +
        'run install_sketchup_bridge, then fully quit and reopen SketchUp.';
    }
    return {
      content: [
        { type: 'image', data: data.toString('base64'), mimeType: 'image/png' },
        { type: 'text', text: JSON.stringify(info) },
      ],
    };
  } finally {
    await fs.rm(file, { force: true }).catch(() => {});
    // After a timeout SketchUp may still write the file later: clean it up again afterwards.
    setTimeout(() => { fs.rm(file, { force: true }).catch(() => {}); }, (TIMEOUT + 60) * 1000).unref();
  }
}));

bridgeTool('export_png',
  "Export the viewport as a PNG/JPG file (e.g. 'D:/Export/perspective.png'). width/height in pixels; view changes the camera first.",
  {
    path: Str, width: opt(z.number().int()), height: opt(z.number().int()),
    view: opt(ViewName), transparent: z.boolean().default(false),
  }, DESTRUCTIVE);

bridgeTool('export_file',
  'Export the model to a 3D/2D file chosen by extension (dae, obj, stl, fbx, dwg, dxf, 3ds...). Some formats require SketchUp Pro.',
  { path: Str }, DESTRUCTIVE);

bridgeTool('save_model',
  'Save the model. Empty path = overwrite the current file; with path = Save As.',
  { path: opt(Str) }, DESTRUCTIVE);

bridgeTool('open_model',
  'Open a .skp file in SketchUp.',
  { path: Str }, DESTRUCTIVE);

bridgeTool('new_model',
  'Create a new (empty) model.',
  {}, DESTRUCTIVE);

// ---------------------------------------------------------------- install the Ruby bridge into SketchUp
// main.rb first, loader su_mcp.rb last: if something fails in between, SketchUp never loads a loader without main.rb.
const BRIDGE_FILES = ['su_mcp/main.rb', 'su_mcp.rb'];

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Folder containing su_mcp.rb: "bridge/" in the .mcpb package, or "extension/" when running from source. */
async function bridgeSourceDir() {
  for (const dir of [path.join(HERE, '..', 'bridge'), path.join(HERE, '..', '..', 'extension')]) {
    if (await exists(path.join(dir, 'su_mcp.rb'))) return dir;
  }
  throw new Error('Bridge files (su_mcp.rb) not found in the extension package.');
}

/** The user's root folder that contains "SketchUp 20xx". */
function sketchupUserRoot() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'SketchUp');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  return null;
}

async function listSketchUpVersions(root) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isDirectory() && /^SketchUp \d{4}$/.test(e.name))
    .map((e) => e.name.slice('SketchUp '.length))
    .sort();
}

server.registerTool('install_sketchup_bridge', {
  description:
    'Install (or update) the "SU MCP Bridge" extension in SketchUp so the other tools can connect. ' +
    'Copies su_mcp.rb + su_mcp/main.rb into the Plugins folder of every SketchUp version found ' +
    '(Windows: %APPDATA%/SketchUp/SketchUp 20xx/SketchUp/Plugins). SketchUp must be restarted afterwards. ' +
    'Empty versions = every version opened at least once; dry_run=true only reports what would be done. ' +
    'Also returns the path of su_mcp.rbz for a manual install via Extension Manager.',
  inputSchema: {
    versions: opt(jsonish(z.array(z.string().regex(/^\d{4}$/)))),
    dry_run: z.boolean().default(false),
  },
  annotations: { ...EDIT_IDEMPOTENT, title: 'Install SU MCP Bridge' },
}, async ({ versions, dry_run }) => {
  const src = await bridgeSourceDir();
  let rbz = null;
  for (const p of [path.join(src, 'su_mcp.rbz'), path.join(src, '..', 'su_mcp.rbz')]) {
    if (await exists(p)) { rbz = p; break; }
  }
  const root = sketchupUserRoot();
  if (!root) throw new Error(`There is no SketchUp on ${process.platform}.`);

  const found = await listSketchUpVersions(root);
  const wanted = versions && versions.length ? versions : found;
  const results = [];
  for (const ver of wanted) {
    const verDir = path.join(root, `SketchUp ${ver}`);
    if (!found.includes(ver)) {
      results.push({ version: ver, status: 'skipped', reason: `${verDir} not found (open SketchUp ${ver} at least once).` });
      continue;
    }
    const plugins = path.join(verDir, 'SketchUp', 'Plugins');
    try {
      const existedBefore = await exists(path.join(plugins, 'su_mcp.rb'));
      let changed = 0;
      for (const rel of BRIDGE_FILES) {
        const want = await fs.readFile(path.join(src, rel));
        const dest = path.join(plugins, rel);
        const have = await fs.readFile(dest).catch(() => null);
        if (have && have.equals(want)) continue;
        changed++;
        if (!dry_run) {
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.writeFile(dest, want);
        }
      }
      let status = 'unchanged';
      if (changed > 0 && dry_run) status = existedBefore ? 'would_update' : 'would_install';
      else if (changed > 0) status = existedBefore ? 'updated' : 'installed';
      results.push({ version: ver, status, plugins_dir: plugins });
    } catch (e) {
      results.push({ version: ver, status: 'error', plugins_dir: plugins, error: `${e.code || e.name}: ${e.message}` });
    }
  }

  const done = results.filter((r) => r.status === 'installed' || r.status === 'updated');
  const pending = results.filter((r) => r.status === 'would_install' || r.status === 'would_update');
  const failed = results.filter((r) => r.status === 'error');
  let note;
  if (done.length) note = `Bridge copied for SketchUp ${done.map((r) => r.version).join(', ')}. Fully quit and reopen SketchUp; check Extensions > SU MCP Bridge > Status.`;
  else if (pending.length) note = `Dry run: would install/update for SketchUp ${pending.map((r) => r.version).join(', ')}. Call again with dry_run=false, then fully quit and reopen SketchUp.`;
  else if (found.length === 0) note = 'No SketchUp version that has been opened at least once was found on this machine.';
  else note = 'Nothing changed.';
  if (failed.length) note += ` Errors for SketchUp ${failed.map((r) => r.version).join(', ')} (see the error field); you can install rbz_path manually via Extension Manager.`;

  return text({
    dry_run,
    sketchup_root: root,
    results,
    rbz_path: rbz,
    note,
  });
});

// ---------------------------------------------------------------- startup
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`v${VERSION} ready, SketchUp at ${HOST}:${PORT} (timeout ${TIMEOUT}s)`);
}

main().catch((e) => {
  log(`Startup error: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});

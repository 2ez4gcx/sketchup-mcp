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
  'selection_info', 'quantity_takeoff', 'screenshot', 'set_view', 'select_entities']);
const NO_UNDO_CMDS = new Set(['undo', 'save_model', 'open_model', 'new_model', 'export_file', 'export_png']);

function afterSendHint(cmd) {
  if (READ_ONLY_CMDS.has(cmd)) {
    return " This command does not modify the model and can be retried; for large models increase 'Timeout' first (Settings > Extensions > SketchUp MCP > Configure).";
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
function call(cmd, params = {}) {
  return exclusive(() => sendNow(cmd, params));
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

/** Register a tool that just forwards its arguments to the SketchUp command of the same name. */
function bridgeTool(name, description, inputSchema, annotations) {
  server.registerTool(name, { description, inputSchema, annotations }, async (args) => text(await call(name, args)));
}

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
  'List tags (layers): name, visible/hidden, and number of entities using the tag (including inside definitions).',
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
  'instance count per component. Untagged/unpainted entities inherit from their parent group.',
  {
    group_by: z.enum(['tag', 'material']).default('tag').describe('Group by "tag" (layer) or by "material"'),
    selection_only: z.boolean().default(false),
    include_hidden: z.boolean().default(false),
  }, READ);

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
  }, EDIT);

bridgeTool('create_shape',
  'Draw a flat face from a polygon (list of [x,y,z] mm points, >= 3 coplanar points) in a new group.\n' +
  'pushpull (mm) extrudes it into a solid (e.g. draw a floor outline, then pull it up to the slab thickness).' + RETURNS,
  {
    points: jsonish(z.array(Point)).describe('Polygon vertices [[x,y,z],...] mm, >= 3 coplanar points, in order around the perimeter'),
    pushpull: opt(z.number()).describe('Extrusion thickness (mm); a horizontal face is pulled up along +Z'),
    name: opt(Str), tag: opt(Str), material: opt(Str), color: opt(Str),
  }, EDIT);

bridgeTool('create_lines',
  'Draw a polyline through [x,y,z] mm points in a new group. close_face=true: closes back to the first point and creates a face (the result has face_created).',
  {
    points: jsonish(z.array(Point)), close_face: z.boolean().default(false),
    name: opt(Str), tag: opt(Str),
  }, EDIT);

bridgeTool('insert_component',
  "Insert a component: from a .skp file (path, e.g. 'D:/Library/table.skp') or from a definition already in\n" +
  'the model (definition = name). position [x,y,z] mm, rotation_deg rotates about the Z axis.',
  {
    path: opt(Str), definition: opt(Str),
    position: opt(Point).describe('Insertion point (component origin) [x,y,z] mm'),
    rotation_deg: z.number().default(0),
    name: opt(Str), tag: opt(Str), material: opt(Str),
  }, EDIT);

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
  'Assign a tag to entities (entity_ids or the current selection). A missing tag is created.',
  { tag: Str, entity_ids: opt(Ids).describe(`${IDS_DESC} Empty = current selection.`) }, EDIT_IDEMPOTENT);

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

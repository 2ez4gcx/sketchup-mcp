// Creates the release folder ../release/SketchUpMCP_v<version>/ plus a .zip with the same name.
// Takes files only from dist/ (build output) and release-docs/en, release-docs/vi - never from the project root.
//   npm run release   (= build + unit-test + release)
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zipSync } from 'fflate';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const DOCS_EN = path.join(ROOT, 'release-docs', 'en');
const DOCS_VI = path.join(ROOT, 'release-docs', 'vi');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const v = pkg.version;
const NAME = `SketchUpMCP_v${v}`;
const OUT_ROOT = path.join(ROOT, '..', 'release');
const OUT = path.join(OUT_ROOT, NAME);
const DIR_EXT = '01_CLAUDE_EXTENSION';
const DIR_RBZ = '02_SKETCHUP_PLUGIN_BACKUP';
const DIR_VI = 'vi';
const d0 = new Date();
const today = `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, '0')}-${String(d0.getDate()).padStart(2, '0')}`;

const mcpb = path.join(DIST, `${pkg.name}-${v}.mcpb`);
const rbz = path.join(DIST, `su_mcp-${v}.rbz`);
const notices = path.join(DIST, 'THIRD_PARTY_NOTICES.txt');
for (const f of [mcpb, rbz, notices]) if (!fs.existsSync(f)) throw new Error(`Missing ${f} - run "npm run build" first.`);

const guideEn = path.join(DOCS_EN, 'GUIDE.html');
const promptsEn = path.join(DOCS_EN, 'SAMPLE_PROMPTS.txt');
const guideVi = path.join(DOCS_VI, 'HUONG_DAN_SU_DUNG.html');
const promptsVi = path.join(DOCS_VI, 'CAU_LENH_MAU.txt');
for (const f of [guideEn, promptsEn, guideVi, promptsVi]) if (!fs.existsSync(f)) throw new Error(`Missing release document ${f}.`);

fs.rmSync(OUT, { recursive: true, force: true });
for (const d of [DIR_EXT, DIR_RBZ, DIR_VI]) fs.mkdirSync(path.join(OUT, d), { recursive: true });
fs.copyFileSync(mcpb, path.join(OUT, DIR_EXT, path.basename(mcpb)));
fs.copyFileSync(rbz, path.join(OUT, DIR_RBZ, 'su_mcp.rbz'));
// Plain-text docs get Windows line endings (CRLF) whatever the checkout uses, so builds are identical.
const copyText = (src, dest) => fs.writeFileSync(dest, fs.readFileSync(src, 'utf8').replace(/\r?\n/g, '\r\n'));
copyText(promptsEn, path.join(OUT, 'SAMPLE_PROMPTS_EN.txt'));
copyText(promptsVi, path.join(OUT, DIR_VI, 'CAU_LENH_MAU.txt'));
fs.copyFileSync(notices, path.join(OUT, 'THIRD_PARTY_NOTICES.txt'));
fs.copyFileSync(path.join(ROOT, '..', 'LICENSE'), path.join(OUT, 'LICENSE.txt'));

// Guides: fill in __VERSION__ / __DATE__, write the .html, then print it to .pdf.
const writeGuide = (src, rel) => {
  const html = fs.readFileSync(src, 'utf8').replaceAll('__VERSION__', v).replaceAll('__DATE__', today);
  const out = path.join(OUT, rel);
  fs.writeFileSync(out, html);
  return out;
};
const guides = [
  writeGuide(guideEn, 'GUIDE_EN.html'),
  writeGuide(guideVi, `${DIR_VI}/HUONG_DAN_SU_DUNG.html`),
];

// PDF via Microsoft Edge (built into Windows 10/11); skipped if Edge is not installed.
const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe']
  .find((p) => fs.existsSync(p));
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function printPdf(htmlOut) {
  const pdf = htmlOut.replace(/\.html$/i, '.pdf');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sumcp-edge-'));
  try {
    execFileSync(edge, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', `--user-data-dir=${profile}`,
      `--print-to-pdf=${pdf}`, pathToFileURL(htmlOut).href], { stdio: 'ignore', timeout: 120_000 });
    // Edge exits before its background process has finished writing the PDF: wait until the file
    // exists and its size is stable (at most 60 s).
    let last = -1;
    for (let i = 0; i < 120; i++) {
      const size = fs.existsSync(pdf) ? fs.statSync(pdf).size : -1;
      if (size > 0 && size === last) break;
      last = size;
      sleep(500);
    }
  } catch (e) {
    console.warn(`Could not create the PDF ${path.basename(pdf)}: ${e.message}`);
  } finally {
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      // Edge may still hold files in the temporary profile; ignore.
    }
  }
  if (!fs.existsSync(pdf)) console.warn(`Warning: ${path.relative(OUT, pdf)} is missing (the .html version is still there).`);
}
if (edge) for (const g of guides) printPdf(g);
else console.warn('Microsoft Edge not found - skipping the PDF versions.');

fs.writeFileSync(path.join(OUT, 'CHANGELOG.txt'), [
  `SketchUp MCP ${v}  (${today})`,
  `  - Claude Desktop extension : ${DIR_EXT}/${path.basename(mcpb)}`,
  `  - SketchUp plugin          : SU MCP Bridge ${v} (install from the chat: "Install SU MCP Bridge in SketchUp";`,
  `                               backup: ${DIR_RBZ}/su_mcp.rbz)`,
  '  - User guide               : GUIDE_EN.html / GUIDE_EN.pdf, sample prompts: SAMPLE_PROMPTS_EN.txt',
  `  - Vietnamese (Tieng Viet)  : ${DIR_VI}/HUONG_DAN_SU_DUNG.html / .pdf, ${DIR_VI}/CAU_LENH_MAU.txt`,
  '',
  'UPDATE RULE: always update BOTH parts - install the new .mcpb file, then type "Install SU MCP Bridge in SketchUp",',
  'then fully quit and reopen SketchUp. "Ping SketchUp" shows the version of both parts and warns if the plugin is outdated.',
  '',
  '1.3.0',
  '  - Professional tags: Claude tags what it models like a finish schedule, "CODE-NN description" (e.g. "FL-01 Engineered',
  '    oak floor 12mm"): one tag per specification = one line of the bill of quantities. Codes: FL floor, SK skirting,',
  '    WL wall finish, PA partition, CL ceiling, CO cornice, DR door, WN window, GL glass partition, JN built-in joinery,',
  '    FN loose furniture, LT lighting, SN sanitary ware, EQ equipment, CU curtain, DE decor, EX existing structure,',
  '    RF reference. A tag scheme already in the model is followed instead.',
  '  - New tool setup_tags: creates the tags of a finish schedule in one Undo step, each in its category folder',
  '    (SketchUp 2021+, e.g. "FL Floor finishes" / "FL San") with a category color (Tags panel > Color by tag).',
  '    New tags created by the modelling tools get the same folder and color; existing tags are not restyled',
  '    (setup_tags restyles them only with update_existing=true).',
  '  - New tool interior_takeoff: interior bill of quantities, one row per tag with the right unit - floors and',
  '    ceilings in m2 (each board once, sloped parts at their real area), walls/partitions/glass in m2 of one side,',
  '    skirting/cornices in m, curtains in width x height, existing structure in m3, items by count - with totals',
  '    per category, warnings (geometry in no tagged object, walls that are not thin objects) and an optional CSV',
  '    file for Excel (comma or semicolon format).',
  '  - Quantities by room: by_room=true splits every line by room (a room = a named group without a tag, e.g.',
  '    "Living room", nested for levels: "Level 2 / Bedroom 1"); the CSV then has one column per room.',
  '  - New tool make_group: puts entities into a new group (e.g. a room).',
  '  - list_tags shows the tag folder. quantity_takeoff: objects on tags inside a hidden tag folder (SketchUp 2021+) are',
  '    now skipped like objects on hidden tags (include_hidden=true includes them).',
  '',
  '1.2.0',
  '  - English edition: the SketchUp menu (Extensions > SU MCP Bridge: Start server, Stop server, Status, Open log file,',
  '    Change port...), status bar, dialogs, error messages, notes, tool descriptions and the instructions for Claude',
  '    are now in English.',
  '  - Bilingual documentation: English guide (GUIDE_EN) and sample prompts (SAMPLE_PROMPTS_EN.txt); the Vietnamese guide',
  '    and sample prompts are in vi/ and quote the English menu and messages.',
  '  - Sample prompt files explain that the wording does not have to be exact: Claude understands natural language in any',
  '    language; only numbers/units, object names, file paths and risky actions need to be precise.',
  `  - Release package: English folder names (${DIR_EXT}, ${DIR_RBZ}); CHANGELOG.txt replaces PHIEN_BAN.txt.`,
  '  - Released under the MIT License (LICENSE.txt, also inside the .mcpb).',
  '  - Tested on SketchUp 2021 and 2023 (Windows).',
  '',
  '1.1.0 (changes since 1.0.0)',
  '  - Errors in run_ruby (including exit and infinite recursion) are reported immediately instead of after 120 s,',
  '    and partial changes are always rolled back; non-UTF-8 strings (TCVN3/VNI) no longer break the result.',
  '  - Stray connections (e.g. port scans) are closed after at most 5 s.',
  '  - Timeout on a model-editing command: clearly says "may have already run, do not repeat" to avoid duplicated geometry.',
  '  - run_ruby errors show the line number in the code; an unsupported command suggests updating the plugin.',
  '  - Ping checks the plugin/extension versions.',
  '  - Screenshot restores the previous view after the capture; the image keeps the viewport aspect ratio (long side 1024 px).',
  '  - Assigning a material no longer silently recolors an EXISTING material (to recolor it: update_existing=true).',
  '  - SketchUp menu: detailed Status (startup error, port taken by another window, last command), Open log file, Change port...',
  '  - create_lines close_face closes the outline automatically and reports face_created; image/file export creates missing folders.',
  '  - Quantity takeoff note: face_area_m2 is the total area of all faces (not floor area).',
  '  - Instructions for Claude: 7 safe working rules (check first, undo when wrong, never guess ids...).',
  '',
  'Notes',
  '  - run_ruby runs on the SketchUp main thread with no time limit - an infinite loop freezes SketchUp; in that case',
  '    close SketchUp with Task Manager (unsaved changes will be lost).',
  '  - Model data: when you ask, Claude reads model information (object names, quantities, screenshots...) and sends it',
  "    to Anthropic's Claude service for processing. Follow your organization's rules for confidential projects and test on",
  '    a copy of the project file.',
  '',
  'License: MIT (see LICENSE.txt). Third-party libraries: see THIRD_PARTY_NOTICES.txt.',
  '',
].join('\r\n'));

// SHA256SUMS + zip
const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else files.push(p);
  }
};
walk(OUT);
files.sort();
const rel = (p) => path.relative(OUT, p).split(path.sep).join('/');
const sums = files.map((f) => `${crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}  ${rel(f)}`);
fs.writeFileSync(path.join(OUT, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
files.push(path.join(OUT, 'SHA256SUMS.txt'));

const entries = {};
for (const f of files) entries[`${NAME}/${rel(f)}`] = new Uint8Array(fs.readFileSync(f));
const zipPath = path.join(OUT_ROOT, `${NAME}.zip`);
fs.writeFileSync(zipPath, zipSync(entries, { level: 9 }));

console.log(`Release folder: ${OUT}`);
for (const f of files) console.log(`  ${rel(f).padEnd(48)} ${String(fs.statSync(f).size).padStart(9)} B`);
console.log(`Zip to share: ${zipPath} (${Math.round(fs.statSync(zipPath).size / 1024)} KB)`);

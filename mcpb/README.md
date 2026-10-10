# SketchUp MCP - Claude Desktop extension (`.mcpb`)

This folder holds the Node.js MCP server for SketchUp and the scripts that package it as a **single `.mcpb` file**
(about 200 KB), a Claude Desktop Extension. Claude Desktop runs it on its own built-in Node.js, so end users do **not**
need to install Python or Node.js.

```
Claude Desktop --stdio/MCP--> sketchup-mcp.mcpb (Node, built in) --TCP 127.0.0.1:9876--> SU MCP Bridge (Ruby) in SketchUp
```

The Ruby side ("SU MCP Bridge", a SketchUp extension) lives in [`../extension/`](../extension). It is bundled inside
the `.mcpb`, so the `install_sketchup_bridge` tool can copy it into SketchUp's Plugins folder.

End-user documentation: [`release-docs/en/GUIDE.html`](release-docs/en/GUIDE.html) (English) and
[`release-docs/vi/HUONG_DAN_SU_DUNG.html`](release-docs/vi/HUONG_DAN_SU_DUNG.html) (Vietnamese).
This README is for developers.

## Layout

| Path | What it is |
|---|---|
| `src/index.mjs` | The MCP server: 26 tools, TCP client for the bridge, `install_sketchup_bridge`. |
| `manifest.json` | MCPB manifest (manifest_version 0.3): tool list, `user_config` (port, timeout), compatibility. |
| `scripts/build.mjs` | `npm run build`: bundle, `.rbz`, notices, validate, pack. |
| `scripts/versions.mjs` | Checks that the version matches in all 4 places (used by the build and the unit tests). |
| `scripts/smoke-test.mjs` | Starts the server over stdio: `initialize` + `tools/list`; with `--live`, read-only calls to SketchUp. |
| `scripts/unit-test.mjs` | Behaviour tests against a fake bridge; no SketchUp needed. |
| `scripts/release.mjs` | Builds the release folder and zip from `dist/` and `release-docs/`. |
| `scripts/make-icon.mjs` | Draws `icon.png` (512x512) with plain Node; the build runs it only if `icon.png` is missing. |
| `release-docs/en/`, `release-docs/vi/` | User guides (HTML) and sample prompts (TXT), English and Vietnamese. |
| `dist/` | Build output (git-ignored). |

## Tools

| Group | Tools |
|---|---|
| Read / quantities | `ping`, `model_info`, `list_tags`, `list_components`, `list_materials`, `selection_info`, `quantity_takeoff` |
| Modelling | `create_box`, `create_shape`, `create_lines`, `insert_component`, `transform_entities`, `set_material`, `set_tag`, `delete_entities`, `select_entities`, `undo` |
| Arbitrary Ruby | `run_ruby` |
| View / files | `set_view`, `screenshot`, `export_png`, `export_file`, `save_model`, `open_model`, `new_model` |
| Setup | `install_sketchup_bridge`: install or update the bridge in the Plugins folder of every SketchUp version opened at least once. `dry_run=true` only reports what it would do; `versions=["2026"]` picks versions. |

Units: lengths in mm, areas in m², volumes in m³, angles in degrees; Z is up. Every model-editing tool is one Undo step.

## Prerequisites

- **Node.js 18 or later** (CI uses Node 22) and npm.
- `npm install` (or `npm ci`) in this folder. All dependencies are dev dependencies: esbuild bundles everything into one
  file, so the `.mcpb` contains no `node_modules`.
- SketchUp is **not** needed to build or test. Only `smoke-test.mjs --live` talks to a real SketchUp.
- Windows is the reference platform: the `install_sketchup_bridge` unit tests use `%APPDATA%`-style paths, and the
  release script prints the PDFs with Microsoft Edge.

## Commands

```bash
cd mcpb
npm install
npm run build                        # bundle + .rbz + notices + mcpb validate/pack -> dist/
npm test                             # smoke test + unit tests with a fake bridge (no SketchUp needed)
npm run release                      # build + unit tests + ../release/SketchUpMCP_v<v>/ folder and .zip
node scripts/smoke-test.mjs --live   # read-only tools against the SketchUp that is open now
```

### `npm run build` (`scripts/build.mjs`)

1. **Version check**: reads the version from the 4 places listed under [Versioning](#versioning) and stops with
   `Version mismatch, all must be <v>` plus the list of values if any of them differs.
2. **Bundle**: esbuild bundles `src/index.mjs` and its dependencies into `dist/bundle/server/index.mjs` (ESM,
   `target: node18`) and bakes the version in as `__SKETCHUP_MCP_VERSION__` and `__BRIDGE_VERSION__`.
3. **Third-party notices**: collects the license text of every npm package that ended up in the bundle and writes
   `dist/bundle/server/THIRD_PARTY_NOTICES.txt` and `dist/THIRD_PARTY_NOTICES.txt`.
4. **Bridge**: copies `../extension/su_mcp.rb` and `../extension/su_mcp/main.rb` into `dist/bundle/bridge/`, then
   builds `su_mcp.rbz` from those same files: a zip with exactly `su_mcp.rb` and `su_mcp/main.rb` (forward-slash
   paths). The zip is reopened and compared byte by byte with the sources; any difference fails the build.
5. **Pack**: `mcpb validate` on the staged manifest, then `mcpb pack` (from the pinned `@anthropic-ai/mcpb`
   dev dependency).

Output:

```
dist/
  sketchup-mcp-<v>.mcpb          <- the Claude Desktop extension
  su_mcp-<v>.rbz                 <- the SketchUp plugin, for a manual install via Extension Manager
  THIRD_PARTY_NOTICES.txt
  bundle/                        <- staging folder = contents of the .mcpb:
    manifest.json
    icon.png
    server/index.mjs
    server/THIRD_PARTY_NOTICES.txt
    bridge/su_mcp.rb
    bridge/su_mcp/main.rb
    bridge/su_mcp.rbz
```

The `.rbz` is always rebuilt from `../extension/`; never edit an `.rbz` by hand. Any other `su_mcp.rbz` lying around
(for example an older one at the repository root) is not used.

### `npm test`

Runs `scripts/smoke-test.mjs` and then `scripts/unit-test.mjs`, both against the **built** bundle
`dist/bundle/server/index.mjs`, so run `npm run build` first. Both scripts accept another server file as their first
argument, e.g. `node scripts/smoke-test.mjs src/index.mjs` to try the unbundled source. The unit tests expect the
version that the build bakes in, so run them on a built bundle.

- **Smoke test**: starts the server over stdio, sends `initialize` and `tools/list`, and prints the server version,
  protocol version and tool names.
- **Unit tests**: start a fake bridge on a random free local port (never the real 9876), set `SKETCHUP_MCP_TIMEOUT=1`
  and point `APPDATA` at a temporary folder. They cover: the "MAY HAVE ALREADY RUN" / "does not modify the model"
  hints after a timeout or a dropped connection, run_ruby error locations, the old-bridge hint on
  `Unsupported command`, empty errors and invalid JSON, compact JSON results, the `ping` version check (older, same,
  newer, missing), string-to-number ids, parameter validation, screenshot view restore and sizing,
  `set_material` `update_existing`, `install_sketchup_bridge` (dry run, install, unchanged, skipped) in the temporary
  `APPDATA`, the "Cannot connect to SketchUp" message on a closed port, and `checkVersions`.
  Each check prints `PASS`/`FAIL`; the exit code is 1 if anything failed.

Several of these checks match user-facing strings (for example `MAY HAVE ALREADY RUN`, `Cannot connect to SketchUp`,
`Location in run_ruby code`). The server also detects an outdated bridge by matching `/Unsupported command/` in the
Ruby error text. If you reword a message in `src/index.mjs` or `../extension/su_mcp/main.rb`, update the tests and the
guides in `release-docs/` too.

### `node scripts/smoke-test.mjs --live`

Same as the smoke test, then calls **read-only** tools against the SketchUp that is open on this machine: `ping`,
`model_info`, `list_tags`, `list_materials`, `list_components`, `selection_info` (limit 5) and `screenshot`
(640x400). It never calls a model-editing tool. It connects to `SKETCHUP_MCP_PORT` (default 9876), so SketchUp must be
running with the bridge started (Extensions > SU MCP Bridge > Status). It still reads the open model, so use a test
model rather than a confidential project.

### `npm run release` (`scripts/release.mjs`)

Runs the build and the unit tests, then creates the release folder (deleted and recreated on every run) and a zip
with the same name. It takes files only from `dist/` and `release-docs/`, and stops if any of them is missing.

```
../release/SketchUpMCP_v<v>/
  01_CLAUDE_EXTENSION/sketchup-mcp-<v>.mcpb
  02_SKETCHUP_PLUGIN_BACKUP/su_mcp.rbz
  GUIDE_EN.html + GUIDE_EN.pdf           <- from release-docs/en/GUIDE.html
  SAMPLE_PROMPTS_EN.txt                  <- from release-docs/en/SAMPLE_PROMPTS.txt
  vi/HUONG_DAN_SU_DUNG.html + .pdf       <- from release-docs/vi/HUONG_DAN_SU_DUNG.html
  vi/CAU_LENH_MAU.txt                    <- from release-docs/vi/CAU_LENH_MAU.txt
  CHANGELOG.txt                          <- generated; the text lives in scripts/release.mjs
  THIRD_PARTY_NOTICES.txt
  SHA256SUMS.txt                         <- SHA-256 of every other file in the folder
../release/SketchUpMCP_v<v>.zip
```

- The PDFs are printed with headless **Microsoft Edge** if it is installed in its standard location. Without Edge the
  PDFs are skipped with a warning and the `.html` guides are still there.
- `../release/` is outside the tracked files (the repository root `.gitignore` is an allowlist).

## Versioning

The version must be **identical in 4 places**:

| File | Field |
|---|---|
| `package.json` | `version` |
| `manifest.json` | `version` |
| `../extension/su_mcp/main.rb` | `VERSION` |
| `../extension/su_mcp.rb` | `ext.version` |

`scripts/versions.mjs` enforces this and `npm run build` stops if they differ. The same version is baked into the
bundle as the server version and as the bundled bridge version; `ping` compares the latter with the version the
running bridge reports, warns when the bridge in SketchUp is older and adds a note when it is newer (the check is
skipped when running the unbuilt source, whose version is `0.0.0-dev`).

To ship a new version:

1. Bump the version in the 4 places.
2. Add the new entry to the CHANGELOG text in `scripts/release.mjs`, and update `release-docs/en` and
   `release-docs/vi` if the UI or the behaviour changed.
3. `npm run release` (optionally followed by `node scripts/smoke-test.mjs --live` against a test model).
4. Share `../release/SketchUpMCP_v<v>.zip`. Users install the new `.mcpb` over the old one (their settings are kept),
   then type "Install SU MCP Bridge in SketchUp" in a chat and fully quit and reopen SketchUp.

**Never change `name` (`sketchup-mcp`) or `author.name` in `manifest.json` between releases.** Claude Desktop uses
these two values as the install id of the extension: if either changes, the new build is installed as a second,
separate extension instead of updating the existing one.

## Rules for contributors

### Ruby bridge: Ruby 2.2 syntax

The bridge must load on **SketchUp 2017 or later**, and SketchUp 2017 ships Ruby 2.2. Do not use anything newer,
for example: the safe navigation operator `&.`, squiggly heredocs `<<~`, `dig`, `Array#sum`, `match?`,
`transform_values` / `transform_keys`, `Hash#slice`, `then` / `yield_self`, `filter_map`, or `rescue` directly
inside a `do ... end` block without `begin`.

### Documentation

- User docs live in `release-docs/en/` (`GUIDE.html`, `SAMPLE_PROMPTS.txt`) and `release-docs/vi/`
  (`HUONG_DAN_SU_DUNG.html`, `CAU_LENH_MAU.txt`).
- The HTML guides use the placeholders `__VERSION__` and `__DATE__`; `release.mjs` replaces them when it writes the
  release folder. Keep the placeholders in the sources, never a hard-coded version or date.
- The Vietnamese docs quote the English UI strings (menu items, messages) verbatim, so update both languages when a
  string changes.

### Runtime facts (Claude Desktop)

- Extensions with `server.type: "node"` run on **Claude Desktop's built-in Node.js** (started through Electron's
  `utilityProcess`), not on a Node installed on the machine. That is why the server is a single esbuild bundle with
  no native modules, targeting Node 18.
- The **working directory is not the extension folder**. Resolve every path from `import.meta.url` (see `HERE` in
  `src/index.mjs`). The bridge files are looked up in `../bridge/` (inside the `.mcpb`), then in `../../extension/`
  (when running from source).
- Claude Desktop **starts a probe instance first**, before the instance it actually uses, so **startup must have no
  side effects**: no connection to SketchUp, no file writes, no installs. The server only connects to SketchUp when a
  tool is called.
- **Never write to stdout.** stdout carries the MCP JSON-RPC stream, and any stray `console.log` corrupts it. Log to
  stderr only (the `log()` helper); the startup line `[sketchup-mcp] v<v> ready, SketchUp at <host>:<port> (timeout <t>s)`
  ends up in Claude Desktop's MCP server log.
- An uncaught error ends the server process, so every socket and promise has its errors handled.
- Values from `user_config` arrive as strings in environment variables and can be the literal
  `${user_config.port}` when unset; `envValue()` treats that as "not set".

### Bridge protocol and environment variables

- One TCP connection per command to `127.0.0.1`. The request is one line of JSON, `{"id", "cmd", "params"}`; the reply
  is one line, `{"id", "ok": true, "result"}` or `{"id", "ok": false, "error", "backtrace"}`. The bridge serves one
  client at a time, so the server queues commands and each command's timeout starts only when its turn comes.
  Replies larger than 64 MB are rejected.
- Environment variables read by the server (handy for local testing): `SKETCHUP_MCP_HOST` (default `127.0.0.1`),
  `SKETCHUP_MCP_PORT` (default `9876`), `SKETCHUP_MCP_TIMEOUT` (seconds, default `120`). In Claude Desktop the port and
  timeout come from Settings > Extensions > SketchUp MCP > Configure.
- Running `src/index.mjs` directly (without a build) reports version `0.0.0-dev`, and `ping` then skips the bridge
  version check. Use the built bundle for anything version-related.

## Continuous integration

`../.github/workflows/ci.yml` runs on `windows-latest` with Node 20: `npm ci`, `npm run build`, the unit tests and the
smoke test, then uploads `dist/*.mcpb`, `dist/*.rbz` and `dist/THIRD_PARTY_NOTICES.txt` as a build artifact.

## Credits

Some ideas come from [zinin/sketchup-mcp2](https://github.com/zinin/sketchup-mcp2) (MIT license): catching every
exception in `eval`, the "may have already run" message, restoring the camera after a screenshot, and the minimum
version check. No code was copied from it.

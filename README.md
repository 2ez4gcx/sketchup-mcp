# SketchUp MCP

**English** | [Tiếng Việt](README.vi.md)

![SketchUp MCP: ask in plain language and the AI works in your SketchUp model](docs/images/hero.png)

SketchUp MCP lets Claude work directly in the SketchUp model you have open. Ask in plain language, in any language, and Claude reads the model, runs quantity takeoffs by tag or material, models geometry, assigns materials and tags, takes screenshots to check its own work, and exports images and files. It ships as a Claude Desktop extension (`.mcpb`) that runs on the Node.js built into Claude Desktop, plus a small Ruby extension for SketchUp (the **SU MCP Bridge**). You do not need to install Python or Node.js.

Current version: **1.2.0** - [download it from Releases](https://github.com/2ez4gcx/sketchup-mcp/releases/latest). Also listed in the official [MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.2ez4gcx/sketchup-mcp) as `io.github.2ez4gcx/sketchup-mcp`.

## Features

26 tools, all working in millimetres (areas in m², volumes in m³, angles in degrees, Z up):

| Group | Tools |
|---|---|
| Read & statistics | `ping`, `model_info`, `list_tags`, `list_components`, `list_materials`, `selection_info`, `quantity_takeoff` |
| Modelling & editing | `create_box`, `create_shape` (polygon + pushpull), `create_lines`, `insert_component`, `transform_entities`, `set_material`, `set_tag`, `delete_entities`, `select_entities`, `undo` |
| Views, images & files | `set_view`, `screenshot`, `export_png`, `export_file`, `save_model`, `open_model`, `new_model` |
| Ruby scripting | `run_ruby` |
| Setup | `install_sketchup_bridge` |

Highlights:

- **Quantity takeoff by tag or material**: walks the whole model (or only the selection) and totals face area, face count, edge length, solid volume and component instance counts. Untagged or unpainted entities inherit the tag or material of their parent group.
- **Screenshot that restores your view**: Claude sees the viewport image directly. When it asks for a specific view (iso, top, front...), the camera changes only for the capture, and your own view comes back afterwards.
- **`run_ruby` as one undo step**: when no dedicated tool fits, Claude can run Ruby API code. The whole snippet is a single Undo step. On an error the partial changes are rolled back, and the message points to the line in the snippet.
- **Every model edit is one Undo step**, named `MCP: ...` in SketchUp's Edit menu, so <kbd>Ctrl</kbd>+<kbd>Z</kbd> always takes back exactly one Claude action.
- **`install_sketchup_bridge`**: Claude installs or updates the Ruby bridge itself. It copies the files into the Plugins folder of every SketchUp version that has been opened at least once (`dry_run` only reports what it would do).
- **Safe defaults**: an existing material keeps its color unless Claude passes `update_existing=true`. `delete_entities` only deletes by explicit id, never by selection. After a timeout, the error tells Claude whether the command may already have run, so it does not repeat the edit and create duplicate geometry.
- **Version check**: `ping` shows which model Claude is controlling and warns when the bridge in SketchUp is older than the one bundled in the extension.
- **SketchUp menu** (*Extensions > SU MCP Bridge*): `Start server`, `Stop server`, `Status`, `Open log file`, `Change port...`.

## Demo

![A pavilion built step by step through the SketchUp MCP tools](docs/images/demo.gif)

This demo pavilion was built entirely through the MCP tools (`create_box`, `create_shape`, `run_ruby`, `set_material`, `set_tag`), then checked with `screenshot` and `quantity_takeoff` - 82 tool calls in total.

## How it works

```
Claude Desktop
    |  MCP over stdio
    v
sketchup-mcp-1.2.0.mcpb        Node.js MCP server, runs on the Node built into Claude Desktop
    |  one JSON request per command, TCP 127.0.0.1:9876 (localhost only)
    v
SU MCP Bridge                  Ruby extension inside SketchUp, starts with SketchUp
    |  SketchUp Ruby API
    v
the open SketchUp model
```

## Requirements

- **Claude Desktop** (a current version, with *Settings > Extensions*), signed in to a Claude account.
- **SketchUp 2017 or later** (desktop). Tested on SketchUp 2021 and 2023. Each SketchUp version must have been opened at least once before you install the bridge.
- **Windows 10/11**: tested. **macOS**: untested (the extension is packaged for macOS and the installer knows the macOS Plugins folder, but it has not been tried on a Mac).
- To build from source only: Node.js 18 or later and npm.

## Download

Get the files from the [latest release](https://github.com/2ez4gcx/sketchup-mcp/releases/latest):

| File | What it is |
|---|---|
| `sketchup-mcp-1.2.0.mcpb` | Claude Desktop extension (the main download) |
| `su_mcp-1.2.0.rbz` | SketchUp plugin (SU MCP Bridge), only needed for a manual install |
| `SketchUpMCP_v1.2.0.zip` | Everything: extension, plugin, user guides (HTML + PDF, English and Vietnamese), sample prompts, changelog, license |
| `SketchUp-MCP-Guide-1.2.0.pdf` | The English user guide on its own |

## Install

1. **Install the extension in Claude Desktop.** Open *Settings > Extensions*, then drag and drop `sketchup-mcp-1.2.0.mcpb` into the window, or click *Advanced settings > Install Extension...* and pick the file. Click *Install*. The build is not code-signed, so Claude Desktop may warn that the extension is unsigned: only install a file from this project's [releases](https://github.com/2ez4gcx/sketchup-mcp/releases/latest) or one you built yourself. On the Microsoft Store version of Claude, double-clicking a `.mcpb` file does not open it, so install it through Settings.
2. **Install the SU MCP Bridge in SketchUp.** In a new chat, ask Claude:
   > Install SU MCP Bridge in SketchUp

   Claude calls `install_sketchup_bridge` (click *Allow*) and lists the SketchUp versions it updated. Or install it manually: *Extensions > Extension Manager > Install Extension* (SketchUp 2017-2020: *Window > Extension Manager*), then pick `su_mcp.rbz`. The plugin is not digitally signed. If SketchUp refuses to load it, set the Extension Loading Policy (gear icon in Extension Manager) to *Approve Unidentified Extensions*, if your IT policy allows it.
3. **Fully quit SketchUp and reopen it.** Then check *Extensions > SU MCP Bridge > Status*. It should show `SU MCP Bridge v1.2.0: RUNNING on 127.0.0.1:9876`. Finally, ask Claude "Ping SketchUp".

Options are under *Settings > Extensions > SketchUp MCP > Configure*: the bridge port (default 9876) and the timeout per command (default 120 s; raise it for takeoffs on large models). If you change the port, change it in SketchUp too (*Extensions > SU MCP Bridge > Change port...*) and restart SketchUp.

To update, install the new `.mcpb` over the old one (your settings are kept), ask Claude to install the bridge again, and restart SketchUp. Always update both parts.

Sample prompts: [`mcpb/release-docs/en/SAMPLE_PROMPTS.txt`](mcpb/release-docs/en/SAMPLE_PROMPTS.txt). The full user guide (HTML and PDF) is in the release zip (`GUIDE_EN.html` / `GUIDE_EN.pdf`) and attached to each release; its source is [`mcpb/release-docs/en/GUIDE.html`](mcpb/release-docs/en/GUIDE.html).

## Other MCP clients

The `.mcpb` one-click install is specific to Claude Desktop, but the server is a standard MCP server over stdio, so any
client that can launch local MCP servers can use it. Outside Claude Desktop you need **Node.js 18 or later** on your PATH.

**1. Get the server.** The `.mcpb` file is a zip archive. Extract it to a folder of your choice, for example with the
`tar` that ships with Windows 10/11, in Command Prompt or PowerShell (the `tar` of Git Bash cannot read it). You can also rename
the file to `.zip` and use *Extract All*:

```bat
mkdir C:\Tools\sketchup-mcp
tar -xf sketchup-mcp-1.2.0.mcpb -C C:\Tools\sketchup-mcp
```

The server is then `C:/Tools/sketchup-mcp/server/index.mjs` (use forward slashes in configs). The folder also contains
the bridge files, so `install_sketchup_bridge` works from any client. You can also build it from source
(`mcpb/dist/bundle/server/index.mjs`).

**2. Register it in your client** (snippets below). Optional environment variables: `SKETCHUP_MCP_PORT` (default 9876)
and `SKETCHUP_MCP_TIMEOUT` (seconds per command, default 120). If your client has its own tool-call timeout, set it
above `SKETCHUP_MCP_TIMEOUT`.

**3. Install the bridge** as in [Install](#install) step 2-3 (ask the assistant to run `install_sketchup_bridge`, or use
`su_mcp.rbz`), then restart SketchUp.

| Client | How | Status |
|---|---|---|
| Claude Desktop | `.mcpb` extension | Tested |
| Claude Code | `claude mcp add` / `.mcp.json` | Tested (tool calls, screenshot image seen by the model) |
| Cursor | `mcp.json` | Config from official docs, not tested yet |
| VS Code (GitHub Copilot agent mode) | `mcp.json` | Config from official docs, not tested yet |
| Windsurf / Devin Desktop | `mcp_config.json` | Config from official docs, not tested yet |
| OpenAI Codex CLI and the ChatGPT desktop app (Codex mode) | `config.toml` | Config from official docs, not tested yet |
| Google Gemini CLI | `settings.json` | Config from official docs, not tested yet |
| ChatGPT on the web (chatgpt.com) | - | **Not supported**: it only connects to remote MCP servers over public HTTPS |

Screenshots are returned as MCP images, so the model must support image input to "see" them. Tool descriptions are
written for any model, but tool-use quality varies between models. If another SketchUp MCP server is already registered
under the name `sketchup`, give this one another name (e.g. `sketchup-node`) to avoid duplicate tools.

<details>
<summary><b>Claude Code</b></summary>

```bat
claude mcp add sketchup --scope user -e SKETCHUP_MCP_TIMEOUT=120 -- node C:/Tools/sketchup-mcp/server/index.mjs
claude mcp list
```

Put the server name before `-e` (an argument right after `-e` is read as another `KEY=value`). Use `--scope project` to
write a shared `.mcp.json` in the current folder instead (Claude Code asks for approval before using it).
</details>

<details>
<summary><b>Cursor</b> - <code>%USERPROFILE%\.cursor\mcp.json</code> (all projects) or <code>.cursor\mcp.json</code> (one project)</summary>

```json
{
  "mcpServers": {
    "sketchup": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/Tools/sketchup-mcp/server/index.mjs"],
      "env": { "SKETCHUP_MCP_TIMEOUT": "120" }
    }
  }
}
```
</details>

<details>
<summary><b>VS Code</b> (GitHub Copilot agent mode) - <code>.vscode\mcp.json</code> or the user <code>mcp.json</code> (<i>MCP: Open User Configuration</i>)</summary>

Note the top-level key is `servers`, not `mcpServers`:

```json
{
  "servers": {
    "sketchup": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/Tools/sketchup-mcp/server/index.mjs"],
      "env": { "SKETCHUP_MCP_TIMEOUT": "120" }
    }
  }
}
```
</details>

<details>
<summary><b>Windsurf / Devin Desktop</b> - <code>%APPDATA%\devin\mcp_config.json</code> (older Windsurf: <code>%USERPROFILE%\.codeium\windsurf\mcp_config.json</code>)</summary>

```json
{
  "mcpServers": {
    "sketchup": {
      "command": "node",
      "args": ["C:/Tools/sketchup-mcp/server/index.mjs"],
      "env": { "SKETCHUP_MCP_TIMEOUT": "120" }
    }
  }
}
```
</details>

<details>
<summary><b>OpenAI Codex CLI / ChatGPT desktop app (Codex mode)</b> - <code>%USERPROFILE%\.codex\config.toml</code></summary>

Both use the same file; in the ChatGPT desktop app you can also add it under *Settings > MCP servers > STDIO*.
Codex stops a tool call after 60 s by default, so raise `tool_timeout_sec`:

```toml
[mcp_servers.sketchup]
command = "node"
args = ["C:/Tools/sketchup-mcp/server/index.mjs"]
tool_timeout_sec = 180

[mcp_servers.sketchup.env]
SKETCHUP_MCP_TIMEOUT = "120"
```

Or: `codex mcp add sketchup --env SKETCHUP_MCP_TIMEOUT=120 -- node C:/Tools/sketchup-mcp/server/index.mjs`
(then add `tool_timeout_sec` by hand).
</details>

<details>
<summary><b>Google Gemini CLI</b> - <code>%USERPROFILE%\.gemini\settings.json</code> (or <code>.gemini\settings.json</code> in a project)</summary>

```json
{
  "mcpServers": {
    "sketchup": {
      "command": "node",
      "args": ["C:/Tools/sketchup-mcp/server/index.mjs"],
      "env": { "SKETCHUP_MCP_TIMEOUT": "120" }
    }
  }
}
```

Or: `gemini mcp add -s user -e SKETCHUP_MCP_TIMEOUT=120 sketchup node C:/Tools/sketchup-mcp/server/index.mjs`.
For personal Google accounts, Gemini CLI has been replaced by Antigravity CLI, which uses its own MCP config file.
</details>

**ChatGPT on the web** cannot start local programs; it would need this server exposed on a public HTTPS endpoint.
That is not recommended: `run_ruby` executes arbitrary Ruby inside SketchUp, and the bridge has no authentication.
Use the ChatGPT desktop app (Codex mode) instead.

## Safety notes

- **Localhost only.** The bridge listens on `127.0.0.1`, so other machines on the network cannot connect. The socket has no authentication, though: any program running on the same computer can send commands while the bridge is running. To turn it off for the current session, use *Extensions > SU MCP Bridge > Stop server* (it starts again with SketchUp).
- **Keep approvals on.** Claude Desktop asks before each tool call. Do not choose "Always allow" for `run_ruby`, `delete_entities`, `undo`, `save_model`, `open_model`, `new_model`, `export_file` or `export_png` (the two export tools can overwrite files).
- **`run_ruby` executes arbitrary Ruby** inside SketchUp, with your user's permissions and no time limit. Read the code before you allow it. An infinite loop freezes SketchUp, and you would have to close it from Task Manager and lose unsaved changes.
- **Every edit is one Undo step**, so a wrong result can be taken back with <kbd>Ctrl</kbd>+<kbd>Z</kbd> or by asking Claude to undo.
- **Work on copies of your projects**, and save a copy before each session with Claude. `save_model` without a path overwrites the current file.
- **Model data is sent to Claude.** When you ask a question, Claude reads model information (object names, quantities, screenshots...) and sends it to Anthropic's Claude service for processing. Follow your organization's and your clients' rules for confidential projects.

## Troubleshooting

| Message (verbatim excerpt) | Cause | What to do |
|---|---|---|
| `Cannot connect to SketchUp at 127.0.0.1:9876. Open SketchUp and check Extensions > SU MCP Bridge > Status ...` | SketchUp is not open, or the bridge is not installed or is stopped. | Open SketchUp and check *Status*. If the *SU MCP Bridge* menu is missing, repeat install step 2. If Status shows `STOPPED`, click *Start server*. |
| `SketchUp did not respond within 120s (command '...'). ... MAY HAVE ALREADY RUN` | A model-editing command took longer than the timeout. It may have finished. | Do not repeat it right away. Check the model, and if something was duplicated, undo it (after `save_model`, `open_model`, `new_model`, `export_*` or `undo` itself, check the file or model instead of using undo). Raise the timeout in *Configure* (other clients: `SKETCHUP_MCP_TIMEOUT`). |
| `SketchUp did not respond within 120s (command '...'). This command does not modify the model and can be retried` | A read command (for example a takeoff on a large model) is still running. | Raise the timeout first (*Configure*, or `SKETCHUP_MCP_TIMEOUT` in other clients), wait until SketchUp is no longer busy, then ask again. |
| `Unsupported command: ...`, or `ping` returns `warning: The bridge in SketchUp ... is v..., older than the bundled v1.2.0` | The bridge in SketchUp is older than the Claude extension. | Run `install_sketchup_bridge` again, then fully quit and reopen SketchUp. |
| `Port 9876 is used by another SketchUp window (or another program).` | Two SketchUp windows are open. Claude controls the first one. | Close the other window, then click *Extensions > SU MCP Bridge > Start server*. |
| `Windows does not allow port 9876 ...` | The port is in a range reserved by Windows/Hyper-V. | Use *Extensions > SU MCP Bridge > Change port...*, restart SketchUp, then set the same port in *Configure* (other clients: `SKETCHUP_MCP_PORT`). |
| `run_ruby must not call exit/abort (SystemExit) - changes were rolled back` | The Ruby snippet called `exit` or `abort`. | Nothing was changed. Ask Claude to rewrite the code without `exit`. |
| `Command '...' HAS RUN in SketchUp but its result could not be sent ...` | The command ran, but its result could not be encoded. | Do not run it again. Ask Claude to check with `model_info` or `selection_info`. |
| `No SketchUp version that has been opened at least once was found on this machine.` | `install_sketchup_bridge` found no SketchUp user folder. | Open SketchUp once, close it, then ask again, or install `su_mcp.rbz` manually. |
| Every SketchUp tool appears twice | Another SketchUp MCP server (for example an older `"sketchup"` entry) is still configured in `claude_desktop_config.json`. | Remove that entry (*Settings > Developer > Edit Config*) and restart Claude Desktop. |

The log file (*Extensions > SU MCP Bridge > Open log file*) records command names, times and error messages, but no geometry and no full code. Error messages can quote parts of `run_ruby` code and file or object names, so review the file before sharing it.

## Build from source

```bash
cd mcpb
npm install
npm run build     # bundle with esbuild, build su_mcp.rbz from ../extension, validate + pack dist/sketchup-mcp-<version>.mcpb
npm test          # smoke test + unit tests against a mock bridge (no SketchUp needed)
npm run release   # build + unit tests + ../release/SketchUpMCP_v<version>/ and its .zip (PDF guides need Microsoft Edge)
```

- The version must match in 4 places: `mcpb/package.json`, `mcpb/manifest.json`, `extension/su_mcp/main.rb` (`VERSION`) and `extension/su_mcp.rb` (`ext.version`). The build stops if they differ.
- The Ruby bridge keeps Ruby 2.2 syntax so it runs on SketchUp 2017 and later (no `&.`, `Array#sum`, `match?`...).
- Do not change `name` (`sketchup-mcp`) or `author.name` in `manifest.json`: Claude Desktop uses them as the install ID, so changing either one makes a new release install as a second extension instead of an update.
- `node scripts/smoke-test.mjs --live` calls the read-only tools against a running SketchUp. Use it only with a model you can safely work on.

## Repository layout

```
extension/                   Ruby bridge (SU MCP Bridge)
  su_mcp.rb                  loader registered with SketchUp
  su_mcp/main.rb             TCP server on 127.0.0.1, commands, menu, status, log
mcpb/                        Node.js MCP server packaged as a Claude Desktop extension
  src/index.mjs              MCP tools, connection to the bridge, install_sketchup_bridge
  manifest.json              .mcpb manifest (tools, user settings: port, timeout)
  scripts/                   build.mjs, unit-test.mjs, smoke-test.mjs, release.mjs, versions.mjs, make-icon.mjs
  release-docs/en/           GUIDE.html, SAMPLE_PROMPTS.txt (English)
  release-docs/vi/           HUONG_DAN_SU_DUNG.html, CAU_LENH_MAU.txt (Vietnamese)
docs/images/                 README images (hero, demo GIF, social preview)
server.json                  entry for the official MCP Registry
.github/workflows/ci.yml     build + tests on Windows
.github/workflows/publish-mcp-registry.yml   publishes server.json to the MCP Registry (run by hand)
```

## Credits

Some ideas come from [zinin/sketchup-mcp2](https://github.com/zinin/sketchup-mcp2) (MIT): catching every exception in eval, the "may have already run" message, restoring the camera after a capture, and checking the minimum version. No code was copied. The third-party libraries bundled into the server are listed with their licenses in `THIRD_PARTY_NOTICES.txt`, which the build generates.

SketchUp is a trademark of Trimble Inc. Claude is a trademark of Anthropic. This project is not affiliated with or endorsed by either company.

## License

Released under the [MIT License](LICENSE). Copyright (c) 2026 Khuong Doan.

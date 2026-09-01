<div align="center">

# 🛠 Skills SwitchTool

**Per-project Agent Skills management: one skill set per project — the model stops picking the wrong skill.**

**English** · [中文](README.zh-CN.md)

</div>

---

## Introduction

### The problem: once global skills pile up, the model starts "crossing wires"

Agent skills are **global by default**: every skill ever installed sits in one shared directory, and the model scans all of them on every task. As skills pile up:

- While writing a backend API, the model invokes `banner-design` left over from a previous frontend project — **the task goes off track**;
- Several similar skills are installed (e.g. three different code-style guides) and the model picks one at random — **output swings back and forth**;
- A temporary skill never gets removed and pollutes the context for good — more tokens spent, and the job done wrong.

The root cause is simple: **skills are managed globally, but work is scoped per project.**

### The fix: move skill management from "global" down to "project"

Skills SwitchTool lets every project bind **its own dedicated skill set**, and materializes only that set into the project's agent skill directories (19 agents supported: `.claude/skills`, `.kimi-code/skills`, `.cursor/skills`, `.codex/skills`, `.gemini/skills`, `.qwen/skills`, `.trae/skills`, `.dsh/skills`, `.factory/skills`, `.cline/skills`, `.continue/skills`, `.crush/skills`, and more — including the interoperable `.agents/skills`). While working in that project, **the model can only see and call the skills that belong to it** — no writing skills in a frontend project, no design skills popping up in a backend project.

```
🎨 my-blog (frontend)      → ui-styling + banner-design + design-tokens
⚙️  api-server (backend)   → deploy-notes + api-design + sql-helper
📝 writing (content)       → brand + slides + copywriting
```

Switch projects with one command; the skills follow the project:

```bash
ssw project switch api-server    # activate project → its skill set is written into each agent's directory
```

How it works: **one central library + per-project skill sets + materialization into each tool's config location + snapshot-based rollback**.

### Highlights

| | |
|---|---|
| 🎯 **One recipe per project** | Each project binds its own "skill set + target agents". Different tasks, different recipes — no interference, reconfigure anytime |
| 🗃️ **Central library, single source of truth** | All skills live in `~/.skills-switch/library/`; project sets are just references — change once, applies everywhere |
| 🔄 **One-command switch** | One `switch` swaps the whole set: click a project in the GUI or type one CLI line, and the skill set lands in each agent's project directory |
| 🔗 **Symlink materialization** | Symlinks by default so library updates take effect instantly; auto-falls back to copy with a warning on failure; same-name conflicts are moved into a snapshot before being overwritten |
| 🔌 **MCP servers, also per project** | MCP servers are registered centrally (stdio/http/sse) and bound per project; apply **merges** them into each agent's project-level config (`.mcp.json`, `.kimi-code/mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`), keeping your existing entries — snapshot & rollback included |
| 📸 **Snapshots & rollback** | Every apply takes a snapshot (last 5 kept per project); roll back with one command if you misconfigure |
| 🌐 **Global sharing** | Beyond project recipes, selected skills can be materialized to each agent's **user-level** directory (`~/.claude/skills` etc.): configure once, shared by every project of that agent |
| 📦 **Move the whole library** | `ssw profile export/import` packs the skill library + MCP + project profiles + global profile into a single file — the same setup across machines and platforms; idempotent import |
| 🤝 **Adopt existing skills** | `ssw skill adopt` pulls skills already sitting in agent directories into the central library — adopt first, then distribute centrally; `--all` scans every agent (deduped by name); the desktop app **auto-adopts on startup** the user-level skills of every agent on the machine, visible as soon as it opens |
| 🔍 **Smart recommendations + built-in catalog** | Detects the project's tech stack and recommends high-star GitHub skills; also ships 111 curated skill repos + 26 common MCP servers in 13 categories (with per-category counts), skills and MCP browsed/installed separately, works offline; the catalog also **searches GitHub live** (results link straight to the repos), and with `--ai` your configured model distills the best keywords from a natural-language requirement before searching; degrades quietly without network |
| 🤖 **AI skill recommendations** | Describe your needs; AI reads the local library and recommends skills to tick & bind, and also **searches GitHub online** (model-provided keywords, falling back to English words from your text; one-click install & bind); callable repeatedly from the new-project dialog and the **project detail page**; model/base URL/API key in settings — official endpoints or any OpenAI-compatible relay (presets: Kimi/DeepSeek/OpenAI/OpenRouter); degrades quietly when unconfigured or offline |
| 🔥 **Optional popularity ranking** | Frequently used skills float to the top: per-skill usage counts (counted on bind, never decrease), GitHub stars (collected on install/update), weighted with project tech-stack and name keyword matching; AI recommendations also use stars/usage as a tie-breaker |
| ⬆️ **Auto-update** | Checks GitHub Releases for new versions (6h cache, degrades quietly offline); a sidebar banner + the settings dialog show the new release and can download the installer for your platform with one click (progress bar included), with optional auto-check on launch and auto-download; same via `ssw update` on the CLI or the `U` key in the TUI |
| 🔄 **Skill library updates** | Periodically checks whether GitHub-sourced skills have upstream updates (first check 15s after launch, then every 6h; per-repo `git fetch`, failure of one repo doesn't affect others); the skill library page shows how many repos are behind, with one-click "update all"; CLI: `ssw skill update --check` / `ssw skill update`; auto-check toggleable in settings |
| 🖥️ **Two ways to open** | Electron desktop app for point-and-click, or a keyboard-driven CLI terminal panel — same core, same state |
| 🪶 **Extremely lightweight** | Only 2 runtime deps (express + commander); the CLI builds into a zero-dependency single file, copy it to any server and run |

## Download

All releases live on the [GitHub Releases](https://github.com/Chongrong1234/Skills_switchtool/releases) page. Every command below is copy-paste ready;

### Linux desktop (AppImage)

```bash
# Download
curl -L -o Skills.SwitchTool.AppImage \
  https://github.com/Chongrong1234/Skills_switchtool/releases/download/v1.7.0/Skills.SwitchTool-1.7.0.AppImage

# Make it executable and run (or double-click in your file manager)
chmod +x Skills.SwitchTool.AppImage
./Skills.SwitchTool.AppImage
```

Don't want to remember version numbers? One command always fetches the latest:

```bash
url=$(curl -s https://api.github.com/repos/Chongrong1234/Skills_switchtool/releases/latest \
  | grep -o '"browser_download_url": *"[^"]*AppImage"' | cut -d'"' -f4) \
  && curl -L -o Skills.SwitchTool.AppImage "$url" \
  && chmod +x Skills.SwitchTool.AppImage && ./Skills.SwitchTool.AppImage
```

> In containers or restricted environments, start it with `--no-sandbox`.

### Windows desktop (NSIS installer, Chinese wizard)

Download in your browser: [Skills.SwitchTool.Setup.1.7.0.exe](https://github.com/Chongrong1234/Skills_switchtool/releases/download/v1.7.0/Skills.SwitchTool.Setup.1.7.0.exe), double-click and follow the wizard (custom install directory supported).

> The installer is **unsigned**, so Windows SmartScreen may show “Windows protected your PC” — this is expected; click **More info → Run anyway**.

Or copy-paste in PowerShell:

```powershell
curl.exe -L -o Skills.SwitchTool.Setup.exe `
  "https://github.com/Chongrong1234/Skills_switchtool/releases/download/v1.7.0/Skills.SwitchTool.Setup.1.7.0.exe"
.\Skills.SwitchTool.Setup.exe        # wizard install; silent install: .\Skills.SwitchTool.Setup.exe /S
```

### macOS desktop (dmg, Apple Silicon)

```bash
curl -L -o Skills.SwitchTool.dmg \
  https://github.com/Chongrong1234/Skills_switchtool/releases/download/v1.7.0/Skills.SwitchTool-1.7.0-arm64.dmg
open Skills.SwitchTool.dmg    # drag into Applications
```

> The build is **unsigned**. If macOS says the app “is damaged and can’t be opened” (quarantine on downloaded unsigned apps — right-click → Open is often not enough), remove the quarantine flag once:
>
> ```bash
> xattr -cr "/Applications/Skills SwitchTool.app"
> ```

### Server / single-file CLI (zero dependencies)

The single-file CLI is not attached to releases; build it once from source (only Node ≥ 18 needed):

```bash
git clone https://github.com/Chongrong1234/Skills_switchtool.git
cd Skills_switchtool
npm install
npm run dist:cli            # produces release/cli/ssw.mjs: zero deps, copy to any server and run

./release/cli/ssw.mjs doctor     # check the environment first
./release/cli/ssw.mjs            # run bare in a TTY to enter the interactive terminal panel
```

To build the desktop app from source or run the tests, see Usage below.

## Usage

### Install & build

```bash
git clone https://github.com/Chongrong1234/Skills_switchtool.git
cd Skills_switchtool
npm install        # install dependencies (only 2 runtime deps: express + commander)
npm run build      # tsc compiles to dist/
npm test           # full vitest suite
```

The data root defaults to `~/.skills-switch/`; override it with the `SSW_HOME` environment variable.

### Three-minute quickstart

```bash
npm run app        # build & launch the desktop app (needs a graphical environment)
```

Then: **create a project (bind a directory) → tick skills and target agents → one-click apply**. The skill set is written into each agent's project-level skills directory; switch projects afterwards and the skills follow.

> 💡 No GUI? Use `npm run dist:cli` to build the zero-dependency single-file CLI and copy it to your server (see Single-file distribution below).

### Desktop app (Electron)

```bash
npm run app    # dev run: tsc compile, then electron . opens the window (needs a graphical environment)
npm run dist   # package: compile + electron-builder, produces the Linux AppImage in release/
```

AppImage usage:

```bash
chmod +x "release/Skills SwitchTool-"*.AppImage
./release/Skills\ SwitchTool-*.AppImage        # run from the terminal; or double-click in a file manager
```

In containers/restricted environments (or systems without kernel sandbox support), Electron may need `--no-sandbox` to start.

### CLI (visual terminal panel)

The CLI (`ssw`, alias `skills`) is primarily an **interactive terminal panel**: run it with no arguments in a terminal and you're in — all daily operations happen inside the panel:

```bash
ssw        # or skills — a keyboard-driven visual panel
```

```
↑↓ browse projects · Enter switches & applies (skill set written into each agent's directory)
n new project (name/path/agents/mode, optional AI requirement auto-recommended & bound)
x delete project / a apply / u unapply / r rollback
s skill library / m MCP registry / c built-in catalog (c cycle categories, k toggle skills/MCP, / GitHub search, i AI search)
i AI recommend / g global sharing / d doctor / q quit
```

The panel, the subcommands and the desktop app all share the same state (`~/.skills-switch/`) — a change anywhere is visible everywhere.

Plain subcommands target scripting & automation (running bare in a non-TTY prints help). Common ones: `doctor` environment check, `project create/switch/apply`, `skill add/list/adopt`, `skill update [--check]` library update check/one-click update, `catalog install`, `catalog --q ... --github [--ai]` online catalog search, `mcp add`, `global apply`, `profile export/import`, `ai recommend`, `update` self-update check/download, etc.; the full list and flags are under `ssw --help` or `ssw <command> --help`. Conventions: projects and skills are addressed by `id|name`; global `--json` output for scripting; errors go to stderr with a non-zero exit code.

Local use: after `npm run build`, run `node dist/cli.js ...` (or `npm link` to use `ssw ...` / `skills ...` directly).

### Single-file distribution (copy to any server)

```bash
npm run dist:cli     # produces release/cli/ssw.mjs (esbuild bundle, zero deps, Node ≥ 18)
```

Copy `ssw.mjs` to any server and run it (`./ssw.mjs agents` or `node ssw.mjs agents`). Only one thing to configure: the data directory defaults to `~/.skills-switch/`; override with `SSW_HOME`, e.g. `export SSW_HOME=/data/skills-switch`.

### Platforms & notes

| Platform | Artifact | Build |
|---|---|---|
| Linux | `release/Skills SwitchTool-<version>.AppImage` | `npm run dist` |
| Windows | `release/Skills SwitchTool Setup <version>.exe` (NSIS, Chinese installer UI) | `npx electron-builder --win nsis`, or CI |
| macOS | dmg + zip (**unsigned**: if “damaged”, run `xattr -cr` on the .app — see above) | CI (macOS runner) |
| Any (incl. servers) | `release/cli/ssw.mjs` (zero-dependency single-file CLI) | `npm run dist:cli` |

**Windows notes**:

- apply defaults to symlink; without Developer Mode / admin rights, symlink creation is denied (EPERM) — it then **automatically falls back to copy with a warning in the output** (after the fallback, library changes require a re-apply to take effect). You can also pick `--mode copy` when creating the project.
- Installing/updating skills from GitHub requires **git** installed and on PATH; if it's missing you get a readable error instead of a crash.

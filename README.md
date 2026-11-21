# opencode-dotagents

> OpenCode adapter for the [`.agents/` directory standard](https://dotagents.io).

One `.agents/` directory, shared across **every** AI coding tool — Claude Code, Cursor, Codex, Gemini, and now **OpenCode**. Drop your MCP servers, instructions, and skills there once; every tool that adopts the spec picks them up.

```
.agents/
├── AGENTS.md      # ambient instructions
├── mcp.json       # MCP servers (mcpServers)
└── skills/        # Agent Skills (SKILL.md)
```

Two layers overlay: global `~/.agents/` (everything, every project) and project `./.agents/` (workspace wins, field by field).

## What this plugin does

| `.agents/` part | OpenCode without this plugin | With this plugin |
| --- | --- | --- |
| `mcp.json` | ❌ not read | ✅ `ctx.mcp.transform` |
| `AGENTS.md` | ❌ only `~/.config/opencode/AGENTS.md` + workspace ancestors | ✅ `~/.agents/AGENTS.md` + `./.agents/AGENTS.md` injected as system context |
| `skills/` | ✅ already native ([docs](https://opencode.ai/docs/skills)) | ✅ native — left untouched |

So OpenCode becomes a first-class citizen of the `.agents/` standard: the same `~/.agents/mcp.json` your other tools read is read here too, and the same `~/.agents/AGENTS.md` applies everywhere.

## Install

**Option A — single file (zero deps).** Copy `dotagents.js` into your plugins folder:

```
~/.config/opencode/plugins/dotagents.js
```

OpenCode auto-loads every file there. Done.

**Option B — npm package.** Add to `opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [{ "package": "opencode-dotagents", "options": {} }]
}
```

## Options

All optional:

```jsonc
{
  "plugin": [{
    "package": "opencode-dotagents",
    "options": {
      "mcp": true,              // register .agents/mcp.json servers
      "instructions": true,     // inject .agents/AGENTS.md into the system prompt
      "globalDir": "~/.agents", // global .agents location
      "dir": ".agents",         // project .agents directory name
      "mcpFile": "mcp.json",
      "instructionsFile": "AGENTS.md",
      "files": [],              // extra mcp.json paths (last wins per field)
      "override": false,        // shadow servers already set in opencode.json
      "watch": true             // hot-reload on file change
    }
  }]
}
```

## `mcp.json`

Every vendor's shape is accepted and normalised into OpenCode's `Mcp.LocalConfig` / `Mcp.RemoteConfig`:

```jsonc
{
  "mcpServers": {
    // Claude / Cursor / generic form
    "sequential-thinking": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"]
    },
    // OpenCode's own local form
    "filesystem": {
      "type": "local",
      "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "~/Documents"]
    },
    // any of http | sse | remote | streamable-http
    "linear": { "type": "http", "url": "https://mcp.linear.app/sse" },
    // secrets stay in the environment: ${VAR}, ${VAR:-fallback}, {env:VAR}
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" }
    },
    // disable without removing
    "disabled-one": { "command": "echo", "args": ["hi"], "disabled": true }
  }
}
```

Notes:
- `mcpServers` (Claude/Cursor), `servers` (VS Code), and `mcp` (OpenCode native) top-level keys are all read.
- JSONC (`//` and `/* */` comments, trailing commas) is fine.
- `${VAR}`, `${VAR:-fallback}` and `{env:VAR}` expand from the environment; `~/` expands to home.
- A project file **overrides per top-level field**: to change one env var, restate the whole `env`.
- A relative `cwd` resolves against the directory that holds `.agents` (the project for a project file, home for the global one).
- Servers already in `opencode.json` are kept unless `options.override` is true.
- Editing the file hot-reloads (watch + 400 ms debounce → `ctx.mcp.reload()`).

## `AGENTS.md`

Put machine-wide rules in `~/.agents/AGENTS.md` and project rules in `./.agents/AGENTS.md`. The plugin injects both into the system prompt on every model request, global first then project. Already-injected text is skipped, so combining this plugin with opencode.json `instructions` never duplicates.

OpenCode's native `AGENTS.md` discovery (workspace ancestors up to the project root, plus `~/.config/opencode/AGENTS.md`) is unchanged — this plugin only adds the two `.agents/AGENTS.md` locations the spec defines.

## `skills/`

Nothing to configure. OpenCode already discovers `.agents/skills/*/SKILL.md` and `~/.agents/skills/*/SKILL.md` natively ([docs](https://opencode.ai/docs/skills)). This plugin deliberately does not re-register them.

## V1 / V2

OpenCode 2 (`setup(ctx)`) gets both MCP and AGENTS.md injection. OpenCode 1 (`server()` → `config`) gets MCP only — V1 has no equivalent context hook.

## Spec

This plugin implements the lightweight [dotagents](https://dotagents.io) consolidation: `AGENTS.md` + `mcp.json` + `skills/`, global `~/.agents/` + project `.agents/` with workspace overlay. It deliberately does not implement the larger ".agents Protocol" extensions (sub-agents, tasks, memories, models) — those are not part of the cross-tool consensus and OpenCode cannot register new sub-agents through a plugin.

## License

MIT

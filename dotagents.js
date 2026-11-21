// dotagents — OpenCode adapter for the `.agents/` directory standard.
//
// One directory, three concerns, every AI coding tool:
//
//   .agents/
//   ├── AGENTS.md     ← ambient instructions (global ~/.agents + project .agents)
//   ├── mcp.json      ← MCP servers (mcpServers / servers / mcp all accepted)
//   └── skills/       ← Agent Skills (OpenCode reads these natively; not here)
//
// Spec: https://dotagents.io — this plugin makes OpenCode load the portable
// `.agents/` directory the same way Claude Code, Cursor, Codex and Gemini do.
//
// What this plugin does:
//   • mcp.json      — registers servers through ctx.mcp.transform
//   • AGENTS.md     — injects through the `context` session hook as system text
//   • skills/       — nothing; OpenCode already discovers .agents/skills natively
//                     (see https://opencode.ai/docs/skills — `.agents/skills` is a
//                     native compatibility source, global and per-project)
//
// MCP sources, later ones win per server name by top-level field (a project can
// override just `args` or `cwd` of a server inherited from the global file; to
// change one env var, restate the whole `env` object):
//   1. ~/.agents/mcp.json                 (global, all projects)
//   2. <location>/.agents/mcp.json        (per project)
//   3. options.files                      (extra paths, same order)
//
// Accepted per-server shapes are normalised into OpenCode's Mcp.LocalConfig /
// Mcp.RemoteConfig, so every vendor's idiom works:
//   { "command": "npx", "args": ["-y", "pkg"], "env": { "K": "v" }, "cwd": "." }
//   { "type": "local", "command": ["npx", "-y", "pkg"], "environment": {...} }
//   { "type": "http" | "sse", "url": "https://x/mcp", "headers": { "K": "v" } }
//   { "type": "remote", "url": "...", "headers": {...}, "oauth": {...} }
// Extras passed through: `disabled` / `enabled:false`, `cwd`, `codemode`,
// `protocol`, `pool`, `timeout` (an object keeps startup/catalog/execution, a
// number becomes `execution`). `${VAR}`, `${VAR:-fallback}` and `{env:VAR}` are
// expanded from the process environment; leading `~/` becomes the home
// directory; a relative `cwd` resolves against the directory that holds the
// `.agents` folder — the project for a project file, home for the global one.
//
// Install: drop this file in ~/.config/opencode/plugins/ (auto-loaded), or add
//   { "plugin": [{ "package": "opencode-dotagents", "options": { ... } }] }
// to opencode.json. Options (all optional):
//   mcp:true, instructions:true, globalDir:"~/.agents", dir:".agents",
//   mcpFile:"mcp.json", instructionsFile:"AGENTS.md", files:[], override:false,
//   watch:true
//
// Servers already configured in opencode.json are left alone unless
// `options.override` is true — the plugin adds, it does not shadow your config.
import { existsSync, readFileSync, watch } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"

const ID = "dotagents"
const REMOTE = new Set(["remote", "http", "https", "sse", "streamable", "streamable-http", "streamable_http"])
const LOCAL = new Set(["local", "stdio", ""])
const PROTOCOLS = new Set(["legacy", "auto", "2026-07-28"])
const SERVER_KEYS = ["type", "url", "command", "args", "env", "environment", "headers", "requestInit", "cwd", "disabled", "enabled", "codemode", "protocol", "pool", "timeout", "oauth"]

const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v)
const str = (v) => (typeof v === "string" ? v : undefined)
const bool = (v) => (typeof v === "boolean" ? v : undefined)
const posInt = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.trunc(v) : undefined)

// `~/x` -> /home/x; everything else untouched
export const tilde = (p) => {
  if (p === "~") return homedir()
  if (p.startsWith("~/") || p.startsWith("~\\")) return resolve(homedir(), p.slice(2))
  return p
}

// ${VAR}, ${VAR:-fallback}, {env:VAR}; a name nothing answers for stays as it
// was written and is reported, rather than silently becoming "".
export const expand = (v, missing) => {
  if (typeof v === "string")
    return v
      .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (all, k, d) => {
        const got = process.env[k]
        if (got !== undefined) return got
        if (d !== undefined) return d
        missing?.add(k)
        return all
      })
      .replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (all, k) => {
        const got = process.env[k]
        if (got !== undefined) return got
        missing?.add(k)
        return all
      })
  if (Array.isArray(v)) return v.map((x) => expand(x, missing))
  if (plain(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expand(x, missing)]))
  return v
}

const strings = (o) => {
  const out = {}
  for (const [k, v] of Object.entries(o))
    if (typeof v === "string") out[k] = v
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v)
  return out
}

const timeout = (v) => {
  if (typeof v === "number") {
    const ms = posInt(v)
    return ms ? { execution: ms } : undefined
  }
  if (!plain(v)) return undefined
  const out = {}
  for (const k of ["startup", "catalog", "execution"]) {
    const ms = posInt(v[k])
    if (ms) out[k] = ms
  }
  return Object.keys(out).length ? out : undefined
}

// one raw entry -> OpenCode Mcp.LocalConfig | Mcp.RemoteConfig, or undefined
export function normalizeServer(name, raw, baseDir, warn) {
  if (!plain(raw)) return void warn(`${name}: not an object`)
  const missing = new Set()
  const type = (str(raw.type) || "").toLowerCase()
  const remote = REMOTE.has(type) || (!LOCAL.has(type) && typeof raw.url === "string")
  const out = remote ? { type: "remote" } : { type: "local" }

  if (remote) {
    const url = str(raw.url)
    if (!url) return void warn(`${name}: remote without a url`)
    out.url = expand(url, missing)
    const headers = plain(raw.headers) ? raw.headers : plain(raw.requestInit?.headers) ? raw.requestInit.headers : undefined
    if (headers) out.headers = strings(expand(headers, missing))
    if (raw.oauth === false) out.oauth = false
    else if (plain(raw.oauth)) {
      const o = {}
      for (const k of ["client_id", "client_secret", "scope", "redirect_uri", "auth_server_metadata_url"]) {
        const v = str(raw.oauth[k])
        if (v) o[k] = expand(v, missing)
      }
      const port = posInt(raw.oauth.callback_port)
      if (port) o.callback_port = port
      if (Object.keys(o).length) out.oauth = o
    }
  } else {
    const parts = Array.isArray(raw.command)
      ? raw.command.map(String)
      : typeof raw.command === "string"
        ? [raw.command]
        : undefined
    if (!parts) return void warn(`${name}: local without a command`)
    if (typeof raw.args === "string") parts.push(raw.args)
    else if (Array.isArray(raw.args)) parts.push(...raw.args.map(String))
    out.command = expand(parts, missing).map(tilde)
    const env = plain(raw.environment) ? raw.environment : plain(raw.env) ? raw.env : undefined
    if (env) out.environment = strings(expand(env, missing))
    const cwd = str(raw.cwd)
    if (cwd) {
      const p = tilde(expand(cwd, missing))
      out.cwd = isAbsolute(p) ? p : resolve(baseDir, p)
    }
  }

  const disabled = bool(raw.disabled) ?? (bool(raw.enabled) === undefined ? undefined : !raw.enabled)
  if (disabled !== undefined) out.disabled = disabled
  const code = bool(raw.codemode)
  if (code !== undefined) out.codemode = code
  const proto = str(raw.protocol)
  if (proto && PROTOCOLS.has(proto)) out.protocol = proto
  const pool = bool(raw.pool)
  if (pool !== undefined) out.pool = pool
  const to = timeout(raw.timeout)
  if (to) out.timeout = to

  for (const k of missing) warn(`${name}: \${${k}} is not set in the environment`)
  // OpenCode takes no unknown fields, so anything else we were given is dropped
  const extras = Object.keys(raw).filter((k) => !SERVER_KEYS.includes(k))
  if (extras.length) warn(`${name}: ignored ${extras.join(", ")}`)
  return out
}

// strip `//` and `/* */` comments while preserving them inside JSON strings
export function stripComments(text) {
  let out = "",
    inStr = false,
    esc = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      out += c
      if (esc) esc = false
      else if (c === "\\") esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      out += c
      continue
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
      out += "\n"
      continue
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i++
      continue
    }
    out += c
  }
  return out
}

// JSONC: comments stripped, then a trailing comma is tolerated on retry
export function parseJsonc(text, path) {
  const stripped = stripComments(text.replace(/^\uFEFF/, ""))
  try {
    return JSON.parse(stripped)
  } catch (err) {
    try {
      return JSON.parse(stripped.replace(/,(\s*[}\]])/g, "$1"))
    } catch {
      throw new Error(`${path}: ${err.message}`)
    }
  }
}

// accept `mcpServers` (Claude/Cursor/generic), `servers` (VS Code), `mcp` (OpenCode)
export function pickServers(doc, path, warn) {
  if (!plain(doc)) return warn(`${path}: not an object`), {}
  for (const key of ["mcpServers", "servers", "mcp"]) if (plain(doc[key])) return doc[key]
  warn(`${path}: no mcpServers / servers / mcp key`)
  return {}
}

// files: ordered paths (global first). returns { servers: [[name, cfg]], from: [path] }
export function loadMcp(files, warn) {
  const raw = {},
    origin = {},
    from = []
  for (const file of files) {
    if (!existsSync(file)) continue
    let doc
    try {
      doc = parseJsonc(readFileSync(file, "utf8"), file)
    } catch (err) {
      warn(err.message)
      continue
    }
    const entries = pickServers(doc, file, warn)
    from.push(file)
    for (const [name, value] of Object.entries(entries)) {
      raw[name] = plain(raw[name]) && plain(value) ? { ...raw[name], ...value } : value
      origin[name] = dirname(dirname(file))
    }
  }
  const servers = Object.entries(raw).flatMap(([name, value]) => {
    const s = normalizeServer(name, value, origin[name] || process.cwd(), warn)
    return s ? [[name, s]] : []
  })
  return { servers, from }
}

export function mcpFiles(opts, directory) {
  const globalDir = tilde(opts.globalDir ?? join(homedir(), ".agents"))
  const dir = opts.dir ?? ".agents"
  const file = opts.mcpFile ?? "mcp.json"
  const files = [join(globalDir, file), join(directory, dir, file)]
  if (Array.isArray(opts.files))
    for (const f of opts.files) files.push(isAbsolute(f) ? f : resolve(directory, f))
  return files
}

// global ~/.agents/AGENTS.md then project .agents/AGENTS.md; missing files skip
export function instructionPaths(opts, directory) {
  const g = join(tilde(opts.globalDir ?? join(homedir(), ".agents")), opts.instructionsFile ?? "AGENTS.md")
  const p = join(directory, opts.dir ?? ".agents", opts.instructionsFile ?? "AGENTS.md")
  const out = []
  if (existsSync(g)) out.push(g)
  if (p !== g && existsSync(p)) out.push(p)
  return out
}

const read = (p) => {
  try {
    return readFileSync(p, "utf8").replace(/^\uFEFF/, "")
  } catch {
    return null
  }
}

// push AGENTS.md text into the system prompt, skipping any already present
// (so combining this plugin with opencode.json `instructions` never duplicates)
function injectInstructions(event, files) {
  if (!files.length) return
  const have = (event.system || []).filter((p) => typeof p?.text === "string").map((p) => p.text).join("\n")
  let added = 0
  for (const f of files) {
    const body = read(f)
    if (!body || !body.trim()) continue
    if (have.includes(body.trim())) continue
    event.system ??= []
    event.system.push({ type: "text", text: `\n# ${f}\n\n${body.trim()}\n` })
    added++
  }
  if (added) console.log(`[${ID}] injected ${added} AGENTS.md file(s)`)
}

let timer = null
function schedule(opts, directory, ctx, setState) {
  clearTimeout(timer)
  timer = setTimeout(async () => {
    const warn = (m) => console.warn(`[${ID}] ${m}`)
    if (!ctx.mcp?.reload) {
      console.log(`[${ID}] .agents file changed; applies on next request or reload`)
      return
    }
    const next = loadMcp(mcpFiles(opts, directory), warn)
    setState?.(next)
    await ctx.mcp.reload().catch((e) => warn(`reload failed: ${e?.message || e}`))
    console.log(`[${ID}] reloaded ${next.servers.length} mcp server(s) from ${next.from.join(", ") || "no files"}`)
  }, 400)
}

function watchDir(dir, onChange) {
  let handle
  try {
    handle = watch(dir, { recursive: false }, (_e, changed) => {
      if (!changed || changed.endsWith(".json") || changed.endsWith(".md")) onChange()
    })
  } catch (err) {
    console.warn(`[${ID}] cannot watch ${dir}: ${err?.message || err}`)
    return () => {}
  }
  return () => {
    try {
      handle.close()
    } catch {}
  }
}

export default {
  id: ID,

  // OpenCode 1: the config hook runs before OpenCode reads its mcp servers.
  // V1 has no context hook here, so AGENTS.md injection is V2-only.
  server: async (input) => ({
    config: async (cfg) => {
      const opts = input?.options || {}
      if (opts.mcp === false) return
      const { servers } = loadMcp(mcpFiles(opts, input?.directory || process.cwd()), (m) =>
        console.warn(`[${ID}] ${m}`),
      )
      for (const [name, s] of servers) {
        const base = (cfg.mcp ||= {})[name]
        if (base) continue
        const { disabled, ...rest } = s
        cfg.mcp[name] = disabled === undefined ? rest : { ...rest, enabled: !disabled }
      }
    },
  }),

  // OpenCode 2: config's own servers are laid under these, then reconciled.
  setup: async (ctx) => {
    const opts = ctx.options || {}
    const log = (m) => console.log(`[${ID}] ${m}`)
    const warn = (m) => console.warn(`[${ID}] ${m}`)
    const directory = ctx.location?.directory || process.cwd()
    const clean = []

    // --- MCP servers ---
    if (opts.mcp !== false && ctx.mcp?.transform) {
      let state = loadMcp(mcpFiles(opts, directory), warn)
      const apply = (editor) => {
        for (const [name, s] of state.servers) {
          if (editor.get(name) && !opts.override) continue
          editor.set(name, s)
        }
      }
      await ctx.mcp.transform(apply)
      log(
        `${state.servers.length} mcp server(s) from ${state.from.join(", ") || "no files"}: ` +
          (state.servers.map(([n]) => n).join(", ") || "-"),
      )
      if (opts.watch !== false)
        for (const d of [...new Set(state.from.map(dirname))])
          clean.push(watchDir(d, () => schedule(opts, directory, ctx, (s) => (state = s))))
    }

    // --- AGENTS.md (ambient instructions) ---
    if (opts.instructions !== false && ctx.session?.hook) {
      const files = instructionPaths(opts, directory)
      if (files.length) {
        clean.push(
          await ctx.session.hook("context", (event) => injectInstructions(event, files)),
        )
        log(`instructions from ${files.join(", ")}`)
        if (opts.watch !== false)
          for (const d of [...new Set(files.map(dirname))])
            clean.push(watchDir(d, () => schedule(opts, directory, ctx, null)))
      }
    }

    return () =>
      clean.forEach((r) => {
        try {
          r?.dispose ? r.dispose() : r?.()
        } catch {}
      })
  },
}

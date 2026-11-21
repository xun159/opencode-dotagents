import test from "node:test"
import assert from "node:assert/strict"
import { default as plugin } from "../dotagents.js"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures")
// Global-style fixture mimicking ~/.agents/mcp.json shape (with an explicit key)
const GLOBAL_MCP = join(FIXTURES, "global-mcp.json")
// Project-level fixture mimicking <project>/.agents/mcp.json shape
const PROJ_MCP = join(FIXTURES, "proj-mcp.json")
// Absolute path pointing into the proj fixture so mcpFiles resolves correctly
const ABS_GLOBAL_MCP = GLOBAL_MCP
const ABS_PROJ_MCP = PROJ_MCP

test("setup: registers mcp servers and injects AGENTS.md via context hook", async () => {
  const servers = {}
  const editor = {
    get: (n) => servers[n],
    set: (n, c) => (servers[n] = c),
  }
  let apply = null
  let contextHook = null
  const ctx = {
    options: {
      // Absolute fixture paths bypass the relative-path resolution quirk; point
      // globalDir to a non-existent place so the real ~/.agents/mcp.json isn't read.
      globalDir: "/nonexistent-dotagents-test",
      dir: ".agents",
      files: [ABS_GLOBAL_MCP, ABS_PROJ_MCP],
    },
    location: { directory: "test/fixtures/proj" },
    mcp: { transform: async (cb) => (apply = cb) },
    session: {
      hook: async (name, cb) => {
        if (name === "context") contextHook = cb
        return { dispose() {} }
      },
    },
  }

  const cleanup = await plugin.setup(ctx)
  assert.ok(apply, "mcp transform was registered")
  apply(editor)
  // alpha merged (env overridden wholesale from proj), beta from global only
  assert.deepEqual(servers.alpha, {
    type: "local",
    command: ["node", "a"],
    environment: { K: "2", L: "3" },
  })
  assert.deepEqual(servers.beta, { type: "local", command: ["node", "b"] })

  assert.ok(contextHook, "context hook was registered")
  const event = { system: [] }
  contextHook(event)
  const text = event.system.map((p) => p.text).join("\n")
  assert.ok(text.includes("test/fixtures/proj"), "system part names the source path")
  assert.ok(text.includes("Run tests before committing."), "AGENTS.md content injected")

  // already-present content is not re-added
  contextHook(event)
  assert.equal(event.system.length, 1, "no duplicate injection")

  cleanup?.()
})

test("setup: mcp:false and instructions:false disable each half", async () => {
  let apply = null
  let hook = null
  const ctx = {
    options: { mcp: false, instructions: false, globalDir: "/nonexistent" },
    location: { directory: "test/fixtures/proj" },
    mcp: { transform: async (cb) => (apply = cb) },
    session: {
      hook: async (name, cb) => {
        if (name === "context") hook = cb
        return { dispose() {} }
      },
    },
  }
  const cleanup = await plugin.setup(ctx)
  assert.equal(apply, null, "no mcp transform when mcp:false")
  assert.equal(hook, null, "no context hook when instructions:false")
  cleanup?.()
})
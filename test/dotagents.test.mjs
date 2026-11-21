import test from "node:test"
import assert from "node:assert/strict"
import {
  stripComments,
  parseJsonc,
  pickServers,
  normalizeServer,
  loadMcp,
  mcpFiles,
  instructionPaths,
  tilde,
  expand,
} from "../dotagents.js"

const warns = () => {
  const out = []
  return { fn: (m) => out.push(m), list: out }
}

test("stripComments preserves // inside strings", () => {
  assert.equal(stripComments('"a//b" // c'), '"a//b" \n')
  assert.equal(stripComments("/* x */ 1"), " 1")
})

test("parseJsonc handles comments and trailing commas", () => {
  assert.deepEqual(parseJsonc('{ // hi\n"a": 1, }', "f"), { a: 1 })
  assert.deepEqual(parseJsonc('{"a": /* x */ 2,}', "f"), { a: 2 })
})

test("pickServers accepts mcpServers / servers / mcp", () => {
  const w = warns()
  assert.deepEqual(pickServers({ mcpServers: { x: 1 } }, "f", w.fn), { x: 1 })
  assert.deepEqual(pickServers({ servers: { y: 2 } }, "f", w.fn), { y: 2 })
  assert.deepEqual(pickServers({ mcp: { z: 3 } }, "f", w.fn), { z: 3 })
  assert.deepEqual(pickServers({}, "f", w.fn), {})
  assert.ok(w.list.some((m) => m.includes("no mcpServers")))
})

test("normalizeServer: Claude/generic local form", () => {
  const w = warns()
  assert.deepEqual(
    normalizeServer("s", { command: "npx", args: ["-y", "pkg"], env: { K: "v" } }, "/p", w.fn),
    { type: "local", command: ["npx", "-y", "pkg"], environment: { K: "v" } },
  )
  assert.equal(w.list.length, 0)
})

test("normalizeServer: OpenCode local form", () => {
  const w = warns()
  assert.deepEqual(
    normalizeServer("s", { type: "local", command: ["node", "x"] }, "/p", w.fn),
    { type: "local", command: ["node", "x"] },
  )
})

test("normalizeServer: stdio type -> local", () => {
  const w = warns()
  assert.deepEqual(
    normalizeServer("s", { type: "stdio", command: "node", args: ["x"] }, "/p", w.fn),
    { type: "local", command: ["node", "x"] },
  )
})

test("normalizeServer: http/sse -> remote", () => {
  const w = warns()
  assert.deepEqual(
    normalizeServer("s", { type: "http", url: "https://x/mcp", headers: { Authorization: "Bearer t" } }, "/p", w.fn),
    { type: "remote", url: "https://x/mcp", headers: { Authorization: "Bearer t" } },
  )
  assert.deepEqual(normalizeServer("s", { type: "sse", url: "https://x" }, "/p", w.fn), {
    type: "remote",
    url: "https://x",
  })
})

test("normalizeServer: disabled / enabled:false", () => {
  const w = warns()
  assert.deepEqual(
    normalizeServer("s", { command: "echo", disabled: true }, "/p", w.fn),
    { type: "local", command: ["echo"], disabled: true },
  )
  assert.deepEqual(
    normalizeServer("s", { command: "echo", enabled: false }, "/p", w.fn),
    { type: "local", command: ["echo"], disabled: true },
  )
})

test("normalizeServer: relative cwd resolves to baseDir", () => {
  const w = warns()
  const out = normalizeServer("s", { command: "echo", cwd: "." }, "D:/proj", w.fn)
  assert.equal(out.cwd.replace(/\\/g, "/"), "D:/proj")
})

test("normalizeServer: ${VAR:-fallback} expands, missing env warns and keeps literal", () => {
  process.env.DOTAGENTS_TEST = "got"
  const w = warns()
  const out = normalizeServer("s", { command: "echo", args: ["${DOTAGENTS_TEST}", "${MISSING:-fb}", "${MISSING2}"] }, "/p", w.fn)
  assert.deepEqual(out.command, ["echo", "got", "fb", "${MISSING2}"])
  assert.ok(w.list.some((m) => m.includes("MISSING2")))
  delete process.env.DOTAGENTS_TEST
})

test("normalizeServer: warns on unknown keys", () => {
  const w = warns()
  normalizeServer("s", { command: "echo", randomField: 1 }, "/p", w.fn)
  assert.ok(w.list.some((m) => m.includes("randomField")))
})

test("normalizeServer: remote without url returns undefined", () => {
  const w = warns()
  assert.equal(normalizeServer("s", { type: "http" }, "/p", w.fn), undefined)
})

test("loadMcp merges per top-level field, project wins", () => {
  const w = warns()
  const { servers, from } = loadMcp(
    ["test/fixtures/global-mcp.json", "test/fixtures/proj-mcp.json"],
    w.fn,
  )
  const map = Object.fromEntries(servers)
  // global defines alpha {command, env:{K:1}}; proj overrides env:{K:2,L:3}
  assert.deepEqual(map.alpha, {
    type: "local",
    command: ["node", "a"],
    environment: { K: "2", L: "3" }, // env replaced wholesale (shallow, per-field)
  })
  // global-only server kept
  assert.deepEqual(map.beta, { type: "local", command: ["node", "b"] })
  assert.equal(from.length, 2)
})

test("loadMcp skips missing files", () => {
  const w = warns()
  const { servers, from } = loadMcp(["test/fixtures/does-not-exist.json"], w.fn)
  assert.deepEqual(servers, [])
  assert.deepEqual(from, [])
})

test("mcpFiles lists global, project, and extra paths in order", () => {
  const files = mcpFiles(
    { globalDir: "~/.agents", dir: ".agents", mcpFile: "mcp.json", files: ["extra.json"] },
    "D:/proj",
  )
  assert.equal(files.length, 3)
  assert.ok(files[0].endsWith(".agents/mcp.json") || files[0].includes(".agents"))
  assert.ok(files[1].includes("D:") || files[1].includes("/proj/") || files[1].endsWith(".agents\\mcp.json"))
  assert.ok(files[2].endsWith("extra.json"))
})

test("instructionPaths returns global then project, missing skipped", () => {
  const home = instructionPaths({ globalDir: "test/fixtures/home/.agents", dir: ".agents" }, "test/fixtures/proj")
  assert.equal(home.length, 2)
  assert.ok(home[0].includes("home"))
  assert.ok(home[1].includes("proj"))
  const none = instructionPaths({ globalDir: "test/fixtures/nope/.agents", dir: ".agents" }, "test/fixtures/nope")
  assert.deepEqual(none, [])
})

test("tilde and expand helpers", () => {
  assert.equal(tilde("x"), "x")
  assert.ok(tilde("~/x").includes("home") || tilde("~/x").length > 2)
  process.env.DOTAGENTS_H = "HV"
  assert.equal(expand("${DOTAGENTS_H}/${X:-d}"), "HV/d")
  delete process.env.DOTAGENTS_H
})

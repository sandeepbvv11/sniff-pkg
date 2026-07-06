"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { REGISTRY, runProjectMode } = require("../index.js");
const { jsonResponse, mockFetch, mockCacheFs, mockProcessExit, captureOutput, ProcessExitError } = require("./helpers.js");

function freshCache(names) {
  return () => JSON.stringify({ savedAt: Date.now(), names });
}

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sniff-pkg-project-"));
}

test("runProjectMode: exits 2 when the path doesn't exist", async (t) => {
  mockProcessExit(t);
  captureOutput(t);
  const missing = path.join(os.tmpdir(), "sniff-pkg-does-not-exist-abc123");
  await assert.rejects(runProjectMode(missing), (err) => err instanceof ProcessExitError && err.code === 2);
});

test("runProjectMode: exits 2 when no package.json files are found", async (t) => {
  mockProcessExit(t);
  captureOutput(t);
  const root = mkTmp();
  try {
    await assert.rejects(runProjectMode(root), (err) => err instanceof ProcessExitError && err.code === 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runProjectMode: accepts a direct path to a single package.json file", async (t) => {
  mockProcessExit(t);
  const { log } = captureOutput(t);
  mockCacheFs(t, { onRead: freshCache(["clean-dep"]) });
  mockFetch(t, [[() => true, () => jsonResponse({}, { status: 404 })]]);

  const root = mkTmp();
  const file = path.join(root, "package.json");
  fs.writeFileSync(file, JSON.stringify({ dependencies: { "clean-dep": "1.0.0" } }));
  try {
    await assert.rejects(runProjectMode(file), (err) => err instanceof ProcessExitError);
    assert.ok(log.some((l) => /Found 1 package\.json file/.test(l)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runProjectMode: skips unreadable/corrupt package.json files and continues", async (t) => {
  mockProcessExit(t);
  const { log, error } = captureOutput(t);
  mockCacheFs(t, { onRead: freshCache(["ok-dep"]) });
  mockFetch(t, [[() => true, () => jsonResponse({ "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": { version: "1.0.0" } }, time: { "1.0.0": new Date().toISOString() } })]]);

  const root = mkTmp();
  fs.writeFileSync(path.join(root, "package.json"), "{ this is not valid json");
  fs.mkdirSync(path.join(root, "sub"));
  fs.writeFileSync(path.join(root, "sub", "package.json"), JSON.stringify({ dependencies: { "ok-dep": "1.0.0" } }));
  try {
    await assert.rejects(runProjectMode(root), (err) => err instanceof ProcessExitError && err.code === 0);
    assert.ok(error.some((l) => /skipping unreadable/.test(l)));
    assert.ok(log.some((l) => /Found 2 package\.json file/.test(l)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runProjectMode: skips non-registry specs (file:/git:/workspace:) and reports them", async (t) => {
  mockProcessExit(t);
  const { log } = captureOutput(t);
  mockCacheFs(t, { onRead: freshCache([]) });

  const root = mkTmp();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    dependencies: {
      "local-dep": "file:../local",
      "git-dep": "git+https://github.com/x/y.git",
      "ws-dep": "workspace:*",
      "link-dep": "link:../linked",
    },
  }));
  try {
    await assert.rejects(runProjectMode(root), (err) => err instanceof ProcessExitError && err.code === 0);
    assert.ok(log.some((l) => /Nothing to check/.test(l)));
    assert.ok(log.some((l) => /skipping 4 non-registry dep/.test(l)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runProjectMode: truncates the non-registry skip list beyond 3 entries", async (t) => {
  mockProcessExit(t);
  const { log } = captureOutput(t);
  mockCacheFs(t, { onRead: freshCache([]) });

  const root = mkTmp();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    dependencies: { a: "file:a", b: "file:b", c: "file:c", d: "file:d" },
  }));
  try {
    await assert.rejects(runProjectMode(root), (err) => err instanceof ProcessExitError);
    assert.ok(log.some((l) => /skipping 4 non-registry dep.*\.\.\.\)/.test(l)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runProjectMode: full run reports clean/warn/danger counts and exits 1 when any DANGER", async (t) => {
  mockProcessExit(t);
  const { log } = captureOutput(t);
  mockCacheFs(t, { onRead: freshCache(["good-dep", "warn-dep"]) });

  mockFetch(t, [
    ["/good-dep", () => jsonResponse({
      "dist-tags": { latest: "1.2.0" },
      time: {
        "1.0.0": new Date(Date.now() - 3e10).toISOString(),
        "1.1.0": new Date(Date.now() - 2e10).toISOString(),
        "1.2.0": new Date(Date.now() - 1e10).toISOString(), // ~115 days old, well past the 72h threshold
      },
      versions: {
        "1.0.0": { version: "1.0.0", repository: "x" },
        "1.1.0": { version: "1.1.0", repository: "x" },
        "1.2.0": { version: "1.2.0", repository: "x" },
      },
    })],
    ["/warn-dep", () => jsonResponse({
      "dist-tags": { latest: "1.2.0" },
      time: {
        "1.0.0": new Date(Date.now() - 3e10).toISOString(),
        "1.1.0": new Date(Date.now() - 2e10).toISOString(),
        "1.2.0": new Date().toISOString(), // published seconds ago -> WARN
      },
      versions: {
        "1.0.0": { version: "1.0.0", repository: "x" },
        "1.1.0": { version: "1.1.0", repository: "x" },
        "1.2.0": { version: "1.2.0", repository: "x" },
      },
    })],
    ["/danger-dep", () => jsonResponse({}, { status: 404 })], // not found -> DANGER
    ["/errors-dep", () => { throw new Error("simulated network failure"); }],
  ]);

  const root = mkTmp();
  // Ranges (not exact pins) so resolvableVersion() resolves to "check latest",
  // matching what these fixtures' dist-tags.latest is set up to exercise.
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    dependencies: { "good-dep": "^1.0.0", "warn-dep": "^1.0.0", "danger-dep": "^1.0.0" },
    devDependencies: { "errors-dep": "^1.0.0" },
  }));
  try {
    await assert.rejects(runProjectMode(root), (err) => err instanceof ProcessExitError && err.code === 1);
    const summary = log.find((l) => /^SUMMARY:/.test(l));
    assert.match(summary, /1 clean/);
    assert.match(summary, /2 with warnings/); // warn-dep (fresh) + errors-dep (Check failed -> WARN)
    assert.match(summary, /1 DANGEROUS/);
    assert.ok(log.some((l) => /Check failed: simulated network failure/.test(l)));
    assert.ok(log.some((l) => /\(dev\)/.test(l))); // errors-dep listed as dev dependency
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runProjectMode: exits 0 when every checked dependency is clean", async (t) => {
  mockProcessExit(t);
  const { log } = captureOutput(t);
  mockCacheFs(t, { onRead: freshCache(["good-dep"]) });
  mockFetch(t, [
    [() => true, () => jsonResponse({
      "dist-tags": { latest: "1.2.0" },
      time: {
        "1.0.0": new Date(Date.now() - 3e10).toISOString(),
        "1.1.0": new Date(Date.now() - 2e10).toISOString(),
        "1.2.0": new Date(Date.now() - 1e10).toISOString(),
      },
      versions: {
        "1.0.0": { version: "1.0.0", repository: "x" },
        "1.1.0": { version: "1.1.0", repository: "x" },
        "1.2.0": { version: "1.2.0", repository: "x" },
      },
    })],
  ]);

  const root = mkTmp();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { "good-dep": "1.0.0" } }));
  try {
    await assert.rejects(runProjectMode(root), (err) => err instanceof ProcessExitError && err.code === 0);
    assert.ok(log.some((l) => /^SUMMARY: 1 clean, 0 with warnings, 0 DANGEROUS/.test(l)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runProjectMode: same dependency declared in multiple files is deduped and tracks all sources", async (t) => {
  mockProcessExit(t);
  const { log } = captureOutput(t);
  mockCacheFs(t, { onRead: freshCache(["shared-dep"]) });
  mockFetch(t, [
    [() => true, () => jsonResponse({
      "dist-tags": { latest: "1.0.0" },
      time: { "1.0.0": new Date(Date.now() - 1e10).toISOString() },
      versions: { "1.0.0": { version: "1.0.0" } }, // no repository -> WARN (hygiene) so it shows up in output with [in: ...]
    })],
  ]);

  const root = mkTmp();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { "shared-dep": "1.0.0" } }));
  fs.mkdirSync(path.join(root, "pkg-a"));
  fs.writeFileSync(path.join(root, "pkg-a", "package.json"), JSON.stringify({ dependencies: { "shared-dep": "1.0.0" } }));
  try {
    await assert.rejects(runProjectMode(root), (err) => err instanceof ProcessExitError && err.code === 0);
    assert.ok(log.some((l) => /Found 2 package\.json file\(s\), 1 unique dependencies/.test(l)));
    assert.ok(log.some((l) => /\[in: package\.json, pkg-a[\\/]package\.json\]/.test(l)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

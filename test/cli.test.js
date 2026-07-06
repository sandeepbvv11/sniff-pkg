"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const { main } = require("../index.js");
const { jsonResponse, mockFetch, mockCacheFs, mockProcessExit, captureOutput, ProcessExitError } = require("./helpers.js");

function withArgv(t, args, fn) {
  const original = process.argv;
  process.argv = ["node", "index.js", ...args];
  t.after(() => { process.argv = original; });
  return fn();
}

function freshCache(names) {
  return () => JSON.stringify({ savedAt: Date.now(), names });
}

test("main: no args prints usage and exits 2", async (t) => {
  mockProcessExit(t);
  const { error } = captureOutput(t);
  await withArgv(t, [], () =>
    assert.rejects(main(), (err) => err instanceof ProcessExitError && err.code === 2));
  assert.ok(error.some((l) => /^Usage:/.test(l)));
});

test("main: --help prints usage and exits 2", async (t) => {
  mockProcessExit(t);
  captureOutput(t);
  await withArgv(t, ["--help"], () =>
    assert.rejects(main(), (err) => err instanceof ProcessExitError && err.code === 2));
});

test("main: -h prints usage and exits 2", async (t) => {
  mockProcessExit(t);
  captureOutput(t);
  await withArgv(t, ["-h"], () =>
    assert.rejects(main(), (err) => err instanceof ProcessExitError && err.code === 2));
});

test("main: --project delegates to runProjectMode", async (t) => {
  mockProcessExit(t);
  captureOutput(t);
  const missing = path.join(os.tmpdir(), "sniff-pkg-cli-missing-abc");
  await withArgv(t, ["--project", missing], () =>
    // runProjectMode's own "path not found" branch also exits 2 -- reaching it proves delegation happened.
    assert.rejects(main(), (err) => err instanceof ProcessExitError && err.code === 2));
});

test("main: -p is an alias for --project", async (t) => {
  mockProcessExit(t);
  captureOutput(t);
  const missing = path.join(os.tmpdir(), "sniff-pkg-cli-missing-xyz");
  await withArgv(t, ["-p", missing], () =>
    assert.rejects(main(), (err) => err instanceof ProcessExitError && err.code === 2));
});

test("main: single package with a DANGER finding exits 1 with a serious-flag verdict", async (t) => {
  mockProcessExit(t);
  const { log } = captureOutput(t);
  mockCacheFs(t, { onRead: freshCache(["react"]) });
  mockFetch(t, [[() => true, () => jsonResponse({}, { status: 404 })]]);

  await withArgv(t, ["totally-nonexistent-pkg-xyz"], () =>
    assert.rejects(main(), (err) => err instanceof ProcessExitError && err.code === 1));
  assert.ok(log.some((l) => /VERDICT:.*serious flag/.test(l)));
});

test("main: single package with only WARN findings exits 0 with a warning verdict", async (t) => {
  mockProcessExit(t);
  const { log } = captureOutput(t);
  mockCacheFs(t, { onRead: freshCache(["warn-only-pkg"]) });
  mockFetch(t, [[() => true, () => jsonResponse({
    "dist-tags": { latest: "1.0.0" },
    time: { "1.0.0": new Date().toISOString() }, // fresh -> WARN, only version -> hygiene WARN too
    versions: { "1.0.0": { version: "1.0.0", repository: "x" } },
  })]]);

  await withArgv(t, ["warn-only-pkg"], () =>
    assert.rejects(main(), (err) => err instanceof ProcessExitError && err.code === 0));
  assert.ok(log.some((l) => /VERDICT:.*warning/.test(l)));
});

test("main: fully clean package exits 0 with 'No red flags found'", async (t) => {
  mockProcessExit(t);
  const { log } = captureOutput(t);
  mockCacheFs(t, { onRead: freshCache(["clean-pkg"]) });
  mockFetch(t, [[() => true, () => jsonResponse({
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
  })]]);

  await withArgv(t, ["clean-pkg"], () =>
    assert.rejects(main(), (err) => err instanceof ProcessExitError && err.code === 0));
  assert.ok(log.some((l) => /VERDICT: No red flags found/.test(l)));
});

test("main: passes requested version through to the check", async (t) => {
  mockProcessExit(t);
  const { log } = captureOutput(t);
  mockCacheFs(t, { onRead: freshCache(["versioned-pkg"]) });
  mockFetch(t, [[() => true, () => jsonResponse({}, { status: 404 })]]);

  await withArgv(t, ["versioned-pkg@2.0.0"], () =>
    assert.rejects(main(), (err) => err instanceof ProcessExitError && err.code === 1));
  assert.ok(log.some((l) => /Checking versioned-pkg@2\.0\.0/.test(l)));
});

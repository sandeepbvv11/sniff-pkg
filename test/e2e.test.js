"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawnSync } = require("node:child_process");

const INDEX_JS = path.join(__dirname, "..", "index.js");
const PRELOAD = path.join(__dirname, "fixtures", "throwing-fetch-preload.js");

test("e2e: running the script directly with --help exits 2 and prints usage", () => {
  const result = spawnSync(process.execPath, [INDEX_JS, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/);
  assert.match(result.stderr, /sniff-pkg <package-name>/);
});

test("e2e: an uncaught rejection in main() is caught, logged, and exits 2", () => {
  const result = spawnSync(
    process.execPath,
    ["--require", PRELOAD, INDEX_JS, "some-package"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Error: simulated total network outage/);
});

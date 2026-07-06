"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { REGISTRY, checkPackage, worstLevel } = require("../index.js");
const { jsonResponse, mockFetch } = require("./helpers.js");

const popular = { names: ["lodash", "react"], source: "test-popular" };

test("checkPackage: package not found on the registry is DANGER", async (t) => {
  mockFetch(t, [[() => true, () => jsonResponse({}, { status: 404 })]]);
  const result = await checkPackage("totally-nonexistent-pkg-xyz", undefined, popular);
  assert.equal(result.name, "totally-nonexistent-pkg-xyz");
  assert.equal(worstLevel(result.findings), "DANGER");
  assert.ok(result.findings.some((f) => /not found on the npm registry/.test(f.title)));
});

test("checkPackage: requested version not found falls back to warning + hygiene/typosquat only", async (t) => {
  const doc = {
    "dist-tags": { latest: "2.0.0" },
    versions: { "2.0.0": { version: "2.0.0", repository: "x" } },
    time: {},
  };
  mockFetch(t, [[() => true, () => jsonResponse(doc)]]);
  const result = await checkPackage("some-pkg", "9.9.9", popular);
  assert.equal(result.version, "9.9.9");
  assert.ok(result.findings.some((f) => /Version "9\.9\.9" not found/.test(f.title)));
});

test("checkPackage: full happy path runs all five checks for an existing version", async (t) => {
  const doc = {
    "dist-tags": { latest: "1.1.0" },
    time: {
      "1.0.0": new Date(Date.now() - 1000 * 3600 * 24 * 60).toISOString(),
      "1.1.0": new Date(Date.now() - 1000 * 3600 * 24 * 10).toISOString(),
    },
    versions: {
      "1.0.0": { version: "1.0.0", maintainers: [{ name: "alice" }], repository: "https://github.com/x/y" },
      "1.1.0": {
        version: "1.1.0",
        maintainers: [{ name: "alice" }],
        repository: "https://github.com/x/y",
        scripts: { postinstall: "node build.js" },
      },
    },
  };
  mockFetch(t, [[() => true, () => jsonResponse(doc)]]);
  const result = await checkPackage("some-pkg", undefined, popular);

  assert.equal(result.version, "1.1.0");
  // freshness (OK, >72h old), install scripts (DANGER, new hook), typosquat (OK),
  // maintainers (OK, unchanged), hygiene (no findings since repo present & many versions... only 2, so WARN expected)
  assert.ok(result.findings.some((f) => /has been public for/.test(f.title)));
  assert.ok(result.findings.some((f) => /NEW in this version/.test(f.title)));
  assert.ok(result.findings.some((f) => /Maintainers unchanged/.test(f.title)));
  assert.ok(result.findings.some((f) => /only 2 published version/.test(f.title)));
});

test("checkPackage: resolves dist-tags.latest when no version requested", async (t) => {
  const doc = {
    "dist-tags": { latest: "3.0.0" },
    time: { "3.0.0": new Date().toISOString() },
    versions: { "3.0.0": { version: "3.0.0" } },
  };
  mockFetch(t, [[() => true, () => jsonResponse(doc)]]);
  const result = await checkPackage("some-pkg", undefined, popular);
  assert.equal(result.version, "3.0.0");
});

test("checkPackage: scoped package name is URL-encoded correctly for the registry request", async (t) => {
  let requestedUrl = null;
  mockFetch(t, [
    [() => true, (url) => {
      requestedUrl = url;
      return jsonResponse({}, { status: 404 });
    }],
  ]);
  await checkPackage("@babel/core", undefined, popular);
  assert.equal(requestedUrl, `${REGISTRY}/@babel%2Fcore`);
});

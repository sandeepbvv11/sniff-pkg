"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  levenshtein,
  hoursSince,
  fmtAge,
  parseArg,
  isRegistrySpec,
  resolvableVersion,
  worstLevel,
  previousVersionOf,
  getLifecycleScripts,
  sanitizeForTerminal,
} = require("../index.js");

test("levenshtein: identical strings are distance 0", () => {
  assert.equal(levenshtein("lodash", "lodash"), 0);
});

test("levenshtein: single substitution is distance 1", () => {
  assert.equal(levenshtein("lodash", "lodask"), 1);
});

test("levenshtein: adjacent transposition costs 1 (OSA variant)", () => {
  assert.equal(levenshtein("lodash", "lodahs"), 1);
});

test("levenshtein: quick-reject when length difference exceeds max", () => {
  assert.equal(levenshtein("a", "abcdefgh", 2), 3);
});

test("levenshtein: early exit when running distance exceeds max", () => {
  assert.equal(levenshtein("aaaaaaaa", "zzzzzzzz", 2), 3);
});

test("levenshtein: empty string vs non-empty returns other length", () => {
  assert.equal(levenshtein("", "abc", 5), 3);
  assert.equal(levenshtein("abc", "", 5), 3);
});

test("hoursSince: computes elapsed hours from an ISO date", () => {
  const tenHoursAgo = new Date(Date.now() - 10 * 36e5).toISOString();
  const hours = hoursSince(tenHoursAgo);
  assert.ok(Math.abs(hours - 10) < 0.01, `expected ~10, got ${hours}`);
});

test("fmtAge: formats minutes for sub-hour ages", () => {
  assert.equal(fmtAge(0.5), "30 minutes");
});

test("fmtAge: formats hours for sub-48h ages", () => {
  assert.equal(fmtAge(5), "5.0 hours");
});

test("fmtAge: formats days for 48h and over", () => {
  assert.equal(fmtAge(72), "3.0 days");
});

test("parseArg: bare name with no version", () => {
  assert.deepEqual(parseArg("lodash"), { name: "lodash" });
});

test("parseArg: name@version", () => {
  assert.deepEqual(parseArg("lodash@4.17.21"), { name: "lodash", version: "4.17.21" });
});

test("parseArg: scoped name with no version", () => {
  assert.deepEqual(parseArg("@babel/core"), { name: "@babel/core" });
});

test("parseArg: scoped name with version", () => {
  assert.deepEqual(parseArg("@babel/core@7.24.0"), { name: "@babel/core", version: "7.24.0" });
});

test("isRegistrySpec: plain semver range is a registry spec", () => {
  assert.equal(isRegistrySpec("^1.2.3"), true);
  assert.equal(isRegistrySpec("1.2.3"), true);
  assert.equal(isRegistrySpec("*"), true);
});

test("isRegistrySpec: file/git/link/workspace specs are not registry specs", () => {
  assert.equal(isRegistrySpec("file:../local-pkg"), false);
  assert.equal(isRegistrySpec("git+https://github.com/x/y.git"), false);
  assert.equal(isRegistrySpec("github:x/y"), false);
  assert.equal(isRegistrySpec("link:../pkg"), false);
  assert.equal(isRegistrySpec("workspace:*"), false);
  assert.equal(isRegistrySpec("https://example.com/pkg.tgz"), false);
  assert.equal(isRegistrySpec("npm:other-pkg@1.0.0"), false);
});

test("isRegistrySpec: non-string range is not a registry spec", () => {
  assert.equal(isRegistrySpec(undefined), false);
  assert.equal(isRegistrySpec(null), false);
});

test("resolvableVersion: missing range resolves to latest", () => {
  assert.deepEqual(resolvableVersion(undefined), { version: null, note: "latest" });
  assert.deepEqual(resolvableVersion(""), { version: null, note: "latest" });
});

test("resolvableVersion: exact version is checked as-is", () => {
  assert.deepEqual(resolvableVersion("1.2.3"), { version: "1.2.3", note: "exact" });
});

test("resolvableVersion: leading = is stripped from an exact version", () => {
  assert.deepEqual(resolvableVersion("=1.2.3"), { version: "1.2.3", note: "exact" });
});

test("resolvableVersion: pre-release exact version is checked as-is", () => {
  assert.deepEqual(resolvableVersion("1.2.3-beta.1"), { version: "1.2.3-beta.1", note: "exact" });
});

test("resolvableVersion: range falls back to checking latest", () => {
  const result = resolvableVersion("^1.2.3");
  assert.equal(result.version, null);
  assert.match(result.note, /checking latest/);
});

test("worstLevel: DANGER beats WARN beats OK", () => {
  assert.equal(worstLevel([{ level: "OK" }, { level: "DANGER" }, { level: "WARN" }]), "DANGER");
  assert.equal(worstLevel([{ level: "OK" }, { level: "WARN" }]), "WARN");
  assert.equal(worstLevel([{ level: "OK" }]), "OK");
  assert.equal(worstLevel([]), "OK");
});

test("previousVersionOf: returns the version published immediately before", () => {
  const doc = {
    time: { "1.0.0": "2024-01-01T00:00:00Z", "1.1.0": "2024-02-01T00:00:00Z", "1.2.0": "2024-03-01T00:00:00Z" },
    versions: { "1.0.0": {}, "1.1.0": {}, "1.2.0": {} },
  };
  assert.equal(previousVersionOf(doc, "1.2.0"), "1.1.0");
  assert.equal(previousVersionOf(doc, "1.1.0"), "1.0.0");
});

test("previousVersionOf: returns null for the first published version", () => {
  const doc = {
    time: { "1.0.0": "2024-01-01T00:00:00Z" },
    versions: { "1.0.0": {} },
  };
  assert.equal(previousVersionOf(doc, "1.0.0"), null);
});

test("previousVersionOf: returns null when version has no time entry", () => {
  const doc = { time: {}, versions: { "1.0.0": {} } };
  assert.equal(previousVersionOf(doc, "1.0.0"), null);
});

test("getLifecycleScripts: picks only preinstall/install/postinstall", () => {
  const versionMeta = { scripts: { preinstall: "a", install: "b", postinstall: "c", prepare: "d", test: "e" } };
  assert.deepEqual(getLifecycleScripts(versionMeta), { preinstall: "a", install: "b", postinstall: "c" });
});

test("getLifecycleScripts: empty when no scripts field", () => {
  assert.deepEqual(getLifecycleScripts({}), {});
});

test("sanitizeForTerminal: strips ESC and other control characters", () => {
  const malicious = "hello\x1b[31mworld\x1b]0;pwned\x07";
  assert.equal(sanitizeForTerminal(malicious), "hello[31mworld]0;pwned");
});

test("sanitizeForTerminal: preserves newlines and tabs", () => {
  assert.equal(sanitizeForTerminal("line1\nline2\tindented"), "line1\nline2\tindented");
});

test("sanitizeForTerminal: coerces non-string input", () => {
  assert.equal(sanitizeForTerminal(123), "123");
});

test("sanitizeForTerminal: strips carriage return (line-overwrite vector)", () => {
  assert.equal(sanitizeForTerminal("clean\rHACKED"), "cleanHACKED");
});

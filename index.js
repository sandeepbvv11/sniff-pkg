#!/usr/bin/env node
/**
 * sniff-pkg — check an npm package for red flags BEFORE you install it.
 *
 * Usage:
 *   npx sniff-pkg <package-name>[@version]   check one package
 *   npx sniff-pkg --project [path]           check all deps in every
 *                                             package.json under path
 *
 * Checks:
 *   1. Freshness       — was this version published very recently?
 *   2. Install scripts — does it run code on install, and is that script NEW/CHANGED?
 *   3. Typosquatting   — is the name suspiciously close to any of ~17,000 popular
 *                        packages? (list auto-downloaded from the npm registry via
 *                        the `npm-high-impact` dataset, cached locally for 7 days)
 *   4. Maintainer churn — did the maintainer list change in the latest release?
 *   5. Basic hygiene   — deprecated, no repo link, tiny track record.
 *
 * Zero dependencies. Uses only Node built-ins + the public npm registry.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const REGISTRY = "https://registry.npmjs.org";
const REGISTRY_HOST = new URL(REGISTRY).host;
const HOURS_FRESH = 72; // versions younger than this are "too fresh"
const CACHE_FILE = path.join(os.homedir(), ".sniff-pkg-popular.json");
const CACHE_MAX_AGE_DAYS = 7;

// Ceilings on anything we pull off the network. Real registry docs and the
// npm-high-impact tarball are all well under a few MB — these caps just stop
// a compromised/MITM'd response (or decompression bomb) from exhausting
// memory on the machine running this tool.
const MAX_JSON_BYTES = 20 * 1024 * 1024;
const MAX_TARBALL_BYTES = 20 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 100 * 1024 * 1024;

// Fallback list used only if downloading the big list fails.
const FALLBACK_POPULAR = [
  "react", "react-dom", "lodash", "express", "axios", "chalk", "commander",
  "moment", "vue", "next", "webpack", "typescript", "jest", "eslint",
  "prettier", "dotenv", "uuid", "classnames", "redux", "vite", "rollup",
  "node-fetch", "yargs", "inquirer", "glob", "rimraf", "fs-extra",
  "mongoose", "socket.io", "cors", "body-parser", "nodemon", "openai",
];

// ---------- popular list: download, cache, load ----------

/** Read a fetch() Response body into a Buffer, aborting once it exceeds
 *  maxBytes. Without this, a compromised or tampered response could stream
 *  an effectively unbounded body and exhaust memory on the caller's machine. */
async function readBodyWithLimit(res, maxBytes) {
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (received > maxBytes) {
      await reader.cancel();
      throw new Error(`response body exceeded ${maxBytes} byte limit`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

/** GET a URL and parse it as JSON. A 404 is treated as "not found" (returns
 *  null) rather than an error, since that's a normal, expected response from
 *  the registry (e.g. an unpublished package or version). */
async function fetchJSON(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Registry returned HTTP ${res.status} for ${url}`);
  const buf = await readBodyWithLimit(res, MAX_JSON_BYTES);
  return JSON.parse(buf.toString("utf8"));
}

/** Minimal tar reader: find one file by name inside a tar buffer. */
function extractFileFromTar(tarBuf, wantedName) {
  let offset = 0;
  while (offset + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    if (!name) break; // end of archive
    const size = parseInt(header.subarray(124, 136).toString("utf8").trim(), 8) || 0;
    const dataStart = offset + 512;
    if (name === wantedName) {
      return tarBuf.subarray(dataStart, dataStart + size);
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

async function downloadPopularList() {
  process.stderr.write("(first run: downloading popular-packages list for typosquat check...)\n");
  const meta = await fetchJSON(`${REGISTRY}/npm-high-impact/latest`);
  const tarballUrl = meta?.dist?.tarball;
  if (!tarballUrl) throw new Error("could not locate npm-high-impact tarball");
  // The registry's own metadata told us where to fetch from — trust it only
  // as far as "still the registry", so a tampered response can't redirect
  // this download to an arbitrary (e.g. internal) host.
  if (new URL(tarballUrl).host !== REGISTRY_HOST) {
    throw new Error(`refusing to fetch tarball from unexpected host: ${tarballUrl}`);
  }

  const res = await fetch(tarballUrl);
  if (!res.ok) throw new Error(`tarball download failed: HTTP ${res.status}`);
  const gz = await readBodyWithLimit(res, MAX_TARBALL_BYTES);
  const tar = zlib.gunzipSync(gz, { maxOutputLength: MAX_DECOMPRESSED_BYTES });

  const file = extractFileFromTar(tar, "package/lib/top.js");
  if (!file) throw new Error("top.js not found inside tarball");

  // File looks like: export const top = [ 'semver', 'minimatch', ... ]
  const names = [...file.toString("utf8").matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (names.length < 1000) throw new Error("popular list looked too small, refusing to trust it");
  return names;
}

async function loadPopularList() {
  // 1. try fresh cache
  try {
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    const ageDays = (Date.now() - cached.savedAt) / 864e5;
    if (ageDays < CACHE_MAX_AGE_DAYS && Array.isArray(cached.names) && cached.names.length) {
      return { names: cached.names, source: `cache (${cached.names.length} names)` };
    }
  } catch { /* no cache or unreadable — fall through */ }

  // 2. download and cache
  try {
    const names = await downloadPopularList();
    try {
      // mode 0o600: this cache is the typosquat allowlist, so keep it from
      // being casually read or tampered with by other local users/processes.
      fs.writeFileSync(CACHE_FILE, JSON.stringify({ savedAt: Date.now(), names }), { mode: 0o600 });
    } catch { /* cache write failed, not fatal */ }
    return { names, source: `registry (${names.length} names)` };
  } catch (err) {
    // 3. stale cache is better than nothing
    try {
      const cached = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
      if (Array.isArray(cached.names) && cached.names.length) {
        return { names: cached.names, source: `stale cache (${cached.names.length} names)` };
      }
    } catch { /* ignore */ }
    process.stderr.write(`(could not download popular list: ${err.message} — using small built-in list)\n`);
    return { names: FALLBACK_POPULAR, source: `built-in fallback (${FALLBACK_POPULAR.length} names)` };
  }
}

// ---------- tiny helpers ----------

/** Damerau-Levenshtein (OSA variant): swapping two adjacent letters costs 1,
 *  because that's one of the most common real typos ("lodahs" vs "lodash"). */
function levenshtein(a, b, max = 2) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1; // quick reject
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev2 = null;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      // transposition of adjacent characters
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        cur[j] = Math.min(cur[j], prev2[j - 2] + 1);
      }
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1; // early exit
    prev2 = prev;
    prev = cur;
  }
  return prev[n];
}

function hoursSince(dateStr) {
  return (Date.now() - new Date(dateStr).getTime()) / 36e5;
}

function fmtAge(hours) {
  if (hours < 1) return `${Math.round(hours * 60)} minutes`;
  if (hours < 48) return `${hours.toFixed(1)} hours`;
  return `${(hours / 24).toFixed(1)} days`;
}

// ---------- checks ----------

function checkFreshness(findings, versionMeta, publishTime) {
  if (!publishTime) return;
  const age = hoursSince(publishTime);
  if (age < HOURS_FRESH) {
    findings.push({
      level: "WARN",
      title: `Version ${versionMeta.version} is only ${fmtAge(age)} old`,
      detail:
        `Most malicious releases are caught and removed within a few days. ` +
        `Consider waiting, or pin the previous version for now.`,
    });
  } else {
    findings.push({
      level: "OK",
      title: `Version ${versionMeta.version} has been public for ${fmtAge(age)}`,
    });
  }
}

function getLifecycleScripts(versionMeta) {
  const s = versionMeta.scripts || {};
  // Only hooks that actually execute on YOUR machine when installing from the
  // registry. ("prepare" runs only for the package's own developers/git installs,
  // so flagging it would just be noise.)
  const hooks = ["preinstall", "install", "postinstall"];
  const found = {};
  for (const h of hooks) if (s[h]) found[h] = s[h];
  return found;
}

function checkInstallScripts(findings, versionMeta, prevMeta) {
  const cur = getLifecycleScripts(versionMeta);
  const curHooks = Object.keys(cur);

  if (curHooks.length === 0) {
    findings.push({ level: "OK", title: "No install-time scripts (nothing runs on npm install)" });
    return;
  }

  const prev = prevMeta ? getLifecycleScripts(prevMeta) : {};
  const newHooks = curHooks.filter((h) => !(h in prev));
  const changedHooks = curHooks.filter((h) => h in prev && prev[h] !== cur[h]);

  for (const h of curHooks) {
    const isNew = newHooks.includes(h);
    const isChanged = changedHooks.includes(h);
    findings.push({
      level: isNew || isChanged ? "DANGER" : "WARN",
      title:
        `Runs code on install via "${h}"` +
        (isNew ? " — NEW in this version!" : isChanged ? " — CHANGED in this version!" : ""),
      detail: `  ${h}: ${cur[h]}`,
    });
  }
}

function checkTyposquat(findings, name, popular) {
  const popSet = new Set(popular.names);
  const bare = name.startsWith("@") ? name.split("/")[1] || name : name;

  if (popSet.has(name) || popSet.has(bare)) {
    findings.push({
      level: "OK",
      title: `"${name}" is itself on the popular-packages list (${popular.source})`,
    });
    return;
  }

  const lower = bare.toLowerCase();
  const hits = [];
  for (const p of popSet) {
    const target = p.startsWith("@") ? p.split("/")[1] || p : p;
    // allowed distance: 1 for short names, 2 for longer names
    const maxD = target.length >= 8 ? 2 : 1;
    const d = levenshtein(lower, target.toLowerCase(), maxD);
    if (d > 0 && d <= maxD) hits.push({ p, d });
    if (hits.length >= 5) break;
  }
  hits.sort((a, b) => a.d - b.d);

  if (hits.length) {
    findings.push({
      level: "DANGER",
      title: `Name is very close to popular package(s): ${hits.map((h) => `"${h.p}"`).join(", ")}`,
      detail: `Possible typosquat. Double-check you spelled the package you actually wanted.`,
    });
  } else {
    findings.push({
      level: "OK",
      title: `Name not close to any of the popular packages checked (${popular.source})`,
    });
  }
}

function checkMaintainers(findings, versionMeta, prevMeta) {
  const cur = (versionMeta.maintainers || []).map((m) => m.name).sort();
  if (!prevMeta) return;
  const prev = (prevMeta.maintainers || []).map((m) => m.name).sort();
  if (!cur.length || !prev.length) return;

  const added = cur.filter((m) => !prev.includes(m));
  const removed = prev.filter((m) => !cur.includes(m));

  if (added.length || removed.length) {
    findings.push({
      level: "WARN",
      title: "Maintainer list changed in the latest release",
      detail:
        (added.length ? `  added: ${added.join(", ")}\n` : "") +
        (removed.length ? `  removed: ${removed.join(", ")}` : ""),
    });
  } else {
    findings.push({ level: "OK", title: "Maintainers unchanged since previous version" });
  }
}

function checkHygiene(findings, doc, versionMeta) {
  if (versionMeta.deprecated) {
    findings.push({
      level: "WARN",
      title: "This version is DEPRECATED",
      detail: `  ${versionMeta.deprecated}`,
    });
  }
  if (!versionMeta.repository) {
    findings.push({
      level: "WARN",
      title: "No repository link — you can't easily inspect the source",
    });
  }
  const versionCount = Object.keys(doc.versions || {}).length;
  if (versionCount <= 2) {
    findings.push({
      level: "WARN",
      title: `Package has only ${versionCount} published version(s) — very little track record`,
    });
  }
}

// ---------- single-package check (returns findings instead of printing) ----------

async function checkPackage(name, requested, popular) {
  // The registry expects scoped packages as "@scope%2Fname" (leading "@" literal,
  // "/" percent-encoded). encodeURIComponent() encodes both, so put the "@" back.
  const doc = await fetchJSON(`${REGISTRY}/${encodeURIComponent(name).replace("%40", "@")}`);
  if (!doc) {
    const findings = [{
      level: "DANGER",
      title: `Package "${name}" not found on the npm registry`,
      detail: `(That itself is a red flag if you copied this name from somewhere.)`,
    }];
    checkTyposquat(findings, name, popular); // name check needs no registry data
    return { name, version: requested, findings };
  }

  const version = requested || doc["dist-tags"]?.latest;
  const versionMeta = doc.versions?.[version];
  if (!versionMeta) {
    const findings = [{
      level: "WARN",
      title: `Version "${version}" not found (latest is ${doc["dist-tags"]?.latest}) — version checks skipped`,
    }];
    checkTyposquat(findings, name, popular);
    checkHygiene(findings, doc, doc.versions?.[doc["dist-tags"]?.latest] || {});
    return { name, version, findings };
  }

  const prevVersion = previousVersionOf(doc, version);
  const prevMeta = prevVersion ? doc.versions[prevVersion] : null;
  const publishTime = doc.time?.[version];

  const findings = [];
  checkFreshness(findings, versionMeta, publishTime);
  checkInstallScripts(findings, versionMeta, prevMeta);
  checkTyposquat(findings, name, popular);
  checkMaintainers(findings, versionMeta, prevMeta);
  checkHygiene(findings, doc, versionMeta);
  return { name, version, findings };
}

function worstLevel(findings) {
  if (findings.some((f) => f.level === "DANGER")) return "DANGER";
  if (findings.some((f) => f.level === "WARN")) return "WARN";
  return "OK";
}

const ICONS = { OK: "  [ok]    ", WARN: "  [warn]  ", DANGER: "  [DANGER]" };

/** Strip terminal control/escape characters from text that ultimately comes
 *  from a package's own metadata (install scripts, maintainer names,
 *  deprecation notices, dependency names from a scanned package.json). That
 *  content is attacker-controlled by definition for a malicious package, and
 *  a raw ESC byte can drive ANSI/OSC sequences — hiding output, spoofing
 *  text, or (via OSC 52) writing into the terminal's clipboard. Newlines are
 *  kept since findings intentionally use them for multi-line detail text. */
function sanitizeForTerminal(str) {
  // Keep only tab (\x09) and newline (\x0A); strip every other C0 control
  // character — including \r, which alone can overwrite a printed line.
  return String(str).replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "");
}

function printFindings(findings) {
  for (const f of findings) {
    console.log(ICONS[f.level] + " " + sanitizeForTerminal(f.title));
    if (f.detail) console.log("            " + sanitizeForTerminal(f.detail).split("\n").join("\n            "));
  }
}

// ---------- project mode ----------

function findPackageJsonFiles(dir, out = [], depth = 0) {
  if (depth > 8) return out; // sanity limit
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) findPackageJsonFiles(full, out, depth + 1);
    else if (e.isFile() && e.name === "package.json") out.push(full);
  }
  return out;
}

/** Turn a package.json version range into something checkable.
 *  Exact versions ("1.2.3", "=1.2.3") are checked as-is; ranges (^ ~ > * etc.)
 *  are checked against the latest published version, since that's what a fresh
 *  install would typically pull for common ^ ranges. */
function resolvableVersion(range) {
  if (!range) return { version: null, note: "latest" };
  const cleaned = range.trim().replace(/^=/, "");
  if (/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(cleaned)) return { version: cleaned, note: "exact" };
  return { version: null, note: `range "${range}" → checking latest` };
}

/** True if a package.json dependency range refers to a plain registry
 *  version/range (checkable here), as opposed to a local path, git URL,
 *  workspace link, etc. (which we have no registry data for and must skip). */
function isRegistrySpec(range) {
  if (typeof range !== "string") return false;
  return !/^(file:|link:|git|github:|gitlab:|bitbucket:|https?:|workspace:|npm:)/.test(range.trim());
}

async function runProjectMode(rootArg) {
  // Step 1: resolve what to scan — a single package.json, or a directory tree.
  const root = path.resolve(rootArg || ".");
  let files;
  const stat = fs.existsSync(root) && fs.statSync(root);
  if (stat && stat.isFile()) files = [root];
  else if (stat && stat.isDirectory()) files = findPackageJsonFiles(root);
  else {
    console.error(`Path not found: ${root}`);
    process.exit(2);
  }

  if (!files.length) {
    console.error(`No package.json files found under ${root} (node_modules is skipped on purpose).`);
    process.exit(2);
  }

  // Step 2: collect unique deps across all files: name -> { range, from: [files], dev }
  const deps = new Map();
  const skipped = [];
  for (const file of files) {
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {
      console.error(`(skipping unreadable ${file}: ${e.message})`);
      continue;
    }
    const rel = path.relative(root, file) || "package.json";
    for (const [section, isDev] of [["dependencies", false], ["devDependencies", true], ["optionalDependencies", false]]) {
      for (const [name, range] of Object.entries(pkg[section] || {})) {
        if (!isRegistrySpec(range)) { skipped.push(`${name}@${range} (${rel})`); continue; }
        if (!deps.has(name)) deps.set(name, { range, from: [], dev: isDev });
        deps.get(name).from.push(rel);
      }
    }
  }

  console.log(`\nFound ${files.length} package.json file(s), ${deps.size} unique dependencies to check.\n`);
  if (skipped.length) {
    console.log(`(skipping ${skipped.length} non-registry dep(s): ${skipped.slice(0, 3).join(", ")}${skipped.length > 3 ? ", ..." : ""})\n`);
  }
  if (!deps.size) { console.log("Nothing to check."); process.exit(0); }

  const popular = await loadPopularList();

  // Step 3: check every dependency, 8 at a time, so we don't hammer the
  // registry (or wait forever) on a project with hundreds of deps.
  const entries = [...deps.entries()];
  const results = new Array(entries.length);
  let next = 0, done = 0;
  const total = entries.length;
  async function worker() {
    while (next < entries.length) {
      const i = next++;
      const [name, info] = entries[i];
      const { version } = resolvableVersion(info.range);
      try {
        results[i] = await checkPackage(name, version, popular);
      } catch (err) {
        results[i] = { name, findings: [{ level: "WARN", title: `Check failed: ${err.message}` }] };
      }
      done++;
      process.stderr.write(`\rChecking... ${done}/${total} `);
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  process.stderr.write("\r                          \r");

  // Step 4: report — one line per clean package, full details for flagged ones.
  let okCount = 0, warnPkgs = [], dangerPkgs = [];
  for (let i = 0; i < entries.length; i++) {
    const [name, info] = entries[i];
    const r = results[i];
    const level = worstLevel(r.findings);
    if (level === "OK") { okCount++; continue; }
    if (level === "WARN") warnPkgs.push({ name, info, r });
    else dangerPkgs.push({ name, info, r });
  }

  for (const group of [dangerPkgs, warnPkgs]) {
    for (const { name, info, r } of group) {
      const level = worstLevel(r.findings);
      console.log(`${ICONS[level]} ${sanitizeForTerminal(name)}@${sanitizeForTerminal(info.range)}${info.dev ? " (dev)" : ""}  [in: ${info.from.join(", ")}]`);
      printFindings(r.findings.filter((f) => f.level !== "OK"));
      console.log("");
    }
  }

  console.log(`SUMMARY: ${okCount} clean, ${warnPkgs.length} with warnings, ${dangerPkgs.length} DANGEROUS (of ${total} checked).`);
  if (dangerPkgs.length) {
    console.log(`Do NOT install/update the dangerous ones without reading their source.`);
    process.exit(1);
  }
  process.exit(0);
}

// ---------- main ----------

/** Split a CLI arg like "lodash@4.17.21" or "@babel/core@7.24.0" into
 *  { name, version }. Scoped package names start with their own "@", so for
 *  those we search for the version-delimiting "@" starting after index 0. */
function parseArg(arg) {
  if (arg.startsWith("@")) {
    const at = arg.indexOf("@", 1);
    return at === -1 ? { name: arg } : { name: arg.slice(0, at), version: arg.slice(at + 1) };
  }
  const at = arg.indexOf("@");
  return at === -1 ? { name: arg } : { name: arg.slice(0, at), version: arg.slice(at + 1) };
}

/** Find the version published immediately before `version`, by publish
 *  timestamp — used to diff install scripts and maintainers release-over-release. */
function previousVersionOf(doc, version) {
  const times = doc.time || {};
  const versions = Object.keys(doc.versions || {})
    .filter((v) => times[v])
    .sort((a, b) => new Date(times[a]) - new Date(times[b]));
  const idx = versions.indexOf(version);
  return idx > 0 ? versions[idx - 1] : null;
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    console.error("Usage:");
    console.error("  sniff-pkg <package-name>[@version]   check one package");
    console.error("  sniff-pkg --project [path]           check all deps in every");
    console.error("                                        package.json under path");
    process.exit(2);
  }

  if (args[0] === "--project" || args[0] === "-p") {
    return runProjectMode(args[1]);
  }

  const { name, version: requested } = parseArg(args[0]);
  console.log(`\nChecking ${name}${requested ? "@" + requested : ""} ...\n`);

  const popular = await loadPopularList();
  const result = await checkPackage(name, requested, popular);
  printFindings(result.findings);

  const warns = result.findings.filter((f) => f.level === "WARN").length;
  const dangers = result.findings.filter((f) => f.level === "DANGER").length;
  console.log("");
  if (dangers) {
    console.log(`VERDICT: ${dangers} serious flag(s), ${warns} warning(s). Do NOT install without reading the source.`);
    process.exit(1);
  } else if (warns) {
    console.log(`VERDICT: ${warns} warning(s). Probably fine, but read them before installing.`);
    process.exit(0);
  } else {
    console.log("VERDICT: No red flags found.");
    process.exit(0);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(2);
  });
}

module.exports = {
  REGISTRY,
  REGISTRY_HOST,
  CACHE_FILE,
  FALLBACK_POPULAR,
  readBodyWithLimit,
  fetchJSON,
  extractFileFromTar,
  downloadPopularList,
  loadPopularList,
  levenshtein,
  hoursSince,
  fmtAge,
  checkFreshness,
  getLifecycleScripts,
  checkInstallScripts,
  checkTyposquat,
  checkMaintainers,
  checkHygiene,
  checkPackage,
  worstLevel,
  sanitizeForTerminal,
  printFindings,
  findPackageJsonFiles,
  resolvableVersion,
  isRegistrySpec,
  runProjectMode,
  parseArg,
  previousVersionOf,
  main,
};

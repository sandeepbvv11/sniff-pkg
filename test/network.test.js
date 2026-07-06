"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  REGISTRY,
  fetchJSON,
  readBodyWithLimit,
  extractFileFromTar,
  downloadPopularList,
  loadPopularList,
  FALLBACK_POPULAR,
} = require("../index.js");
const { jsonResponse, bytesResponse, mockFetch, mockCacheFs, buildTar, buildTarGz, fakeTopJs } = require("./helpers.js");

// ---------- readBodyWithLimit ----------

test("readBodyWithLimit: returns full body when under the limit", async () => {
  const res = bytesResponse(Buffer.from("hello world"));
  const buf = await readBodyWithLimit(res, 1000);
  assert.equal(buf.toString("utf8"), "hello world");
});

test("readBodyWithLimit: throws once the body exceeds the limit", async () => {
  const res = bytesResponse(Buffer.from("this is way more than ten bytes"));
  await assert.rejects(readBodyWithLimit(res, 10), /exceeded 10 byte limit/);
});

// ---------- fetchJSON ----------

test("fetchJSON: 404 resolves to null", async (t) => {
  mockFetch(t, [["/missing", () => jsonResponse({}, { status: 404 })]]);
  const result = await fetchJSON(`${REGISTRY}/missing`);
  assert.equal(result, null);
});

test("fetchJSON: non-ok status throws", async (t) => {
  mockFetch(t, [["/broken", () => jsonResponse({ error: "nope" }, { status: 500 })]]);
  await assert.rejects(fetchJSON(`${REGISTRY}/broken`), /Registry returned HTTP 500/);
});

test("fetchJSON: ok status parses and returns JSON", async (t) => {
  mockFetch(t, [["/ok", () => jsonResponse({ hello: "world" })]]);
  const result = await fetchJSON(`${REGISTRY}/ok`);
  assert.deepEqual(result, { hello: "world" });
});

// ---------- extractFileFromTar ----------

test("extractFileFromTar: finds a named file's contents inside a tar buffer", () => {
  const tar = buildTar([{ name: "package/lib/top.js", content: "export const top = ['a'];" }]);
  const file = extractFileFromTar(tar, "package/lib/top.js");
  assert.equal(file.toString("utf8"), "export const top = ['a'];");
});

test("extractFileFromTar: returns null when the wanted file isn't present", () => {
  const tar = buildTar([{ name: "package/other.js", content: "x" }]);
  assert.equal(extractFileFromTar(tar, "package/lib/top.js"), null);
});

test("extractFileFromTar: returns null for an empty archive", () => {
  const tar = buildTar([]);
  assert.equal(extractFileFromTar(tar, "package/lib/top.js"), null);
});

test("extractFileFromTar: finds the right file among multiple entries", () => {
  const tar = buildTar([
    { name: "package/README.md", content: "# readme" },
    { name: "package/lib/top.js", content: "export const top = ['b'];" },
    { name: "package/package.json", content: "{}" },
  ]);
  const file = extractFileFromTar(tar, "package/lib/top.js");
  assert.equal(file.toString("utf8"), "export const top = ['b'];");
});

// ---------- downloadPopularList ----------

test("downloadPopularList: happy path returns the parsed name list", async (t) => {
  const names = Array.from({ length: 1200 }, (_, i) => `pkg-${i}`);
  const topJs = `export const top = [${names.map((n) => `'${n}'`).join(", ")}];`;
  const tarGz = buildTarGz([{ name: "package/lib/top.js", content: topJs }]);

  mockFetch(t, [
    ["npm-high-impact/latest", () => jsonResponse({ dist: { tarball: `${REGISTRY}/npm-high-impact/-/npm-high-impact-1.0.0.tgz` } })],
    [".tgz", () => bytesResponse(tarGz)],
  ]);

  const result = await downloadPopularList();
  assert.equal(result.length, 1200);
  assert.equal(result[0], "pkg-0");
});

test("downloadPopularList: throws when registry metadata has no tarball", async (t) => {
  mockFetch(t, [["npm-high-impact/latest", () => jsonResponse({})]]);
  await assert.rejects(downloadPopularList(), /could not locate npm-high-impact tarball/);
});

test("downloadPopularList: refuses a tarball URL on an unexpected host (SSRF guard)", async (t) => {
  mockFetch(t, [
    ["npm-high-impact/latest", () => jsonResponse({ dist: { tarball: "https://evil.example.com/payload.tgz" } })],
  ]);
  await assert.rejects(downloadPopularList(), /refusing to fetch tarball from unexpected host/);
});

test("downloadPopularList: throws when the tarball download fails", async (t) => {
  mockFetch(t, [
    ["npm-high-impact/latest", () => jsonResponse({ dist: { tarball: `${REGISTRY}/npm-high-impact/-/x.tgz` } })],
    [".tgz", () => bytesResponse(Buffer.from(""), { status: 500 })],
  ]);
  await assert.rejects(downloadPopularList(), /tarball download failed: HTTP 500/);
});

test("downloadPopularList: throws when top.js is missing from the tarball", async (t) => {
  const tarGz = buildTarGz([{ name: "package/README.md", content: "no top.js here" }]);
  mockFetch(t, [
    ["npm-high-impact/latest", () => jsonResponse({ dist: { tarball: `${REGISTRY}/npm-high-impact/-/x.tgz` } })],
    [".tgz", () => bytesResponse(tarGz)],
  ]);
  await assert.rejects(downloadPopularList(), /top\.js not found inside tarball/);
});

test("downloadPopularList: throws when the parsed list looks too small to trust", async (t) => {
  const tarGz = buildTarGz([{ name: "package/lib/top.js", content: "export const top = ['only-one'];" }]);
  mockFetch(t, [
    ["npm-high-impact/latest", () => jsonResponse({ dist: { tarball: `${REGISTRY}/npm-high-impact/-/x.tgz` } })],
    [".tgz", () => bytesResponse(tarGz)],
  ]);
  await assert.rejects(downloadPopularList(), /looked too small/);
});

// ---------- loadPopularList ----------

test("loadPopularList: fresh cache short-circuits and never hits the network", async (t) => {
  mockCacheFs(t, {
    onRead: () => JSON.stringify({ savedAt: Date.now(), names: ["from-cache"] }),
  });
  mockFetch(t, [[() => true, () => { throw new Error("network should not be called"); }]]);

  const result = await loadPopularList();
  assert.deepEqual(result.names, ["from-cache"]);
  assert.match(result.source, /^cache/);
});

test("loadPopularList: no cache downloads fresh list and writes it back", async (t) => {
  let written = null;
  mockCacheFs(t, { onWrite: (data) => { written = JSON.parse(data); } });

  const topJs = fakeTopJs(1500);
  const tarGz = buildTarGz([{ name: "package/lib/top.js", content: topJs }]);
  mockFetch(t, [
    ["npm-high-impact/latest", () => jsonResponse({ dist: { tarball: `${REGISTRY}/npm-high-impact/-/x.tgz` } })],
    [".tgz", () => bytesResponse(tarGz)],
  ]);

  const result = await loadPopularList();
  assert.equal(result.names.length, 1500);
  assert.match(result.source, /^registry/);
  assert.equal(written.names.length, 1500);
});

test("loadPopularList: download failure falls back to stale cache", async (t) => {
  mockCacheFs(t, {
    onRead: () => JSON.stringify({ savedAt: 0, names: ["stale-name"] }), // savedAt=0 -> definitely stale
  });
  mockFetch(t, [["npm-high-impact/latest", () => jsonResponse({}, { status: 500 })]]);

  const result = await loadPopularList();
  assert.deepEqual(result.names, ["stale-name"]);
  assert.match(result.source, /^stale cache/);
});

test("loadPopularList: download failure with no cache at all falls back to built-in list", async (t) => {
  mockCacheFs(t); // no onRead -> every read throws ENOENT
  mockFetch(t, [["npm-high-impact/latest", () => jsonResponse({}, { status: 500 })]]);

  const result = await loadPopularList();
  assert.deepEqual(result.names, FALLBACK_POPULAR);
  assert.match(result.source, /^built-in fallback/);
});

test("loadPopularList: stale (expired) cache is not used directly, triggers a re-download", async (t) => {
  let written = null;
  mockCacheFs(t, {
    onRead: () => JSON.stringify({ savedAt: 0, names: ["old-stale-name"] }),
    onWrite: (data) => { written = JSON.parse(data); },
  });
  const topJs = fakeTopJs(1100);
  const tarGz = buildTarGz([{ name: "package/lib/top.js", content: topJs }]);
  mockFetch(t, [
    ["npm-high-impact/latest", () => jsonResponse({ dist: { tarball: `${REGISTRY}/npm-high-impact/-/x.tgz` } })],
    [".tgz", () => bytesResponse(tarGz)],
  ]);

  const result = await loadPopularList();
  assert.equal(result.names.length, 1100);
  assert.match(result.source, /^registry/);
  assert.equal(written.names.length, 1100);
});

"use strict";
const fs = require("fs");
const zlib = require("zlib");
const { CACHE_FILE } = require("../index.js");

/** Thrown by the mocked process.exit() so tests can assert on the exit code
 *  via assert.rejects/assert.throws instead of the process actually dying. */
class ProcessExitError extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

/** Replace process.exit with one that throws ProcessExitError instead of
 *  killing the test worker. Auto-restored when the test ends (t.mock). */
function mockProcessExit(t) {
  return t.mock.method(process, "exit", (code) => {
    throw new ProcessExitError(code);
  });
}

/** Silence + capture console.log / console.error / process.stderr.write so
 *  assertions can inspect output without spamming the test log. */
function captureOutput(t) {
  const log = [];
  const error = [];
  const stderr = [];
  t.mock.method(console, "log", (...args) => { log.push(args.join(" ")); });
  t.mock.method(console, "error", (...args) => { error.push(args.join(" ")); });
  t.mock.method(process.stderr, "write", (chunk) => { stderr.push(String(chunk)); return true; });
  return { log, error, stderr };
}

/** Build a fetch()-compatible Response for a JSON body. */
function jsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Build a fetch()-compatible Response for raw bytes (e.g. a gzip tarball). */
function bytesResponse(buf, { status = 200 } = {}) {
  return new Response(buf, { status });
}

/** Route global.fetch to a handler keyed by URL prefix/predicate. `routes` is
 *  an array of [predicate, handlerFn]; the first predicate that matches the
 *  requested URL wins. Auto-restored when the test ends. */
function mockFetch(t, routes) {
  return t.mock.method(global, "fetch", async (url, opts) => {
    const u = String(url);
    for (const [predicate, handler] of routes) {
      const matches = typeof predicate === "function" ? predicate(u) : u.includes(predicate);
      if (matches) return handler(u, opts);
    }
    throw new Error(`mockFetch: no route matched ${u}`);
  });
}

/** Intercept only reads/writes to the popular-packages CACHE_FILE, passing
 *  everything else through to the real fs — so project-mode tests using a
 *  real temp directory keep working unaffected. */
function mockCacheFs(t, { onRead, onWrite } = {}) {
  const realRead = fs.readFileSync.bind(fs);
  const realWrite = fs.writeFileSync.bind(fs);
  t.mock.method(fs, "readFileSync", (p, enc) => {
    if (p === CACHE_FILE) {
      if (!onRead) { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; }
      return onRead();
    }
    return realRead(p, enc);
  });
  t.mock.method(fs, "writeFileSync", (p, data, opts) => {
    if (p === CACHE_FILE) { onWrite?.(data, opts); return; }
    return realWrite(p, data, opts);
  });
}

/** Build a minimal valid (uncompressed) tar buffer containing the given
 *  files, matching what extractFileFromTar() expects to walk: 512-byte
 *  headers with a name and octal size, data padded to a 512-byte boundary,
 *  terminated by two zero blocks. */
function buildTar(entries) {
  const blocks = [];
  for (const { name, content } of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0, "utf8");
    const sizeOctal = content.length.toString(8).padStart(11, "0") + " ";
    header.write(sizeOctal, 124, "utf8");
    header.write("0000644\0", 100, "utf8"); // mode
    header.write("        ", 148, "utf8"); // checksum field, left blank/spaces (not validated by our reader)
    blocks.push(header);
    const dataBuf = Buffer.from(content, "utf8");
    const padded = Buffer.alloc(Math.ceil(dataBuf.length / 512) * 512);
    dataBuf.copy(padded);
    blocks.push(padded);
  }
  blocks.push(Buffer.alloc(1024)); // two zero blocks mark end-of-archive
  return Buffer.concat(blocks);
}

/** Same as buildTar(), gzipped — what downloadPopularList() actually
 *  downloads and decompresses from the npm-high-impact tarball. */
function buildTarGz(entries) {
  return zlib.gzipSync(buildTar(entries));
}

/** Generate a `export const top = [...]` file body listing `count` unique
 *  fake popular package names, for feeding into buildTarGz(). */
function fakeTopJs(count) {
  const names = Array.from({ length: count }, (_, i) => `fake-popular-pkg-${i}`);
  return `export const top = [${names.map((n) => `'${n}'`).join(", ")}];\n`;
}

module.exports = {
  ProcessExitError,
  mockProcessExit,
  captureOutput,
  jsonResponse,
  bytesResponse,
  mockFetch,
  mockCacheFs,
  buildTar,
  buildTarGz,
  fakeTopJs,
};

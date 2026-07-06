"use strict";
// Loaded via `node --require` before index.js runs, to deterministically force
// main() to reject (without depending on real network flakiness) so the e2e
// test can exercise the top-level `main().catch(...)` error handler.
global.fetch = async () => {
  throw new Error("simulated total network outage");
};

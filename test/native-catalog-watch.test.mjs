import assert from "node:assert/strict";
import test from "node:test";

import { NATIVE_ACCOUNT_CATALOG_TTL_MS } from "../src/native-account-catalog.mjs";
import { watchNativeCatalog } from "../src/native-catalog-drift.mjs";

test("native catalog watcher refreshes periodically without overlapping passes", async () => {
  let tick;
  let release;
  let calls = 0;
  const stop = watchNativeCatalog({
    clear(timer) { assert.equal(timer, 1); },
    interval(callback, delay) {
      tick = callback;
      assert.equal(delay, NATIVE_ACCOUNT_CATALOG_TTL_MS);
      return 1;
    },
    republish() {
      calls += 1;
      return new Promise((resolve) => { release = resolve; });
    },
  });

  const first = tick();
  await tick();
  assert.equal(calls, 1);
  release();
  await first;
  const second = tick();
  assert.equal(calls, 2);
  release();
  await second;
  stop();
});

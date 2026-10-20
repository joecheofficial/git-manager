"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const estimate = require("../src/checkout-estimate");
test("tree estimate rejects malformed evidence and accounts for blobs", () => {
  assert.throws(() => estimate.estimate("bad data"), /Unknown/);
  assert.ok(estimate.estimate("100644 blob abc123 100000000\tlarge\0") > 100000000);
  assert.equal(estimate.estimate("160000 commit abc123 -\tsubmodule\0"), estimate.estimate(""));
});
test("sparse estimate accounts only for the resolved materialization closure", () => {
  const full = estimate.estimate("100644 blob abc123 2147483648\tfull.bin\0");
  const sparse = estimate.estimateRows([{ kind: "blob", bytes: 1000 }]);
  assert.ok(sparse < full / 10);
  assert.throws(() => estimate.estimateRows([{ kind: "commit", bytes: 0 }]), /Unknown/);
});
test("the customer build has no disk-capacity admission", () => {
  assert.deepEqual(Object.keys(estimate).sort(), ["estimate", "estimateRows"]);
});

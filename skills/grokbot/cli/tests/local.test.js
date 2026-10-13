import { test } from "node:test";
import assert from "node:assert/strict";
import { b32decode, b32encode, parseSliceKey, transcriptText } from "../src/local.js";

test("base32 roundtrip matches the app's lowercase unpadded filenames", () => {
  const key = "sand.client.slice.account.grok%7Cuser_01ABC.sidebar.last-sections";
  const enc = b32encode(key);
  assert.match(enc, /^[a-z2-7]+$/);
  assert.equal(b32decode(enc), key);
  assert.equal(b32decode("onqw4zbomnwgszlooqxhg3djmnss45ljfvwgc6lpov2a"), "sand.client.slice.ui-layout");
});

test("slice key parsing", () => {
  assert.deepEqual(parseSliceKey("sand.client.slice.account.grok%7Cuser_1.transcript.replicas.abc"), { accountId: "grok|user_1", slice: "transcript.replicas.abc" });
  assert.deepEqual(parseSliceKey("sand.client.slice.ui-layout"), { accountId: null, slice: "ui-layout" });
  assert.equal(parseSliceKey("nope"), null);
});

test("transcript flattening tolerates shapes", () => {
  const t = transcriptText({ entries: [{ id: "1", role: "user", text: "hi" }, { id: "2", message: { content: [{ text: "a" }, "b"] } }, { id: "3" }] });
  assert.deepEqual(t.map((x) => x.text), ["hi", "a b"]);
});

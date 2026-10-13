import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { decryptSafeStorage, encryptSafeStorage, parseDescriptorFile, readSecretValue, redact, jwtClaims, normalizeHeaders } from "../src/session.js";

const key = crypto.pbkdf2Sync("test-password", "saltysalt", 1003, 16, "sha1");

test("safeStorage v10 roundtrip", () => {
  const ct = encryptSafeStorage('{"hello":"world"}', key);
  assert.ok(Buffer.from(ct, "base64").subarray(0, 3).toString("latin1") === "v10");
  assert.equal(decryptSafeStorage(ct, key), '{"hello":"world"}');
  assert.throws(() => decryptSafeStorage(Buffer.from("xyz123").toString("base64"), key), /Unsupported safeStorage prefix/);
});

test("descriptor v2: newest entry wins, scope filter, header normalization", () => {
  const enc = (o) => encryptSafeStorage(JSON.stringify(o), key);
  const file = { version: 2, entries: {
    old: { savedAtMs: 1, encrypted: enc({ baseUrl: "https://old/", token: "t1" }) },
    fresh: { savedAtMs: 2, encrypted: enc({ baseUrl: "https://fresh/", token: "t2", headers: { "X-Anyrun-Network-Token": "n" } }) },
  } };
  const d = parseDescriptorFile(file, { decrypt: (c) => decryptSafeStorage(c, key) });
  assert.equal(d.accountScope, "fresh");
  assert.equal(d.baseUrl, "https://fresh");
  assert.deepEqual(d.headers, { "x-anyrun-network-token": "n" });
  assert.equal(parseDescriptorFile(file, { accountScope: "old", decrypt: (c) => decryptSafeStorage(c, key) }).token, "t1");
  assert.equal(parseDescriptorFile({ version: 2, entries: {} }, { decrypt: () => "" }), null);
  assert.throws(() => parseDescriptorFile({ encrypted: enc({ baseUrl: "x" }) }, { decrypt: (c) => decryptSafeStorage(c, key) }), /missing baseUrl or token/);
});

test("secret values: plaintext prefix, scoped prefix, ciphertext", () => {
  assert.equal(readSecretValue("plaintext:v1:" + Buffer.from("abc").toString("base64"), key), "abc");
  const ct = encryptSafeStorage("tok", key);
  assert.equal(readSecretValue("scoped:v1:" + "a".repeat(64) + ":" + ct, key), "tok");
  assert.equal(readSecretValue(ct, key), "tok");
  assert.equal(readSecretValue(null, key), null);
});

test("redact + jwt claims + headers", () => {
  const jwt = ["eyJhbGciOiJIUzI1NiJ9", Buffer.from(JSON.stringify({ sub: "u", exp: 1 })).toString("base64url"), "sigsigsigsigsig"].join(".");
  assert.deepEqual(jwtClaims(jwt), { sub: "u", exp: 1 });
  assert.equal(jwtClaims("nope"), null);
  const out = redact(`Bearer ${jwt} {"token":"abc","gatewayToken":"x","name":"ok"}`);
  assert.ok(!out.includes("abc") && !out.includes(jwt) && out.includes('"name":"ok"'));
  assert.deepEqual(normalizeHeaders({ A: "1", b: "", c: null }), { a: "1" });
});

test("redact covers hyphen/snake-case secret keys and nested bodies", async () => {
  const { redactValue } = await import("../src/session.js");
  const out = redact('{"cursor-access-token":"abc","x-anyrun-network-token":"n1","gateway_token":"g","api_key":"k","name":"ok"}');
  assert.ok(!/abc|n1|"g"|"k"/.test(out) && out.includes('"name":"ok"'));
  assert.deepEqual(redactValue({ a: { refreshToken: "r", list: [{ Cookie: "c", ok: 1 }] }, msg: "Bearer x.y.z" }), { a: { refreshToken: "<redacted>", list: [{ Cookie: "<redacted>", ok: 1 }] }, msg: "Bearer <redacted>" });
});

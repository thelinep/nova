'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkLocalAccess } = require('../lib/local-access');
const port = 8787;
const local = { socket: { remoteAddress: '127.0.0.1' }, method: 'GET', headers: { host: '127.0.0.1:8787' } };
test('rejects remote peers even when local headers are forged', () => {
  assert.match(checkLocalAccess({ ...local, socket: { remoteAddress: '192.0.2.1' } }, port), /Loopback/);
});
test('rejects rebinding hosts, missing hosts, and wrong ports', () => {
  for (const host of [undefined, 'evil.example:8787', '127.0.0.1:9999', 'localhost.evil.example:8787', 'user@localhost:8787']) {
    assert.match(checkLocalAccess({ ...local, headers: { host } }, port), /Host/);
  }
});
test('mutations require the exact origin, including port and scheme', () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    for (const origin of [undefined, 'null', 'https://127.0.0.1:8787', 'http://localhost:8787', 'http://127.0.0.1:9999', 'https://evil.example']) {
      assert.ok(checkLocalAccess({ ...local, method, headers: { ...local.headers, origin } }, port));
    }
    assert.equal(checkLocalAccess({ ...local, method, headers: { ...local.headers, origin: 'http://127.0.0.1:8787' } }, port), null);
  }
});
test('browser cross-origin reads are rejected; local CLI health checks work', () => {
  assert.equal(checkLocalAccess(local, port), null);
  assert.ok(checkLocalAccess({ ...local, headers: { ...local.headers, origin: 'https://evil.example' } }, port));
  for (const site of ['cross-site', 'same-site']) {
    assert.ok(checkLocalAccess({ ...local, headers: { ...local.headers, 'sec-fetch-site': site } }, port));
  }
});

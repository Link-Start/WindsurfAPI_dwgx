import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { EventEmitter } from 'node:events';
import { streamChat, __setRequestImpl } from '../src/devin-connect.js';
import { endOfStreamEnvelope } from '../src/connect.js';

const TOKEN = 'devin-session-token$s5-offline-fixture';
afterEach(() => __setRequestImpl(null));

function captureTransport(calls) {
  return (options, onResponse) => {
    const call = { options, chunks: [] };
    calls.push(call);
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.write = chunk => { call.chunks.push(Buffer.from(chunk)); return true; };
    req.destroy = () => req;
    req.end = chunk => {
      if (chunk) call.chunks.push(Buffer.from(chunk));
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      onResponse(res);
      setImmediate(() => {
        res.emit('data', endOfStreamEnvelope());
        res.emit('end');
      });
      return req;
    };
    return req;
  };
}

async function drain(host, flag) {
  const events = [];
  for await (const event of streamChat({
    messages: [{ role: 'user', content: 'offline host-boundary fixture' }],
    model: 'claude-sonnet-4.6',
    token: TOKEN,
    host,
    sessionId: '11111111-2222-4333-8444-555555555555',
    deviceSeed: 's5-offline-device',
    env: { DEVIN_CONNECT_ACCOUNT_HOST: flag, DEVIN_CONNECT_TOKEN: TOKEN },
  })) events.push(event);
  return events;
}

test('SEC-3: enabled account host cannot send a live token to an unapproved origin', async () => {
  const calls = [];
  __setRequestImpl(captureTransport(calls));
  for (const host of [
    'https://evil.example',
    'http://server.codeium.com',
    'https://server.codeium.com.evil.example',
    'https://server.codeium.com:8443',
    'https://user:password@server.codeium.com',
    'https://@server.codeium.com',
    'https://server.codeium.com/private',
    'https://server.codeium.com/?token=fixture',
    'https://server.codeium.com/#fragment',
    'server.codeium.com',
    'https://server.codeium.com\n',
  ]) {
    await assert.rejects(drain(host, '1'), { code: 'ERR_CONNECT_ACCOUNT_HOST_NOT_ALLOWED' });
    assert.equal(calls.length, 0, host);
  }
});

test('SEC-3: the proven HTTPS origin and its explicit default port are accepted', async () => {
  const calls = [];
  __setRequestImpl(captureTransport(calls));
  await drain('https://server.codeium.com', '1');
  await drain('https://server.codeium.com:443/', '1');
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.options.hostname || call.options.host, 'server.codeium.com');
    assert.equal(call.options.port, 443);
    assert.equal(call.options.headers.authorization, `Basic ${TOKEN}-${TOKEN}`);
    assert.ok(Buffer.concat(call.chunks).length > 0);
  }
});

test('SEC-3: off or unset never examines the imported host and retains the default transport', async () => {
  const calls = [];
  __setRequestImpl(captureTransport(calls));
  const poison = { toString() { throw new Error('account host must not be inspected'); } };
  for (const flag of [undefined, '0']) {
    await drain('https://evil.example', flag);
    await drain(poison, flag);
  }
  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.equal(call.options.hostname || call.options.host, 'server.codeium.com');
    assert.equal(call.options.headers.authorization, `Basic ${TOKEN}-${TOKEN}`);
  }
});

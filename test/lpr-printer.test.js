const assert = require('node:assert/strict');
const net = require('node:net');
const { test } = require('node:test');
const { printLprRaw } = require('../lpr-printer');

test('envía datos RAW y archivo de control mediante LPR', async (t) => {
  const received = [];
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let phase = 'job';
    let expectedFileBytes = 0;

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      processBuffer();
    });

    function processBuffer() {
      if (phase === 'job') {
        const end = buffer.indexOf(0x0a);
        if (end < 0) return;
        assert.deepEqual(buffer.subarray(0, end + 1), Buffer.from([0x02, ...Buffer.from('LPT\n', 'ascii')]));
        buffer = buffer.subarray(end + 1);
        socket.write(Buffer.from([0]));
        phase = 'data-header';
      }

      if (phase === 'data-header') {
        const end = buffer.indexOf(0x0a);
        if (end < 0) return;
        const header = buffer.subarray(0, end).toString('ascii');
        const match = /^\x02(\d+) (\S+)$/.exec(header);
        assert.ok(match);
        expectedFileBytes = Number(match[1]);
        buffer = buffer.subarray(end + 1);
        socket.write(Buffer.from([0]));
        phase = 'data';
      }

      if (phase === 'data' && buffer.length >= expectedFileBytes + 1) {
        received.push(buffer.subarray(0, expectedFileBytes));
        assert.equal(buffer[expectedFileBytes], 0);
        buffer = buffer.subarray(expectedFileBytes + 1);
        socket.write(Buffer.from([0]));
        phase = 'control-header';
      }

      if (phase === 'control-header') {
        const end = buffer.indexOf(0x0a);
        if (end < 0) return;
        const header = buffer.subarray(0, end).toString('ascii');
        const match = /^\x02(\d+) (\S+)$/.exec(header);
        assert.ok(match);
        expectedFileBytes = Number(match[1]);
        buffer = buffer.subarray(end + 1);
        socket.write(Buffer.from([0]));
        phase = 'control';
      }

      if (phase === 'control' && buffer.length >= expectedFileBytes + 1) {
        const control = buffer.subarray(0, expectedFileBytes).toString('ascii');
        assert.match(control, /fdfA001/);
        assert.match(control, /UdfA001/);
        assert.equal(buffer[expectedFileBytes], 0);
        socket.end(Buffer.from([0]));
        phase = 'done';
      }
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const payload = Buffer.from([0x1b, 0x40, 0x50, 0x52, 0x55, 0x45, 0x42, 0x41, 0x0a]);

  await printLprRaw(payload, {
    host: '127.0.0.1',
    port: address.port,
    queue: 'LPT',
    clientHost: 'TEST-PC',
    userName: 'tester',
    jobName: 'test-job',
    timeoutMs: 2_000,
  });

  assert.deepEqual(received, [payload]);
});

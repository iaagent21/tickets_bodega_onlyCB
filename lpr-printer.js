const net = require('node:net');
const os = require('node:os');

function safeLprField(value, fallback) {
  const normalized = String(value ?? '').trim().replace(/[\r\n\s]+/g, '_');
  return normalized || fallback;
}

function connectToLpr(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      socket.removeListener('error', onError);
      socket.removeListener('timeout', onTimeout);
      callback(value);
    };
    const onError = (error) => finish(reject, error);
    const onTimeout = () => finish(reject, new Error(`Tiempo agotado al conectar con el servidor LPR ${host}:${port}.`));
    socket.once('connect', () => {
      socket.setTimeout(0);
      finish(resolve, socket);
    });
    socket.once('error', onError);
    socket.once('timeout', onTimeout);
    socket.setTimeout(timeoutMs);
  });
}

function createLprSession(socket, timeoutMs) {
  let received = Buffer.alloc(0);
  let ackWaiter = null;
  let sessionError = null;

  const onData = (chunk) => {
    received = Buffer.concat([received, chunk]);
    if (ackWaiter && received.length > 0) {
      const waiter = ackWaiter;
      ackWaiter = null;
      const response = received[0];
      received = received.subarray(1);
      clearTimeout(waiter.timer);
      response === 0
        ? waiter.resolve()
        : waiter.reject(new Error(`El servidor LPR rechazó la operación (código ${response}).`));
    }
  };
  socket.on('data', onData);
  socket.on('error', (error) => {
    sessionError = error;
    if (ackWaiter) {
      const waiter = ackWaiter;
      ackWaiter = null;
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  });

  function write(payload) {
    return new Promise((resolve, reject) => {
      socket.write(payload, (error) => (error ? reject(error) : resolve()));
    });
  }

  function waitForAck() {
    if (sessionError) return Promise.reject(sessionError);
    if (received.length > 0) {
      const response = received[0];
      received = received.subarray(1);
      return response === 0
        ? Promise.resolve()
        : Promise.reject(new Error(`El servidor LPR rechazó la operación (código ${response}).`));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (ackWaiter?.timer === timer) ackWaiter = null;
        reject(new Error('Tiempo agotado esperando confirmación del servidor LPR.'));
      }, timeoutMs);
      ackWaiter = { resolve, reject, timer };
    });
  }

  return { write, waitForAck };
}

async function sendLprFile(session, data, filename, command) {
  const header = Buffer.concat([
    Buffer.from([command]),
    Buffer.from(`${data.length} ${filename}\n`, 'ascii'),
  ]);
  await session.write(header);
  await session.waitForAck();
  await session.write(data);
  await session.write(Buffer.from([0]));
  await session.waitForAck();
}

async function printLprRaw(data, options = {}) {
  if (!Buffer.isBuffer(data) || data.length === 0) throw new Error('El trabajo LPR está vacío.');
  const host = String(options.host ?? '').trim();
  const port = Number(options.port ?? 515);
  const queue = safeLprField(options.queue, 'LPT');
  const timeoutMs = Number(options.timeoutMs ?? 15_000);
  if (!host) throw new Error('ESCPOS_HOST es obligatorio para el transporte LPR.');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('ESCPOS_PORT no es válido.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('El timeout LPR no es válido.');

  const clientHost = safeLprField(options.clientHost, os.hostname());
  const userName = safeLprField(options.userName, process.env.USERNAME || 'escanersglobal');
  const jobName = safeLprField(options.jobName, `ticket_${Date.now()}`);
  const dataFilename = `dfA001${clientHost}`;
  const controlFilename = `cfA001${clientHost}`;
  const controlFile = Buffer.from([
    `H${clientHost}`,
    `P${userName}`,
    `J${jobName}`,
    `C${clientHost}`,
    `L${userName}`,
    `l${dataFilename}`,
    `U${dataFilename}`,
    `N${dataFilename}`,
    '',
  ].join('\n'), 'ascii');

  const socket = await connectToLpr(host, port, timeoutMs);
  try {
    const session = createLprSession(socket, timeoutMs);
    await session.write(Buffer.from([0x02]));
    await session.write(Buffer.from(`${queue}\n`, 'ascii'));
    await session.waitForAck();
    // RFC 1179 permits either file order, but control-first is the most
    // compatible order for small print servers. ESC/POS must be sent with
    // command 0x03 (data file); command 0x02 is reserved for control files.
    await sendLprFile(session, controlFile, controlFilename, 0x02);
    await sendLprFile(session, data, dataFilename, 0x03);
    socket.end();
    await new Promise((resolve) => {
      if (socket.destroyed) {
        resolve();
        return;
      }
      socket.once('close', resolve);
      socket.once('error', resolve);
    });
  } finally {
    if (!socket.destroyed) socket.destroy();
  }
}

module.exports = { printLprRaw };

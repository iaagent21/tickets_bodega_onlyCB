const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createEscPosTicket } = require('../escpos-ticket');

test('genera un ticket ESC/POS centrado sin comando de corte', () => {
  const ticket = createEscPosTicket('0013481', 'JAVIER SOLANO', {
    paperWidthDots: 512,
    barcodeScale: 2,
    barcodeHeight: 72,
    feedLines: 1,
  });

  assert.ok(Buffer.isBuffer(ticket));
  assert.deepEqual(ticket.subarray(0, 2), Buffer.from([0x1b, 0x40]));
  assert.ok(ticket.includes(Buffer.from([0x1d, 0x76, 0x30, 0x00])));
  assert.ok(ticket.includes(Buffer.from('Pedido: #0013481 - Cliente: JAVIER SOLANO', 'ascii')));
  assert.equal(ticket.includes(Buffer.from([0x1d, 0x56])), false);
});

test('deja separación después del ticket ESC/POS por defecto', () => {
  const ticket = createEscPosTicket('0013481', 'CLIENTE');

  assert.deepEqual(ticket.subarray(-3), Buffer.from([0x0a, 0x0a, 0x0a]));
});

test('rechaza un pedido que no cabe en el ancho ESC/POS', () => {
  assert.throws(
    () => createEscPosTicket('0013481', 'CLIENTE', { paperWidthDots: 64 }),
    /demasiado pequeño|no cabe/,
  );
});

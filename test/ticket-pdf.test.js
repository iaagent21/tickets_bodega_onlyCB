const assert = require('node:assert/strict');
const { test } = require('node:test');
const { renderTicketContent } = require('../ticket-pdf');

function createDocumentDouble() {
  return {
    images: [],
    texts: [],
    font() { return this; },
    fontSize() { return this; },
    text(value) {
      this.texts.push(String(value));
      return this;
    },
    image(buffer, x, y, options) {
      this.images.push({ buffer, x, y, options });
      return this;
    },
  };
}

test('el ticket contiene código, pedido y cliente', () => {
  const document = createDocumentDouble();

  const result = renderTicketContent(
    document,
    '0013481',
    'JAVIER SOLANO',
    Buffer.from('barcode'),
  );

  assert.equal(document.images.length, 1);
  assert.deepEqual(document.texts, ['Pedido: #0013481 - Cliente: JAVIER SOLANO']);
  assert.equal(result.renderedItems, 0);
  assert.equal(result.expectedTotal, null);
  assert.equal(document.images[0].options.width, 82);
  assert.equal(document.images[0].options.height, 62);
});

test('el ticket indica cuando el cliente no viene informado', () => {
  const document = createDocumentDouble();

  renderTicketContent(document, '0013481', '', Buffer.from('barcode'));

  assert.deepEqual(document.texts, ['Pedido: #0013481 - Cliente: Cliente no informado']);
});

test('el ticket falla si no existe el código de barras', () => {
  const document = createDocumentDouble();

  assert.throws(
    () => renderTicketContent(document, '0013481', 'JAVIER SOLANO', null),
    /No se generó el código de barras/,
  );
});

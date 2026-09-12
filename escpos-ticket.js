const ESC = 0x1b;
const GS = 0x1d;

// Code 128, patrones de los valores 0..106. Se genera Code Set B para que
// el mismo pedido se pueda leer con los escáneres actuales.
const CODE128_PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];

function normalizeClientName(value) {
  return String(value ?? '').trim() || 'Cliente no informado';
}

function buildCode128BModules(value) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error('El número de pedido es obligatorio.');
  if (![...text].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) <= 126)) {
    throw new Error('El número de pedido contiene caracteres que ESC/POS no puede codificar.');
  }

  const values = [...text].map((character) => character.charCodeAt(0) - 32);
  const checksum = (104 + values.reduce((sum, value, index) => sum + value * (index + 1), 0)) % 103;
  const encoded = [104, ...values, checksum, 106];
  return encoded.map((value) => CODE128_PATTERNS[value]).join('');
}

function setBlackPixel(buffer, rowWidthBytes, x, y) {
  const offset = y * rowWidthBytes + Math.floor(x / 8);
  buffer[offset] |= 0x80 >> (x % 8);
}

function createBarcodeRaster(value, options = {}) {
  const paperWidthDots = Number(options.paperWidthDots ?? 512);
  const barcodeScale = Number(options.barcodeScale ?? 2);
  const height = Number(options.barcodeHeight ?? 72);
  const quietModules = 10;

  if (!Number.isInteger(paperWidthDots) || paperWidthDots < 64) {
    throw new Error('ESCPOS_WIDTH_DOTS es demasiado pequeño.');
  }
  if (!Number.isInteger(barcodeScale) || barcodeScale < 1) {
    throw new Error('ESCPOS_BARCODE_SCALE no es válido.');
  }
  if (!Number.isInteger(height) || height < 1) {
    throw new Error('ESCPOS_BARCODE_HEIGHT no es válido.');
  }

  const modules = buildCode128BModules(value);
  const barcodeWidth = (modules.length + quietModules * 2) * barcodeScale;
  if (barcodeWidth > paperWidthDots) {
    throw new Error('El código de barras no cabe en el ancho ESC/POS configurado.');
  }

  const rowWidthBytes = Math.ceil(paperWidthDots / 8);
  const raster = Buffer.alloc(rowWidthBytes * height);
  const left = Math.floor((paperWidthDots - barcodeWidth) / 2) + quietModules * barcodeScale;
  let x = left;

  modules.split('').forEach((run, index) => {
    const runWidth = Number(run) * barcodeScale;
    if (index % 2 === 0) {
      for (let pixelX = x; pixelX < x + runWidth; pixelX += 1) {
        for (let pixelY = 0; pixelY < height; pixelY += 1) setBlackPixel(raster, rowWidthBytes, pixelX, pixelY);
      }
    }
    x += runWidth;
  });

  return {
    rowWidthBytes,
    height,
    data: raster,
  };
}

function createEscPosTicket(pedidoId, clienteNombre, options = {}) {
  const normalizedPedidoId = String(pedidoId ?? '').trim();
  const paperWidthDots = Number(options.paperWidthDots ?? 512);
  const feedLines = Number(options.feedLines ?? 3);
  const barcode = createBarcodeRaster(normalizedPedidoId, options);
  const clientText = normalizeClientName(clienteNombre);
  const label = `Pedido: #${normalizedPedidoId} - Cliente: ${clientText}`;
  const barcodeHeader = Buffer.from([
    GS, 0x76, 0x30, 0x00,
    barcode.rowWidthBytes & 0xff, (barcode.rowWidthBytes >> 8) & 0xff,
    barcode.height & 0xff, (barcode.height >> 8) & 0xff,
  ]);
  const feed = Buffer.alloc(feedLines, 0x0a);

  return Buffer.concat([
    Buffer.from([ESC, 0x40]), // Inicializa sin cambiar la configuración persistente de la impresora.
    Buffer.from([ESC, 0x61, 0x01]), // Centrado.
    barcodeHeader,
    barcode.data,
    Buffer.from([0x0a, ESC, 0x45, 0x01]), // Texto en negritas.
    Buffer.from(label, 'ascii'),
    Buffer.from([ESC, 0x45, 0x00, 0x0a]),
    feed,
    // No se agrega GS V: el corte automático queda fuera del modo ESC/POS.
  ]);
}

module.exports = { buildCode128BModules, createBarcodeRaster, createEscPosTicket };

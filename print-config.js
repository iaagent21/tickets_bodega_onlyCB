function parsePrintMode(value) {
  const normalized = String(value ?? 'pdf').trim().toLowerCase();
  if (normalized === 'pdf' || normalized === 'escpos') return normalized;
  throw new Error('PRINT_MODE debe ser pdf o escpos.');
}

function parseEscPosTransport(value) {
  const normalized = String(value ?? 'windows').trim().toLowerCase();
  if (normalized === 'windows' || normalized === 'lpr') return normalized;
  throw new Error('ESCPOS_TRANSPORT debe ser windows o lpr.');
}

function parsePositiveInteger(value, name, fallback, max) {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${name} debe ser un entero entre 1 y ${max}.`);
  }
  return parsed;
}

function getEscPosOptions(environment = process.env) {
  return {
    transport: parseEscPosTransport(environment.ESCPOS_TRANSPORT),
    host: String(environment.ESCPOS_HOST ?? '').trim(),
    queue: String(environment.ESCPOS_QUEUE ?? 'LPT').trim(),
    port: parsePositiveInteger(environment.ESCPOS_PORT, 'ESCPOS_PORT', 515, 65_535),
    paperWidthDots: parsePositiveInteger(environment.ESCPOS_WIDTH_DOTS, 'ESCPOS_WIDTH_DOTS', 512, 2_048),
    barcodeScale: parsePositiveInteger(environment.ESCPOS_BARCODE_SCALE, 'ESCPOS_BARCODE_SCALE', 2, 8),
    barcodeHeight: parsePositiveInteger(environment.ESCPOS_BARCODE_HEIGHT, 'ESCPOS_BARCODE_HEIGHT', 72, 512),
    feedLines: parsePositiveInteger(environment.ESCPOS_FEED_LINES, 'ESCPOS_FEED_LINES', 3, 10),
  };
}

module.exports = { parsePrintMode, parseEscPosTransport, parsePositiveInteger, getEscPosOptions };

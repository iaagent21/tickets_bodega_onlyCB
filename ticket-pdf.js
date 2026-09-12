const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const bwipjs = require('bwip-js');

const PAGE_WIDTH = 227; // 80 mm en puntos PDF.
const PAGE_HEIGHT = 108; // 1.5 pulgadas de alto.
const PAGE_MARGINS = { top: 8, bottom: 8, left: 10, right: 10 };
const BARCODE_WIDTH = 82; // 60% menos que el ancho anterior.
const BARCODE_HEIGHT = 62;

function generateBarcodeBuffer(text) {
  return new Promise((resolve, reject) => {
    bwipjs.toBuffer({
      bcid: 'code128',
      text: String(text),
      scale: 3,
      height: 14,
      includetext: false,
    }, (error, png) => {
      if (error) reject(error);
      else resolve(png);
    });
  });
}

function safeFilenamePart(value) {
  const safe = String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '_');
  return safe || 'sin_pedido';
}

function normalizeClientName(value) {
  return String(value ?? '').trim();
}

function createPdfDocument() {
  return new PDFDocument({
    size: [PAGE_WIDTH, PAGE_HEIGHT],
    margins: PAGE_MARGINS,
  });
}

function renderTicketContent(doc, pedidoId, clienteNombre, barcodeBuffer) {
  if (!barcodeBuffer) throw new Error('No se generó el código de barras.');

  const barcodeTop = PAGE_MARGINS.top;
  doc.image(barcodeBuffer, (PAGE_WIDTH - BARCODE_WIDTH) / 2, barcodeTop, {
    width: BARCODE_WIDTH,
    height: BARCODE_HEIGHT,
  });

  const clientText = normalizeClientName(clienteNombre) || 'Cliente no informado';
  const label = `Pedido: #${String(pedidoId).trim()} - Cliente: ${clientText}`;
  doc.font('Helvetica-Bold').fontSize(8.5).text(label, PAGE_MARGINS.left, 77, {
    width: PAGE_WIDTH - PAGE_MARGINS.left - PAGE_MARGINS.right,
    align: 'center',
    lineBreak: false,
    ellipsis: true,
  });

  return {
    renderedItems: 0,
    expectedTotal: null,
  };
}

async function createTicketPdf(pedidoId, clienteNombre, ticketsDir) {
  const normalizedPedidoId = String(pedidoId ?? '').trim();
  if (!normalizedPedidoId) throw new Error('El número de pedido es obligatorio.');

  fs.mkdirSync(ticketsDir, { recursive: true });
  const pdfPath = path.join(ticketsDir, `pedido_${safeFilenamePart(normalizedPedidoId)}.pdf`);
  const barcodeBuffer = await generateBarcodeBuffer(normalizedPedidoId);

  const doc = createPdfDocument();
  const writeStream = fs.createWriteStream(pdfPath);
  doc.pipe(writeStream);
  const rendered = renderTicketContent(doc, normalizedPedidoId, clienteNombre, barcodeBuffer);

  return new Promise((resolve, reject) => {
    writeStream.on('finish', () => resolve({
      pdfPath,
      renderedItems: rendered.renderedItems,
      expectedTotal: rendered.expectedTotal,
      pageWidth: PAGE_WIDTH,
      pageHeight: PAGE_HEIGHT,
    }));
    writeStream.on('error', reject);
    doc.end();
  });
}

module.exports = { createTicketPdf, renderTicketContent };

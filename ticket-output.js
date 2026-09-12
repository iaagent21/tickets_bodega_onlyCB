const fs = require('node:fs');
const path = require('node:path');
const { createTicketPdf } = require('./ticket-pdf');
const { createEscPosTicket } = require('./escpos-ticket');

function safeFilenamePart(value) {
  const safe = String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '_');
  return safe || 'sin_pedido';
}

async function createTicketArtifact({ pedidoId, clienteNombre, ticketsDir, printMode, escposOptions }) {
  if (printMode === 'pdf') {
    const pdf = await createTicketPdf(pedidoId, clienteNombre, ticketsDir);
    return {
      ...pdf,
      artifactPath: pdf.pdfPath,
      printMode: 'pdf',
    };
  }

  fs.mkdirSync(ticketsDir, { recursive: true });
  const normalizedPedidoId = String(pedidoId ?? '').trim();
  const artifactPath = path.join(ticketsDir, `pedido_${safeFilenamePart(normalizedPedidoId)}.escpos.bin`);
  const data = createEscPosTicket(normalizedPedidoId, clienteNombre, escposOptions);
  fs.writeFileSync(artifactPath, data);
  return {
    artifactPath,
    data,
    renderedItems: 0,
    expectedTotal: null,
    printMode: 'escpos',
    transport: escposOptions?.transport ?? 'windows',
    lprOptions: escposOptions,
  };
}

function artifactState(artifact) {
  return {
    printMode: artifact.printMode,
    artifactPath: artifact.artifactPath,
    ...(artifact.pdfPath ? { pdfPath: artifact.pdfPath } : {}),
    renderedItems: artifact.renderedItems,
    ...(artifact.printMode === 'escpos' ? { escposTransport: artifact.transport } : {}),
  };
}

module.exports = { createTicketArtifact, artifactState };

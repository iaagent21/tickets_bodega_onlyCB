const { print } = require('pdf-to-printer');
const { printRawToWindowsPrinter } = require('./windows-raw-printer');

async function printTicketArtifact(artifact, { printerName, timeoutMs = 15_000 } = {}) {
  if (artifact.printMode === 'escpos') {
    await printRawToWindowsPrinter(printerName, artifact.data, timeoutMs);
    return;
  }

  await print(artifact.pdfPath, {
    ...(printerName ? { printer: printerName } : {}),
    orientation: 'landscape',
    scale: 'noscale',
  });
}

async function printTicketWithRetry(artifact, options = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await printTicketArtifact(artifact, options);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
  throw lastError;
}

module.exports = { printTicketArtifact, printTicketWithRetry };

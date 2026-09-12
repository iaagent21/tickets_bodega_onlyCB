const fs = require('fs');
const path = require('path');
const { print } = require('pdf-to-printer');
const { createApiClient } = require('./api-client');
const { createTicketPdf } = require('./ticket-pdf');

require('dotenv').config();

const pedidoId = String(process.argv[2] ?? '').trim();
if (!pedidoId) {
  console.log('Uso: node test-print.js <numero_de_pedido>');
  console.log('Ejemplo: node test-print.js 0098072');
  process.exit(0);
}

const {
  API_URL,
  STORE_USER_EMAIL,
  STORE_USER_PASSWORD,
  TIENDA,
  AUTO_PRINT = 'false',
  PRINTER_NAME = '',
} = process.env;

const missingVars = [
  !API_URL && 'API_URL',
  !STORE_USER_EMAIL && 'STORE_USER_EMAIL',
  !STORE_USER_PASSWORD && 'STORE_USER_PASSWORD',
  !TIENDA && 'TIENDA',
].filter(Boolean);

if (missingVars.length > 0) {
  console.error(`ERROR: Faltan variables en .env: ${missingVars.join(', ')}`);
  process.exit(1);
}

const shouldPrint = String(AUTO_PRINT).trim().toLowerCase() === 'true';
const ticketsDir = path.join(__dirname, 'tickets');
fs.mkdirSync(ticketsDir, { recursive: true });

async function main() {
  const apiClient = createApiClient({
    apiUrl: API_URL,
    tienda: TIENDA,
    email: STORE_USER_EMAIL,
    password: STORE_USER_PASSWORD,
    timeoutMs: Number(process.env.API_TIMEOUT_MS ?? 15_000),
  });
  console.log(`Probando ticket por API para #${pedidoId}...`);
  const rutaData = await apiClient.fetchPickingRoute(pedidoId);
  const clienteNombre = String(rutaData?.nombre ?? '').trim();
  console.log(`Cliente obtenido de la API: ${clienteNombre || 'no informado'}.`);
  const result = await createTicketPdf(pedidoId, clienteNombre, ticketsDir);
  console.log(`PDF generado: ${result.pdfPath}`);

  if (shouldPrint) {
    await print(result.pdfPath, {
      ...(PRINTER_NAME ? { printer: PRINTER_NAME } : {}),
      orientation: 'landscape',
      scale: 'noscale',
    });
    console.log(`Ticket enviado a ${PRINTER_NAME || 'la impresora predeterminada'}.`);
  }
}

main().catch((error) => {
  console.error('Error durante la prueba:', error.message);
  process.exitCode = 1;
});

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createApiClient } = require('./api-client');
const { parsePrintMode, parsePositiveInteger, getEscPosOptions } = require('./print-config');
const { createTicketArtifact, artifactState } = require('./ticket-output');
const { printTicketWithRetry } = require('./ticket-printer');

require('dotenv').config();

function parseBoolean(value, name) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`${name} debe ser true o false.`);
}

const {
  STORE_USER_EMAIL,
  STORE_USER_PASSWORD,
  API_URL,
  TIENDA,
  PRINTER_NAME = '',
  TICKET_CLIENT_ID,
} = process.env;

const DRY_RUN = parseBoolean(process.env.DRY_RUN ?? 'false', 'DRY_RUN');
const AUTO_PRINT = parseBoolean(process.env.AUTO_PRINT ?? 'true', 'AUTO_PRINT');
const PRINT_MODE = parsePrintMode(process.env.PRINT_MODE ?? 'pdf');
const API_TIMEOUT_MS = parsePositiveInteger(process.env.API_TIMEOUT_MS, 'API_TIMEOUT_MS', 15_000, 120_000);
const LEASE_SECONDS = parsePositiveInteger(process.env.LEASE_SECONDS, 'LEASE_SECONDS', 120, 900);
const PENDING_POLL_MS = parsePositiveInteger(process.env.PENDING_POLL_MS, 'PENDING_POLL_MS', 30_000, 15 * 60_000);
const ESCPOS_OPTIONS = getEscPosOptions(process.env);

const missingVars = [
  !STORE_USER_EMAIL && 'STORE_USER_EMAIL',
  !STORE_USER_PASSWORD && 'STORE_USER_PASSWORD',
  !API_URL && 'API_URL',
  !TIENDA && 'TIENDA',
  PRINT_MODE === 'escpos' && AUTO_PRINT && ESCPOS_OPTIONS.transport === 'windows' && !String(PRINTER_NAME).trim() && 'PRINTER_NAME (obligatoria con ESCPOS_TRANSPORT=windows)',
  PRINT_MODE === 'escpos' && AUTO_PRINT && ESCPOS_OPTIONS.transport === 'lpr' && !ESCPOS_OPTIONS.host && 'ESCPOS_HOST (obligatoria con ESCPOS_TRANSPORT=lpr)',
].filter(Boolean);

if (missingVars.length > 0) {
  console.error(`ERROR: Faltan variables en .env: ${missingVars.join(', ')}`);
  process.exit(1);
}

const storeId = String(TIENDA).trim().toLowerCase();
const ticketsDir = path.join(__dirname, 'tickets');
const statePath = path.join(ticketsDir, '.ticket-state.json');
const clientIdPath = path.join(ticketsDir, '.ticket-client-id');
fs.mkdirSync(ticketsDir, { recursive: true });

function resolveClientId() {
  const configured = String(TICKET_CLIENT_ID ?? '').trim();
  if (configured) return configured;

  try {
    const existing = fs.readFileSync(clientIdPath, 'utf8').trim();
    if (/^[A-Za-z0-9._:-]{1,128}$/.test(existing)) return existing;
  } catch {
    // Se crea debajo.
  }

  const generated = crypto.randomUUID();
  fs.writeFileSync(clientIdPath, `${generated}\n`, 'utf8');
  return generated;
}

const clientId = resolveClientId();

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.jobs && typeof parsed.jobs === 'object') {
      return { version: 2, jobs: parsed.jobs };
    }
  } catch {
    // Primera ejecución o archivo incompleto después de un apagado brusco.
  }
  return { version: 2, jobs: {} };
}

const state = loadState();

function saveState() {
  const tempPath = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tempPath, statePath);
}

function updateJobState(job, status, extra = {}) {
  state.jobs[job.id] = {
    jobId: job.id,
    pedido: job.pedido,
    status,
    updatedAt: new Date().toISOString(),
    ...extra,
  };
  saveState();
}

function isClaimConflict(error) {
  return error?.status === 409;
}

function isJobGone(error) {
  return error?.status === 404;
}

async function reportFailed(apiClient, job, errorMessage) {
  try {
    const result = await apiClient.markTicketJobFailed(job.id, clientId, errorMessage);
    console.warn(`Job ${job.id} quedó como ${result?.reason || 'failed'}.`);
  } catch (error) {
    console.error(`No se pudo reportar failed para #${job.pedido}:`, error.message);
    console.error('El lease expirará y el job podrá recuperarse automáticamente.');
  }
}

async function processJob(job, apiClient, previewedJobs) {
  const pedidoId = String(job?.pedido ?? '').trim();
  if (!job?.id || !pedidoId) {
    console.warn('Se ignoró un evento de ticket sin id o pedido.');
    return;
  }

  if (previewedJobs.has(job.id)) return;
  const startedAt = Date.now();
  const elapsed = () => `${Date.now() - startedAt} ms`;
  console.log(`[${new Date().toLocaleTimeString()}] Procesando ticket #${pedidoId} (job ${job.id})...`);

  let clienteNombre = '';
  try {
    const orderInfo = await apiClient.fetchTicketOrderInfo(pedidoId);
    clienteNombre = String(orderInfo?.nombre ?? '').trim();
    console.log(`Cliente obtenido de la API para #${pedidoId}: ${clienteNombre || 'no informado'} (${elapsed()}).`);
  } catch (error) {
    updateJobState(job, 'client_lookup_failed', { error: error.message });
    console.error(`No se pudo obtener el cliente de #${pedidoId} (${elapsed()}):`, error.message);
    return;
  }

  // La vista previa no reclama ni confirma el job: queda pendiente para producción.
  if (DRY_RUN || !AUTO_PRINT) {
    try {
      if (!DRY_RUN) {
        const result = await createTicketArtifact({
          pedidoId,
          clienteNombre,
          ticketsDir,
          printMode: PRINT_MODE,
          escposOptions: ESCPOS_OPTIONS,
        });
        updateJobState(job, 'previewed', {
          ...artifactState(result),
          clienteNombre,
        });
        console.log(`Archivo de vista previa ${PRINT_MODE.toUpperCase()} generado: ${result.artifactPath}`);
      } else {
        updateJobState(job, 'dry_run', { clienteNombre });
        console.log(`Vista previa de código de barras para #${pedidoId}.`);
      }
      previewedJobs.add(job.id);
    } catch (error) {
      updateJobState(job, 'preview_failed', { error: error.message });
      console.error(`Error en vista previa de #${pedidoId}:`, error.message);
    }
    return;
  }

  let claimed = false;
  let physicalPrintSucceeded = false;
  try {
    let claim;
    try {
      claim = await apiClient.claimTicketJob(job.id, clientId, LEASE_SECONDS);
    } catch (error) {
      if (isClaimConflict(error)) {
        updateJobState(job, 'busy');
        console.log(`Job ${job.id} está ocupado para esta PC; se deja para su lease.`);
        return;
      }
      if (isJobGone(error)) {
        updateJobState(job, 'not_found');
        console.log(`Job ${job.id} ya no existe; se omite.`);
        return;
      }
      throw error;
    }

    if (claim?.reason === 'busy') {
      updateJobState(job, 'busy');
      console.log(`Job ${job.id} está ocupado para esta PC.`);
      return;
    }
    if (claim?.reason === 'printed') {
      updateJobState(job, 'printed');
      console.log(`Job ${job.id} ya estaba impreso; se omite duplicado.`);
      return;
    }
    if (claim?.reason === 'not_found') {
      updateJobState(job, 'not_found');
      return;
    }
    if (!['claimed', 'already_claimed'].includes(claim?.reason)) {
      throw new Error(`La API no permitió reclamar el job ${job.id}: ${claim?.reason || 'respuesta inválida'}.`);
    }
    claimed = true;
    console.log(`Job ${job.id} reclamado para #${pedidoId} (${elapsed()}).`);
    updateJobState(job, 'claimed', {
      attempts: claim?.job?.attempts ?? null,
      clienteNombre,
    });

    const result = await createTicketArtifact({
      pedidoId,
      clienteNombre,
      ticketsDir,
      printMode: PRINT_MODE,
      escposOptions: ESCPOS_OPTIONS,
    });
    updateJobState(job, 'generated', {
      ...artifactState(result),
      clienteNombre,
    });
    console.log(`${PRINT_MODE.toUpperCase()} generado: ${result.artifactPath} (${elapsed()}).`);

    await printTicketWithRetry(result, {
      printerName: PRINTER_NAME,
      timeoutMs: API_TIMEOUT_MS,
    });
    physicalPrintSucceeded = true;
    console.log(`Transporte confirmó la impresión de #${pedidoId} (${elapsed()}).`);
    updateJobState(job, 'printed_unconfirmed', {
      ...artifactState(result),
      clienteNombre,
    });
    const destination = PRINT_MODE === 'escpos' && ESCPOS_OPTIONS.transport === 'lpr'
      ? `${ESCPOS_OPTIONS.host}:${ESCPOS_OPTIONS.port}/${ESCPOS_OPTIONS.queue}`
      : (PRINTER_NAME || 'la impresora predeterminada');
    console.log(`Ticket #${pedidoId} enviado a ${destination} (${elapsed()}).`);

    try {
      const printed = await apiClient.markTicketJobPrinted(job.id, clientId);
      updateJobState(job, 'printed', {
        ...artifactState(result),
        clienteNombre,
      });
      console.log(`Job ${job.id} confirmado en la API (${elapsed()}).`);
      console.log(`Job ${job.id} confirmado como ${printed?.reason || 'printed'}.`);
    } catch (error) {
      updateJobState(job, 'printed_unconfirmed', {
        ...artifactState(result),
        clienteNombre,
        error: error.message,
      });
      console.error(`La impresión fue exitosa, pero no se confirmó el job ${job.id}:`, error.message);
      console.error('Se puede repetir el ticket después de que expire el lease; es la limitación inevitable del corte entre imprimir y confirmar.');
    }
  } catch (error) {
    updateJobState(job, 'failed', { error: error.message });
    console.error(`Error al procesar #${pedidoId}:`, error.message);
    if (claimed && !physicalPrintSucceeded) await reportFailed(apiClient, job, error.message);
  }
}

function createOrderQueue(apiClient) {
  const pending = [];
  const queued = new Set();
  const previewedJobs = new Set();
  let running = false;

  function enqueue(job, source) {
    const jobId = String(job?.id ?? '').trim();
    const pedidoId = String(job?.pedido ?? '').trim();
    const jobStore = String(job?.tienda ?? storeId).trim().toLowerCase();
    if (!jobId || !pedidoId || jobStore !== storeId) return;
    if (queued.has(jobId)) return;
    queued.add(jobId);
    pending.push({ job, source });
    console.log(`Ticket #${pedidoId} agregado a la cola (${source}). Pendientes: ${pending.length}`);
    void drain();
  }

  async function drain() {
    if (running) return;
    running = true;
    try {
      while (pending.length > 0) {
        const item = pending.shift();
        queued.delete(item.job.id);
        await processJob(item.job, apiClient, previewedJobs);
      }
    } finally {
      running = false;
    }
  }

  return { enqueue };
}

let stopListener = async () => {
  process.exit(0);
};

async function main() {
  const apiClient = createApiClient({
    apiUrl: API_URL,
    tienda: storeId,
    email: STORE_USER_EMAIL,
    password: STORE_USER_PASSWORD,
    timeoutMs: API_TIMEOUT_MS,
  });
  const queue = createOrderQueue(apiClient);
  let lastEventId = null;
  let stopping = false;
  let pendingTimer = null;
  let streamAbort = null;

  await apiClient.login();

  async function recoverPending(source) {
    let after = null;
    let pages = 0;
    while (!stopping) {
      pages += 1;
      if (pages > 10_000) throw new Error('La recuperación de tickets excedió el límite de páginas.');
      const page = await apiClient.listPendingTicketJobs({ clientId, after, limit: 100 });
      page.items.forEach((job) => queue.enqueue(job, source));
      if (!page.nextCursor) return;
      if (page.nextCursor === after) throw new Error('El cursor de tickets no avanzó.');
      after = page.nextCursor;
    }
  }

  async function runStream() {
    let retryMs = 3_000;
    while (!stopping) {
      streamAbort = new AbortController();
      try {
        lastEventId = await apiClient.consumeTicketStream({
          clientId,
          lastEventId,
          signal: streamAbort.signal,
          onJob: async (job) => queue.enqueue(job, 'SSE'),
        });
        retryMs = 3_000;
        if (!stopping) await recoverPending('recuperación del stream');
      } catch (error) {
        if (stopping) break;
        console.error(`Stream de tickets desconectado: ${error.message}`);
        try {
          await recoverPending('recuperación por desconexión');
        } catch (recoveryError) {
          console.error(`No se pudieron recuperar pendientes: ${recoveryError.message}`);
        }
        await new Promise((resolve) => setTimeout(resolve, retryMs));
        retryMs = Math.min(retryMs * 2, 30_000);
      } finally {
        streamAbort = null;
      }
    }
  }

  stopListener = async () => {
    if (stopping) return;
    stopping = true;
    if (pendingTimer) clearInterval(pendingTimer);
    if (streamAbort) streamAbort.abort();
    console.log('\nListener cerrado.');
    process.exit(0);
  };

  console.log('==================================================');
  console.log('   Listener de tickets iniciado');
  console.log(`   Tienda: ${storeId}`);
  console.log(`   API: ${String(API_URL).replace(/\/+$/, '')}`);
  console.log(`   Cliente: ${clientId}`);
  console.log(`   Modo simulación: ${DRY_RUN ? 'ACTIVADO' : 'DESACTIVADO'}`);
  console.log(`   Impresión automática: ${AUTO_PRINT ? 'ACTIVADA' : 'DESACTIVADA'}`);
  console.log(`   Formato de impresión: ${PRINT_MODE.toUpperCase()}`);
  if (PRINT_MODE === 'escpos') console.log(`   Transporte ESC/POS: ${ESCPOS_OPTIONS.transport.toUpperCase()}`);
  console.log('   Fuente: /tickets/stream + /tickets/pending');
  console.log('==================================================');

  if (!AUTO_PRINT && !DRY_RUN) {
    console.warn('AUTO_PRINT=false: se generarán PDFs sin reclamar ni confirmar jobs.');
  }

  // El stream del API se registra antes de recuperar pendientes y además hace su
  // propia recuperación inicial. La deduplicación por job_id cubre ambas vías.
  void runStream();
  await recoverPending('arranque');
  pendingTimer = setInterval(() => {
    void recoverPending('sondeo de pendientes').catch((error) => {
      if (!stopping) console.error(`Error en sondeo de pendientes: ${error.message}`);
    });
  }, PENDING_POLL_MS);
}

process.on('SIGINT', () => {
  console.log('\nCerrando listener...');
  void stopListener();
});

main().catch((error) => {
  console.error('No se pudo iniciar el listener:', error.message);
  process.exitCode = 1;
});

const fetch = require('node-fetch');

const RETRYABLE_STATUS = new Set([502, 503, 504]);
const RETRY_DELAYS_MS = [250, 750, 1500];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseExpiresAt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000;
  }

  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : Date.now() + 5 * 60_000;
}

function getErrorMessage(payload, fallback) {
  if (payload && typeof payload === 'object') {
    const message = payload.message || payload.error;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  if (typeof payload === 'string' && payload.trim()) return payload.trim();
  return fallback;
}

function createApiClient({ apiUrl, tienda, email, password, timeoutMs = 15_000 }) {
  const baseUrl = String(apiUrl ?? '').replace(/\/+$/, '');
  const storeId = String(tienda ?? '').trim();
  let session = null;
  let authInFlight = null;

  if (!baseUrl) throw new Error('API_URL no está configurada.');
  if (!storeId) throw new Error('TIENDA no está configurada.');

  async function requestJson(path, options = {}) {
    const method = String(options.method ?? 'GET').toUpperCase();
    const canRetry = method === 'GET';
    const maxAttempts = canRetry ? RETRY_DELAYS_MS.length + 1 : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const headers = {
        Accept: 'application/json',
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.headers || {}),
      };
      const body = options.body === undefined ? undefined : JSON.stringify(options.body);
      if (body !== undefined) headers['Content-Type'] = 'application/json';

      try {
        const response = await fetch(`${baseUrl}${path}`, {
          method,
          headers,
          body,
          signal: controller.signal,
        });
        const rawBody = await response.text();
        let payload = null;
        try {
          payload = rawBody ? JSON.parse(rawBody) : null;
        } catch {
          payload = rawBody;
        }

        if (response.ok) return payload;

        const error = new Error(getErrorMessage(payload, `La API respondió HTTP ${response.status}`));
        error.status = response.status;
        error.payload = payload;

        if (canRetry && RETRYABLE_STATUS.has(response.status) && attempt < maxAttempts) {
          await sleep(RETRY_DELAYS_MS[attempt - 1]);
          continue;
        }
        throw error;
      } catch (error) {
        const isAbort = error?.name === 'AbortError';
        const isRetryableNetworkError = !error?.status;
        if (canRetry && (isAbort || isRetryableNetworkError) && attempt < maxAttempts) {
          await sleep(RETRY_DELAYS_MS[attempt - 1]);
          continue;
        }
        if (isAbort) throw new Error(`La API no respondió dentro de ${timeoutMs} ms.`);
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }

    throw new Error('Se agotaron los intentos de comunicación con la API.');
  }

  function saveSession(data) {
    if (!data || typeof data.access_token !== 'string' || !data.access_token) {
      throw new Error('La API no devolvió un access_token válido.');
    }

    session = {
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : null,
      expiresAt: parseExpiresAt(data.expires_at),
      profile: data.profile ?? null,
    };
    return session;
  }

  async function login() {
    if (!email || !password) throw new Error('STORE_USER_EMAIL y STORE_USER_PASSWORD son obligatorios.');
    const data = await requestJson('/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    const nextSession = saveSession(data);
    const profileStore = String(data?.profile?.tienda ?? data?.profile?.store?.id ?? '').trim().toLowerCase();
    if (profileStore && profileStore !== storeId) {
      throw new Error(`El usuario de la API está asignado a ${profileStore}, no a ${storeId}.`);
    }
    return nextSession;
  }

  async function refresh() {
    if (!session?.refreshToken) return login();
    try {
      const data = await requestJson('/auth/refresh', {
        method: 'POST',
        body: { refresh_token: session.refreshToken },
      });
      return saveSession(data);
    } catch {
      session = null;
      return login();
    }
  }

  async function getSession() {
    if (session && session.expiresAt > Date.now() + 60_000) return session;
    if (!authInFlight) {
      authInFlight = (session?.refreshToken ? refresh() : login()).finally(() => {
        authInFlight = null;
      });
    }
    return authInFlight;
  }

  async function authenticatedJson(path, options = {}) {
    let current = await getSession();
    const request = (token) => requestJson(path, {
      ...options,
      token,
      headers: {
        'x-app-id': 'etiquetas',
        'x-store-id': storeId,
        ...(options.headers || {}),
      },
    });

    try {
      return await request(current.accessToken);
    } catch (error) {
      if (error?.status !== 401) throw error;
      session = null;
      current = await getSession();
      return request(current.accessToken);
    }
  }

  async function fetchPickingRoute(pedido) {
    const normalizedPedido = String(pedido ?? '').trim();
    if (!normalizedPedido) throw new Error('El número de pedido es obligatorio.');
    const data = await authenticatedJson(`/picking/ruta/${encodeURIComponent(normalizedPedido)}`);
    if (!data || typeof data !== 'object') {
      throw new Error('La API devolvió una respuesta inválida para la ruta del pedido.');
    }
    return data;
  }

  async function fetchTicketOrderInfo(pedido) {
    const normalizedPedido = String(pedido ?? '').trim();
    if (!normalizedPedido) throw new Error('El número de pedido es obligatorio.');
    const data = await authenticatedJson(`/tickets/order-info/${encodeURIComponent(normalizedPedido)}`);
    if (!data || typeof data !== 'object') {
      throw new Error('La API devolvió una respuesta inválida para /tickets/order-info.');
    }
    return data;
  }

  async function listPendingTicketJobs({ clientId, after = null, limit = 100 } = {}) {
    const normalizedClientId = String(clientId || '').trim();
    if (!normalizedClientId) throw new Error('clientId es obligatorio para consultar tickets pendientes.');
    const query = new URLSearchParams({ client_id: normalizedClientId, limit: String(limit) });
    if (after) query.set('after', String(after));
    const data = await authenticatedJson(`/tickets/pending?${query.toString()}`);
    if (!data || !Array.isArray(data.items)) {
      throw new Error('La API devolvió una respuesta inválida para /tickets/pending.');
    }
    return {
      items: data.items,
      nextCursor: data.next_cursor ?? null,
    };
  }

  async function claimTicketJob(jobId, clientId, leaseSeconds = 120) {
    return authenticatedJson(`/tickets/jobs/${encodeURIComponent(jobId)}/claim`, {
      method: 'POST',
      body: { client_id: clientId, lease_seconds: leaseSeconds },
    });
  }

  async function markTicketJobPrinted(jobId, clientId) {
    return authenticatedJson(`/tickets/jobs/${encodeURIComponent(jobId)}/printed`, {
      method: 'POST',
      body: { client_id: clientId },
    });
  }

  async function markTicketJobFailed(jobId, clientId, errorMessage) {
    return authenticatedJson(`/tickets/jobs/${encodeURIComponent(jobId)}/failed`, {
      method: 'POST',
      body: { client_id: clientId, error: String(errorMessage || 'Error desconocido').slice(0, 2_000) },
    });
  }

  async function openTicketStream({ clientId, lastEventId = null, signal } = {}) {
    const normalizedClientId = String(clientId || '').trim();
    if (!normalizedClientId) throw new Error('clientId es obligatorio para abrir el stream de tickets.');
    const query = new URLSearchParams({ client_id: normalizedClientId });
    let current = await getSession();
    const open = (token) => fetch(`${baseUrl}/tickets/stream?${query.toString()}`, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${token}`,
        'x-app-id': 'etiquetas',
        'x-store-id': storeId,
        ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
      },
      signal,
    });

    let response = await open(current.accessToken);
    if (response.status === 401) {
      session = null;
      current = await getSession();
      response = await open(current.accessToken);
    }

    if (!response.ok) {
      const rawBody = await response.text();
      let payload = null;
      try {
        payload = rawBody ? JSON.parse(rawBody) : null;
      } catch {
        payload = rawBody;
      }
      const error = new Error(getErrorMessage(payload, `El stream respondió HTTP ${response.status}`));
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    if (!response.body) throw new Error('La API abrió el stream sin cuerpo de respuesta.');
    return response.body;
  }

  async function consumeTicketStream({ clientId, lastEventId = null, signal, onJob }) {
    const body = await openTicketStream({ clientId, lastEventId, signal });
    const decoder = new TextDecoder();
    let buffer = '';
    let latestEventId = lastEventId;

    async function dispatch(block) {
      const lines = block.split(/\r?\n/);
      let eventName = 'message';
      let eventId = null;
      const dataLines = [];

      for (const line of lines) {
        if (!line || line.startsWith(':')) continue;
        const separator = line.indexOf(':');
        const field = separator === -1 ? line : line.slice(0, separator);
        const value = separator === -1 ? '' : line.slice(separator + 1).replace(/^ /, '');
        if (field === 'event') eventName = value;
        else if (field === 'id') eventId = value;
        else if (field === 'data') dataLines.push(value);
      }

      if (dataLines.length === 0) return;
      const payloadText = dataLines.join('\n');
      if (eventName === 'error') {
        let message = payloadText;
        try {
          message = JSON.parse(payloadText)?.message || message;
        } catch {
          // El mensaje plano también es válido.
        }
        throw new Error(`El stream de tickets reportó un error: ${message}`);
      }
      if (eventName !== 'order_created') return;

      let payload;
      try {
        payload = JSON.parse(payloadText);
      } catch {
        throw new Error('El stream devolvió un evento de ticket inválido.');
      }

      const jobId = String(payload?.event_id ?? eventId ?? '').trim();
      const pedido = String(payload?.pedido ?? '').trim();
      const tienda = String(payload?.tienda ?? storeId).trim().toLowerCase();
      if (!jobId || !pedido || tienda !== storeId) {
        throw new Error('El stream devolvió un ticket sin event_id, pedido o tienda válida.');
      }

      latestEventId = jobId;
      await onJob({
        id: jobId,
        tienda,
        pedido,
        createdAt: payload.created_at ?? null,
        status: 'pending',
      });
    }

    for await (const chunk of body) {
      buffer += decoder.decode(chunk, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? '';
      for (const block of blocks) await dispatch(block);
    }
    buffer += decoder.decode();
    if (buffer.trim()) await dispatch(buffer);
    return latestEventId;
  }

  return {
    login,
    refresh,
    getSession,
    fetchPickingRoute,
    fetchTicketOrderInfo,
    listPendingTicketJobs,
    claimTicketJob,
    markTicketJobPrinted,
    markTicketJobFailed,
    consumeTicketStream,
  };
}

module.exports = { createApiClient };

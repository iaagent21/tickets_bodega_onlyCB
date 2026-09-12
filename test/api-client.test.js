const assert = require('node:assert/strict');
const http = require('node:http');
const { test } = require('node:test');
const { createApiClient } = require('../api-client');

test('consulta el nombre del cliente por la API y envía el contexto de tienda', async (t) => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      appId: request.headers['x-app-id'],
      storeId: request.headers['x-store-id'],
    });

    if (request.method === 'POST' && request.url === '/auth/login') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        expires_at: Date.now() + 60 * 60 * 1_000,
      }));
      return;
    }

    if (request.method === 'GET' && request.url === '/picking/ruta/0098069') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        nombre: 'CLIENTE DE PRUEBA',
        rutas: [],
        sin_ruta: [],
        sin_ubicacion: [],
        sin_layout: [],
        cambios: [],
      }));
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ message: 'No encontrado' }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const apiClient = createApiClient({
    apiUrl: `http://127.0.0.1:${address.port}`,
    tienda: 'la4ta',
    email: 'tickets@example.com',
    password: 'secret',
  });

  const route = await apiClient.fetchPickingRoute('0098069');

  assert.equal(route.nombre, 'CLIENTE DE PRUEBA');
  assert.deepEqual(requests, [
    {
      method: 'POST',
      url: '/auth/login',
      authorization: undefined,
      appId: undefined,
      storeId: undefined,
    },
    {
      method: 'GET',
      url: '/picking/ruta/0098069',
      authorization: 'Bearer test-access-token',
      appId: 'etiquetas',
      storeId: 'la4ta',
    },
  ]);
});

test('consulta el encabezado ligero del ticket sin pedir la ruta completa', async (t) => {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      appId: request.headers['x-app-id'],
      storeId: request.headers['x-store-id'],
    });

    if (request.method === 'POST' && request.url === '/auth/login') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        expires_at: Date.now() + 60 * 60 * 1_000,
      }));
      return;
    }

    if (request.method === 'GET' && request.url === '/tickets/order-info/0098069') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        pedido: '0098069',
        nombre: 'CLIENTE DE PRUEBA',
        vendedora: 'VENDEDORA',
        total_documento: 123.45,
        created_at: '2026-09-12T12:00:00.000Z',
      }));
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ message: 'No encontrado' }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const apiClient = createApiClient({
    apiUrl: `http://127.0.0.1:${address.port}`,
    tienda: 'la4ta',
    email: 'tickets@example.com',
    password: 'secret',
  });

  const info = await apiClient.fetchTicketOrderInfo('0098069');

  assert.equal(info.nombre, 'CLIENTE DE PRUEBA');
  assert.deepEqual(requests, [
    {
      method: 'POST',
      url: '/auth/login',
      authorization: undefined,
      appId: undefined,
      storeId: undefined,
    },
    {
      method: 'GET',
      url: '/tickets/order-info/0098069',
      authorization: 'Bearer test-access-token',
      appId: 'etiquetas',
      storeId: 'la4ta',
    },
  ]);
});

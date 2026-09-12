# Tickets OnlyCB

Servicio Node.js para recibir jobs de tickets desde EscanersGlobal, consultar el pedido mediante la API, generar un ticket compacto de 80 mm con el código de barras, pedido y cliente, e imprimirlo en Windows.

La PC se comunica exclusivamente con la API. No necesita `SUPABASE_URL`, `SUPABASE_KEY`, `PEDIDOS_TABLE`, acceso directo a Supabase ni ninguna clave `service_role`.

## Requisitos

- Windows con la impresora térmica instalada y funcionando.
- Node.js 18 o superior.
- Usuario de la API activo, con acceso a la aplicación `etiquetas`, permiso de consulta y acceso a la tienda correspondiente.
- API de EscanersGlobal disponible y con las migraciones de tickets aplicadas (`068`, `069`, `070`, `071` y `072`).
- Conectividad permanente entre esta PC y `API_URL`.

## Qué hace el servicio

1. Inicia sesión en la API con `/auth/login` y renueva la sesión con `/auth/refresh`.
2. Escucha `GET /tickets/stream` mediante SSE.
3. Recupera periódicamente `GET /tickets/pending` para su `TICKET_CLIENT_ID`, incluyendo jobs fallidos y leases vencidos.
4. Reclama cada job con `POST /tickets/jobs/:id/claim` antes de procesarlo.
5. Consulta `GET /picking/ruta/:pedido` en la API y extrae el nombre del cliente de `nombre`.
6. Genera la salida configurada en `PRINT_MODE`: PDF horizontal o bytes ESC/POS RAW con código de barras y el texto `Pedido: #... - Cliente: ...`.
7. Imprime el ticket y confirma con `POST /tickets/jobs/:id/printed`.
8. Si ocurre un error antes de imprimir, reporta `POST /tickets/jobs/:id/failed`.

La deduplicación se realiza por `(job_id, TICKET_CLIENT_ID)`. Cada PC de la misma tienda recibe su propia entrega, por lo que puede imprimir el mismo ticket que otras PCs sin bloquearlas. Si una PC se desconecta, el API conserva su entrega y el servicio la recupera al reconectar o durante el sondeo de pendientes.

## Contenido del ticket

El PDF mide 80 mm de ancho por 1.5 pulgadas de alto y contiene el código de barras Code128 generado con el número de pedido y una línea con el pedido y el cliente. El nombre se obtiene de la respuesta de la API. No se consulta Supabase desde esta PC. Si el nombre no existe, imprime `Cliente no informado`.

Con `PRINT_MODE=escpos`, el programa genera un trabajo RAW para la misma cola de Windows (`PRINTER_NAME`, por ejemplo `BODEGAS1`) usando `WritePrinter`. No cambia el D-Link, su IP, su puerto ni el controlador instalado. Tampoco envía el comando de corte automático. Este modo está pensado para colas `Generic / Text Only` y comandos ESC/POS.

## Instalación en Windows

Abre PowerShell en la carpeta del proyecto:

```powershell
cd C:\Apps\tickets_bodega_onlyCB
npm ci
Copy-Item .env.example .env
notepad .env
```

También puedes copiar el archivo desde CMD:

```cmd
copy .env.example .env
```

Configura `.env` antes de iniciar el listener. El archivo `.env` real está ignorado por Git y no debe publicarse.

## Configuración de `.env`

Ejemplo completo:

```env
# Usuario de EscanersGlobal con permiso para la app etiquetas.
STORE_USER_EMAIL=usuario@ejemplo.com
STORE_USER_PASSWORD=tu_contraseña

# URL base de la API, sin barra final.
API_URL=https://api.ejemplo.com

# Identificador exacto de la tienda.
TIENDA=surti

# Producción: false. Simula la recepción sin reclamar ni imprimir.
DRY_RUN=false

# Producción: true. Reclama jobs e imprime códigos de barras.
AUTO_PRINT=true

# pdf conserva la impresión actual; escpos envía RAW ESC/POS a la misma cola.
PRINT_MODE=pdf

# Nombre exacto de la cola de Windows. En escpos es obligatorio, por ejemplo BODEGAS1.
PRINTER_NAME=

# Sólo para PRINT_MODE=escpos.
ESCPOS_WIDTH_DOTS=512
ESCPOS_BARCODE_SCALE=2
ESCPOS_BARCODE_HEIGHT=72
ESCPOS_FEED_LINES=1

# Lease para evitar duplicados dentro de la misma PC.
LEASE_SECONDS=120

# Cada cuánto se recuperan jobs pendientes o leases vencidos.
PENDING_POLL_MS=30000

# Identificador opcional y único para esta PC.
# Si se omite, se crea tickets/.ticket-client-id automáticamente.
# TICKET_CLIENT_ID=pc-tickets-surti-01

# Timeout de cada llamada normal a la API.
API_TIMEOUT_MS=15000
```

Variables obligatorias:

| Variable | Descripción |
| --- | --- |
| `STORE_USER_EMAIL` | Correo del usuario de la API. |
| `STORE_USER_PASSWORD` | Contraseña del usuario de la API. |
| `API_URL` | URL base de EscanersGlobal. |
| `TIENDA` | Tienda autorizada para esa PC. |

Variables importantes:

| Variable | Valor recomendado |
| --- | --- |
| `DRY_RUN` | `false` en producción; `true` para diagnóstico sin reclamar jobs. |
| `AUTO_PRINT` | `true` en producción; `false` genera vista previa sin confirmar jobs. |
| `PRINT_MODE` | `pdf` mantiene el flujo actual; `escpos` envía datos RAW a la cola de Windows. |
| `PRINTER_NAME` | Nombre exacto de Windows; obligatorio en `escpos`, por ejemplo `BODEGAS1`. |
| `TICKET_CLIENT_ID` | Un valor distinto por cada PC de tickets. |

No configures `SUPABASE_URL`, `SUPABASE_KEY`, `PEDIDOS_TABLE`, `SUPABASE_SERVICE_ROLE_KEY` ni ninguna otra credencial de Supabase en la PC de tickets.

## Uso normal

Inicia el listener:

```powershell
node listener.js
```

Al iniciar correctamente debe mostrar la tienda, la URL de la API, el identificador del cliente y que la fuente es `/tickets/stream + /tickets/pending`.

Déjalo ejecutándose en la PC de bodega. Para detenerlo, presiona `Ctrl+C`.

## Prueba manual de un pedido

Para generar y probar el ticket de un pedido específico:

```powershell
node test-print.js 0098072
```

El comportamiento de `test-print.js` usa `AUTO_PRINT` y `PRINT_MODE` del `.env`:

- `AUTO_PRINT=false`: genera el PDF o archivo `.escpos.bin` sin imprimir.
- `AUTO_PRINT=true`: genera e imprime en el formato configurado.

La prueba consulta el cliente mediante `GET /picking/ruta/:pedido`, igual que el listener. No reclama ni confirma un job; se utiliza para verificar el ticket y la impresora.

## Modos de diagnóstico

Para validar autenticación y recepción de jobs sin generar PDF ni imprimir:

```env
DRY_RUN=true
AUTO_PRINT=true
```

Para generar PDFs sin imprimir:

```env
DRY_RUN=false
AUTO_PRINT=false
```

En ambos casos los jobs no se marcan como impresos y permanecen recuperables. En producción usa `DRY_RUN=false` y `AUTO_PRINT=true`.

## Impresión y recuperación

- El job se reclama antes de generar el código de barras.
- El cliente se obtiene de `nombre` en la respuesta de `GET /picking/ruta/:pedido`.
- Si la impresora falla, el job se marca como `failed` y puede reintentarse.
- Si la PC se apaga antes de confirmar, el lease vence y el job vuelve a ser recuperable.
- Si la impresión física terminó pero se corta la conexión antes de `printed`, puede ocurrir una reimpresión; es la limitación inevitable entre imprimir y confirmar.
- Los PDFs y el estado local se guardan en `tickets/`, carpeta excluida de Git.

## Problemas comunes

### `401` o usuario sin acceso

Verifica `STORE_USER_EMAIL`, `STORE_USER_PASSWORD`, `TIENDA` y que el usuario tenga acceso a la app `etiquetas` y a esa tienda.

### No llegan tickets

Verifica que `API_URL` sea correcta, que la API esté disponible y que las migraciones `068`, `069`, `070`, `071` y `072` estén aplicadas. El servicio también consulta `/tickets/pending` con su `TICKET_CLIENT_ID`, por lo que un pedido creado durante una desconexión debe recuperarse para esa PC.

### La impresora no responde

Confirma que Windows pueda imprimir una página de prueba y configura `PRINTER_NAME` con el nombre exacto de la cola. PDF conserva la orientación horizontal y sin escalado; ESC/POS envía datos RAW a esa misma cola sin tocar el D-Link.

### Se necesita cambiar de tienda

Edita `TIENDA` y usa credenciales autorizadas para esa tienda. No reutilices el mismo `TICKET_CLIENT_ID` en dos PCs simultáneamente.

## Archivos principales

| Archivo | Función |
| --- | --- |
| `listener.js` | SSE, recuperación, cola, claim, deduplicación e impresión. |
| `api-client.js` | Login, refresh, stream, consulta de pedido y jobs. |
| `ticket-pdf.js` | Generación del PDF horizontal con código, pedido y cliente. |
| `escpos-ticket.js` | Generación de bytes ESC/POS, código de barras raster y texto. |
| `windows-raw-printer.js` | Envío RAW a una cola de impresión de Windows. |
| `ticket-output.js` | Selección y creación del artefacto PDF o ESC/POS. |
| `ticket-printer.js` | Impresión con reintentos según `PRINT_MODE`. |
| `test-print.js` | Prueba manual de un pedido. |
| `.env.example` | Plantilla segura de configuración. |

## Seguridad

El `.env` real contiene credenciales y nunca debe subirse a GitHub. Sólo se publica `.env.example` con valores de ejemplo. La PC sólo usa las credenciales de la API; Supabase queda encapsulado dentro de la API.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const POWERSHELL_SCRIPT = String.raw`
$printerName = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ESC_POS_PRINTER_B64))
$payload = [Convert]::FromBase64String($env:ESC_POS_PAYLOAD_B64)

Add-Type @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class RawWindowsPrinter {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public class DocInfo {
        public string pDocName;
        public string pOutputFile;
        public string pDataType;
    }

    [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool OpenPrinter(string name, out IntPtr handle, IntPtr defaults);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool ClosePrinter(IntPtr handle);

    [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern int StartDocPrinter(IntPtr handle, int level, DocInfo document);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool EndDocPrinter(IntPtr handle);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool StartPagePrinter(IntPtr handle);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool EndPagePrinter(IntPtr handle);

    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool WritePrinter(IntPtr handle, IntPtr data, int count, out int written);

    public static void Send(string printerName, byte[] data) {
        IntPtr printer = IntPtr.Zero;
        string[] candidates = new string[] {
            printerName,
            "\\\\localhost\\" + printerName,
            "\\\\" + Environment.MachineName + "\\" + printerName,
        };
        int lastError = 0;
        foreach (string candidate in candidates) {
            if (OpenPrinter(candidate, out printer, IntPtr.Zero)) {
                break;
            }
            lastError = Marshal.GetLastWin32Error();
        }
        if (printer == IntPtr.Zero) {
            throw new Win32Exception(lastError, "No se pudo abrir la cola de impresión: " + printerName);
        }

        bool documentStarted = false;
        try {
            var document = new DocInfo {
                pDocName = "EscanersGlobal ESC/POS",
                pOutputFile = null,
                pDataType = "RAW",
            };
            if (StartDocPrinter(printer, 1, document) == 0) {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "No se pudo iniciar el trabajo RAW.");
            }
            documentStarted = true;
            if (!StartPagePrinter(printer)) {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "No se pudo iniciar la página RAW.");
            }

            var pinned = GCHandle.Alloc(data, GCHandleType.Pinned);
            try {
                int written;
            if (!WritePrinter(printer, pinned.AddrOfPinnedObject(), data.Length, out written) || written != data.Length) {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "La cola no aceptó todos los datos RAW.");
            }
            } finally {
                pinned.Free();
            }

            if (!EndPagePrinter(printer)) {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "No se pudo cerrar la página RAW.");
            }
        } finally {
            if (documentStarted) EndDocPrinter(printer);
            ClosePrinter(printer);
        }
    }
}
"@

try {
    [RawWindowsPrinter]::Send($printerName, $payload)
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
`;

function printRawToWindowsPrinter(printerName, data, timeoutMs = 15_000) {
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('ESC/POS directo solo está disponible en Windows.'));
  }
  const normalizedPrinterName = String(printerName ?? '').trim();
  if (!normalizedPrinterName) return Promise.reject(new Error('PRINTER_NAME es obligatorio para PRINT_MODE=escpos.'));
  if (!Buffer.isBuffer(data) || data.length === 0) return Promise.reject(new Error('El trabajo ESC/POS está vacío.'));

  return runPowerShellRawPrint(normalizedPrinterName, data, timeoutMs).catch(async (nativeError) => {
    try {
      await printRawViaSharedQueue(normalizedPrinterName, data, timeoutMs);
      return;
    } catch (sharedError) {
      throw new Error(`${nativeError.message} También falló la cola compartida: ${sharedError.message}`);
    }
  });
}

function runPowerShellRawPrint(printerName, data, timeoutMs) {
  const printerNameBase64 = Buffer.from(printerName, 'utf8').toString('base64');
  const payloadBase64 = data.toString('base64');
  const childEnvironment = {
    ...process.env,
    ESC_POS_PRINTER_B64: printerNameBase64,
    ESC_POS_PAYLOAD_B64: payloadBase64,
  };
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', POWERSHELL_SCRIPT],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 1_000_000, env: childEnvironment },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || stdout || error.message).trim();
          reject(new Error(`No se pudo enviar el trabajo ESC/POS a ${printerName}: ${detail}`));
          return;
        }
        resolve();
      },
    );
  });
}

function printRawViaSharedQueue(printerName, data, timeoutMs) {
  if (!/^[A-Za-z0-9._ -]{1,128}$/.test(printerName)) {
    return Promise.reject(new Error('PRINTER_NAME contiene caracteres no compatibles con la cola compartida de Windows.'));
  }

  const filePath = path.join(os.tmpdir(), `escanersglobal-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.prn`);
  const sharePath = `\\\\localhost\\${printerName}`;
  fs.writeFileSync(filePath, data);

  return new Promise((resolve, reject) => {
    const command = `copy /b "${filePath}" "${sharePath}"`;
    execFile('cmd.exe', ['/d', '/c', command], { windowsHide: true, timeout: timeoutMs, maxBuffer: 1_000_000 }, (error, stdout, stderr) => {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // El archivo temporal se puede limpiar en el siguiente mantenimiento del sistema.
      }
      if (error) {
        reject(new Error(String(stderr || stdout || error.message).trim()));
        return;
      }
      resolve();
    });
  });
}

module.exports = { printRawToWindowsPrinter, printRawViaSharedQueue };

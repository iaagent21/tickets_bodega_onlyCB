const { execFile } = require('node:child_process');

const POWERSHELL_SCRIPT = String.raw`
$printerName = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($args[0]))
$payload = [Convert]::FromBase64String($args[1])

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

  const printerNameBase64 = Buffer.from(normalizedPrinterName, 'utf8').toString('base64');
  const payloadBase64 = data.toString('base64');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', POWERSHELL_SCRIPT, printerNameBase64, payloadBase64],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 1_000_000 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || stdout || error.message).trim();
          reject(new Error(`No se pudo enviar el trabajo ESC/POS a ${normalizedPrinterName}: ${detail}`));
          return;
        }
        resolve();
      },
    );
  });
}

module.exports = { printRawToWindowsPrinter };

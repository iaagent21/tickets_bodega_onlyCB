# Instalación rápida de Tickets OnlyCB

Guía para instalar el listener en una PC Windows y dejarlo iniciando solo al iniciar sesión.

## 1. Instalar Git y Node.js

Abre PowerShell y ejecuta:

```powershell
winget install --id Git.Git -e --source winget
winget install --id OpenJS.NodeJS.LTS -e --source winget
```

Cierra PowerShell, abre uno nuevo y verifica:

```powershell
git --version
node --version
npm.cmd --version
```

Node.js debe ser versión 18 o superior.

## 2. Descargar el proyecto

```powershell
New-Item -ItemType Directory -Path C:\Apps -Force
git clone https://github.com/iaagent21/tickets_bodega_onlyCB.git C:\Apps\tickets_bodega_onlyCB
Set-Location C:\Apps\tickets_bodega_onlyCB
npm.cmd ci
Copy-Item .env.example .env
notepad .env
```

Configura estos valores:

```env
STORE_USER_EMAIL=usuario_de_la_api
STORE_USER_PASSWORD=contraseña
API_URL=https://ferreteriasgd-api-cb.w8k0jk.easypanel.host
TIENDA=la4ta
AUTO_PRINT=true
PRINT_MODE=pdf
PRINTER_NAME=Nombre_exacto_de_la_impresora_termica
TICKET_CLIENT_ID=pc-tickets-la4ta-01
```

El usuario debe tener acceso a `etiquetas`, permiso de consulta y acceso a la tienda. No configures variables de Supabase. Cada PC debe usar un `TICKET_CLIENT_ID` diferente.

`PRINT_MODE=pdf` conserva el flujo actual. Para ESC/POS directo al D-Link usa esta configuración, sin cambiar el D-Link:

```env
PRINT_MODE=escpos
ESCPOS_TRANSPORT=lpr
ESCPOS_HOST=192.168.4.6
ESCPOS_PORT=515
ESCPOS_QUEUE=LPT
ESCPOS_FEED_LINES=3
```

También puedes usar `ESCPOS_HOST=BODEGA1` si ese nombre resuelve en la red. Con `ESCPOS_TRANSPORT=windows` se conserva la ruta de la cola de Windows y `PRINTER_NAME` debe ser el nombre exacto de esa cola.

## 3. Probar antes de automatizar

Genera el archivo configurado sin imprimir:

```powershell
$env:AUTO_PRINT = "false"
node test-print.js 0098098
Get-ChildItem .\tickets\pedido_0098098.*
```

Si el PDF es correcto, elimina la variable temporal:

```powershell
Remove-Item Env:AUTO_PRINT
```

Para imprimir físicamente mediante Windows, `PRINTER_NAME` debe ser el nombre de la cola, no el nombre del equipo ni la IP del D-Link. En PDF se conserva la orientación horizontal y sin escalado. En ESC/POS por LPR se envían bytes RAW al servidor existente y no se manda comando de corte.

## 4. Iniciar automáticamente y oculto

Crea el archivo de inicio:

```powershell
notepad C:\Apps\tickets_bodega_onlyCB\start-listener.vbs
```

Pega y guarda:

```vbscript
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = "C:\Apps\tickets_bodega_onlyCB"

nodePath = "C:\Program Files\nodejs\node.exe"
scriptPath = "C:\Apps\tickets_bodega_onlyCB\listener.js"

shell.Run Chr(34) & nodePath & Chr(34) & " " & Chr(34) & scriptPath & Chr(34), 0, False
```

Registra e inicia la tarea:

```powershell
$TaskName = "Tickets OnlyCB"
$ProjectPath = "C:\Apps\tickets_bodega_onlyCB"
$VbsPath = Join-Path $ProjectPath "start-listener.vbs"
$TaskUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$WScriptPath = "$env:WINDIR\System32\wscript.exe"
$Action = New-ScheduledTaskAction -Execute $WScriptPath -Argument ('"' + $VbsPath + '"')
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $TaskUser
$Principal = New-ScheduledTaskPrincipal -UserId $TaskUser -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Description "Listener oculto de Tickets OnlyCB" -Force
Start-ScheduledTask -TaskName $TaskName
```

## 5. Verificar

Debe existir un solo listener:

```powershell
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
Where-Object { $_.CommandLine -like "*tickets_bodega_onlyCB*listener.js*" } |
Select-Object ProcessId,CommandLine
```

Para actualizarlo después:

```powershell
Set-Location C:\Apps\tickets_bodega_onlyCB
git pull origin master
npm.cmd ci
Restart-ScheduledTask -TaskName "Tickets OnlyCB"
```

No ejecutes `node listener.js` manualmente si la tarea ya está activa; podrías crear un segundo listener.

## 6. Quitar el arranque automático

Para detenerlo ahora y evitar que vuelva a iniciar con Windows:

```powershell
Stop-ScheduledTask -TaskName "Tickets OnlyCB" -ErrorAction SilentlyContinue
Disable-ScheduledTask -TaskName "Tickets OnlyCB"
```

Para volver a activarlo:

```powershell
Enable-ScheduledTask -TaskName "Tickets OnlyCB"
Start-ScheduledTask -TaskName "Tickets OnlyCB"
```

Para eliminar por completo la tarea programada:

```powershell
Stop-ScheduledTask -TaskName "Tickets OnlyCB" -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "Tickets OnlyCB" -Confirm:$false
```

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
PRINTER_NAME=Nombre_exacto_de_la_impresora_termica
TICKET_CLIENT_ID=pc-tickets-la4ta-01
```

El usuario debe tener acceso a `etiquetas`, permiso de consulta y acceso a la tienda. No configures variables de Supabase. Cada PC debe usar un `TICKET_CLIENT_ID` diferente.

## 3. Probar antes de automatizar

Genera un PDF sin imprimir:

```powershell
$env:AUTO_PRINT = "false"
node test-print.js 0098098
Start-Process .\tickets\pedido_0098098.pdf
```

Si el PDF es correcto, elimina la variable temporal:

```powershell
Remove-Item Env:AUTO_PRINT
```

Para imprimir físicamente, `PRINTER_NAME` debe ser el nombre de la impresora térmica, no Microsoft Print to PDF ni XPS. El programa envía el ticket horizontal y sin escalado.

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

# Compila alma-base (la Home Station). No flashea ni abre puertos.
# Uso: powershell -ExecutionPolicy Bypass -File build_base.ps1 -CredsDir <carpeta fuera del repo con alma_dev_creds.h>
param([Parameter(Mandatory = $true)][string]$CredsDir)
$ErrorActionPreference = "Stop"
$env:IDF_TOOLS_PATH = "C:\Users\ikann\.espressif"
. C:\Espressif\frameworks\esp-idf-v5.2.1\export.ps1 | Out-Null
Set-Location $PSScriptRoot
$env:ALMA_F2_CREDS_DIR = $CredsDir
Copy-Item ..\..\tools\base_leds\salida\alma_base.alb main\alma_base.alb -ErrorAction SilentlyContinue
idf.py -B build build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
idf.py -B build size

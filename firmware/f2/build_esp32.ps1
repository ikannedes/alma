# Compila alma-f2 para el ESP32, revisa R15 (y, con -Remota, que no haya servos) y muestra el tamaño. No flashea ni abre puertos.
# Uso: powershell -ExecutionPolicy Bypass -File build_esp32.ps1 [-Remota] [-MotionOnUsb] [-Api -CredsDir <carpeta fuera del repo con alma_dev_creds.h>]
# -MotionOnUsb: variante de desarrollo (R14 relajada: mueve servos con el USB puesto), en build_motor_usb
# -MemWrite: memoria con escritura encendida (06; PRUEBA-MEMORIA.md), en build_mem
# -Ble: escuchar a la Home Station por Bluetooth (main/ble_base.c, sdkconfig.ble), en build_..._ble
param([switch]$Api, [switch]$Remota, [switch]$MotionOnUsb, [switch]$MemWrite, [switch]$Ble, [string]$CredsDir = "")
$ErrorActionPreference = "Stop"
$env:IDF_TOOLS_PATH = "C:\Users\ikann\.espressif"
. C:\Espressif\frameworks\esp-idf-v5.2.1\export.ps1 | Out-Null
Set-Location $PSScriptRoot
$build = "build"
if ($Remota) { $build += "_remota" }
if ($Api) { $build += "_api" }
if ($MotionOnUsb) { $build += "_motor_usb" }
if ($MemWrite) { $build += "_mem" }
if ($Ble) { $build += "_ble" }
$idfArgs = @("-B", $build)
if ($build -ne "build") { $idfArgs += @("-DSDKCONFIG=$build/sdkconfig") }
# Van por variable de entorno: ESP-IDF resuelve los REQUIRES en una pasada que no ve los -D (main/CMakeLists.txt)
if ($Api) { $env:ALMA_F2_API = "1"; $env:ALMA_F2_CREDS_DIR = $CredsDir }
else { Remove-Item Env:ALMA_F2_API -ErrorAction SilentlyContinue; Remove-Item Env:ALMA_F2_CREDS_DIR -ErrorAction SilentlyContinue }
if ($Remota) { $env:ALMA_SERVOS_DISABLED = "1" } else { Remove-Item Env:ALMA_SERVOS_DISABLED -ErrorAction SilentlyContinue }
if ($MotionOnUsb) { $env:ALMA_DEV_MOTION_ON_USB = "1" } else { Remove-Item Env:ALMA_DEV_MOTION_ON_USB -ErrorAction SilentlyContinue }
if ($MemWrite) { $env:ALMA_MEM_WRITE_ENABLED = "1" } else { Remove-Item Env:ALMA_MEM_WRITE_ENABLED -ErrorAction SilentlyContinue }
if ($Ble) { $env:ALMA_F2_BLE = "1" } else { Remove-Item Env:ALMA_F2_BLE -ErrorAction SilentlyContinue }
idf.py @idfArgs build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
python -I tools\check_r15.py $build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ($Remota) {
    python -I ..\tools\check_servos_off.py "$build\alma-f2.elf"
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
idf.py -B $build size

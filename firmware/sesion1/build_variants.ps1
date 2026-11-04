# Compila alma-sesion1 normal (build/) y remota (build_remota/, ALMA_SERVOS_DISABLED=1) y revisa que la remota no
# traiga servos y que la normal sí (prueba negativa). No flashea ni abre puertos.
# Uso: powershell -ExecutionPolicy Bypass -File build_variants.ps1
$ErrorActionPreference = "Stop"
$env:IDF_TOOLS_PATH = "C:\Users\ikann\.espressif"
. C:\Espressif\frameworks\esp-idf-v5.2.1\export.ps1 | Out-Null
Set-Location $PSScriptRoot
Remove-Item Env:ALMA_SERVOS_DISABLED -ErrorAction SilentlyContinue
idf.py -B build build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$env:ALMA_SERVOS_DISABLED = "1"
idf.py -B build_remota -DSDKCONFIG=build_remota/sdkconfig build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Remove-Item Env:ALMA_SERVOS_DISABLED
python -I ..\tools\check_servos_off.py build_remota\alma-sesion1.elf
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
python -I ..\tools\check_servos_off.py build\alma-sesion1.elf --expect-servos
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
# I2C solo con el driver heredado: con los dos drivers en el binario, ESP-IDF aborta al arrancar (sensors.c)
foreach ($b in "build", "build_remota") {
    python -I ..\tools\check_i2c_driver.py "$b\alma-sesion1.elf"
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

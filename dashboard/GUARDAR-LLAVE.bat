@echo off
chcp 65001 >nul
set "TARGET=%~dp0.env"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$k=(Get-Clipboard -Raw).Trim(); if($k -and $k.StartsWith('eyJ')){ $out='SUPABASE_URL=https://mjbuqqoifrlxeukicwfl.supabase.co'+[char]10+'SUPABASE_SERVICE_KEY='+$k; [IO.File]::WriteAllText($env:TARGET,$out,(New-Object Text.UTF8Encoding($false))); Write-Host ''; Write-Host '  LLAVE GUARDADA CORRECTAMENTE' -ForegroundColor Green } else { Write-Host ''; Write-Host '  El portapapeles no tiene la llave. Vuelve a copiarla en Supabase (boton Copy) y ejecuta esto de nuevo.' -ForegroundColor Red }"
echo.
echo   Ya puedes cerrar esta ventana.
echo.
pause

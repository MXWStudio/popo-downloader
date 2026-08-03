@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0native-host\install.ps1" -ExtensionRoot "%~dp0extension" -BundledGopeedRoot "%~dp0Gopeed"
if errorlevel 1 (
  echo.
  echo Installation failed. Load the extension folder in chrome://extensions and try again.
  pause
  exit /b 1
)
echo.
echo POPO helper and bundled Gopeed installed successfully.
echo Open the extension. Gopeed will start automatically when needed.
pause

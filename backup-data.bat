@echo off
REM backup-data.bat - archive the confidential data folder outside the repo.
REM Keeps a timestamped zip in ..\data-backups so a wiped working copy
REM never means a lost dataset. Safe to run any time; it only reads data\.

setlocal
cd /d "%~dp0"

set "DATA_SRC=data"
if not exist "%DATA_SRC%\s4_imei_master.csv" (
  if exist "..\data\s4_imei_master.csv" set "DATA_SRC=..\data"
)
if not exist "%DATA_SRC%\" (
  echo No data folder found next to this script or in ..\data.
  exit /b 1
)

if not exist "..\data-backups\" mkdir "..\data-backups"

for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "STAMP=%%i"
set "OUT=..\data-backups\nspector-data-%STAMP%.zip"

tar -a -c -f "%OUT%" -C "%DATA_SRC%" .
if errorlevel 1 (
  echo Backup failed.
  exit /b 1
)

echo Backup written to %OUT%

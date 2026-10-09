@echo off
REM ---------------------------------------------------------------------------
REM  Build the Android APK.
REM
REM  The SDK location is taken from ANDROID_HOME. This project deliberately does
REM  NOT use android/local.properties — on some Windows/AGP combinations a valid
REM  sdk.dir there makes dependency resolution fail with the misleading error:
REM     "The filename, directory name, or volume label syntax is incorrect"
REM  If you have a local.properties lying around, delete it before building.
REM
REM  Requires: a JDK on PATH (or JAVA_HOME set) and ANDROID_HOME pointing at the
REM  Android SDK.
REM ---------------------------------------------------------------------------
setlocal enabledelayedexpansion

if "%ANDROID_HOME%"=="" (
  if "%ANDROID_SDK_ROOT%"=="" (
    echo.
    echo   ANDROID_HOME is not set.
    echo   Set it to your SDK, for example:
    echo     set ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk
    echo.
    exit /b 1
  )
  set "ANDROID_HOME=%ANDROID_SDK_ROOT%"
)

if not exist "%ANDROID_HOME%" (
  echo   ANDROID_HOME points at a folder that does not exist: %ANDROID_HOME%
  exit /b 1
)

REM local.properties breaks the build on some setups - remove it if present.
if exist local.properties (
  echo   Removing local.properties ^(it breaks dependency resolution on some systems^)
  del /q local.properties
)

where java >nul 2>&1
if errorlevel 1 (
  echo.
  echo   java was not found on PATH. Install a JDK 17 or newer, or set JAVA_HOME.
  echo.
  exit /b 1
)

echo   ANDROID_HOME : %ANDROID_HOME%
echo   java         :
java -version 2>&1 | findstr /C:"version" | more
echo.
echo   Building APK ...
echo.

call gradlew.bat assembleDebug --no-daemon
if errorlevel 1 (
  echo.
  echo   BUILD FAILED
  exit /b 1
)

if not exist "app\build\outputs\apk\debug\app-debug.apk" (
  echo.
  echo   BUILD FAILED - no APK produced
  exit /b 1
)

copy /y "app\build\outputs\apk\debug\app-debug.apk" "NSpector.apk" >nul
echo.
echo   BUILD OK
echo   APK: %~dp0NSpector.apk
for %%F in (NSpector.apk) do echo   Size: %%~zF bytes
echo.
endlocal
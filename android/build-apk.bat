@echo off
REM Build the Android APK.
REM Gradle fails on deeply-nested Windows paths with a misleading
REM "The filename, directory name, or volume label syntax is incorrect",
REM so the project is staged into a short path before building.
setlocal
set SDK=%ANDROID_HOME%
if "%SDK%"=="" set SDK=%LOCALAPPDATA%\Android\Sdk

set SHORT=C:\nscbuild
set PROJ=%~dp0

echo Staging project to %SHORT% ...
if exist "%SHORT%" rmdir /s /q "%SHORT%"
mkdir "%SHORT%\app\src\main\java\com\nspector\app" 2>nul
mkdir "%SHORT%\app\src\main\res" 2>nul
mkdir "%SHORT%\gradle" 2>nul

copy /y "%PROJ%settings.gradle" "%SHORT%\" >nul
copy /y "%PROJ%build.gradle" "%SHORT%\" >nul
copy /y "%PROJ%gradle.properties" "%SHORT%\" >nul
copy /y "%PROJ%gradlew" "%SHORT%\" >nul
copy /y "%PROJ%gradlew.bat" "%SHORT%\" >nul
copy /y "%PROJ%local.properties" "%SHORT%\" >nul
xcopy /y /i /q "%PROJ%gradle\wrapper" "%SHORT%\gradle\" >nul
copy /y "%PROJ%app\build.gradle" "%SHORT%\app\" >nul
xcopy /y /i /q "%PROJ%app\src\main\AndroidManifest.xml" "%SHORT%\app\src\main\" >nul
xcopy /y /i /q "%PROJ%app\src\main\java" "%SHORT%\app\src\main\" >nul
xcopy /y /i /q "%PROJ%app\src\main\res" "%SHORT%\app\src\main\" >nul

echo Building APK ...
pushd "%SHORT%"
call gradlew.bat assembleDebug --no-daemon
popd

if exist "%SHORT%\app\build\outputs\apk\debug\app-debug.apk" (
  copy /y "%SHORT%\app\build\outputs\apk\debug\app-debug.apk" "%PROJ%NSpector.apk" >nul
  echo.
  echo BUILD OK - APK at %PROJ%NSpector.apk
) else (
  echo.
  echo BUILD FAILED
)
endlocal
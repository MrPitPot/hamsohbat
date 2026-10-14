@echo off
rem Builds build\Hamsohbat.exe (Visual Studio C++ tools) and build\Hamsohbat-Setup.msi (WiX).
setlocal
set VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe
for /f "usebackq tokens=*" %%i in (`call "%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set VS=%%i
if not defined VS (echo Visual Studio C++ build tools not found & exit /b 1)
call "%VS%\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
cd /d "%~dp0"
if not exist build mkdir build
set WV=.deps\wv2\build\native
set CFLAGS=/nologo /O1 /Os /GL /GS- /Gy /MT /EHsc /std:c++17 /utf-8 /W3 /DUNICODE /D_UNICODE /DNOMINMAX /D_CRT_SECURE_NO_WARNINGS /I%WV%\include /Ibuild
set LFLAGS=/LTCG /OPT:REF /OPT:ICF /SUBSYSTEM:WINDOWS /MANIFEST:NO /EMITPOGOPHASEINFO /DEBUG:NONE
set LIBS=user32.lib gdi32.lib shell32.lib ole32.lib oleaut32.lib advapi32.lib winhttp.lib bcrypt.lib shlwapi.lib dwmapi.lib comctl32.lib propsys.lib uuid.lib
rc /nologo /Ibuild /fo build\app.res app.rc || exit /b 1
cl %CFLAGS% app.cpp build\app.res /Fobuild\ /Febuild\Hamsohbat.exe /link %LFLAGS% %WV%\x64\WebView2LoaderStatic.lib %LIBS% || exit /b 1
rem The installer: a per-user Windows Installer package (HS_VERSION and HS_SERVER come from scripts/release.mjs).
set "PATH=%PATH%;%USERPROFILE%\.dotnet\tools"
if not defined HS_VERSION set HS_VERSION=0.0.0
if not defined HS_SERVER set HS_SERVER=https://example.com
wix build installer.wxs -arch x64 -d Version=%HS_VERSION% -d Server=%HS_SERVER% -o build\Hamsohbat-Setup.msi || exit /b 1
echo Built build\Hamsohbat.exe and build\Hamsohbat-Setup.msi
exit /b 0

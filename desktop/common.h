// Shared by the desktop app and its installer.
#pragma once
#include <windows.h>
#include <shlobj.h>
#include <shlwapi.h>
#include <shobjidl.h>
#include <propkey.h>
#include <propvarutil.h>
#include <string>
#include "version.h"

#define APP_NAME L"Hamsohbat"
#define APP_NAME_FA L"\x0647\x0645\x0635\x062D\x0628\x062A"  // همصحبت
#define APP_ID L"Hamsohbat.Desktop"
#define WINDOW_CLASS L"HamsohbatMainWindow"
#define MUTEX_NAME L"Local\\Hamsohbat.SingleInstance"
#define UNINSTALL_KEY L"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Hamsohbat"
#define RUN_KEY L"Software\\Microsoft\\Windows\\CurrentVersion\\Run"

#define WM_APP_TRAY (WM_APP + 1)
#define WM_APP_QUIT (WM_APP + 2)
#define WM_APP_SHOW (WM_APP + 3)
#define WM_APP_PTT (WM_APP + 4)
#define WM_APP_POSTJSON (WM_APP + 5)
#define WM_APP_RUNSETUP (WM_APP + 6)

inline std::wstring KnownFolder(REFKNOWNFOLDERID id) {
  PWSTR p = nullptr;
  std::wstring out;
  if (SUCCEEDED(SHGetKnownFolderPath(id, KF_FLAG_CREATE, nullptr, &p))) out = p;
  CoTaskMemFree(p);
  return out;
}
inline std::wstring InstallDir() { return KnownFolder(FOLDERID_LocalAppData) + L"\\Programs\\Hamsohbat"; }
inline std::wstring DataDir() { return KnownFolder(FOLDERID_LocalAppData) + L"\\Hamsohbat"; }
inline std::wstring ConfigDir() { return KnownFolder(FOLDERID_RoamingAppData) + L"\\Hamsohbat"; }
inline std::wstring ConfigPath() { return ConfigDir() + L"\\config.ini"; }
inline std::wstring StartMenuShortcut() { return KnownFolder(FOLDERID_Programs) + L"\\Hamsohbat.lnk"; }
inline std::wstring DesktopShortcut() { return KnownFolder(FOLDERID_Desktop) + L"\\Hamsohbat.lnk"; }

inline std::wstring CfgGet(const wchar_t* key, const wchar_t* def = L"") {
  wchar_t buf[2048];
  GetPrivateProfileStringW(L"app", key, def, buf, 2048, ConfigPath().c_str());
  return buf;
}
inline void CfgSet(const wchar_t* key, const std::wstring& value) {
  CreateDirectoryW(ConfigDir().c_str(), nullptr);
  WritePrivateProfileStringW(L"app", key, value.c_str(), ConfigPath().c_str());
}

/** The app speaks Persian unless the user switched it to English (the web app reports its language). */
inline bool LangFa() { return CfgGet(L"Lang") != L"en"; }

inline bool CreateShortcut(const std::wstring& lnk, const std::wstring& target, const std::wstring& args) {
  IShellLinkW* link = nullptr;
  if (FAILED(CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&link)))) return false;
  link->SetPath(target.c_str());
  link->SetArguments(args.c_str());
  std::wstring dir = target.substr(0, target.find_last_of(L'\\'));
  link->SetWorkingDirectory(dir.c_str());
  link->SetIconLocation(target.c_str(), 0);
  link->SetDescription(L"Hamsohbat - chat, voice and video");
  // The AppUserModelID ties the shortcut, the taskbar button and notifications together.
  IPropertyStore* props = nullptr;
  if (SUCCEEDED(link->QueryInterface(IID_PPV_ARGS(&props)))) {
    PROPVARIANT pv;
    if (SUCCEEDED(InitPropVariantFromString(APP_ID, &pv))) {
      props->SetValue(PKEY_AppUserModel_ID, pv);
      props->Commit();
      PropVariantClear(&pv);
    }
    props->Release();
  }
  IPersistFile* file = nullptr;
  bool ok = false;
  if (SUCCEEDED(link->QueryInterface(IID_PPV_ARGS(&file)))) {
    ok = SUCCEEDED(file->Save(lnk.c_str(), TRUE));
    file->Release();
  }
  link->Release();
  return ok;
}

inline void SetRegString(HKEY root, const wchar_t* key, const wchar_t* name, const std::wstring& value) {
  HKEY h;
  if (RegCreateKeyExW(root, key, 0, nullptr, 0, KEY_SET_VALUE, nullptr, &h, nullptr) == ERROR_SUCCESS) {
    RegSetValueExW(h, name, 0, REG_SZ, (const BYTE*)value.c_str(), (DWORD)((value.size() + 1) * sizeof(wchar_t)));
    RegCloseKey(h);
  }
}
inline void SetRegDword(HKEY root, const wchar_t* key, const wchar_t* name, DWORD value) {
  HKEY h;
  if (RegCreateKeyExW(root, key, 0, nullptr, 0, KEY_SET_VALUE, nullptr, &h, nullptr) == ERROR_SUCCESS) {
    RegSetValueExW(h, name, 0, REG_DWORD, (const BYTE*)&value, sizeof(value));
    RegCloseKey(h);
  }
}
inline bool RegValueExists(HKEY root, const wchar_t* key, const wchar_t* name) {
  return RegGetValueW(root, key, name, RRF_RT_ANY, nullptr, nullptr, nullptr) == ERROR_SUCCESS;
}

/** Asks a running copy of the app to quit and waits for it (forcing it after a few seconds). */
inline void CloseRunningApp(DWORD exceptPid = 0) {
  for (int round = 0; round < 3; round++) {
    HWND w = FindWindowW(WINDOW_CLASS, nullptr);
    if (!w) return;
    DWORD pid = 0;
    GetWindowThreadProcessId(w, &pid);
    if (pid == exceptPid) return;
    HANDLE proc = OpenProcess(SYNCHRONIZE | PROCESS_TERMINATE, FALSE, pid);
    PostMessageW(w, WM_APP_QUIT, 0, 0);
    if (proc) {
      if (WaitForSingleObject(proc, 5000) == WAIT_TIMEOUT) TerminateProcess(proc, 0);
      WaitForSingleObject(proc, 2000);
      CloseHandle(proc);
    } else
      Sleep(1500);
  }
}

inline void ShowMessage(HWND owner, const std::wstring& text, UINT flags) {
  UINT rtl = LangFa() ? (MB_RTLREADING | MB_RIGHT) : 0;
  MessageBoxW(owner, text.c_str(), LangFa() ? APP_NAME_FA : APP_NAME, flags | rtl);
}

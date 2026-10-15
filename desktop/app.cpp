// Hamsohbat for Windows: a small native shell around WebView2 (the Edge engine that ships with Windows).
// Adds what a browser tab cannot do: tray icon, start with Windows, global mute/deafen/push-to-talk,
// taskbar unread badge, single instance and an updater.
#include "common.h"
#include <wrl.h>
#include <shellapi.h>
#include <dwmapi.h>
#include <winhttp.h>
#include <bcrypt.h>
#include <vector>
#include <commctrl.h>
#include <thread>
#include <atomic>
#include "WebView2.h"
#include "WebView2EnvironmentOptions.h"
#include <map>
#include <windowsx.h>

using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;

static HINSTANCE g_inst;
static HWND g_hwnd;
static ComPtr<ICoreWebView2Environment> g_env;
static ComPtr<ICoreWebView2Controller> g_ctrl;
static ComPtr<ICoreWebView2> g_wv;
static std::wstring g_server;
static bool g_quitting = false;
static bool g_devtools = false;
static NOTIFYICONDATAW g_nid = {};
static UINT g_msgTaskbarCreated;
static int g_badge = 0;
static HICON g_iconBig, g_iconSmall, g_dotIcon;
static ComPtr<ITaskbarList3> g_taskbar;
static UINT g_pttVk = 0;
static bool g_pttDown = false;
static std::atomic<bool> g_updateBusy{false};
static std::wstring g_lastUpdateJson;  // last update status, replayed to the page after a reload
static std::wstring g_updUrl, g_updSha, g_updVersion;
static bool g_fullscreen = false;

// ------------------------------------------------------------------ bundled user interface
// The whole interface ships inside this exe (resource 200, built by scripts/release.mjs), so the app
// opens instantly and works like an installed program. Only data (/api, /ws) goes to the server.
struct PackFile {
  const BYTE* data;
  DWORD size;
  std::wstring mime;
};
static std::map<std::wstring, PackFile> g_pack;
static std::wstring g_filterOrigin;

static void LoadUiPack() {
  HRSRC res = FindResourceW(nullptr, MAKEINTRESOURCEW(200), RT_RCDATA);
  if (!res) return;
  const BYTE* base = (const BYTE*)LockResource(LoadResource(nullptr, res));
  DWORD total = SizeofResource(nullptr, res);
  if (!base || total < 8 || memcmp(base, "HSPK", 4) != 0) return;
  DWORD count = *(const DWORD*)(base + 4), pos = 8;
  auto str = [&](WORD len) {
    std::string u((const char*)base + pos, len);
    pos += len;
    int n = MultiByteToWideChar(CP_UTF8, 0, u.data(), (int)u.size(), nullptr, 0);
    std::wstring w(n, 0);
    MultiByteToWideChar(CP_UTF8, 0, u.data(), (int)u.size(), &w[0], n);
    return w;
  };
  for (DWORD i = 0; i < count && pos < total; i++) {
    WORD pl = *(const WORD*)(base + pos);
    pos += 2;
    std::wstring path = str(pl);
    WORD ml = *(const WORD*)(base + pos);
    pos += 2;
    std::wstring mime = str(ml);
    DWORD off = *(const DWORD*)(base + pos), size = *(const DWORD*)(base + pos + 4);
    pos += 8;
    if (off + size <= total) g_pack[path] = {base + off, size, mime};
  }
}
static WINDOWPLACEMENT g_beforeFullscreen = {sizeof(WINDOWPLACEMENT)};

static std::wstring T(const wchar_t* en, const wchar_t* fa) { return LangFa() ? fa : en; }

// ------------------------------------------------------------------ small JSON helpers
static std::wstring JsonEscape(const std::wstring& s) {
  std::wstring o;
  for (wchar_t c : s) {
    if (c == L'"' || c == L'\\') o += L'\\', o += c;
    else if (c == L'\n') o += L"\\n";
    else if (c == L'\r') o += L"\\r";
    else if (c == L'\t') o += L"\\t";
    else if (c < 0x20) {
      wchar_t b[8];
      swprintf_s(b, L"\\u%04x", c);
      o += b;
    } else o += c;
  }
  return o;
}
/** Reads one value of a flat JSON object: strings are unescaped, other values are returned raw. */
static std::wstring JsonGet(const std::wstring& j, const std::wstring& key) {
  std::wstring pat = L"\"" + key + L"\"";
  size_t p = 0;
  while ((p = j.find(pat, p)) != std::wstring::npos) {
    size_t q = p + pat.size();
    while (q < j.size() && iswspace(j[q])) q++;
    if (q < j.size() && j[q] == L':') {
      q++;
      while (q < j.size() && iswspace(j[q])) q++;
      if (q >= j.size()) return L"";
      if (j[q] == L'"') {
        std::wstring out;
        for (q++; q < j.size() && j[q] != L'"'; q++) {
          if (j[q] == L'\\' && q + 1 < j.size()) {
            wchar_t e = j[++q];
            if (e == L'n') out += L'\n';
            else if (e == L't') out += L'\t';
            else if (e == L'r') out += L'\r';
            else if (e == L'u' && q + 4 < j.size()) {
              out += (wchar_t)wcstol(j.substr(q + 1, 4).c_str(), nullptr, 16);
              q += 4;
            } else out += e;
          } else out += j[q];
        }
        return out;
      }
      size_t e = q;
      while (e < j.size() && j[e] != L',' && j[e] != L'}') e++;
      std::wstring v = j.substr(q, e - q);
      while (!v.empty() && iswspace(v.back())) v.pop_back();
      return v;
    }
    p = q;
  }
  return L"";
}
/** Returns the raw text of a nested object value ("notes": {...}). */
static std::wstring JsonGetObject(const std::wstring& j, const std::wstring& key) {
  size_t p = j.find(L"\"" + key + L"\"");
  if (p == std::wstring::npos) return L"";
  size_t s = j.find(L'{', p);
  if (s == std::wstring::npos) return L"";
  int depth = 0;
  bool inStr = false;
  for (size_t i = s; i < j.size(); i++) {
    wchar_t c = j[i];
    if (inStr) {
      if (c == L'\\') i++;
      else if (c == L'"') inStr = false;
    } else if (c == L'"') inStr = true;
    else if (c == L'{') depth++;
    else if (c == L'}' && --depth == 0) return j.substr(s, i - s + 1);
  }
  return L"";
}
static std::wstring Utf8ToWide(const std::string& s) {
  if (s.empty()) return L"";
  int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
  std::wstring w(n, 0);
  MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), &w[0], n);
  return w;
}

static void PostJson(const std::wstring& json) {
  if (g_wv) g_wv->PostWebMessageAsJson(json.c_str());
}
/** Safe from any thread: the JSON is delivered on the UI thread. */
static void PostJsonFromThread(const std::wstring& json) { PostMessageW(g_hwnd, WM_APP_POSTJSON, 0, (LPARAM) new std::wstring(json)); }

// ------------------------------------------------------------------ settings
static bool AutostartEnabled() { return RegValueExists(HKEY_CURRENT_USER, RUN_KEY, L"Hamsohbat"); }
static void SetAutostart(bool on) {
  if (on) {
    wchar_t exe[MAX_PATH];
    GetModuleFileNameW(nullptr, exe, MAX_PATH);
    SetRegString(HKEY_CURRENT_USER, RUN_KEY, L"Hamsohbat", L"\"" + std::wstring(exe) + L"\" --minimized");
  } else {
    HKEY h;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, RUN_KEY, 0, KEY_SET_VALUE, &h) == ERROR_SUCCESS) {
      RegDeleteValueW(h, L"Hamsohbat");
      RegCloseKey(h);
    }
  }
}
static bool CloseToTray() { return CfgGet(L"CloseToTray", L"1") != L"0"; }

static void PostInfo() {
  PostJson(L"{\"type\":\"info\",\"version\":\"" APP_VERSION_W L"\",\"autostart\":" + std::wstring(AutostartEnabled() ? L"true" : L"false") +
           L",\"closeToTray\":" + (CloseToTray() ? L"true" : L"false") + L",\"server\":\"" + JsonEscape(g_server) + L"\"}");
}

static std::wstring OriginOf(const std::wstring& url) {
  size_t s = url.find(L"://");
  if (s == std::wstring::npos) return L"";
  size_t e = url.find_first_of(L"/?#", s + 3);
  std::wstring o = url.substr(0, e);
  for (auto& c : o) c = towlower(c);
  return o;
}
static bool SameOrigin(const std::wstring& url) { return OriginOf(url) == OriginOf(g_server); }
static void OpenExternal(const std::wstring& url) {
  if (url.rfind(L"http://", 0) == 0 || url.rfind(L"https://", 0) == 0 || url.rfind(L"mailto:", 0) == 0)
    ShellExecuteW(nullptr, L"open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
}

// ------------------------------------------------------------------ window helpers
static void ShowMain() {
  if (IsIconic(g_hwnd)) ShowWindow(g_hwnd, SW_RESTORE);
  else ShowWindow(g_hwnd, SW_SHOW);
  SetForegroundWindow(g_hwnd);
  if (g_ctrl) g_ctrl->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
}
static void SavePlacement() {
  if (g_fullscreen) return;
  WINDOWPLACEMENT wp = {sizeof(wp)};
  if (!GetWindowPlacement(g_hwnd, &wp)) return;
  RECT r = wp.rcNormalPosition;
  wchar_t buf[128];
  swprintf_s(buf, L"%d,%d,%d,%d,%d", r.left, r.top, r.right - r.left, r.bottom - r.top, wp.showCmd == SW_SHOWMAXIMIZED ? 1 : 0);
  CfgSet(L"Window", buf);
}
// The window draws its own Discord-style title bar (in the page); the standard caption is removed in
// WM_NCCALCSIZE. A thin strip above the page stays ours so the top edge can still be dragged to resize.
static int TopGrip() { return IsZoomed(g_hwnd) || g_fullscreen ? 0 : MulDiv(3, GetDpiForWindow(g_hwnd), 96); }
static void ResizeWebView() {
  if (!g_ctrl) return;
  RECT r;
  GetClientRect(g_hwnd, &r);
  r.top += TopGrip();
  g_ctrl->put_Bounds(r);
}
static void PostWindowState() {
  PostJson(std::wstring(L"{\"type\":\"window\",\"maximized\":") + (IsZoomed(g_hwnd) ? L"true" : L"false") + L",\"fullscreen\":" + (g_fullscreen ? L"true" : L"false") + L"}");
}
static void SetFullscreen(bool on) {
  if (on == g_fullscreen) return;
  LONG style = GetWindowLongW(g_hwnd, GWL_STYLE);
  if (on) {
    GetWindowPlacement(g_hwnd, &g_beforeFullscreen);
    MONITORINFO mi = {sizeof(mi)};
    GetMonitorInfoW(MonitorFromWindow(g_hwnd, MONITOR_DEFAULTTONEAREST), &mi);
    SetWindowLongW(g_hwnd, GWL_STYLE, style & ~WS_OVERLAPPEDWINDOW);
    SetWindowPos(g_hwnd, HWND_TOP, mi.rcMonitor.left, mi.rcMonitor.top, mi.rcMonitor.right - mi.rcMonitor.left, mi.rcMonitor.bottom - mi.rcMonitor.top,
                 SWP_NOOWNERZORDER | SWP_FRAMECHANGED);
  } else {
    SetWindowLongW(g_hwnd, GWL_STYLE, style | WS_OVERLAPPEDWINDOW);
    SetWindowPlacement(g_hwnd, &g_beforeFullscreen);
    SetWindowPos(g_hwnd, nullptr, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_FRAMECHANGED);
  }
  g_fullscreen = on;
}

// ------------------------------------------------------------------ tray + badge
static void TrayTip() {
  std::wstring tip = LangFa() ? APP_NAME_FA : APP_NAME;
  if (g_badge > 0) tip += L" (" + std::to_wstring(g_badge) + L")";
  wcsncpy_s(g_nid.szTip, tip.c_str(), _TRUNCATE);
}
static void TrayAdd() {
  g_nid = {sizeof(g_nid)};
  g_nid.hWnd = g_hwnd;
  g_nid.uID = 1;
  g_nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
  g_nid.uCallbackMessage = WM_APP_TRAY;
  g_nid.hIcon = g_iconSmall;
  TrayTip();
  Shell_NotifyIconW(NIM_ADD, &g_nid);
}
static void TrayBalloon(const std::wstring& title, const std::wstring& text) {
  g_nid.uFlags = NIF_INFO;
  wcsncpy_s(g_nid.szInfoTitle, title.c_str(), _TRUNCATE);
  wcsncpy_s(g_nid.szInfo, text.c_str(), _TRUNCATE);
  g_nid.dwInfoFlags = NIIF_USER | NIIF_LARGE_ICON;
  g_nid.hBalloonIcon = g_iconBig;
  Shell_NotifyIconW(NIM_MODIFY, &g_nid);
  g_nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
}
/** A small anti-aliased red dot, used as the taskbar overlay when something is unread. */
static HICON MakeDotIcon() {
  const int S = 16;
  BITMAPV5HEADER bi = {sizeof(bi)};
  bi.bV5Width = S;
  bi.bV5Height = -S;
  bi.bV5Planes = 1;
  bi.bV5BitCount = 32;
  bi.bV5Compression = BI_BITFIELDS;
  bi.bV5RedMask = 0x00FF0000;
  bi.bV5GreenMask = 0x0000FF00;
  bi.bV5BlueMask = 0x000000FF;
  bi.bV5AlphaMask = 0xFF000000;
  void* bits = nullptr;
  HDC dc = GetDC(nullptr);
  HBITMAP color = CreateDIBSection(dc, (BITMAPINFO*)&bi, DIB_RGB_COLORS, &bits, nullptr, 0);
  ReleaseDC(nullptr, dc);
  DWORD* px = (DWORD*)bits;
  for (int y = 0; y < S; y++)
    for (int x = 0; x < S; x++) {
      double dx = x + 0.5 - S / 2.0, dy = y + 0.5 - S / 2.0, d = sqrt(dx * dx + dy * dy);
      double a = d < 6.5 ? 1 : d < 7.5 ? 7.5 - d : 0;  // red disc
      double ring = d >= 6.5 && d < 8 ? 1 : 0;         // white rim
      BYTE A = (BYTE)(255 * (a > 0 ? 1 : ring));
      BYTE r = a > 0 ? 0xED : 0xFF, g = a > 0 ? 0x42 : 0xFF, b = a > 0 ? 0x45 : 0xFF;
      px[y * S + x] = A ? ((DWORD)A << 24) | ((DWORD)(r * A / 255) << 16) | ((DWORD)(g * A / 255) << 8) | (DWORD)(b * A / 255) : 0;
    }
  HBITMAP mask = CreateBitmap(S, S, 1, 1, nullptr);
  ICONINFO ii = {TRUE, 0, 0, mask, color};
  HICON icon = CreateIconIndirect(&ii);
  DeleteObject(color);
  DeleteObject(mask);
  return icon;
}
// Discord-style tray icon while in voice: a ring that fills up with your voice level.
static std::map<int, HICON> g_trayIcons;
static int g_trayKey = -1;
static HICON MakeVoiceIcon(int state, int level) {
  // state: 1 connected, 2 muted, 3 deafened; level 0..5 = how loud you are right now
  const int S = GetSystemMetrics(SM_CXSMICON) * 2;  // drawn at 2x; Windows scales it down smoothly
  BITMAPV5HEADER bi = {sizeof(bi)};
  bi.bV5Width = S;
  bi.bV5Height = -S;
  bi.bV5Planes = 1;
  bi.bV5BitCount = 32;
  bi.bV5Compression = BI_BITFIELDS;
  bi.bV5RedMask = 0x00FF0000;
  bi.bV5GreenMask = 0x0000FF00;
  bi.bV5BlueMask = 0x000000FF;
  bi.bV5AlphaMask = 0xFF000000;
  void* bits = nullptr;
  HDC dc = GetDC(nullptr);
  HBITMAP color = CreateDIBSection(dc, (BITMAPINFO*)&bi, DIB_RGB_COLORS, &bits, nullptr, 0);
  ReleaseDC(nullptr, dc);
  DWORD* px = (DWORD*)bits;
  double R = S / 2.0, ring = S * 0.11;
  int cr = 0x23, cg = 0xa5, cb = 0x59;              // connected: green
  if (state == 2) cr = 0x9a, cg = 0x9d, cb = 0xa3;  // muted: gray
  if (state == 3) cr = 0xf2, cg = 0x3f, cb = 0x43;  // deafened: red
  double maxFill = R - ring * 1.6;
  double fill = state == 1 ? (0.3 + 0.7 * level / 5.0) * maxFill : maxFill * 0.3;
  auto cov = [](double edge, double dd) { return dd <= edge - 0.5 ? 1.0 : dd >= edge + 0.5 ? 0.0 : edge + 0.5 - dd; };
  for (int y = 0; y < S; y++)
    for (int x = 0; x < S; x++) {
      double dx = x + 0.5 - R, dy = y + 0.5 - R, d = sqrt(dx * dx + dy * dy);
      double outer = cov(R - 0.5, d) * (1 - cov(R - 0.5 - ring, d));
      double inner = cov(fill, d);
      double a = outer > inner ? outer : inner;
      int r = cr, g = cg, b = cb;
      if (inner > outer && state == 1 && level > 0) r = 0xff, g = 0xff, b = 0xff;  // speaking: bright center
      if (state == 2 || state == 3) {
        double ds = fabs((dx - dy) / 1.41421356);
        double slash = d < R - ring ? cov(S * 0.07, ds) : 0;
        if (slash > a) a = slash, r = 0xf2, g = 0x3f, b = 0x43;
      }
      BYTE A = (BYTE)(255 * (a > 1 ? 1 : a));
      px[y * S + x] = ((DWORD)A << 24) | ((DWORD)(r * A / 255) << 16) | ((DWORD)(g * A / 255) << 8) | (DWORD)(b * A / 255);
    }
  HBITMAP mask = CreateBitmap(S, S, 1, 1, nullptr);
  ICONINFO ii = {TRUE, 0, 0, mask, color};
  HICON icon = CreateIconIndirect(&ii);
  DeleteObject(color);
  DeleteObject(mask);
  return icon;
}
/** state 0 = the normal app icon. */
static void SetTrayVoice(int state, int level) {
  int key = state * 10 + (state == 1 ? level : 0);
  if (key == g_trayKey) return;
  g_trayKey = key;
  HICON icon = g_iconSmall;
  if (state) {
    auto it = g_trayIcons.find(key);
    if (it == g_trayIcons.end()) it = g_trayIcons.emplace(key, MakeVoiceIcon(state, level)).first;
    icon = it->second;
  }
  g_nid.hIcon = icon;
  g_nid.uFlags = NIF_ICON;
  Shell_NotifyIconW(NIM_MODIFY, &g_nid);
  g_nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
}

static void SetBadge(int n) {
  if (n > g_badge && GetForegroundWindow() != g_hwnd) {
    FLASHWINFO fi = {sizeof(fi), g_hwnd, FLASHW_TRAY | FLASHW_TIMERNOFG, 3, 0};
    FlashWindowEx(&fi);
  }
  g_badge = n;
  if (g_taskbar) g_taskbar->SetOverlayIcon(g_hwnd, n ? g_dotIcon : nullptr, n ? L"Unread" : L"");
  TrayTip();
  g_nid.uFlags = NIF_TIP;
  Shell_NotifyIconW(NIM_MODIFY, &g_nid);
  g_nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
}

// ------------------------------------------------------------------ global push-to-talk
static UINT VkFromCode(const std::wstring& c) {
  if (c.size() == 4 && c.rfind(L"Key", 0) == 0) return c[3];
  if (c.size() == 6 && c.rfind(L"Digit", 0) == 0) return c[5];
  if (c.size() >= 2 && c[0] == L'F' && iswdigit(c[1])) return VK_F1 + _wtoi(c.c_str() + 1) - 1;
  if (c.rfind(L"Numpad", 0) == 0 && c.size() == 7 && iswdigit(c[6])) return VK_NUMPAD0 + (c[6] - L'0');
  static const struct { const wchar_t* code; UINT vk; } map[] = {
      {L"Backquote", VK_OEM_3}, {L"Minus", VK_OEM_MINUS}, {L"Equal", VK_OEM_PLUS}, {L"BracketLeft", VK_OEM_4}, {L"BracketRight", VK_OEM_6},
      {L"Backslash", VK_OEM_5}, {L"Semicolon", VK_OEM_1}, {L"Quote", VK_OEM_7}, {L"Comma", VK_OEM_COMMA}, {L"Period", VK_OEM_PERIOD},
      {L"Slash", VK_OEM_2}, {L"Space", VK_SPACE}, {L"Tab", VK_TAB}, {L"CapsLock", VK_CAPITAL}, {L"ShiftLeft", VK_LSHIFT},
      {L"ShiftRight", VK_RSHIFT}, {L"ControlLeft", VK_LCONTROL}, {L"ControlRight", VK_RCONTROL}, {L"AltLeft", VK_LMENU},
      {L"AltRight", VK_RMENU}, {L"Insert", VK_INSERT}, {L"Delete", VK_DELETE}, {L"Home", VK_HOME}, {L"End", VK_END},
      {L"PageUp", VK_PRIOR}, {L"PageDown", VK_NEXT}, {L"ArrowUp", VK_UP}, {L"ArrowDown", VK_DOWN}, {L"ArrowLeft", VK_LEFT},
      {L"ArrowRight", VK_RIGHT}, {L"Pause", VK_PAUSE}, {L"ScrollLock", VK_SCROLL}, {L"NumpadAdd", VK_ADD}, {L"NumpadSubtract", VK_SUBTRACT},
      {L"NumpadMultiply", VK_MULTIPLY}, {L"NumpadDivide", VK_DIVIDE}, {L"NumpadDecimal", VK_DECIMAL}, {L"ContextMenu", VK_APPS},
  };
  for (auto& m : map)
    if (c == m.code) return m.vk;
  return 0;
}
/** Push-to-talk outside the window: checks the chosen key's state ~40 times a second. */
static void CALLBACK PttPoll(HWND h, UINT, UINT_PTR, DWORD) {
  if (!g_pttVk) return;
  bool down = (GetAsyncKeyState(g_pttVk) & 0x8000) != 0;
  PostMessageW(h, WM_APP_PTT, down ? 1 : 0, 0);
}
static void SetPtt(const std::wstring& codeName, bool enabled) {
  g_pttVk = enabled ? VkFromCode(codeName) : 0;
  if (g_pttVk) SetTimer(g_hwnd, 7, 25, PttPoll);
  else {
    KillTimer(g_hwnd, 7);
    if (g_pttDown) PostMessageW(g_hwnd, WM_APP_PTT, 0, 0);
  }
}

// ------------------------------------------------------------------ Proxy + Discord window (experimental)
// hs-proxy.exe is the open-source Mihomo (Clash.Meta) core, the same engine FlClash uses. The page writes its
// config (subscription link, local ports) and controls it over its REST API on 127.0.0.1. Discord opens in its own
// window whose WebView2 uses that local proxy only; the rest of Hamsohbat never goes through it.
static HANDLE g_proxyProc = nullptr;
static ICoreWebView2Controller* g_dcCtrl = nullptr;

static void ProxyStop() {
  if (g_proxyProc) {
    TerminateProcess(g_proxyProc, 0);
    CloseHandle(g_proxyProc);
    g_proxyProc = nullptr;
  }
}

static void ProxyStart(const std::wstring& yaml) {
  ProxyStop();
  wchar_t exe[MAX_PATH];
  GetModuleFileNameW(nullptr, exe, MAX_PATH);
  std::wstring path = exe;
  path = path.substr(0, path.find_last_of(L'\\') + 1) + L"hs-proxy.exe";
  if (GetFileAttributesW(path.c_str()) == INVALID_FILE_ATTRIBUTES) {
    PostJson(L"{\"type\":\"proxy\",\"state\":\"error\",\"message\":\"hs-proxy.exe is missing\"}");
    return;
  }
  std::wstring dir = DataDir() + L"\\proxy";
  CreateDirectoryW(DataDir().c_str(), nullptr);
  CreateDirectoryW(dir.c_str(), nullptr);
  int n = WideCharToMultiByte(CP_UTF8, 0, yaml.c_str(), (int)yaml.size(), nullptr, 0, nullptr, nullptr);
  std::string utf8(n, 0);
  WideCharToMultiByte(CP_UTF8, 0, yaml.c_str(), (int)yaml.size(), &utf8[0], n, nullptr, nullptr);
  HANDLE f = CreateFileW((dir + L"\\config.yaml").c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (f == INVALID_HANDLE_VALUE) {
    PostJson(L"{\"type\":\"proxy\",\"state\":\"error\",\"message\":\"cannot write config\"}");
    return;
  }
  DWORD w;
  WriteFile(f, utf8.data(), (DWORD)utf8.size(), &w, nullptr);
  CloseHandle(f);
  STARTUPINFOW si = {sizeof(si)};
  PROCESS_INFORMATION pi;
  std::wstring cmd = L"\"" + path + L"\" -d \"" + dir + L"\"";
  if (CreateProcessW(path.c_str(), &cmd[0], nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, dir.c_str(), &si, &pi)) {
    CloseHandle(pi.hThread);
    g_proxyProc = pi.hProcess;
    // The core must never outlive the app (a crash would leave it holding its ports).
    static HANDLE job = nullptr;
    if (!job) {
      job = CreateJobObjectW(nullptr, nullptr);
      JOBOBJECT_EXTENDED_LIMIT_INFORMATION li = {};
      li.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      SetInformationJobObject(job, JobObjectExtendedLimitInformation, &li, sizeof(li));
    }
    if (job) AssignProcessToJobObject(job, pi.hProcess);
    PostJson(L"{\"type\":\"proxy\",\"state\":\"started\"}");
  } else
    PostJson(L"{\"type\":\"proxy\",\"state\":\"error\",\"message\":\"cannot start hs-proxy.exe\"}");
}

// Discord lives inside the main window: a second WebView2 (own profile, proxied) is placed over the area the page
// reserves for it and hidden whenever that page is not shown.
static bool g_dcCreating = false;
static RECT g_dcRect = {0, 0, 0, 0};
static bool g_dcVisible = false;

static void DiscordApplyBounds() {
  if (!g_dcCtrl) return;
  g_dcCtrl->put_IsVisible(g_dcVisible && g_dcRect.right > g_dcRect.left && g_dcRect.bottom > g_dcRect.top);
  RECT r = g_dcRect;  // the page starts TopGrip() below the window's top edge
  r.top += TopGrip();
  r.bottom += TopGrip();
  g_dcCtrl->put_Bounds(r);
}

/** x/y/w/h are in device pixels relative to the window's client area. */
static void DiscordShow(int port, int x, int y, int w, int h, bool visible) {
  g_dcRect = {x, y, x + w, y + h};
  g_dcVisible = visible;
  if (g_dcCtrl) {
    DiscordApplyBounds();
    return;
  }
  if (!visible || g_dcCreating) return;
  g_dcCreating = true;
  auto opts = Microsoft::WRL::Make<CoreWebView2EnvironmentOptions>();
  std::wstring args = L"--proxy-server=http://127.0.0.1:" + std::to_wstring(port) + L" --autoplay-policy=no-user-gesture-required";
  opts->put_AdditionalBrowserArguments(args.c_str());
  std::wstring data = DataDir() + L"\\DiscordWebView2";
  CreateCoreWebView2EnvironmentWithOptions(
      nullptr, data.c_str(), opts.Get(),
      Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>([](HRESULT hr, ICoreWebView2Environment* env) -> HRESULT {
        if (FAILED(hr) || !env) {
          g_dcCreating = false;
          return S_OK;
        }
        env->CreateCoreWebView2Controller(g_hwnd, Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>([](HRESULT hr, ICoreWebView2Controller* c) -> HRESULT {
                                                g_dcCreating = false;
                                                if (FAILED(hr) || !c) return S_OK;
                                                g_dcCtrl = c;
                                                g_dcCtrl->AddRef();
                                                DiscordApplyBounds();
                                                ICoreWebView2* wv = nullptr;
                                                c->get_CoreWebView2(&wv);
                                                if (wv) {
                                                  wv->Navigate(L"https://discord.com/app");
                                                  wv->Release();
                                                }
                                                return S_OK;
                                              }).Get());
        return S_OK;
      }).Get());
}

static void DiscordReload() {
  if (!g_dcCtrl) return;
  ICoreWebView2* wv = nullptr;
  g_dcCtrl->get_CoreWebView2(&wv);
  if (wv) {
    wv->Navigate(L"https://discord.com/app");
    wv->Release();
  }
}

// ------------------------------------------------------------------ TeamSpeak bridge
// hs-teamspeak.exe (next to this exe) speaks the TeamSpeak 3 protocol. We relay JSON lines:
// page -> {type:"ts", payload:{cmd...}} -> bridge stdin; bridge stdout -> page {type:"ts", event:{...}}.
static HANDLE g_tsIn = nullptr, g_tsProc = nullptr;

static void TsStop() {
  if (g_tsIn) {
    DWORD w;
    const char* quit = "{\"cmd\":\"quit\"}\n";
    WriteFile(g_tsIn, quit, (DWORD)strlen(quit), &w, nullptr);
    CloseHandle(g_tsIn);
    g_tsIn = nullptr;
  }
  if (g_tsProc) {
    if (WaitForSingleObject(g_tsProc, 4000) == WAIT_TIMEOUT) TerminateProcess(g_tsProc, 0);
    CloseHandle(g_tsProc);
    g_tsProc = nullptr;
  }
}

static bool TsStart() {
  if (g_tsProc && WaitForSingleObject(g_tsProc, 0) == WAIT_TIMEOUT) return true;
  if (g_tsProc) TsStop();
  wchar_t exe[MAX_PATH];
  GetModuleFileNameW(nullptr, exe, MAX_PATH);
  std::wstring path = exe;
  path = path.substr(0, path.find_last_of(L'\\') + 1) + L"hs-teamspeak.exe";
  SECURITY_ATTRIBUTES sa = {sizeof(sa), nullptr, TRUE};
  HANDLE inR, inW, outR, outW;
  if (!CreatePipe(&inR, &inW, &sa, 0)) return false;
  if (!CreatePipe(&outR, &outW, &sa, 0)) {
    CloseHandle(inR);
    CloseHandle(inW);
    return false;
  }
  SetHandleInformation(inW, HANDLE_FLAG_INHERIT, 0);
  SetHandleInformation(outR, HANDLE_FLAG_INHERIT, 0);
  STARTUPINFOW si = {sizeof(si)};
  si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdInput = inR;
  si.hStdOutput = outW;
  si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  PROCESS_INFORMATION pi;
  std::wstring cmd = L"\"" + path + L"\"";
  BOOL ok = CreateProcessW(path.c_str(), &cmd[0], nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi);
  CloseHandle(inR);
  CloseHandle(outW);
  if (!ok) {
    CloseHandle(inW);
    CloseHandle(outR);
    return false;
  }
  CloseHandle(pi.hThread);
  g_tsProc = pi.hProcess;
  g_tsIn = inW;
  std::thread([outR] {
    std::string buf;
    char chunk[4096];
    DWORD got;
    while (ReadFile(outR, chunk, sizeof(chunk), &got, nullptr) && got) {
      buf.append(chunk, got);
      size_t nl;
      while ((nl = buf.find('\n')) != std::string::npos) {
        std::string line = buf.substr(0, nl);
        buf.erase(0, nl + 1);
        if (!line.empty() && line[0] == '{') PostJsonFromThread(L"{\"type\":\"ts\",\"event\":" + Utf8ToWide(line) + L"}");
      }
    }
    CloseHandle(outR);
    PostJsonFromThread(L"{\"type\":\"ts\",\"event\":{\"type\":\"status\",\"state\":\"disconnected\",\"reason\":\"exited\"}}");
  }).detach();
  return true;
}

static void TsSend(const std::wstring& payload) {
  if (!TsStart()) {
    PostJson(L"{\"type\":\"ts\",\"event\":{\"type\":\"error\",\"message\":\"TeamSpeak support is missing (hs-teamspeak.exe not found)\"}}");
    return;
  }
  int n = WideCharToMultiByte(CP_UTF8, 0, payload.c_str(), (int)payload.size(), nullptr, 0, nullptr, nullptr);
  std::string u(n, 0);
  WideCharToMultiByte(CP_UTF8, 0, payload.c_str(), (int)payload.size(), &u[0], n, nullptr, nullptr);
  u += "\n";
  DWORD w;
  WriteFile(g_tsIn, u.data(), (DWORD)u.size(), &w, nullptr);
}

// ------------------------------------------------------------------ updater
static int CompareVersions(const std::wstring& a, const std::wstring& b) {
  int pa[4] = {0}, pb[4] = {0};
  swscanf_s(a.c_str(), L"%d.%d.%d.%d", &pa[0], &pa[1], &pa[2], &pa[3]);
  swscanf_s(b.c_str(), L"%d.%d.%d.%d", &pb[0], &pb[1], &pb[2], &pb[3]);
  for (int i = 0; i < 4; i++)
    if (pa[i] != pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

/** Downloads a URL into memory, or into a file when `file` is given (reporting progress). */
static bool HttpGet(const std::wstring& url, std::string* body, const std::wstring& file, std::wstring& error, void (*progress)(double) = nullptr) {
  URL_COMPONENTS uc = {sizeof(uc)};
  wchar_t host[256] = {}, path[2048] = {};
  uc.lpszHostName = host;
  uc.dwHostNameLength = 256;
  uc.lpszUrlPath = path;
  uc.dwUrlPathLength = 2048;
  wchar_t extra[1024] = {};
  uc.lpszExtraInfo = extra;
  uc.dwExtraInfoLength = 1024;
  if (!WinHttpCrackUrl(url.c_str(), 0, 0, &uc)) {
    error = L"Invalid address";
    return false;
  }
  HINTERNET s = WinHttpOpen(L"Hamsohbat/" APP_VERSION_W, WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, nullptr, nullptr, 0);
  if (!s) s = WinHttpOpen(L"Hamsohbat/" APP_VERSION_W, WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, nullptr, nullptr, 0);
  bool ok = false;
  HINTERNET c = nullptr, r = nullptr;
  HANDLE out = INVALID_HANDLE_VALUE;
  do {
    if (!s) break;
    WinHttpSetTimeouts(s, 10000, 10000, 20000, 60000);
    c = WinHttpConnect(s, host, uc.nPort, 0);
    if (!c) break;
    std::wstring target = std::wstring(path) + extra;
    r = WinHttpOpenRequest(c, L"GET", target.c_str(), nullptr, nullptr, nullptr, uc.nScheme == INTERNET_SCHEME_HTTPS ? WINHTTP_FLAG_SECURE : 0);
    if (!r) break;
    WinHttpAddRequestHeaders(r, L"Cache-Control: no-cache", (DWORD)-1, WINHTTP_ADDREQ_FLAG_ADD);
    if (!WinHttpSendRequest(r, nullptr, 0, nullptr, 0, 0, 0) || !WinHttpReceiveResponse(r, nullptr)) break;
    DWORD status = 0, len = sizeof(status);
    WinHttpQueryHeaders(r, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, nullptr, &status, &len, nullptr);
    if (status != 200) {
      error = L"HTTP " + std::to_wstring(status);
      break;
    }
    DWORD total = 0;
    len = sizeof(total);
    WinHttpQueryHeaders(r, WINHTTP_QUERY_CONTENT_LENGTH | WINHTTP_QUERY_FLAG_NUMBER, nullptr, &total, &len, nullptr);
    if (!file.empty()) {
      out = CreateFileW(file.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
      if (out == INVALID_HANDLE_VALUE) {
        error = L"Cannot write the download";
        break;
      }
    }
    std::vector<char> buf(64 * 1024);
    DWORD got = 0;
    unsigned long long done = 0;
    bool failed = false;
    for (;;) {
      if (!WinHttpReadData(r, buf.data(), (DWORD)buf.size(), &got)) {
        failed = true;
        break;
      }
      if (!got) break;
      done += got;
      if (body) body->append(buf.data(), got);
      if (out != INVALID_HANDLE_VALUE) {
        DWORD w;
        WriteFile(out, buf.data(), got, &w, nullptr);
      }
      if (progress && total) progress((double)done / total);
      if (body && body->size() > 1024 * 1024) break;  // the update manifest is tiny
    }
    ok = !failed;
  } while (false);
  if (!ok && error.empty()) error = L"Network error (" + std::to_wstring(GetLastError()) + L")";
  if (out != INVALID_HANDLE_VALUE) CloseHandle(out);
  if (r) WinHttpCloseHandle(r);
  if (c) WinHttpCloseHandle(c);
  if (s) WinHttpCloseHandle(s);
  return ok;
}

static std::wstring Sha256File(const std::wstring& file) {
  HANDLE f = CreateFileW(file.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr);
  if (f == INVALID_HANDLE_VALUE) return L"";
  BCRYPT_ALG_HANDLE alg = nullptr;
  BCRYPT_HASH_HANDLE h = nullptr;
  std::wstring hex;
  if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0) == 0 && BCryptCreateHash(alg, &h, nullptr, 0, nullptr, 0, 0) == 0) {
    std::vector<BYTE> buf(64 * 1024);
    DWORD got;
    while (ReadFile(f, buf.data(), (DWORD)buf.size(), &got, nullptr) && got) BCryptHashData(h, buf.data(), got, 0);
    BYTE digest[32];
    if (BCryptFinishHash(h, digest, 32, 0) == 0)
      for (BYTE b : digest) {
        wchar_t x[3];
        swprintf_s(x, L"%02x", b);
        hex += x;
      }
  }
  if (h) BCryptDestroyHash(h);
  if (alg) BCryptCloseAlgorithmProvider(alg, 0);
  CloseHandle(f);
  return hex;
}

static std::wstring ResolveUrl(const std::wstring& u) {
  if (u.rfind(L"http://", 0) == 0 || u.rfind(L"https://", 0) == 0) return u;
  return OriginOf(g_server) + (u.empty() || u[0] != L'/' ? L"/" : L"") + u;
}

static void SendUpdateStatus(const std::wstring& json) {
  g_lastUpdateJson = json;
  PostJson(json);
}

/** Looks for a newer version in <server>/downloads/latest.json (runs on a worker thread). */
static void CheckForUpdates(bool manual) {
  if (g_updateBusy.exchange(true)) return;
  std::wstring server = g_server;
  if (manual) PostJsonFromThread(L"{\"type\":\"update\",\"state\":\"checking\",\"manual\":true}");
  std::thread([manual, server] {
    std::string body;
    std::wstring err;
    std::wstring json;
    if (!HttpGet(OriginOf(server) + L"/downloads/latest.json", &body, L"", err)) {
      json = L"{\"type\":\"update\",\"state\":\"error\",\"error\":\"" + JsonEscape(err) + L"\",\"manual\":" + (manual ? L"true" : L"false") + L"}";
    } else {
      std::wstring j = Utf8ToWide(body);
      std::wstring v = JsonGet(j, L"version");
      if (v.empty()) json = L"{\"type\":\"update\",\"state\":\"error\",\"error\":\"Invalid update information\"}";
      else if (CompareVersions(v, APP_VERSION_W) > 0) {
        g_updVersion = v;
        std::wstring msi = JsonGet(j, L"msi");
        g_updUrl = ResolveUrl(msi.empty() ? JsonGet(j, L"url") : msi);
        g_updSha = JsonGet(j, L"sha256");
        std::wstring notes = JsonGetObject(j, L"notes");
        json = L"{\"type\":\"update\",\"state\":\"available\",\"version\":\"" + JsonEscape(v) + L"\",\"notes\":" + (notes.empty() ? L"null" : notes) +
               L",\"manual\":" + (manual ? L"true" : L"false") + L"}";
      } else
        json = L"{\"type\":\"update\",\"state\":\"none\",\"manual\":" + std::wstring(manual ? L"true" : L"false") + L"}";
    }
    CfgSet(L"LastUpdateCheck", std::to_wstring(GetTickCount64() / 1000) + L"@" + std::to_wstring(time(nullptr)));
    g_updateBusy = false;
    PostJsonFromThread(json);
  }).detach();
}

static void InstallUpdate() {
  if (g_updUrl.empty() || g_updateBusy.exchange(true)) return;
  std::wstring url = g_updUrl, sha = g_updSha, version = g_updVersion;
  std::thread([url, sha, version] {
    wchar_t tmp[MAX_PATH];
    GetTempPathW(MAX_PATH, tmp);
    std::wstring file = std::wstring(tmp) + L"Hamsohbat-" + version + L".msi";
    static ULONGLONG last = 0;
    std::wstring err;
    PostJsonFromThread(L"{\"type\":\"update\",\"state\":\"downloading\",\"version\":\"" + JsonEscape(version) + L"\",\"progress\":0}");
    auto progress = [](double p) {
      ULONGLONG now = GetTickCount64();
      if (now - last < 150 && p < 1) return;
      last = now;
      wchar_t b[160];
      swprintf_s(b, L"{\"type\":\"update\",\"state\":\"downloading\",\"progress\":%.3f}", p);
      PostJsonFromThread(b);
    };
    bool ok = HttpGet(url, nullptr, file, err, progress);
    if (ok && !sha.empty() && _wcsicmp(Sha256File(file).c_str(), sha.c_str()) != 0) {
      ok = false;
      err = L"The download is damaged (checksum mismatch). Please try again.";
      DeleteFileW(file.c_str());
    }
    g_updateBusy = false;
    if (!ok) {
      PostJsonFromThread(L"{\"type\":\"update\",\"state\":\"error\",\"error\":\"" + JsonEscape(err) + L"\"}");
      return;
    }
    PostJsonFromThread(L"{\"type\":\"update\",\"state\":\"installing\",\"version\":\"" + JsonEscape(version) + L"\"}");
    PostMessageW(g_hwnd, WM_APP_RUNSETUP, 0, (LPARAM) new std::wstring(file));
  }).detach();
}

// ------------------------------------------------------------------ pages shown by the shell itself
static std::wstring OfflinePage() {
  std::wstring fa = LangFa() ? L"1" : L"0";
  return LR"HTML(<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#1e1f22;color:#dbdee1;font-family:'Segoe UI',Tahoma,sans-serif}
.c{max-width:440px;padding:32px;background:#313338;border-radius:12px;text-align:center}
h1{font-size:20px;color:#fff;margin:12px 0 6px}p{color:#b5bac1;font-size:14px;line-height:1.6}
input{width:100%;box-sizing:border-box;padding:10px;border-radius:6px;border:0;background:#1e1f22;color:#fff;direction:ltr;margin:8px 0}
button{padding:10px 18px;border:0;border-radius:6px;background:#5865f2;color:#fff;font-size:14px;cursor:pointer;margin:4px}
button.s{background:#4e5058}.logo{width:64px;height:64px;border-radius:18px;background:#5865f2;display:inline-flex;align-items:center;justify-content:center;font-size:34px}
.tb{position:fixed;top:0;left:0;right:0;height:23px;display:flex;justify-content:space-between;align-items:center;app-region:drag;-webkit-app-region:drag;color:#949ba4;font-size:12px;font-weight:700;padding-left:10px}
.tb div{display:flex;height:100%;app-region:no-drag;-webkit-app-region:no-drag}.tb div button{margin:0;border-radius:0;background:none;color:#949ba4;width:34px;padding:0;font-size:14px}
.tb div button:hover{background:#35373c;color:#fff}.tb div button.x:hover{background:#da373c}
</style></head><body><div class="tb">Hamsohbat<div><button onclick="chrome.webview.postMessage({type:'window',action:'minimize'})">&#8211;</button><button onclick="chrome.webview.postMessage({type:'window',action:'maximize'})">&#9744;</button><button class="x" onclick="chrome.webview.postMessage({type:'window',action:'close'})">&#10005;</button></div></div><div class="c" id="c"><div class="logo">&#128172;</div>
<h1 id="t"></h1><p id="d"></p><button onclick="chrome.webview.postMessage({type:'retry'})" id="r"></button>
<p id="l" style="margin-top:20px"></p><input id="u"><button class="s" id="b" onclick="chrome.webview.postMessage({type:'setServer',url:document.getElementById('u').value})"></button></div>
<script>
var fa=)HTML" + fa + LR"HTML(,s=)HTML" + L"\"" + JsonEscape(g_server) + L"\"" + LR"HTML(;
var T=fa?{t:'اتصال به سرور برقرار نشد',d:'اینترنت یا فیلترشکن را بررسی کنید. اگر سرور گروه‌تان عوض شده، آدرس جدید را پایین وارد کنید.',r:'تلاش دوباره',l:'آدرس سرور',b:'اتصال'}
:{t:"Can't reach the server",d:'Check your internet connection or VPN. If your group moved to another server, enter its address below.',r:'Try Again',l:'Server address',b:'Connect'};
document.getElementById('c').dir=fa?'rtl':'ltr';for(var k in T)document.getElementById(k).textContent=T[k];document.getElementById('u').value=s;
setTimeout(function(){chrome.webview.postMessage({type:'retry',auto:true})},15000);
</script></body></html>)HTML";
}

static void Navigate() {
  if (!g_wv) return;
  // Serve the bundled interface under the current server's address.
  std::wstring origin = OriginOf(g_server);
  if (origin != g_filterOrigin) {
    if (!g_filterOrigin.empty()) g_wv->RemoveWebResourceRequestedFilter((g_filterOrigin + L"/*").c_str(), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
    g_wv->AddWebResourceRequestedFilter((origin + L"/*").c_str(), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
    g_filterOrigin = origin;
  }
  g_wv->Navigate((origin + L"/channels/@me").c_str());
}

// ------------------------------------------------------------------ presence: idle time and the game being played
// Discord shows "Playing X" for the game you are playing; we match the program in the foreground against a list of
// well-known games plus the ones the user adds in Activity Privacy. Only the matched name is sent to the page.
static const wchar_t* KNOWN_GAMES[][2] = {
    {L"valorant-win64-shipping.exe", L"VALORANT"}, {L"cs2.exe", L"Counter-Strike 2"}, {L"csgo.exe", L"Counter-Strike: Global Offensive"},
    {L"dota2.exe", L"Dota 2"}, {L"league of legends.exe", L"League of Legends"}, {L"fortniteclient-win64-shipping.exe", L"Fortnite"},
    {L"minecraft.windows.exe", L"Minecraft"}, {L"gta5.exe", L"Grand Theft Auto V"}, {L"gta5_enhanced.exe", L"Grand Theft Auto V"},
    {L"rocketleague.exe", L"Rocket League"}, {L"overwatch.exe", L"Overwatch 2"}, {L"r5apex.exe", L"Apex Legends"}, {L"r5apex_dx12.exe", L"Apex Legends"},
    {L"tslgame.exe", L"PUBG: BATTLEGROUNDS"}, {L"eldenring.exe", L"ELDEN RING"}, {L"witcher3.exe", L"The Witcher 3"},
    {L"modernwarfare.exe", L"Call of Duty"}, {L"cod.exe", L"Call of Duty"}, {L"blackops6.exe", L"Call of Duty: Black Ops 6"},
    {L"rainbowsix.exe", L"Tom Clancy's Rainbow Six Siege"}, {L"rainbowsix_vulkan.exe", L"Tom Clancy's Rainbow Six Siege"},
    {L"fc25.exe", L"EA SPORTS FC 25"}, {L"fc24.exe", L"EA SPORTS FC 24"}, {L"fifa23.exe", L"FIFA 23"}, {L"efootball.exe", L"eFootball"},
    {L"among us.exe", L"Among Us"}, {L"terraria.exe", L"Terraria"}, {L"rustclient.exe", L"Rust"}, {L"destiny2.exe", L"Destiny 2"},
    {L"robloxplayerbeta.exe", L"Roblox"}, {L"genshinimpact.exe", L"Genshin Impact"}, {L"cyberpunk2077.exe", L"Cyberpunk 2077"},
    {L"rdr2.exe", L"Red Dead Redemption 2"}, {L"bf2042.exe", L"Battlefield 2042"}, {L"deadbydaylight-win64-shipping.exe", L"Dead by Daylight"},
    {L"warframe.x64.exe", L"Warframe"}, {L"wow.exe", L"World of Warcraft"}, {L"hearthstone.exe", L"Hearthstone"},
    {L"palworld-win64-shipping.exe", L"Palworld"}, {L"helldivers2.exe", L"HELLDIVERS 2"}, {L"phasmophobia.exe", L"Phasmophobia"},
    {L"stardew valley.exe", L"Stardew Valley"}, {L"marvel-win64-shipping.exe", L"Marvel Rivals"}, {L"thefinals.exe", L"THE FINALS"},
    {L"pathofexile_x64.exe", L"Path of Exile"}, {L"pathofexile2.exe", L"Path of Exile 2"}, {L"sea of thieves.exe", L"Sea of Thieves"},
    {L"lethal company.exe", L"Lethal Company"}, {L"repo.exe", L"R.E.P.O."}, {L"forzahorizon5.exe", L"Forza Horizon 5"},
    {L"nba2k25.exe", L"NBA 2K25"}, {L"pes2021.exe", L"eFootball PES 2021"}, {L"clashofclans.exe", L"Clash of Clans"},
    {L"hl2.exe", L"Half-Life 2"}, {L"left4dead2.exe", L"Left 4 Dead 2"}, {L"tf_win64.exe", L"Team Fortress 2"},
    {L"starcraft ii.exe", L"StarCraft II"}, {L"diablo iv.exe", L"Diablo IV"}, {L"aoe2de_s.exe", L"Age of Empires II"},
    {L"ffxiv_dx11.exe", L"FINAL FANTASY XIV"}, {L"baldursgate3.exe", L"Baldur's Gate 3"}, {L"bg3.exe", L"Baldur's Gate 3"},
};
static std::map<std::wstring, std::wstring> g_customGames;
static std::wstring g_lastGame = L"-";

static HANDLE g_gameProc = nullptr;  // the game we saw last, kept while it keeps running
static std::wstring g_gameName;

static std::wstring GameNameFor(const std::wstring& path) {
  std::wstring exe = path.substr(path.find_last_of(L"\\/") + 1);
  for (auto& c : exe) c = towlower(c);
  auto custom = g_customGames.find(exe);
  if (custom != g_customGames.end()) return custom->second;
  for (auto& g : KNOWN_GAMES)
    if (exe == g[0]) return g[1];
  return L"";
}

/** Looks at the program in the foreground (like Discord, a game counts once you have played it in front). */
static std::wstring DetectGame() {
#ifdef HS_NO_GAMES
  return L"";
#endif
  if (g_gameProc && WaitForSingleObject(g_gameProc, 0) != WAIT_TIMEOUT) {
    CloseHandle(g_gameProc);
    g_gameProc = nullptr;
    g_gameName.clear();
  }
  HWND fg = GetForegroundWindow();
  DWORD pid = 0;
  if (fg) GetWindowThreadProcessId(fg, &pid);
  if (pid && pid != GetCurrentProcessId()) {
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid);
    if (h) {
      wchar_t path[MAX_PATH * 2];
      DWORD len = MAX_PATH * 2;
      std::wstring name = QueryFullProcessImageNameW(h, 0, path, &len) ? GameNameFor(path) : L"";
      if (!name.empty() && name != g_gameName) {
        if (g_gameProc) CloseHandle(g_gameProc);
        g_gameProc = h;
        g_gameName = name;
        h = nullptr;
      }
      if (h) CloseHandle(h);
    }
  }
  return g_gameName;
}

static void CALLBACK PresenceTick(HWND, UINT, UINT_PTR, DWORD) {
  LASTINPUTINFO li{};
  li.cbSize = sizeof(li);
  if (GetLastInputInfo(&li)) PostJson(L"{\"type\":\"sysidle\",\"seconds\":" + std::to_wstring((GetTickCount() - li.dwTime) / 1000) + L"}");
  std::wstring game = DetectGame();
  if (game != g_lastGame) {
    g_lastGame = game;
    PostJson(game.empty() ? std::wstring(L"{\"type\":\"game\",\"name\":null}") : L"{\"type\":\"game\",\"name\":\"" + JsonEscape(game) + L"\"}");
  }
}

static void HandleWebMessage(const std::wstring& json) {
  std::wstring type = JsonGet(json, L"type");
  if (type == L"hello") {
    std::wstring lang = JsonGet(json, L"lang");
    if (lang == L"fa" || lang == L"en") CfgSet(L"Lang", lang);
    PostInfo();
    PostWindowState();
    if (!g_lastUpdateJson.empty()) PostJson(g_lastUpdateJson);
    g_lastGame = L"-";  // the page was (re)loaded: tell it about the current game again
    PresenceTick(nullptr, 0, 0, 0);
  } else if (type == L"games") {
    // "exe=Name|exe=Name" from the user's own game list.
    g_customGames.clear();
    std::wstring list = JsonGet(json, L"list");
    size_t pos = 0;
    while (pos < list.size()) {
      size_t end = list.find(L'|', pos);
      if (end == std::wstring::npos) end = list.size();
      std::wstring item = list.substr(pos, end - pos);
      size_t eq = item.find(L'=');
      if (eq != std::wstring::npos && eq > 0) {
        std::wstring exe = item.substr(0, eq);
        for (auto& c : exe) c = towlower(c);
        g_customGames[exe] = item.substr(eq + 1);
      }
      pos = end + 1;
    }
    g_lastGame = L"-";
    if (g_gameProc) CloseHandle(g_gameProc);
    g_gameProc = nullptr;
    g_gameName.clear();
    PresenceTick(nullptr, 0, 0, 0);
  } else if (type == L"lang") {
    std::wstring lang = JsonGet(json, L"value");
    if (lang == L"fa" || lang == L"en") CfgSet(L"Lang", lang);
    TrayTip();
    g_nid.uFlags = NIF_TIP;
    Shell_NotifyIconW(NIM_MODIFY, &g_nid);
    g_nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
  } else if (type == L"ptt") {
    SetPtt(JsonGet(json, L"code"), JsonGet(json, L"enabled") == L"true");
  } else if (type == L"setOption") {
    std::wstring key = JsonGet(json, L"key");
    bool value = JsonGet(json, L"value") == L"true";
    if (key == L"autostart") SetAutostart(value);
    else if (key == L"closeToTray") CfgSet(L"CloseToTray", value ? L"1" : L"0");
    PostInfo();
  } else if (type == L"setServer") {
    std::wstring url = JsonGet(json, L"url");
    while (!url.empty() && (url.back() == L'/' || iswspace(url.back()))) url.pop_back();
    while (!url.empty() && iswspace(url.front())) url.erase(url.begin());
    if (url.find(L"://") == std::wstring::npos) url = L"https://" + url;
    if (url.rfind(L"http://", 0) == 0 || url.rfind(L"https://", 0) == 0) {
      g_server = url;
      CfgSet(L"Server", url);
      Navigate();
    }
  } else if (type == L"window") {
    std::wstring action = JsonGet(json, L"action");
    if (action == L"minimize") ShowWindow(g_hwnd, SW_MINIMIZE);
    else if (action == L"maximize") ShowWindow(g_hwnd, IsZoomed(g_hwnd) ? SW_RESTORE : SW_MAXIMIZE);
    else if (action == L"close") PostMessageW(g_hwnd, WM_CLOSE, 0, 0);
    else PostWindowState();
  } else if (type == L"retry") {
    Navigate();
  } else if (type == L"checkUpdate") {
    CheckForUpdates(true);
  } else if (type == L"ts") {
    std::wstring payload = JsonGetObject(json, L"payload");
    if (!payload.empty()) TsSend(payload);
  } else if (type == L"proxy") {
    std::wstring cmd = JsonGet(json, L"cmd");
    if (cmd == L"start") ProxyStart(JsonGet(json, L"yaml"));
    else if (cmd == L"stop") ProxyStop();
  } else if (type == L"discord") {
    std::wstring cmd = JsonGet(json, L"cmd");
    int port = _wtoi(JsonGet(json, L"port").c_str());
    if (cmd == L"reload") DiscordReload();
    else if (cmd == L"hide") DiscordShow(port > 0 ? port : 17890, 0, 0, 0, 0, false);
    else if (port > 0 && port < 65536)
      DiscordShow(port, _wtoi(JsonGet(json, L"x").c_str()), _wtoi(JsonGet(json, L"y").c_str()), _wtoi(JsonGet(json, L"w").c_str()),
                  _wtoi(JsonGet(json, L"h").c_str()), cmd == L"show");
  } else if (type == L"tray") {
    std::wstring st = JsonGet(json, L"state");
    int level = _wtoi(JsonGet(json, L"level").c_str());
    SetTrayVoice(st == L"voice" ? 1 : st == L"muted" ? 2 : st == L"deafened" ? 3 : 0, level < 0 ? 0 : level > 5 ? 5 : level);
  } else if (type == L"installUpdate") {
    InstallUpdate();
  }
}

// ------------------------------------------------------------------ WebView2 setup
static void NoRuntime() {
  if (MessageBoxW(g_hwnd,
                  T(L"Hamsohbat needs the Microsoft Edge WebView2 Runtime, which is missing on this PC.\n\nDownload it now from Microsoft?",
                    L"همصحبت به «Microsoft Edge WebView2 Runtime» نیاز دارد که روی این کامپیوتر نصب نیست.\n\nالان از سایت مایکروسافت دانلودش کنیم؟")
                      .c_str(),
                  LangFa() ? APP_NAME_FA : APP_NAME, MB_YESNO | MB_ICONWARNING | (LangFa() ? MB_RTLREADING | MB_RIGHT : 0)) == IDYES)
    OpenExternal(L"https://go.microsoft.com/fwlink/p/?LinkId=2124703");
  g_quitting = true;
  DestroyWindow(g_hwnd);
}

static void SetupWebView() {
  ComPtr<ICoreWebView2Settings> st;
  g_wv->get_Settings(&st);
  st->put_IsStatusBarEnabled(FALSE);
  st->put_AreDevToolsEnabled(g_devtools);
  st->put_IsZoomControlEnabled(TRUE);
  ComPtr<ICoreWebView2Settings3> st3;
  if (SUCCEEDED(st.As(&st3))) st3->put_AreBrowserAcceleratorKeysEnabled(g_devtools);  // no F5/F12/Ctrl+P etc.
  ComPtr<ICoreWebView2Settings5> st5;
  if (SUCCEEDED(st.As(&st5))) st5->put_IsPinchZoomEnabled(FALSE);
  ComPtr<ICoreWebView2Settings6> st6;
  if (SUCCEEDED(st.As(&st6))) st6->put_IsSwipeNavigationEnabled(FALSE);
  ComPtr<ICoreWebView2Settings9> st9;  // CSS app-region: drag works for our own title bar
  if (SUCCEEDED(st.As(&st9))) st9->put_IsNonClientRegionSupportEnabled(TRUE);
  ComPtr<ICoreWebView2Controller2> c2;
  if (SUCCEEDED(g_ctrl.As(&c2))) c2->put_DefaultBackgroundColor({255, 0x1e, 0x1f, 0x22});

  EventRegistrationToken tok;
  g_wv->add_WebResourceRequested(Callback<ICoreWebView2WebResourceRequestedEventHandler>([](ICoreWebView2*, ICoreWebView2WebResourceRequestedEventArgs* a) -> HRESULT {
                                   if (g_pack.empty()) return S_OK;
                                   ComPtr<ICoreWebView2WebResourceRequest> req;
                                   a->get_Request(&req);
                                   LPWSTR uri = nullptr;
                                   req->get_Uri(&uri);
                                   std::wstring u = uri ? uri : L"";
                                   CoTaskMemFree(uri);
                                   if (!SameOrigin(u)) return S_OK;
                                   size_t ps = u.find(L'/', u.find(L"://") + 3);
                                   std::wstring path = ps == std::wstring::npos ? L"/" : u.substr(ps);
                                   path = path.substr(0, path.find_first_of(L"?#"));
                                   // Data and downloads always come from the server.
                                   if (path.rfind(L"/api/", 0) == 0 || path == L"/ws" || path.rfind(L"/downloads/", 0) == 0) return S_OK;
                                   auto it = g_pack.find(path);
                                   if (it == g_pack.end()) {
                                     std::wstring last = path.substr(path.find_last_of(L'/') + 1);
                                     if (last.find(L'.') != std::wstring::npos) return S_OK;  // unknown file: let the server answer
                                     it = g_pack.find(L"/index.html");                       // an app route
                                     if (it == g_pack.end()) return S_OK;
                                   }
                                   ComPtr<IStream> stream;
                                   stream.Attach(SHCreateMemStream(it->second.data, it->second.size));
                                   std::wstring headers = L"Content-Type: " + it->second.mime + L"\r\nCache-Control: no-cache\r\nX-Hamsohbat-Bundled: 1";
                                   ComPtr<ICoreWebView2WebResourceResponse> resp;
                                   if (SUCCEEDED(g_env->CreateWebResourceResponse(stream.Get(), 200, L"OK", headers.c_str(), &resp))) a->put_Response(resp.Get());
                                   return S_OK;
                                 }).Get(),
                                 &tok);
  g_wv->add_PermissionRequested(Callback<ICoreWebView2PermissionRequestedEventHandler>([](ICoreWebView2*, ICoreWebView2PermissionRequestedEventArgs* a) -> HRESULT {
                                  LPWSTR uri = nullptr;
                                  a->get_Uri(&uri);
                                  COREWEBVIEW2_PERMISSION_KIND kind;
                                  a->get_PermissionKind(&kind);
                                  bool ours = uri && SameOrigin(uri);
                                  CoTaskMemFree(uri);
                                  if (ours && (kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE || kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA ||
                                               kind == COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS || kind == COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ ||
                                               kind == COREWEBVIEW2_PERMISSION_KIND_AUTOPLAY))
                                    a->put_State(COREWEBVIEW2_PERMISSION_STATE_ALLOW);
                                  return S_OK;
                                }).Get(),
                                &tok);
  g_wv->add_NewWindowRequested(Callback<ICoreWebView2NewWindowRequestedEventHandler>([](ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* a) -> HRESULT {
                                 LPWSTR uri = nullptr;
                                 a->get_Uri(&uri);
                                 if (uri) OpenExternal(uri);
                                 CoTaskMemFree(uri);
                                 a->put_Handled(TRUE);
                                 return S_OK;
                               }).Get(),
                               &tok);
  g_wv->add_NavigationStarting(Callback<ICoreWebView2NavigationStartingEventHandler>([](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* a) -> HRESULT {
                                 LPWSTR uri = nullptr;
                                 a->get_Uri(&uri);
                                 std::wstring u = uri ? uri : L"";
                                 CoTaskMemFree(uri);
                                 // Links to other sites open in the normal browser.
                                 if (!u.empty() && u.rfind(L"about:", 0) != 0 && u.rfind(L"data:", 0) != 0 && !SameOrigin(u)) {
                                   a->put_Cancel(TRUE);
                                   OpenExternal(u);
                                 }
                                 return S_OK;
                               }).Get(),
                               &tok);
  g_wv->add_NavigationCompleted(Callback<ICoreWebView2NavigationCompletedEventHandler>([](ICoreWebView2*, ICoreWebView2NavigationCompletedEventArgs* a) -> HRESULT {
                                  BOOL ok = TRUE;
                                  a->get_IsSuccess(&ok);
                                  COREWEBVIEW2_WEB_ERROR_STATUS status;
                                  a->get_WebErrorStatus(&status);
                                  if (!ok && status != COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED) g_wv->NavigateToString(OfflinePage().c_str());
                                  return S_OK;
                                }).Get(),
                                &tok);
  g_wv->add_DocumentTitleChanged(Callback<ICoreWebView2DocumentTitleChangedEventHandler>([](ICoreWebView2* w, IUnknown*) -> HRESULT {
                                   LPWSTR title = nullptr;
                                   w->get_DocumentTitle(&title);
                                   std::wstring t = title ? title : L"";
                                   CoTaskMemFree(title);
                                   if (t.empty() || t.rfind(L"data:", 0) == 0 || t.find(L"about:") == 0) return S_OK;
                                   SetWindowTextW(g_hwnd, t.c_str());
                                   int n = 0;
                                   if (t.size() > 2 && t[0] == L'(') n = _wtoi(t.c_str() + 1);
                                   if (n != g_badge) SetBadge(n);
                                   return S_OK;
                                 }).Get(),
                                 &tok);
  g_wv->add_ContainsFullScreenElementChanged(Callback<ICoreWebView2ContainsFullScreenElementChangedEventHandler>([](ICoreWebView2* w, IUnknown*) -> HRESULT {
                                               BOOL fs = FALSE;
                                               w->get_ContainsFullScreenElement(&fs);
                                               SetFullscreen(fs);
                                               return S_OK;
                                             }).Get(),
                                             &tok);
  g_wv->add_WebMessageReceived(Callback<ICoreWebView2WebMessageReceivedEventHandler>([](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* a) -> HRESULT {
                                 LPWSTR src = nullptr;
                                 a->get_Source(&src);
                                 std::wstring s = src ? src : L"";
                                 CoTaskMemFree(src);
                                 // Only our own site (or our offline page) may talk to the shell.
                                 if (!SameOrigin(s) && s.rfind(L"about:", 0) != 0 && s.rfind(L"data:", 0) != 0) return S_OK;
                                 LPWSTR json = nullptr;
                                 if (SUCCEEDED(a->get_WebMessageAsJson(&json)) && json) HandleWebMessage(json);
                                 CoTaskMemFree(json);
                                 return S_OK;
                               }).Get(),
                               &tok);
  ResizeWebView();
  Navigate();
}

static void InitWebView() {
  std::wstring data = DataDir() + L"\\WebView2";
  auto opts = Microsoft::WRL::Make<CoreWebView2EnvironmentOptions>();
  // Requests to Discord (import from a template, etc.) use the local VPN proxy while it runs; everything else goes direct.
  // PAC (base64): FindProxyForURL(u,h){ if (h=="discord.com"||dnsDomainIs(h,".discord.com")||dnsDomainIs(h,".discordapp.com")||dnsDomainIs(h,".discord.gg")||dnsDomainIs(h,".discordapp.net")) return "PROXY 127.0.0.1:17890; DIRECT"; return "DIRECT"; }
  opts->put_AdditionalBrowserArguments(
      L"--autoplay-policy=no-user-gesture-required --proxy-pac-url=data:application/x-ns-proxy-autoconfig;base64,"
      L"ZnVuY3Rpb24gRmluZFByb3h5Rm9yVVJMKHUsaCl7aWYoaD09ImRpc2NvcmQuY29tInx8ZG5zRG9tYWluSXMoaCwiLmRpc2NvcmQuY29tIil8fGRuc0RvbWFpbklzKGgsIi5kaXNjb3JkYXBwLmNvbSIpfHxkbnNEb21haW5JcyhoLCIuZGlzY29yZC5nZyIpfHxkbnNEb21haW5JcyhoLCIuZGlzY29yZGFwcC5uZXQiKSl7cmV0dXJuIlBST1hZIDEyNy4wLjAuMToxNzg5MDsgRElSRUNUIjt9cmV0dXJuIkRJUkVDVCI7fQ==");
  HRESULT hr = CreateCoreWebView2EnvironmentWithOptions(
      nullptr, data.c_str(), opts.Get(),
      Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>([](HRESULT hr, ICoreWebView2Environment* env) -> HRESULT {
        if (FAILED(hr) || !env) {
          NoRuntime();
          return S_OK;
        }
        g_env = env;
        env->CreateCoreWebView2Controller(g_hwnd, Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>([](HRESULT hr, ICoreWebView2Controller* c) -> HRESULT {
                                                     if (FAILED(hr) || !c) {
                                                       NoRuntime();
                                                       return S_OK;
                                                     }
                                                     g_ctrl = c;
                                                     g_ctrl->get_CoreWebView2(&g_wv);
                                                     SetupWebView();
                                                     return S_OK;
                                                   }).Get());
        return S_OK;
      }).Get());
  if (FAILED(hr)) NoRuntime();
}

// ------------------------------------------------------------------ window procedure
static void ShowTrayMenu() {
  HMENU m = CreatePopupMenu();
  bool fa = LangFa();
  UINT rtl = fa ? MFT_RIGHTORDER : 0;
  auto add = [&](UINT id, const std::wstring& text, UINT flags = 0) { AppendMenuW(m, MF_STRING | flags, id, text.c_str()); };
  add(1, T(L"Open Hamsohbat", L"باز کردن همصحبت"), MF_DEFAULT);
  add(2, T(L"Toggle Mute", L"قطع/وصل میکروفون"));
  add(3, T(L"Toggle Deafen", L"قطع/وصل صدا"));
  AppendMenuW(m, MF_SEPARATOR, 0, nullptr);
  add(4, T(L"Check for Updates", L"بررسی بروزرسانی"));
  add(5, T(L"Start with Windows", L"اجرا با ویندوز"), AutostartEnabled() ? MF_CHECKED : 0);
  AppendMenuW(m, MF_SEPARATOR, 0, nullptr);
  add(6, T(L"Quit Hamsohbat", L"خروج از همصحبت"));
  if (rtl) {
    MENUINFO mi = {sizeof(mi), MIM_STYLE};
    // Right-to-left order for Persian menus.
    for (int i = 0; i < GetMenuItemCount(m); i++) {
      MENUITEMINFOW ii = {sizeof(ii), MIIM_FTYPE};
      GetMenuItemInfoW(m, i, TRUE, &ii);
      ii.fType |= MFT_RIGHTORDER | MFT_RIGHTJUSTIFY;
      SetMenuItemInfoW(m, i, TRUE, &ii);
    }
    (void)mi;
  }
  POINT pt;
  GetCursorPos(&pt);
  SetForegroundWindow(g_hwnd);
  UINT cmd = TrackPopupMenu(m, TPM_RETURNCMD | TPM_RIGHTBUTTON | (fa ? TPM_LAYOUTRTL : 0), pt.x, pt.y, 0, g_hwnd, nullptr);
  DestroyMenu(m);
  switch (cmd) {
    case 1: ShowMain(); break;
    case 2: if (g_wv) g_wv->ExecuteScript(L"window.__toggleMute&&__toggleMute()", nullptr); break;
    case 3: if (g_wv) g_wv->ExecuteScript(L"window.__toggleDeafen&&__toggleDeafen()", nullptr); break;
    case 4:
      ShowMain();
      if (g_wv) g_wv->ExecuteScript(L"window.__openUpdates&&__openUpdates()", nullptr);
      CheckForUpdates(true);
      break;
    case 5: SetAutostart(!AutostartEnabled()); PostInfo(); break;
    case 6: g_quitting = true; DestroyWindow(g_hwnd); break;
  }
}

static LRESULT CALLBACK WndProc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
  if (msg == g_msgTaskbarCreated && msg) {
    TrayAdd();
    return 0;
  }
  switch (msg) {
    case WM_SIZE:
      ResizeWebView();
      if (wp == SIZE_MAXIMIZED || wp == SIZE_RESTORED) PostWindowState();
      return 0;
    case WM_NCCALCSIZE:
      if (wp && !g_fullscreen) {
        // Keep the invisible resize borders on the left, right and bottom; drop the caption.
        auto* p = (NCCALCSIZE_PARAMS*)lp;
        UINT dpi = GetDpiForWindow(h);
        int fx = GetSystemMetricsForDpi(SM_CXFRAME, dpi) + GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi);
        int fy = GetSystemMetricsForDpi(SM_CYFRAME, dpi) + GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi);
        p->rgrc[0].left += fx;
        p->rgrc[0].right -= fx;
        p->rgrc[0].bottom -= fy;
        if (IsZoomed(h)) p->rgrc[0].top += fy;  // a maximized window hangs over the screen edge
        return 0;
      }
      break;
    case WM_NCHITTEST: {
      LRESULT hit = DefWindowProcW(h, msg, wp, lp);
      if (hit != HTCLIENT || g_fullscreen || IsZoomed(h)) return hit;
      POINT pt = {GET_X_LPARAM(lp), GET_Y_LPARAM(lp)};
      ScreenToClient(h, &pt);
      RECT rc;
      GetClientRect(h, &rc);
      int grip = TopGrip() + 2;
      if (pt.y < grip) return pt.x < grip * 3 ? HTTOPLEFT : pt.x > rc.right - grip * 3 ? HTTOPRIGHT : HTTOP;
      return hit;
    }
    case WM_GETMINMAXINFO: {
      auto* mm = (MINMAXINFO*)lp;
      mm->ptMinTrackSize = {420, 480};
      return 0;
    }
    case WM_ACTIVATE:
      if (LOWORD(wp) != WA_INACTIVE && g_ctrl) g_ctrl->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
      break;
    case WM_MOVE:
      if (g_ctrl) g_ctrl->NotifyParentWindowPositionChanged();
      break;
    case WM_DPICHANGED: {
      RECT* r = (RECT*)lp;
      SetWindowPos(h, nullptr, r->left, r->top, r->right - r->left, r->bottom - r->top, SWP_NOZORDER | SWP_NOACTIVATE);
      return 0;
    }
    case WM_APP_TRAY:
      if (LOWORD(lp) == WM_LBUTTONUP || LOWORD(lp) == WM_LBUTTONDBLCLK) ShowMain();
      else if (LOWORD(lp) == WM_RBUTTONUP || LOWORD(lp) == WM_CONTEXTMENU) ShowTrayMenu();
      else if (LOWORD(lp) == NIN_BALLOONUSERCLICK) ShowMain();
      return 0;
    case WM_APP_SHOW:
      ShowMain();
      return 0;
    case WM_APP_QUIT:
      g_quitting = true;
      DestroyWindow(h);
      return 0;
    case WM_APP_PTT: {
      bool down = wp != 0;
      if (down != g_pttDown && g_wv) {
        g_pttDown = down;
        g_wv->ExecuteScript(down ? L"window.__ptt&&__ptt(true)" : L"window.__ptt&&__ptt(false)", nullptr);
      }
      return 0;
    }
    case WM_APP_POSTJSON: {
      auto* json = (std::wstring*)lp;
      std::wstring type = JsonGet(*json, L"type");
      if (type == L"update") {
        SendUpdateStatus(*json);
        // Startup checks tell people about updates even when the window is hidden.
        if (JsonGet(*json, L"state") == L"available" && JsonGet(*json, L"manual") != L"true" && !IsWindowVisible(h))
          TrayBalloon(T(L"Update available", L"بروزرسانی جدید"),
                      T(L"A new version of Hamsohbat is ready. Open the app to install it.", L"نسخه‌ی جدید همصحبت آماده است. برنامه را باز کنید تا نصب شود."));
      } else
        PostJson(*json);
      delete json;
      return 0;
    }
    case WM_APP_RUNSETUP: {
      auto* file = (std::wstring*)lp;
      // HAMSOHBAT_SETUP_EXTRA lets the automated tests pass extra installer properties.
      wchar_t extra[512] = {};
      GetEnvironmentVariableW(L"HAMSOHBAT_SETUP_EXTRA", extra, 512);
      std::wstring params = L"/i \"" + *file + L"\" /qb- /norestart " + extra;
      SHELLEXECUTEINFOW se = {sizeof(se)};
      se.lpVerb = L"open";
      se.lpFile = L"msiexec.exe";
      se.lpParameters = params.c_str();
      se.nShow = SW_SHOWNORMAL;
      if (ShellExecuteExW(&se)) {
        g_quitting = true;
        DestroyWindow(h);
      } else
        SendUpdateStatus(L"{\"type\":\"update\",\"state\":\"error\",\"error\":\"Could not start the installer\"}");
      delete file;
      return 0;
    }
    case WM_HOTKEY:
      if (g_wv) g_wv->ExecuteScript(wp == 1 ? L"window.__toggleMute&&__toggleMute()" : L"window.__toggleDeafen&&__toggleDeafen()", nullptr);
      return 0;
    case WM_CLOSE:
      if (!g_quitting && CloseToTray()) {
        SavePlacement();
        ShowWindow(h, SW_HIDE);
        if (CfgGet(L"TrayHintShown") != L"1") {
          CfgSet(L"TrayHintShown", L"1");
          TrayBalloon(LangFa() ? APP_NAME_FA : APP_NAME,
                      T(L"Hamsohbat is still running in the tray so friends can reach you. Right-click the icon to quit.",
                        L"همصحبت در کنار ساعت ویندوز باز می‌ماند تا دوستانتان بتوانند به شما زنگ بزنند. برای خروج روی آیکون راست‌کلیک کنید."));
        }
        return 0;
      }
      g_quitting = true;
      DestroyWindow(h);
      return 0;
    case WM_QUERYENDSESSION:
      g_quitting = true;
      return TRUE;
    case WM_DESTROY:
      TsStop();
      ProxyStop();
      for (auto& kv : g_trayIcons) DestroyIcon(kv.second);
      SavePlacement();
      Shell_NotifyIconW(NIM_DELETE, &g_nid);
      if (g_ctrl) g_ctrl->Close();
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcW(h, msg, wp, lp);
}

// ------------------------------------------------------------------ entry point
int WINAPI wWinMain(HINSTANCE inst, HINSTANCE, PWSTR cmdLine, int show) {
  g_inst = inst;
  std::wstring args = cmdLine ? cmdLine : L"";
  CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  SetCurrentProcessExplicitAppUserModelID(APP_ID);
  HANDLE mutex = CreateMutexW(nullptr, TRUE, MUTEX_NAME);
  if (GetLastError() == ERROR_ALREADY_EXISTS) {
    HWND other = FindWindowW(WINDOW_CLASS, nullptr);
    if (other) {
      DWORD pid = 0;
      GetWindowThreadProcessId(other, &pid);
      AllowSetForegroundWindow(pid);
      PostMessageW(other, WM_APP_SHOW, 0, 0);
    }
    return 0;
  }
  g_devtools = args.find(L"--devtools") != std::wstring::npos || CfgGet(L"DevTools") == L"1";
  g_server = CfgGet(L"Server", DEFAULT_SERVER_W);
  size_t sp = args.find(L"--server=");
  if (sp != std::wstring::npos) {
    // For this run only (tests, development); it must never overwrite the saved server address.
    g_server = args.substr(sp + 9, args.find(L' ', sp) - sp - 9);
  }

  g_iconBig = (HICON)LoadImageW(inst, MAKEINTRESOURCEW(1), IMAGE_ICON, GetSystemMetrics(SM_CXICON), GetSystemMetrics(SM_CYICON), 0);
  g_iconSmall = (HICON)LoadImageW(inst, MAKEINTRESOURCEW(1), IMAGE_ICON, GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON), 0);
  g_dotIcon = MakeDotIcon();
  LoadUiPack();
  g_msgTaskbarCreated = RegisterWindowMessageW(L"TaskbarCreated");

  WNDCLASSEXW wc = {sizeof(wc)};
  wc.lpfnWndProc = WndProc;
  wc.hInstance = inst;
  wc.hIcon = g_iconBig;
  wc.hIconSm = g_iconSmall;
  wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
  wc.hbrBackground = CreateSolidBrush(RGB(0x1e, 0x1f, 0x22));
  wc.lpszClassName = WINDOW_CLASS;
  RegisterClassExW(&wc);

  int x = CW_USEDEFAULT, y = CW_USEDEFAULT, w = 1280, hgt = 800, maxed = 0;
  swscanf_s(CfgGet(L"Window").c_str(), L"%d,%d,%d,%d,%d", &x, &y, &w, &hgt, &maxed);
  // Ignore a saved position that is no longer on any screen (e.g. a disconnected monitor).
  RECT saved = {x, y, x + w, y + hgt};
  if (x != CW_USEDEFAULT && !MonitorFromRect(&saved, MONITOR_DEFAULTTONULL)) x = y = CW_USEDEFAULT;
  g_hwnd = CreateWindowExW(0, WINDOW_CLASS, LangFa() ? APP_NAME_FA : APP_NAME, WS_OVERLAPPEDWINDOW, x, y, w, hgt, nullptr, nullptr, inst, nullptr);
  BOOL dark = TRUE;
  DwmSetWindowAttribute(g_hwnd, 20 /* DWMWA_USE_IMMERSIVE_DARK_MODE */, &dark, sizeof(dark));
  SetWindowPos(g_hwnd, nullptr, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);

  bool minimized = args.find(L"--minimized") != std::wstring::npos;
  if (!minimized) {
    ShowWindow(g_hwnd, maxed ? SW_SHOWMAXIMIZED : show);
    UpdateWindow(g_hwnd);
  }
  TrayAdd();
  if (SUCCEEDED(CoCreateInstance(CLSID_TaskbarList, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&g_taskbar)))) g_taskbar->HrInit();
  RegisterHotKey(g_hwnd, 1, MOD_CONTROL | MOD_SHIFT | MOD_NOREPEAT, 'M');
  RegisterHotKey(g_hwnd, 2, MOD_CONTROL | MOD_SHIFT | MOD_NOREPEAT, 'D');
  InitWebView();
  SetTimer(g_hwnd, 9, 10000, PresenceTick);

  // Check for updates shortly after start, at most every six hours.
  long long lastCheck = 0;
  std::wstring lc = CfgGet(L"LastUpdateCheck");
  size_t at = lc.find(L'@');
  if (at != std::wstring::npos) lastCheck = _wtoi64(lc.c_str() + at + 1);
  if (time(nullptr) - lastCheck > 6 * 3600) SetTimer(g_hwnd, 1, 8000, [](HWND h, UINT, UINT_PTR id, DWORD) {
      KillTimer(h, id);
      CheckForUpdates(false);
    });

  MSG m;
  while (GetMessageW(&m, nullptr, 0, 0)) {
    TranslateMessage(&m);
    DispatchMessageW(&m);
  }
  if (mutex) CloseHandle(mutex);
  CoUninitialize();
  return 0;
}

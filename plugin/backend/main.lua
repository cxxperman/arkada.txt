--[[
  Arkada plugin for Millennium: the backend, run by Millennium's Lua host (LuaJIT).

  Two jobs. Here: ask Windows for the system backdrop under the windows of the Steam client, so that the
  theme can let the desktop show through. The frontend (plugin/src/backdrop.js) calls
  ApplyBackdrop(mode) with "mica", "acrylic" or "off"; nothing here runs by itself.
  And How Long To Beat (arkada_hltb.lua, GetHltbData and HltbSetup at the end of this file): the only
  part of the backend that goes to the internet, and only while its setting is on.

    Windows 11 22H2 and later (build 22621+), the documented way:
      DWMWA_USE_IMMERSIVE_DARK_MODE (20) = TRUE    the dark variant of the material
      DWMWA_WINDOW_CORNER_PREFERENCE (33)          ROUND for big windows, ROUNDSMALL for the rest
      DWMWA_SYSTEMBACKDROP_TYPE (38)               2 = Mica (main windows in "mica"), 3 = Acrylic (menus,
                                                   pop-ups, small windows; everything in "acrylic")
      DwmExtendFrameIntoClientArea(-1)             "sheet of glass": the material under the whole window
    Older builds, or when attribute 38 is refused: the accent blur of SetWindowCompositionAttribute,
    the way DWMX does it (the Windows 10 path; on recent Windows 11 builds it may draw nothing).

  Windows that are skipped: hidden ones, Big Picture (by title) and windows covering a whole monitor
  without a caption (fullscreen). A window patched before and now fullscreen is put back (on a full pass).

  Cheap on purpose, since it runs whenever a menu opens: the steamwebhelper process list is cached,
  titles are read without a message to the window, and a new-window pass ({ only = "new" }) leaves the
  windows already patched alone. Each pass that patched something is logged with its time.

  Based on DWMX (Window Styler) by shdwmtr — https://github.com/shdwmtr/dwmx (now github.com/ejalxndr/dwmx),
  backend/main.lua at commit 8c996ca3e66a, Apache License 2.0; the license text is LICENSE-dwmx next to
  this file, see also THIRD_PARTY.md. Taken from it: finding the steamwebhelper.exe processes with a
  Toolhelp snapshot, EnumWindows over their windows, the accent blur and the corner preference.
  Changed: struct types fixed for 64-bit (ULONG_PTR, LPARAM) and renamed with an arkada_ prefix, API
  names bound through __asm__ so as not to clash with other plugins' declarations; added the Windows 11
  backdrop path, dark mode, frame extension, the version check, window classes (main / small / skipped),
  undoing on "off" and on unload, and a result the frontend can read.
]]

-- Kept as a string so that the notice survives the .star build, which strips comments
local NOTICE = "window backdrop code based on DWMX by shdwmtr (github.com/shdwmtr/dwmx), Apache License 2.0, changed"

local logger = require("logger")
local millennium = require("millennium")
local json = require("json")
local ffi = require("ffi")
local bit = require("bit")

ffi.cdef [[
typedef struct {
  uint32_t dwSize;
  uint32_t cntUsage;
  uint32_t th32ProcessID;
  uintptr_t th32DefaultHeapID;
  uint32_t th32ModuleID;
  uint32_t cntThreads;
  uint32_t th32ParentProcessID;
  int32_t pcPriClassBase;
  uint32_t dwFlags;
  uint16_t szExeFile[260];
} arkada_PROCESSENTRY32W;
typedef struct { int32_t left, top, right, bottom; } arkada_RECT;
typedef struct { uint32_t cbSize; arkada_RECT rcMonitor; arkada_RECT rcWork; uint32_t dwFlags; } arkada_MONITORINFO;
typedef struct { int32_t cxLeftWidth, cxRightWidth, cyTopHeight, cyBottomHeight; } arkada_MARGINS;
typedef struct {
  uint32_t dwOSVersionInfoSize, dwMajorVersion, dwMinorVersion, dwBuildNumber, dwPlatformId;
  uint16_t szCSDVersion[128];
} arkada_OSVERSIONINFOW;
typedef struct { int32_t AccentState; int32_t AccentFlags; uint32_t GradientColor; int32_t AnimationId; } arkada_ACCENTPOLICY;
typedef struct { int32_t Attrib; void *pvData; size_t cbData; } arkada_WINCOMPATTRDATA;
typedef int (__stdcall *arkada_WNDENUMPROC)(void *hwnd, intptr_t lParam);

void *arkada_CreateToolhelp32Snapshot(uint32_t dwFlags, uint32_t th32ProcessID) __asm__("CreateToolhelp32Snapshot");
int arkada_Process32FirstW(void *hSnapshot, arkada_PROCESSENTRY32W *lppe) __asm__("Process32FirstW");
int arkada_Process32NextW(void *hSnapshot, arkada_PROCESSENTRY32W *lppe) __asm__("Process32NextW");
int arkada_CloseHandle(void *hObject) __asm__("CloseHandle");

int arkada_EnumWindows(arkada_WNDENUMPROC lpEnumFunc, intptr_t lParam) __asm__("EnumWindows");
uint32_t arkada_GetWindowThreadProcessId(void *hwnd, uint32_t *lpdwProcessId) __asm__("GetWindowThreadProcessId");
int arkada_IsWindow(void *hwnd) __asm__("IsWindow");
int arkada_IsWindowVisible(void *hwnd) __asm__("IsWindowVisible");
int arkada_GetWindowRect(void *hwnd, arkada_RECT *lpRect) __asm__("GetWindowRect");
int32_t arkada_GetWindowLongW(void *hwnd, int nIndex) __asm__("GetWindowLongW");
int arkada_InternalGetWindowText(void *hwnd, uint16_t *pString, int cchMaxCount) __asm__("InternalGetWindowText");
int arkada_QueryPerformanceCounter(int64_t *lpPerformanceCount) __asm__("QueryPerformanceCounter");
int arkada_QueryPerformanceFrequency(int64_t *lpFrequency) __asm__("QueryPerformanceFrequency");
void *arkada_MonitorFromWindow(void *hwnd, uint32_t dwFlags) __asm__("MonitorFromWindow");
int arkada_GetMonitorInfoW(void *hMonitor, arkada_MONITORINFO *lpmi) __asm__("GetMonitorInfoW");
int arkada_SetWindowCompositionAttribute(void *hwnd, arkada_WINCOMPATTRDATA *data) __asm__("SetWindowCompositionAttribute");

int32_t arkada_DwmSetWindowAttribute(void *hwnd, uint32_t dwAttribute, const void *pvAttribute, uint32_t cbAttribute) __asm__("DwmSetWindowAttribute");
int32_t arkada_DwmExtendFrameIntoClientArea(void *hwnd, const arkada_MARGINS *pMarInset) __asm__("DwmExtendFrameIntoClientArea");

int32_t arkada_RtlGetVersion(arkada_OSVERSIONINFOW *lpVersionInformation) __asm__("RtlGetVersion");
]]

local kernel32 = ffi.load("kernel32")
local user32 = ffi.load("user32")
local dwmapi = ffi.load("dwmapi")
local ntdll = ffi.load("ntdll")

local TH32CS_SNAPPROCESS = 0x00000002
local INVALID_HANDLE = ffi.cast("void *", -1)
local GWL_STYLE, GWL_EXSTYLE = -16, -20
local WS_CAPTION = 0x00C00000
local WS_EX_TOOLWINDOW = 0x00000080
local MONITOR_DEFAULTTONEAREST = 2

local DWMWA_USE_IMMERSIVE_DARK_MODE = 20
local DWMWA_WINDOW_CORNER_PREFERENCE = 33
local DWMWA_SYSTEMBACKDROP_TYPE = 38
local DWMWCP_ROUND, DWMWCP_ROUNDSMALL = 2, 3
local DWMSBT_AUTO, DWMSBT_NONE, DWMSBT_MAINWINDOW, DWMSBT_TRANSIENTWINDOW = 0, 1, 2, 3

local WCA_ACCENT_POLICY = 19
local ACCENT_DISABLED, ACCENT_ENABLE_BLURBEHIND = 0, 3

-- A window at least this big (and not a tool window) is a "main" window: Mica in the "mica" mode
local MAIN_MIN_W, MAIN_MIN_H = 480, 320

-- ───────── Small helpers ─────────
local function hex(hr)
  local v = tonumber(hr) or 0
  if v < 0 then v = v + 4294967296 end
  return string.format("0x%08X", v)
end

-- UTF-16 buffer → lower-case ASCII (anything else becomes "?"); enough to compare file names and find "big picture"
local function wide_lower(buf, max)
  local out = {}
  for i = 0, max - 1 do
    local c = buf[i]
    if c == 0 then break end
    if c < 128 then out[#out + 1] = string.char(c):lower() else out[#out + 1] = "?" end
  end
  return table.concat(out)
end

-- Milliseconds from the performance counter, for the timings in the log and the reply
local qpc, qpf = ffi.new("int64_t[1]"), 0
do
  local f = ffi.new("int64_t[1]")
  if pcall(function() return kernel32.arkada_QueryPerformanceFrequency(f) end) then qpf = tonumber(f[0]) or 0 end
end
local function now_ms()
  if qpf > 0 and kernel32.arkada_QueryPerformanceCounter(qpc) ~= 0 then return tonumber(qpc[0]) * 1000 / qpf end
  return os.clock() * 1000
end

local function key_of(hwnd) return tonumber(ffi.cast("intptr_t", hwnd)) end
local function hwnd_of(key) return ffi.cast("void *", key) end

-- ───────── Which Windows this is ─────────
local BUILD = 0
do
  local ok, err = pcall(function()
    local v = ffi.new("arkada_OSVERSIONINFOW")
    v.dwOSVersionInfoSize = ffi.sizeof(v)
    if ntdll.arkada_RtlGetVersion(v) == 0 then BUILD = tonumber(v.dwBuildNumber) end
  end)
  if not ok then logger:error("RtlGetVersion failed: " .. tostring(err)) end
end
local MODERN = BUILD >= 22621 -- DWMWA_SYSTEMBACKDROP_TYPE is documented from Windows 11 22H2

-- GetWindowLongPtrW exists only in 64-bit user32; the styles fit in 32 bits either way
local get_long = function(hwnd, index) return tonumber(user32.arkada_GetWindowLongW(hwnd, index)) end
do
  local ok = pcall(ffi.cdef, [[intptr_t arkada_GetWindowLongPtrW(void *hwnd, int nIndex) __asm__("GetWindowLongPtrW");]])
  if ok and ffi.abi("64bit") and pcall(function() return user32.arkada_GetWindowLongPtrW end) then
    get_long = function(hwnd, index) return tonumber(user32.arkada_GetWindowLongPtrW(hwnd, index)) end
  end
end

-- ───────── The windows of Steam ─────────
local function steam_pids()
  local pids = {}
  local snap = kernel32.arkada_CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
  if snap == nil or snap == INVALID_HANDLE then
    logger:error("CreateToolhelp32Snapshot failed")
    return pids
  end
  local ok, err = pcall(function()
    local e = ffi.new("arkada_PROCESSENTRY32W")
    e.dwSize = ffi.sizeof(e)
    local more = kernel32.arkada_Process32FirstW(snap, e)
    while more ~= 0 do
      if wide_lower(e.szExeFile, 260) == "steamwebhelper.exe" then pids[tonumber(e.th32ProcessID)] = true end
      more = kernel32.arkada_Process32NextW(snap, e)
    end
  end)
  kernel32.arkada_CloseHandle(snap)
  if not ok then logger:error("process list failed: " .. tostring(err)) end
  return pids
end

-- One callback for the life of the plugin (a cast callback is a scarce resource in LuaJIT)
local enum_targets, enum_found = {}, {}
local enum_pid = ffi.new("uint32_t[1]")
local enum_callback = ffi.cast("arkada_WNDENUMPROC", function(hwnd, _)
  enum_pid[0] = 0
  user32.arkada_GetWindowThreadProcessId(hwnd, enum_pid)
  if enum_targets[tonumber(enum_pid[0])] then enum_found[#enum_found + 1] = key_of(hwnd) end
  return 1
end)

-- The steamwebhelper processes rarely change: the process list is taken again only after PIDS_TTL_MS,
-- or at once when the remembered ones have no window left (a helper restarted)
local PIDS_TTL_MS = 10000
local pids, pids_at = {}, -math.huge

local function enumerate()
  enum_targets, enum_found = pids, {}
  user32.arkada_EnumWindows(enum_callback, 0)
  local found = enum_found
  enum_found = {}
  return found
end

local function steam_windows()
  local fresh = false
  if next(pids) == nil or now_ms() - pids_at > PIDS_TTL_MS then
    pids, pids_at, fresh = steam_pids(), now_ms(), true
  end
  if next(pids) == nil then return {} end
  local found = enumerate()
  if #found == 0 and not fresh then
    pids, pids_at = steam_pids(), now_ms()
    if next(pids) == nil then return {} end
    found = enumerate()
  end
  return found
end
-- A callback into Lua must not come from a C call made by JIT-compiled code ("bad callback"): keep this one interpreted
if jit and jit.off then jit.off(enumerate); jit.off(steam_windows) end

local rect = ffi.new("arkada_RECT")
local monitor = ffi.new("arkada_MONITORINFO")
local title = ffi.new("uint16_t[256]")

-- "main", "small", "skip" (Big Picture, fullscreen) or nil (hidden, no size yet)
local function classify(hwnd)
  if user32.arkada_IsWindowVisible(hwnd) == 0 then return nil end
  if user32.arkada_GetWindowRect(hwnd, rect) == 0 then return nil end
  local w, h = rect.right - rect.left, rect.bottom - rect.top
  if w <= 0 or h <= 0 then return nil end
  -- InternalGetWindowText reads the title Windows keeps; GetWindowText would send WM_GETTEXT to the
  -- window's thread in steamwebhelper and wait for it, while that thread is busy opening the window
  local n = user32.arkada_InternalGetWindowText(hwnd, title, 256)
  local name = n > 0 and wide_lower(title, 256) or ""
  if name:find("big picture", 1, true) then return "skip", "big picture" end
  -- Menus (Steam's "… Menu", "… Supernav", "Menu"): their window is bigger than the menu, for its
  -- shadow, and a backdrop fills the whole window: a blurred rectangle around the menu. They keep
  -- none; the theme draws their panel solid (plugin/src/steam.js leaves them unmarked by the same rule)
  if name:find("menu$") or name:find("supernav$") then return "skip", "menu" end
  local style, exstyle = get_long(hwnd, GWL_STYLE) or 0, get_long(hwnd, GWL_EXSTYLE) or 0
  if bit.band(style, WS_CAPTION) ~= WS_CAPTION then
    local mon = user32.arkada_MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
    monitor.cbSize = ffi.sizeof(monitor)
    if mon ~= nil and user32.arkada_GetMonitorInfoW(mon, monitor) ~= 0 then
      local m = monitor.rcMonitor
      if rect.left <= m.left and rect.top <= m.top and rect.right >= m.right and rect.bottom >= m.bottom then return "skip", "fullscreen" end
    end
  end
  if bit.band(exstyle, WS_EX_TOOLWINDOW) ~= 0 or w < MAIN_MIN_W or h < MAIN_MIN_H then return "small" end
  return "main"
end

-- ───────── Applying ─────────
local function set_int(hwnd, attribute, value)
  local v = ffi.new("int32_t[1]", value)
  return tonumber(dwmapi.arkada_DwmSetWindowAttribute(hwnd, attribute, v, 4))
end

local function extend_frame(hwnd, all)
  local n = all and -1 or 0
  local m = ffi.new("arkada_MARGINS[1]")
  m[0].cxLeftWidth, m[0].cxRightWidth, m[0].cyTopHeight, m[0].cyBottomHeight = n, n, n, n
  return tonumber(dwmapi.arkada_DwmExtendFrameIntoClientArea(hwnd, m))
end

local function accent(hwnd, state)
  local policy = ffi.new("arkada_ACCENTPOLICY[1]") -- zero-filled: no flags, no colour, no animation
  policy[0].AccentState = state
  local data = ffi.new("arkada_WINCOMPATTRDATA[1]")
  data[0].Attrib = WCA_ACCENT_POLICY
  data[0].pvData = policy
  data[0].cbData = ffi.sizeof("arkada_ACCENTPOLICY")
  return user32.arkada_SetWindowCompositionAttribute(hwnd, data) ~= 0
end

-- → path ("backdrop" | "accent" | "blur" | nil when nothing took) and a line for the log
--   "blur": the accent blur of SetWindowCompositionAttribute (ACCENT_ENABLE_BLURBEHIND, 3), what is behind
--           the window blurred with no luminosity layer or noise, and it stays when the window is inactive
--           (the system backdrop turns to a plain colour then). Not ACCENT_ENABLE_ACRYLICBLURBEHIND (4): on
--           Windows 10 1903+ and Windows 11 it makes dragging and resizing the window lag; the tint is
--           drawn by the theme instead (overlay/backdrop.css). The system backdrop is set to none (1) so the
--           two do not stack, and the frame is not extended.
local function apply(hwnd, kind, mode)
  local corner = set_int(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, kind == "main" and DWMWCP_ROUND or DWMWCP_ROUNDSMALL)
  if mode == "blur" then
    local dark = set_int(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, 1)
    local none = MODERN and set_int(hwnd, DWMWA_SYSTEMBACKDROP_TYPE, DWMSBT_NONE) or 0
    local frame = extend_frame(hwnd, false)
    local blurred = accent(hwnd, ACCENT_ENABLE_BLURBEHIND)
    return blurred and "blur" or nil, string.format("dark=%s corner=%s backdrop(1)=%s frame=%s accent(3)=%s", hex(dark), hex(corner), hex(none), hex(frame), tostring(blurred))
  end
  accent(hwnd, ACCENT_DISABLED) -- from "blur" to a system backdrop: the accent would draw over it
  if MODERN then
    local dark = set_int(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, 1)
    local kindOf = (mode == "mica" and kind == "main") and DWMSBT_MAINWINDOW or DWMSBT_TRANSIENTWINDOW
    local backdrop = set_int(hwnd, DWMWA_SYSTEMBACKDROP_TYPE, kindOf)
    local frame = extend_frame(hwnd, true)
    local line = string.format("dark=%s corner=%s backdrop(%d)=%s frame=%s", hex(dark), hex(corner), kindOf, hex(backdrop), hex(frame))
    if backdrop == 0 then return "backdrop", line end
    local blurred = accent(hwnd, ACCENT_ENABLE_BLURBEHIND)
    return blurred and "accent" or nil, line .. " accent=" .. tostring(blurred)
  end
  local blurred = accent(hwnd, ACCENT_ENABLE_BLURBEHIND)
  return blurred and "accent" or nil, string.format("corner=%s accent=%s", hex(corner), tostring(blurred))
end

local function undo(hwnd, path)
  if path == "backdrop" then
    set_int(hwnd, DWMWA_SYSTEMBACKDROP_TYPE, DWMSBT_AUTO)
    extend_frame(hwnd, false)
  elseif path == "accent" then
    accent(hwnd, ACCENT_DISABLED)
  elseif path == "blur" then
    accent(hwnd, ACCENT_DISABLED)
    if MODERN then set_int(hwnd, DWMWA_SYSTEMBACKDROP_TYPE, DWMSBT_AUTO) end
  end
end

-- hwnd key → { want = "mode:kind", path = "backdrop" | "accent" }
local patched = {}
local menuCleared = {} -- menu/Supernav hwnds whose leftover blur was cleared once (see the "skip" branch)

local function undo_all()
  local n = 0
  for key, rec in pairs(patched) do
    local hwnd = hwnd_of(key)
    if user32.arkada_IsWindow(hwnd) ~= 0 then
      pcall(undo, hwnd, rec.path)
      n = n + 1
    end
  end
  patched = {}
  return n
end

-- only_new: a window has just been opened or shown; the windows already patched are taken as they are
-- (not classified again), so only a new hwnd costs anything. A full pass (start, a change of mode) also
-- notices a patched window that went fullscreen.
local function run(mode, only_new)
  local result = { ok = true, mode = mode, build = BUILD, path = MODERN and "backdrop" or "accent", windows = 0, patched = 0, kept = 0, skipped = 0, failed = 0 }
  if mode == "off" then
    result.undone = undo_all()
    if result.undone > 0 then logger:info("off: " .. result.undone .. " window(s) put back") end
    return result
  end
  local seen = {}
  for _, key in ipairs(steam_windows()) do
    local hwnd = hwnd_of(key)
    local rec = patched[key]
    local kind, why
    if only_new and rec and rec.want:sub(1, #mode + 1) == mode .. ":" then
      kind = rec.want:sub(#mode + 2)
    else
      kind, why = classify(hwnd)
    end
    if kind then
      seen[key] = true
      result.windows = result.windows + 1
      if kind == "skip" then
        result.skipped = result.skipped + 1
        if rec then
          undo(hwnd, rec.path)
          patched[key] = nil
          logger:info(string.format("hwnd %s: %s, backdrop taken off", hex(key), why))
        elseif why == "menu" and not menuCleared[key] then
          -- Steam keeps menu windows alive and reuses them, so one patched by an older backend (or before a
          -- restart of this Lua state) still carries its blur: clear it once per window, whatever we remember
          menuCleared[key] = true
          pcall(undo, hwnd, "blur")                     -- accent off (+ system backdrop to auto)
          if MODERN then pcall(undo, hwnd, "backdrop") end -- frame extension off
        end
      elseif rec and rec.want == mode .. ":" .. kind then
        result.kept = result.kept + 1
      else
        local path, line = apply(hwnd, kind, mode)
        logger:info(string.format("hwnd %s %s %s: %s", hex(key), kind, mode, line))
        if path then
          patched[key] = { want = mode .. ":" .. kind, path = path }
          result.patched = result.patched + 1
        else
          patched[key] = nil
          result.failed = result.failed + 1
        end
      end
    end
  end
  -- Forget windows that are gone
  for key in pairs(patched) do
    if not seen[key] and user32.arkada_IsWindow(hwnd_of(key)) == 0 then patched[key] = nil end
  end
  result.ok = not (result.failed > 0 and result.patched == 0 and result.kept == 0)
  return result
end

-- ───────── Called by the frontend ─────────
-- The frontend sends { mode = "mica" | "acrylic" | "off", only = "new"?, afterMs = n? }. Millennium hands
-- the fields over as positional arguments, in an order of its own (alphabetical: afterMs, mode, only), or
-- as one table: so each argument is recognised by what it is, never by where it stands.
local function read_args(...)
  local mode, only_new, after
  local function take(v)
    if v == "blur" or v == "mica" or v == "acrylic" or v == "off" then mode = v
    elseif v == "new" then only_new = true
    elseif type(v) == "number" then after = v
    end
  end
  for i = 1, select("#", ...) do
    local v = select(i, ...)
    if type(v) == "table" then
      take(v.mode); if v.only == "new" then only_new = true end
      if tonumber(v.afterMs) then after = tonumber(v.afterMs) end
    else
      take(v)
    end
  end
  return mode, only_new == true, after
end

-- ApplyBackdrop(…) → JSON { ok, mode, build, path, windows, patched, kept, skipped, failed, ms }
-- only = "new": see run(); afterMs: how long ago the frontend saw the window open, for the log.
-- No mode recognised: nothing is done ({ ok = false }); it is never taken for "off".
function ApplyBackdrop(...)
  local mode, only_new, after = read_args(...)
  if not mode then
    logger:error("ApplyBackdrop: no mode in the arguments, nothing done")
    return json.encode({ ok = false, build = BUILD, error = "no mode" })
  end
  local started = now_ms()
  local ok, result = pcall(run, mode, only_new)
  if not ok then
    logger:error("ApplyBackdrop(" .. mode .. ") failed: " .. tostring(result))
    result = { ok = false, mode = mode, build = BUILD, error = tostring(result) }
  end
  result.ms = math.floor((now_ms() - started) * 100 + 0.5) / 100
  if ok and (result.patched > 0 or result.failed > 0) then
    logger:info(string.format("%s pass: %d window(s), %d patched, %d kept, %d failed in %.2f ms%s", only_new and "new-window" or "full",
      result.windows, result.patched, result.kept, result.failed, result.ms, after and string.format(" (%d ms after the window opened)", after) or ""))
  end
  return json.encode(result)
end

-- ───────── How Long To Beat (arkada_hltb.lua) ─────────
-- Loaded in a pcall: if that module cannot load, the window backdrop above still works.
local hltb_ok, hltb = pcall(require, "arkada_hltb")
if not hltb_ok then logger:error("How Long To Beat is not available: " .. tostring(hltb)); hltb = nil end

-- GetHltbData(app_id, fallback_name, force_refresh) → JSON, the same call and reply as the HLTB for Steam
-- plugin (Steam Enhanced's card asks it so, positionally; the frontend with these names, which Millennium
-- hands over in the same order). See arkada_hltb.lua.
function GetHltbData(app_id, fallback_name, force_refresh)
  if type(app_id) == "table" then app_id, fallback_name, force_refresh = app_id.app_id, app_id.fallback_name, app_id.force_refresh end
  if not hltb then return json.encode({ success = false, error = "not available" }) end
  local ok, result = pcall(hltb.get, app_id, fallback_name, force_refresh == true)
  if not ok then logger:error("GetHltbData: " .. tostring(result)); result = { success = false, error = tostring(result) } end
  return json.encode(result)
end

-- HltbSetup({ on, steam_user_id }): the frontend switches the feature on or off (plugin/src/hltb.js). Each
-- argument is recognised by what it is, as in read_args: a boolean is the switch, a string of digits the user.
function HltbSetup(...)
  local on, user = false, nil
  local function take(v)
    if type(v) == "boolean" then on = v
    elseif type(v) == "string" and v:match("^%d+$") then user = v
    elseif type(v) == "table" then take(v.on); take(v.steam_user_id)
    end
  end
  for i = 1, select("#", ...) do take(select(i, ...)) end
  if not hltb then return json.encode({ success = false, error = "not available" }) end
  local ok, result = pcall(hltb.setup, on, user)
  if not ok then logger:error("HltbSetup: " .. tostring(result)); result = { success = false, error = tostring(result) } end
  return json.encode(result)
end

-- ───────── IsThereAnyDeal (arkada_itad.lua) ─────────
-- Called by a game's page in the store (plugin/src/prices.js, through Millennium.callServerMethod). Loaded in a
-- pcall as HLTB is: without it the rest still works. Nothing is asked of IsThereAnyDeal without the user's key.
local itad_ok, itad = pcall(require, "arkada_itad")
if not itad_ok then logger:error("IsThereAnyDeal is not available: " .. tostring(itad)); itad = nil end

local function itad_call(name, fn, ...)
  if not itad then return json.encode({ success = false, error = "not available" }) end
  local ok, result = pcall(fn, ...)
  if not ok then logger:error(name .. ": " .. tostring(result)); result = { success = false, error = "failed" } end
  return json.encode(result)
end
-- ItadPrices({ appid, country }) → JSON, see arkada_itad.lua
function ItadPrices(...) return itad_call("ItadPrices", itad and itad.prices, ...) end
-- ItadKey({ key }) → JSON { success, hasKey }; an empty key removes it
function ItadKey(...) return itad_call("ItadKey", itad and itad.set_key, ...) end
-- ItadState() → JSON { success, hasKey }
function ItadState(...) return itad_call("ItadState", itad and itad.state, ...) end

local function on_load()
  logger:info(string.format("Arkada backend loaded: Windows build %d, %s path; %s", BUILD,
    MODERN and "DWMWA_SYSTEMBACKDROP_TYPE" or "accent blur (build < 22621)", NOTICE .. (hltb and ("; " .. hltb.NOTICE) or "")))
  millennium.ready()
end

local function on_frontend_loaded()
  logger:info("Arkada frontend loaded")
end

local function on_unload()
  local ok, n = pcall(undo_all)
  logger:info("Arkada backend unloaded" .. (ok and n > 0 and (": " .. n .. " window(s) put back") or ""))
end

return {
  on_load = on_load,
  on_frontend_loaded = on_frontend_loaded,
  on_unload = on_unload,
}

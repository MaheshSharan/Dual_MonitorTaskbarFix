# Phase 1: Target surface findings (Taskbar.dll)

Status: Taskbar.dll fully decompiled (11,219 functions, 0 failures). explorer.exe
decompilation running. All findings below are from static analysis of the shipped
binaries plus live Win32 observation on the host.

## Correction to the original research report

The report assumed Win11's WinUI taskbar replaced the legacy COM taskbar classes, and
that all taskbars are `Shell_TrayWnd`. **Both assumptions are wrong for build 26200.**

Live enumeration of explorer.exe top-level windows (PID 7080):

```
Shell_TrayWnd             vis=True  rect=(0,816)-(1536,864)     mon=71075F   primary
Shell_SecondaryTrayWnd    vis=True  rect=(1920,720)-(3286,768)   mon=4E05FD   secondary
XamlExplorerHostIslandWindow_WASDK  vis=True
TopLevelWindowForOverflowXamlIsland
```

Win11 keeps the **legacy taskband model**: one `Shell_TrayWnd` for the primary display
plus one `Shell_SecondaryTrayWnd` per secondary display, all inside the single
explorer.exe process. The WinUI/XAML layer is a *view* over the surviving Win10-era
`taskband2` object model, confirmed by the assert path embedded in the binary:
`pcshell\shell\taskbar\taskband2\taskband2.cpp`.

So the placement decision is made by the **taskband in explorer.exe**, not by the XAML
view in Taskbar.dll. Taskbar.dll owns the per-monitor taskbar *instances* and their UI.

## Taskbar.dll build identity

```
path      C:\Windows\System32\Taskbar.dll
sha256    ca1e335ac1fae5ff57519035302a2f365c4620d3a230f31f1231af7331760741
timestamp 1989904251
linker    14.38
imagebase 0x180000000
sections  8   (.text rva 0x1000 size 0x1B3AAC)
exports   DllCanUnloadNow, DllGetActivationFactory, DllGetClassObject
```

Only three exports, and `DllGetActivationFactory` present ⇒ **Taskbar.dll is a WinRT
activation component**, not a plain COM DLL. Its internal C++ classes are hidden
behind WinRT vtables; several key functions are therefore reached only through
vtable dispatch and have **zero direct call sites** (confirmed for `FUN_18002fa70`).

## The monitor association mechanism

**`TaskbarMonitor` is a window property carrying the HMONITOR.**

`FUN_18002efe0`, bind a taskbar instance to its monitor:

```c
hData = *(HANDLE *)(param_1 + 0x160);                              // this->m_hMonitor
hWnd  = (**(code **)(**(longlong **)(param_1 + 600) + 0x18))();   // this->GetTaskbarWindow()
SetPropW(hWnd, L"TaskbarMonitor", hData);                          // <== HMONITOR as property
GetMonitorInfoW(this->m_hMonitor, &mi);
this->m_bPrimary = (mi.dwFlags & MONITORINFOF_PRIMARY) ? 1 : 0;
```

`FUN_18002eee8`, collect the monitors that currently have a taskbar:

```c
hWnd   = GetAncestor(*(HWND *)(param_1 + 8), 2);
pvVar4 = GetPropW(hWnd, L"TaskbarMonitor");
uVar2  = FUN_18002fcbc(pvVar4);        // HMONITOR -> display id
// push uVar2 into the caller's vector
if (FUN_18002e1c0() != 0)
    EnumDisplayMonitors(NULL, NULL, FUN_1800323b0, &local_18);
```

`FUN_18002fcbc`, HMONITOR → display id; **16 direct call sites**, the central
identity mapping used throughout the module.

Both `explorer.exe` (string at RVA 0x219ED8) and `Taskbar.dll` (RVA 0x1C1028) carry
the literal `TaskbarMonitor`, so the property is the **shared contract between the
taskband in explorer.exe and the taskbar instances in Taskbar.dll**. This is the seam.

## Monitor resolution helpers

| Function | RVA | Behaviour |
|---|---|---|
| `FUN_18002fa70` | 0x2FA70 | `MonitorFromWindow(this->m_hWnd, MONITOR_DEFAULTTONULL)`; if the resolved display id differs from the cached one at `this+0x1A0`, fires `FUN_18002f6d4(this-0x28, 0)`. **Detects that a taskbar's own monitor changed.** Virtual; 0 direct callers. |
| `FUN_180083a10` | 0x83A10 | Trivial wrapper `MonitorFromWindow(hwnd, flags)` with flags passed through by the caller. Virtual; 0 direct callers. |
| `FUN_18001a1954` | 0x1A1954 | `MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)` + `GetMonitorInfoW` follow-up. 2 direct callers (0x1A15A4 call, 0x1A1A66 tail-jmp). |
| `FUN_180055304` | 0x55304 | `GetWindowBand(hwnd, &band)`; if `band == 1` (ZBID_DESKTOP) then `MonitorFromWindow(hwnd, MONITOR_DEFAULTTOPRIMARY)` and hands the HMONITOR to a vtable slot 0xA0. Legacy AppBar/window-band path. |

Flag usage across the module is inconsistent, `MONITOR_DEFAULTTONULL` (1),
`MONITOR_DEFAULTTOPRIMARY` (0) and `MONITOR_DEFAULTTONEAREST` (2) all appear. That
inconsistency is a strong candidate for the placement defect.

## The mode gate

`ProgrammableTaskbarStatus` is read exactly once, during taskband2 init:

```c
// FUN_180096a14  -  pcshell\shell\taskbar\taskband2\taskband2.cpp
Ordinal_121(0xffffffff80000001,                        // HKEY_CURRENT_USER
            L"Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced",
            L"ProgrammableTaskbarStatus", 0x18);        // RegGetValueW
if (value_found) FUN_18001b200(value);                 // applies the mode
```

`FUN_18001b200` is therefore the function that *applies* the multi-taskbar mode.
The value is read at startup, so a mode change requires an Explorer restart to take
effect, consistent with the observed behaviour that toggling the setting alone does
nothing until the shell reloads.

Other multi-monitor mode values present in Taskbar.dll: `MMTaskbarEnabled` (0x1C0B00),
`MMTaskbarMode` (0x1C0DC8), `MMTaskbarGlomLevel` (0x1C0DA0), `TaskbarDPI_AllTaskbars`
(0x1C0FF8), `OTPTBExternalPlacementIdOverride` (0x1ED130), `PlacementPreference`
(0x1E9598).

## WinRT surface exposed by Taskbar.dll

```
WindowsUdk.UI.Shell.MultiTaskbarControllerExtension     <== multi-taskbar control
WindowsUdk.UI.Shell.TaskbarControllerExtension
WindowsUdk.UI.Shell.DisplayMonitorInfoCollectionServer  <== monitor info provider
WindowsUdk.UI.Shell.TaskbarModel / TaskbarAppsList / TaskbarSettings
WindowsUdk.UI.Shell.TaskGroup / TaskItem / TaskItemThumbnail
WindowsUdk.UI.Shell.TaskGroupMovedEventArgs             <== button migration event
WindowsUdk.UI.Shell.NotificationAreaControllerExtension
Windows.Internal.Shell.TaskGroups.TaskGroupDataModel / TaskGroupProvider
Windows.Internal.Shell.TaskbarInternal.TaskbarTestProxy
Windows.Internal.Shell.XamlExplorerHost.XamlExplorerHostWindow
Taskbar.ProgrammableTaskbarManager                      <== owns ProgrammableTaskbarStatus
```

## Taskbar instance creation

`FUN_18008a5c4` (0x8A5C4..0x8A7F7) contains, in order: `MonitorFromRect` (0x8A667),
`FUN_18002fcbc` (0x8A71E), `FUN_18002efe0` (0x8A73A). This is the
**"create a taskbar instance for this monitor"** path: rect → HMONITOR → display id →
taskbar instance → tag the window with `TaskbarMonitor`.

`FUN_1800e6504` is a second instance-creation path (calls `FUN_18002efe0` at 0xE6614).

## Tooling built

| Script | Purpose |
|---|---|
| `experimental/scripts/peinfo.py` | Dependency-free PE inspector: sections, imports with IAT RVAs, exports, UTF-16/ASCII string search with RVAs, RVA↔offset, build fingerprint. |
| `experimental/scripts/xrefs.py` | x64 xref scanner: RIP-relative operands, near CALL/JMP rel32, `FF 15` indirect-call site resolution to import names, and native function bounds from the `.pdata` exception directory. |
| `experimental/scripts/grepdec.py` | Greps the Ghidra-exported decompiled C and reports the owning function's entry RVA. |
| `tools\decompile_elf.ps1` | Host Ghidra headless pipeline, used for bulk decompilation outside the MCP transport. |

These replace the REA MCP server for bulk work, which crashed twice on a 3 MB PE.

## Next

Decompile explorer.exe (running) and locate, in the taskband:
1. the function that maps an application window to a target taskbar / monitor;
2. where `ProgrammableTaskbarStatus == 2` selects the strict per-monitor path;
3. whether the monitor is derived from a cached rectangle (defect B) or from the live
   window (correct), and whether the placement is skipped (defect A).

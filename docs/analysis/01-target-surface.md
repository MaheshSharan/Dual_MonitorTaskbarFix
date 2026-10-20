# Win11 Per-Monitor Taskbar Isolation: Target Surface

Status: RE phase 1 (target identification) complete. REA MCP crashed twice during
Ghidra queries, see "Operational notes" at the end.

## Goal

Each monitor's taskbar shows only the windows currently on that monitor. Windows 11's
native setting is already enabled but the shell does not reliably re-evaluate button
placement when a window crosses a monitor boundary (known Win11 bug, confirmed in
Microsoft Q&A threads: a round-trip drag is the only thing that fixes it).

Target: a reverse-engineered fix at the actual decision point, so behaviour does not
depend on display scaling/DPI (see "Why this is not a DPI workaround").

## Host state (verified)

```
OS            Windows 11 Pro, build 26200 (25H2 lineage), x64
explorer.exe  10.0.26100.8875
DISPLAY1      1920x1080 physical -> 1536x864 logical = 125% scale  (primary, laptop panel)
DISPLAY2      1366x768   physical -> 1366x768 logical = 100% scale  (external display)
```

Mixed scale (125% / 100%) is the trigger condition for the Win11 placement bug.

### Taskbar settings (HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced)

| Value | State | Meaning |
|---|---|---|
| MMTaskbarEnabled | 1 | Show my taskbar on all displays, ON |
| ProgrammableTaskbarStatus | 2 | Show my taskbar apps on: "taskbar where window is open", strict isolation |
| TaskbarAl | 1 | Taskbar alignment: center |
| TaskbarLocation | 3 | Bottom |
| TaskbarDa | 0 | Widgets off |
| TaskbarAnimations | 0 | Animations off |
| ShowTaskViewButton | 0 | Task View off |
| TaskbarFlashing | 1 | Flashing on |
| TaskbarSmallIcons | 0 | Normal size |

`HKCU\...\Policies\Explorer` key is absent, no Group Policy override.

**Conclusion: the native mechanism is already fully configured.** The defect is shell
behaviour, not configuration. Any fix must therefore intervene in shell logic.

No third-party shell modifiers present (no ExplorerPatcher, Windhawk, StartAllBack,
DisplayFusion, ActualWindowManager, AutoHotkey, TranslucentTB). Baseline is stock
`explorer.exe`. This is a clean environment for behavioural observation.

## Architecture split (observed)

The modern taskbar is not the Win10 COM taskbar. It is a WinUI/XAML app hosted inside
explorer.exe, split across three binaries:

| Binary | Size | Role | Evidence |
|---|---|---|---|
| `C:\Windows\System32\Taskbar.dll` | 3,142 KB | **Placement decision + taskbar implementation** | contains `ProgrammableTaskbarStatus`, `MMTaskbarEnabled`, `Shell_TrayWnd` strings; imports monitor/DPI/AppBar APIs |
| `C:\Windows\explorer.exe` | 3,398 KB | **Window event source** | imports `SetWinEventHook` + `UnhookWinEvent` (only module of the three that does) |
| `C:\Windows\SystemApps\MicrosoftWindows.Client.Core_cw5n1h2txyewy\Taskbar.View.dll` | 9,786 KB | **XAML view layer** | `TaskbarFrame` x48, `TaskList` x55 |

Supporting: `Windows.Internal.Taskbar.dll` (204 KB), `SettingsHandlers_DesktopTaskbar.dll` (596 KB),
`Windows.UI.Xaml.dll` (17,524 KB), `Windows.UI.Xaml.Controls.dll` (3,209 KB), `StartMenu.dll` (4,980 KB).

### Import evidence

`Taskbar.dll` imports (one hit each, import table entries):
`MonitorFromWindow`, `MonitorFromRect`, `MonitorFromPoint`, `GetMonitorInfo`,
`EnumDisplayMonitors`, `GetDpiForWindow`, `GetDpiForMonitor`, `SHAppBarMessage`,
`SetWindowPos`, `GetWindowRect`, `DwmGetWindowAttribute`, `RegisterWindowMessage`.

`Taskbar.dll` does **not** import `SetWinEventHook`/`UnhookWinEvent`/`SetWindowsHookEx`
(except `SetWindowsHookEx` only in Taskbar.View.dll). Therefore:

> explorer.exe registers the window-tracking events; Taskbar.dll consumes the resulting
> notifications and decides which taskbar owns the button.

This is the seam we are looking for.

## Live window classes (explorer.exe, PID 7080)

```
Shell_TrayWnd                             visible   primary taskbar
XamlExplorerHostIslandWindow_WASDK        visible   XAML host window for the taskbar island
TopLevelWindowForOverflowXamlIsland       hidden    system tray overflow flyout
Xaml_WindowedPopupClass                   hidden    popup host
```

Open question for RE phase 2: confirm whether the secondary taskbar is a second
`Shell_TrayWnd` in the same process or a distinct class on this build. The single
visible `Shell_TrayWnd` above is a discrepancy worth resolving, enumerate all
top-level windows of the explorer process with full class names and check per-monitor
work areas.

## Why this is not a DPI workaround

A watchdog that reacts to geometry changes and re-nudges the shell is a *reaction* to a
symptom, and its correctness depends on the coordinate system it observes (which is
exactly where 125% vs 100% scale bites).

Intervening at the decision point instead means the monitor is derived from the live
window handle at decision time:

```
MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
```

That answer is a physical monitor, independent of logical scaling. Scale only affects
*where* the shell thinks the window is, not *which* physical monitor it occupies.

## RE plan

### Phase 2: locate the decision function (Taskbar.dll)

1. Ghidra: import `Taskbar.dll`, locate xrefs to `MonitorFromWindow` / `MonitorFromRect`
   / `EnumDisplayMonitors` / `GetMonitorInfo`.
2. Locate xrefs to the `ProgrammableTaskbarStatus` and `MMTaskbarEnabled` strings -
   the mode gate. Establish how value 2 changes the branch.
3. Identify the function that consumes explorer.exe's window-move notification and
   resolves a target taskbar/monitor.
4. Reconstruct the decision: which monitor wins, what happens on a mismatch, whether
   the button is migrated between taskbars or shown/hidden.

### Phase 3: confirm the defect dynamically (Frida)

Attach to `explorer.exe`, hook `MonitorFromWindow` and log caller + hwnd + returned
HMONITOR. Drag a window across the monitor boundary and observe:

-  (a) Is the placement function called at all on a cross-monitor drag?
-  (b) If called, does it receive a stale or scaled rectangle?
-  (c) Which HMONITOR does it resolve to, versus `MonitorFromWindow` truth?

Also hook `SetWinEventHook` in explorer.exe to dump exactly which events the shell
subscribes to. This tells us whether the *event* never fires (case A) or the
*computation* is wrong (case B/C), these lead to different hooks.

### Phase 4: design the fix (depends on phase 3 outcome)

| Finding | Fix |
|---|---|
| A. placement function never invoked on cross-monitor move | hook the notification entry point; invoke placement with a freshly computed monitor |
| B. placement invoked but uses cached/stale rect | hook the monitor resolution; force `MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)` |
| C. placement correct but button migration in the XAML layer is skipped | hook in Taskbar.View.dll / intercept the button-migration call |

### Phase 5: build and ship

-  Hook shim: Dobby or MinHook, x64, trampoline preserving volatile registers and SIMD state.
-  Anchor to the target by **AOB signature** (wildcard mask), not a hardcoded RVA, so the
  fix survives recompiler/compiler drift within a build family.
-  Per-build fingerprint: SHA-256 of `Taskbar.dll` -> AOB table entry. Unknown build ->
  refuse to patch and fall back to native behaviour (fail-safe, never crash the shell).
-  No admin required: explorer.exe runs at the same integrity level as the user session,
  so a same-user loader can inject without elevation.
-  Distribution: GitHub repo, MIT, signed releases, windet manifest, per-build support
  matrix. Optionally publish as a Windhawk mod to inherit its signing + injection +
  crash-isolation machinery, that is the cleanest path to "any Win11 user can apply it".

## Workspace layout

```
win11_taskbar/
  original/bin/      copies of the shell binaries (fetched from the running system)
  v1/analysis/       Ghidra output (gitignored, regenerable)
  experimental/injector/   the experimental injector (see experimental/README.md)
  experimental/scripts/    automation (AOB scan, fingerprint table, build)
  docs/analysis/        this file and findings
```

### original/bin: SHA-256 (first 16 hex)

```
Taskbar.dll                          CA1E335AC1FAE5FF
explorer.exe                         EEE089FE6F927C7F
Taskbar.View.dll                     CF7E002533DEF662
Windows.Internal.Taskbar.dll        8BF62E3DA1303493
SettingsHandlers_DesktopTaskbar.dll 8CB28494F26E6FA3
```

Taskbar.dll full digest:
`ca1e335ac1fae5ff57519035302a2f365c4620d3a230f31f1231af7331760741`

## Operational notes: REA MCP stability

The REA MCP server crashed twice while serving Ghidra queries against a 3 MB PE
(207-tool server, Ghidra 12.1.4 headless, JDK 21). Symptom: tool call aborted,
server process respawned, `binary_session` reported `open: false`, and the open
analysis database was lost.

Mitigations to apply:

1. **Do bulk decompilation outside the MCP transport.** The host already has a working
   pipeline: `tools\decompile_elf.ps1` + `tools\ghidra-scripts\ExportDecompilerC.java`
   + `tools\ghidra-workspace\`. Drive Ghidra headless directly from the shell and read
   the exported `.c` files. Zero risk of crashing the MCP server.
2. **Reserve REA MCP for small targeted queries only**, one function, one xref page,
   `detail: "summary"`, explicit small `offset`/`limit`.
3. **Use `inspect_analysis_view`** with the retained `parent_evidence_id` to page
   through large result sets instead of re-requesting a full analysis.
4. Re-verify provider state with `binary_session` after any restart; Ghidra availability
   was confirmed healthy at `GHIDRA_INSTALL_DIR=<ghidra install>`.

No analysis findings were lost, the crashes occurred before any xref results were
returned. Only the transient Ghidra session state was lost.

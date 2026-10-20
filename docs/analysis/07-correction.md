# CORRECTION: the root cause is a registry value, not a missing event

**This note supersedes the conclusion in `05-root-cause.md`.** That note was
written on the basis of a live trace, and the trace was invalid. The rest of that
note, the mapped decision chain, is still accurate and worth keeping. Its
conclusion is not.

## What was wrong

The earlier conclusion was:

> explorer.exe's taskband subscribes to WinEvent notifications for
> EVENT_SYSTEM_FOREGROUND only, so when a window crosses a monitor boundary the
> taskband is never told and never re-evaluates.

The supporting evidence was a Frida trace of a bare probe window
(`experimental/scripts/move_window.py`) being dragged across the boundary, in which the
taskband's placement chain fired zero times.

**The probe window was never a taskbar window.** It was a plain Win32 window
created by a Python script. The shell never created a taskbar group for it, so
there was nothing to re-evaluate and the placement chain correctly did not run.
The trace proved "the chain does not run for a window the shell does not track",
which was then misread as "the chain never runs on a move".

The shell does have a working move trigger. It was invisible to the trace because
the probe was invisible to the taskband.

## The actual root cause

Windows 11 Settings → Personalization → Taskbar → Taskbar behaviors →
*"When using multiple displays, show my taskbar apps on"* is controlled by:

```
HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced
    MMTaskbarMode   (REG_DWORD)
```

| Option | `MMTaskbarMode` |
|---|---|
| All taskbars | 0 |
| Main taskbar and taskbar where window is open | 1 |
| Taskbar where window is open | 2 |

This was established from the ground truth: the Settings app was driven through
UI Automation, the dropdown was read, and the registry was diffed across the
change (`experimental/scripts/set_taskbar_mode.ps1`).

**The host was in mode 0, "All taskbars".** In that mode every window's button
is rendered on *every* taskbar, so a button never appears to leave the monitor
it came from: it is still on the old taskbar *and* the new one. That is exactly
the reported symptom, and it is not a bug in the placement logic at all.

### The value that was being read instead

`ProgrammableTaskbarStatus` (also 2 on the host) is a *different* setting. It
is read once by `Taskbar.dll` during taskband2 init and applied through
`FUN_18001b200`. It does not control per-monitor placement of running
applications. Third-party documentation that maps
`ProgrammableTaskbarStatus` to the multi-display taskbar mode is wrong, which is
where the original research went astray.

## Verification after setting `MMTaskbarMode = 2`

All checks below were made with **no shim loaded**, the Explorer restart used to
apply the setting also unloaded the experimental injector.

| Test | Result |
|---|---|
| `OpenCode` window on MON2, mode 2 | button on the secondary taskbar only |
| `OpenCode` moved to MON1 | button moved to the primary taskbar only |
| `Notepad` moved to MON2 by `SetWindowPos` | button moved to the secondary taskbar only |
| `Notepad` moved MON1→MON2 in 80 small steps (in-transit, as during a real drag) | button moved to the secondary taskbar only |
| Modes 0, 1, 2 compared | button appears on **both** taskbars in every mode before the change, confirming the mode is what governs it |

Checked with UI Automation (`experimental/scripts/taskbar_buttons.ps1`), which lists the
actual taskbar buttons rather than inferring them from a screenshot.

## What this means for the project

* The shipped fix is **one registry value**, set through the Settings UI or by
  the tool in `experimental/scripts/`. It needs no administrator rights, no injection, no
  shell patching, works on every Windows 11 build, and cannot break anything.
* The reverse-engineered injector is **not needed**. Shipping an
  `explorer.exe` injector that adds no value would be a security and
  maintenance liability for no benefit, so it is not part of the shipped
  artifact. The code is retained under `experimental/` because it is the
  evidence for the analysis and because the mapped decision chain is
  interesting in its own right.
* The reverse-engineering record still has value: the knob is essentially
  undocumented, the Settings UI does not name it, the commonly cited value name
  is wrong, and the verification methodology is the part that is hard to
  reproduce.

## Correction of the record

| Earlier claim | Corrected |
|---|---|
| "The taskband never re-evaluates on a window move" | It does. The trace's probe window had no taskbar group. |
| "`ProgrammableTaskbarStatus` selects the isolation mode" | It does not. `MMTaskbarMode` does. |
| "The fix must inject a notification into the shell" | The fix is a setting. No injection is required. |
| "The mixed 125%/100% scaling is what makes the defect visible" | Still true, and worth explaining: in mode 0 the duplicate buttons on the secondary taskbar are what made it look like a placement bug. |

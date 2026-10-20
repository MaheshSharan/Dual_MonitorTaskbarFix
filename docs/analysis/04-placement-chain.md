# Phase 1/2: The placement decision chain in explorer.exe

## Summary

The Win11 taskbar's per-monitor button placement is decided in **explorer.exe**,
not in `Taskbar.dll`. The decision chain was located statically and then
confirmed dynamically against the live shell.

**Root cause (defect A): when a window crosses a monitor boundary, the shell
resolves the window's new monitor but never re-runs the placement logic. The
button stays on the old taskbar until something else forces a re-evaluation.**

This is why the native setting looks broken and why no configuration fixes it:
the mode is correct, the monitor resolution is correct, the placement code is
correct, it is simply **never called** on a move.

## The chain

```
FUN_1400603f0   taskband command dispatcher
                opcode = *(uint *)(cmd + 0x28)
                opcode 9  ->  FUN_140067cc8      (re-evaluate placement)
                opcode 11 ->  MonitorFromRect(&cmd[0x10], 2) -> FUN_140010d90
                opcode 12 ->  MonitorFromRect(&cmd[0x10], 2) -> FUN_1400dfdb8
                opcode 7,8 -> primary monitor from a virtual call

FUN_140067cc8   the re-evaluation
                hwnd  = *(HWND *)(param_2 + 4)
                group = the task-group object for hwnd, in the list at param_1+0x100
                mon   = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
                task  = FUN_140010cd8(taskbars, mon)        HMONITOR -> taskbar
                if (task == 0) return;                      <--  placement skipped
                if (the taskbar already hosts hwnd in the right band) return;
                FUN_140011960(taskbars, hwnd, group->band)

FUN_140010cd8   HMONITOR -> taskbar
                linear search of the list at param_1+0x1C0, comparing the
                taskbar's stored HMONITOR against the requested one

FUN_140011960   the migration
                re-scans the taskbar list at param_1+0x188 for the entry whose
                HMONITOR equals MonitorFromWindow(hwnd, 2), and posts
                WM_0x552 to *(param_1 -  0x30) with the displaced window

FUN_140010d90   sibling lookup: HMONITOR -> the HWND currently occupying a band
```

### The data structures

| list | offset from the taskband object | contents |
|---|---|---|
| task groups | `param_1 + 0x100` | one entry per window: `[0]` = HWND, `[0x1C]` = band index |
| taskbars | `param_1 + 0x188` | one entry per taskbar: `[0]` = HMONITOR, `[1..4]` = HWND per band |
| taskbars | `param_1 + 0x1C0` | one entry per taskbar: `[0]` = HMONITOR |

Each taskbar entry holds **four** band slots (`param_3 < 4` in
`FUN_140011960`), which is why a monitor can host several independent bands.

## Why the taskbars know their monitor

Each taskbar window carries its HMONITOR as a window property:

```c
// Taskbar.dll, FUN_18002efe0
SetPropW(hWnd, L"TaskbarMonitor", this->m_hMonitor);
```

and explorer.exe reads it back. The literal `TaskbarMonitor` appears in both
binaries (`explorer.exe` RVA 0x219ED8, `Taskbar.dll` RVA 0x1C1028), so it is the
contract between the taskband and the taskbar instances.

explorer.exe's only reference to the string is inside `FUN_140010ef4`, which is
the taskbar **destructor**, it calls `RemovePropW(hwnd, L"TaskbarMonitor")`
alongside the other `TaskbarDPI_*` properties. The property itself is written by
`Taskbar.dll`.

## Dynamic confirmation

Frida 17.17.0 attached to the live `explorer.exe` (pid 7080) with hooks on
`MonitorFromWindow`, `MonitorFromRect`, the `TaskbarMonitor` property, and the
six functions of the chain above. A bare Win32 probe window
(`experimental/scripts/move_window.py`) was moved across the monitor boundary three times.

Result:

```
[MON] MonitorFromWindow 0x...c8 [TaskbarFixProbe] flags=DEFAULTTOPRIMARY -> MON#0 ...
[MON] MonitorFromWindow 0x...c8 [TaskbarFixProbe] flags=DEFAULTTOPRIMARY -> MON#1 ...
      ... alternating correctly with each move ...
```

* The shell **does** notice the move and **does** resolve the new monitor
  correctly. The resolution alternates MON#0 / MON#1 in exact step with the
  probe window's position.
* The resolution uses `MONITOR_DEFAULTTOPRIMARY` (0), not
  `MONITOR_DEFAULTTONEAREST` (2), at this call site. That is not the bug: the
  window was wholly inside one display, so both flags agree. It does mean the
  answer degenerates to "the primary" whenever the window intersects no
  display, which is worth correcting.
* **Zero `CHAIN` events across the whole trace.** The dispatcher, the
  re-evaluation and the migration were never entered, not once, during six
  cross-monitor moves.

So the placement logic is intact and the monitor arithmetic is right, the
trigger is missing.

## What the fix therefore has to do

Not "compute the monitor differently". The monitor is already computed
correctly. The fix has to make the shell **re-run the placement decision** when
a window's owning monitor changes.

Concretely, the options are:

1. **Trigger the existing path.** Find how the shell normally issues opcode 9
   and reproduce it when a window's monitor changes. The dispatcher
   `FUN_1400603f0` has exactly one caller (RVA 0x21D92), inside a very large
   function (RVA 0x21C90..0x23B66) that is almost certainly the taskband's
   window procedure. If opcode 9 maps to a window message, the fix is to post
   that message. This is the preferred route: it reuses the shell's own
   bookkeeping, including the task-group/AUMID grouping, the band index and the
   virtual-desktop rules.
2. **Call the chain directly.** From a hook on the shell's window-move
   notification, invoke `FUN_140067cc8` with a synthesised command structure.
   Viable, but it depends on the taskband object pointer and on the shape of
   the command structure, both of which are build-specific and harder to keep
   correct across updates than option 1.
3. **Do the migration ourselves.** Resolve the target taskbar for the window's
   monitor and post the shell's own `WM_0x552` migration message. This is the
   most invasive and most likely to get the grouping and virtual-desktop rules
   wrong.

Option 1 is the target. Everything needed for it is now known except the
message-to-opcode mapping.

## Tooling built for this phase

| script | purpose |
|---|---|
| `experimental/scripts/trace_taskbar.py` | Frida driver: attaches to explorer.exe, streams hook output |
| `experimental/scripts/trace_taskbar.js` | the tracer: monitor APIs, the `TaskbarMonitor` property, and the six chain functions |
| `experimental/scripts/move_window.py` | creates a bare Win32 probe window and drags it across the monitor boundary, so the experiment is deterministic instead of manual |

Frida 17 notes that cost time:

* `Module.getExportByName` and `Module.getBaseAddress` were **removed**. Use
  `Process.getModuleByName(name).getExportByName(name)`.
* `Interceptor.replace` does **not** return a callable original. Use
  `Interceptor.attach`, which also allows rewriting `args[]` in place, which is
  what a fix needs anyway.
* `Thread.backtrace(..., Backtracer.ACCURATE)` mis-attributes frames in a
  stripped binary. `this.returnAddress` is exact.

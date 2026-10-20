# Phase 2: Root cause

> **SUPERSEDED, see `07-correction.md`.**
> The *analysis* in this note (the mapped decision chain) is accurate and still
> useful. The *conclusion* is wrong: the placement chain does run on a window
> move, and the real cause is the `MMTaskbarMode` registry value being set to
> 0 ("All taskbars"). The trace that led to the wrong conclusion used a probe
> window the shell never tracked as a taskbar window.

## Verdict (SUPERSEDED)

**The Windows 11 taskband has no window-move trigger. That is the entire bug.**

The placement logic is correct. The monitor arithmetic is correct. The native
setting is correct. The placement decision is simply **never re-evaluated**
when a window crosses a monitor boundary, because nothing in the shell tells
it to.

## Evidence

### 1. The placement chain (static, explorer.exe)

```
FUN_140021c90   taskband window procedure
                case 0x4a (WM_COPYDATA) -> FUN_1400603f0(param_1, lParam)
                case 0x552             -> the migration message
                case 0x7e (WM_DISPLAYCHANGE) -> FUN_14007a468(param_1)

FUN_1400603f0   command dispatcher; opcode = *(uint *)(cmd + 0x28)
                where cmd = COPYDATASTRUCT->lpData
                opcode 9 -> FUN_140067cc8(param_1, cmd)

FUN_140067cc8   the re-evaluation
                hwnd  = *(HWND *)(cmd + 4)
                mon   = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
                task  = FUN_140010cd8(taskbars, mon)
                if (task == 0) return;
                FUN_140011960(taskbars, hwnd, group->band)

FUN_140011960   the migration; posts WM_0x552 to the taskband window
```

### 2. The shell never subscribes to window-move events

`explorer.exe` imports `SetWinEventHook` and calls it exactly **twice**:

```c
// FUN_1400776e0
hWinEventHook = SetWinEventHook(0x20, 0x20, NULL, FUN_14005e320, 0, 0, 0);

// FUN_1400faf84
pHVar2 = SetWinEventHook(0x20, 0x20, NULL, FUN_14017f650, 0, 0, 0);
```

`0x20` is `EVENT_SYSTEM_FOREGROUND`. **Both registrations are for the
foreground event and nothing else.** There is no `EVENT_OBJECT_LOCATIONCHANGE`
(0x800B) subscription anywhere in explorer.exe.

The two foreground handlers are:

* `FUN_14005e320`, reacts to high-contrast / theme changes.
* `FUN_14017f650`, calls into the shell view coordinator.

Neither is a taskbar placement trigger.

### 3. The dynamic trace

Frida 17.17.0 on the live `explorer.exe` (pid 7080), with a bare Win32 probe
window dragged across the monitor boundary three times (six moves):

* The shell **did** notice every move and **did** resolve the new monitor
  correctly, the result alternated `MON#0` / `MON#1` in exact step with the
  window's position.
* But those resolutions came from `Taskbar.dll+0x7389d` and `twinui.dll+0x68d55`
  -  the **XAML taskbar layer**, not the taskband.
* The taskband's placement chain fired **zero** times for the app window. The
  only `migrate` calls in the whole trace were for the taskbar's own window
  (`Shell_TrayWnd`, slot 3).

So the move is observed by one half of the shell and never reaches the half
that owns button placement.

### 4. Why the symptom looks the way it does

The button *does* eventually follow the window, whenever something else
re-evaluates the band:

* the window is clicked (foreground change),
* it is minimised and restored,
* the display configuration changes (`WM_DISPLAYCHANGE`),
* the window is recreated.

That is exactly the long-standing user report: *"if I drag a certain window
from monitor 2 to monitor 1, and back to monitor 2, then the app tab will also
move to monitor 2"*. A round trip re-triggers the re-evaluation.

### 5. Why the DPI scale made it look like a scaling bug

The mixed 125% / 100% setup is what makes the bug *visible* rather than
latent. On a uniform-scale setup the taskband's single taskbar is the only
candidate and the placement looks correct by accident, so nobody notices that
the re-evaluation never happened. With a secondary taskbar, the stale placement
becomes obvious.

The scale is not the cause of the wrong placement, it is only the reason the
wrong placement is visible. This matters for the fix: **no coordinate or
scaling correction is needed.** The decision function already resolves the
monitor correctly with `MONITOR_DEFAULTTONEAREST`.

## Consequences for the design

* The original plan, hook the monitor resolution and force
  `MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)`, is **unnecessary**. The
  shell already does exactly that at `FUN_140067cc8`.
* The fix has to **create the missing trigger**, not correct a wrong answer.
* The fix therefore has to be a *notification*, not a *correction*: when a
  window's owning monitor changes, the taskband must be told to re-evaluate.
* Doing it out of process is impossible without the shell's internals: the
  taskband's re-evaluation entry points are private functions reached through
  a private message protocol. So the intervention is in-process.

## Candidate fixes, ranked

### A. Synthesize the shell's own re-evaluation command (preferred)

The taskband accepts commands over `WM_COPYDATA`. The dispatcher reads:

* `cmd + 0x04`, the window handle
* `cmd + 0x28`, the opcode; `9` means "re-evaluate this window's placement"

The command content is marshalled by `FUN_1400c3dd0`, and the two producers
are `FUN_1400dcec8` and `FUN_1400df004`, both of which use
`SendMessageTimeoutW(hwnd, WM_COPYDATA, 0, cmd, SMTO_ABORTIFHUNG|SMTO_BLOCK|SMTO_ERRORONEXIT, timeout, &result)`.

If the shim reproduces that structure it can ask the shell to re-evaluate a
window using the shell's own code path, which keeps AUMID grouping, the band
index and the virtual-desktop rules correct for free.

*Needs:* the exact layout of the marshalled command, and the opcode-9 payload.

### B. Call `FUN_140067cc8` directly

The shim can obtain the taskband object pointer by hooking the taskband
window procedure (its `this` is the first argument), then call
`FUN_140067cc8(taskband, cmd)` with a hand-built command.

*Needs:* the taskband object pointer and the same command layout. More
coupled to the build than option A, because it calls a private function
directly rather than going through a message.

### C. Re-register the shell's event hook with a wider range

Not possible: the shell's `SetWinEventHook` registration has already happened
with `eventMin == eventMax == 0x20` and cannot be widened from outside.

### D. Out-of-process nudge

Rejected. It reacts to the symptom, and it cannot reach the shell's private
re-evaluation path.

## Where the trigger comes from

The shim needs to know that a window changed monitor. The cleanest source is a
WinEvent hook the shim installs itself, from inside explorer.exe:

```c
SetWinEventHook(EVENT_OBJECT_LOCATIONCHANGE,   /* 0x800B */
                 EVENT_OBJECT_LOCATIONCHANGE,
                 NULL, ourCallback, 0, 0,
                 WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
```

The callback resolves the monitor with
`MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)` and compares it with the
value recorded the last time the window was seen. A change means the window
crossed a boundary and the taskband must re-evaluate.

This is DPI-independent by construction: `MONITOR_DEFAULTTONEAREST` names a
physical monitor and is unaffected by logical scaling.

`EVENT_OBJECT_LOCATIONCHANGE` is a hot event, so the callback must be cheap:
a hash lookup of the window handle against a small table of last-seen
monitors, and a `MonitorFromWindow` only when the window is plausibly
taskbar-eligible.

## Status of the plan

Phases 1 and 2 are complete and the root cause is established. Phase 3 has to
change shape: the hook no longer corrects a monitor resolution, it injects a
missing notification. The shim infrastructure already built (SHA-256
fingerprinting, AOB anchoring, fail-safe installation, no-admin loader) applies
unchanged; only the payload of the intervention changes.

The remaining unknown is the exact layout of the marshalled re-evaluation
command. That is what phase 1's static work continues on, in
`FUN_1400c3dd0` and the two producers.

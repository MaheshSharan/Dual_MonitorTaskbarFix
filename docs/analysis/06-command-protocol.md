# Phase 3: How to deliver the missing notification

## What is now certain

The taskband's re-evaluation is reached from exactly one place:

```
FUN_140021c90   taskband window procedure
                case 0x4a (WM_COPYDATA)
                  -> FUN_1400603f0(param_1, lParam)

FUN_1400603f0   dispatcher
                cmd  = *(COPYDATASTRUCT **)(param_2 + 0x10)   // lpData
                op   = *(uint *)(cmd + 0x28)
                op == 9  ->  FUN_140067cc8(param_1, cmd)
```

and `FUN_140067cc8` needs only two things:

```c
void FUN_140067cc8(longlong taskband, longlong cmd)
{
    HWND  hwnd = *(HWND *)(cmd + 4);          // <--  the only field it reads from cmd
    ... find the task group for hwnd in taskband->groups        (taskband + 0x100)
    ... mon  = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
    ... task = lookup taskbar whose HMONITOR == mon            (taskband + 0x1C0)
    ... FUN_140011960(taskband + 0x38, hwnd, group->band)
}
```

**Everything else is derived by the shell itself.** The command payload only
has to carry the window handle at offset 4; the band index, the group, the
target taskbar and the migration are all looked up internally.

So the two things a fix needs are:

1. the **taskband object pointer** (`param_1`), and
2. a **four-byte window handle** in the payload.

## Why the taskband object is not simply available

The taskbar windows are not plain Win32 windows:

```
Shell_TrayWnd            hwnd=0x302CE  GWLP_USERDATA=0  GWLP_WNDPROC=0
Shell_SecondaryTrayWnd   hwnd=0x302FE  GWLP_USERDATA=0  GWLP_WNDPROC=0
```

Both user-data and window-proc are zero, because the taskbar windows are
XAML-hosted and the taskband's `FUN_140021c90` is a **member** function
(`this` in rcx, hwnd in rdx), invoked through a thunk rather than as the
window's own window procedure. The object pointer therefore cannot be read
out of the window.

## The command producer is not in Taskbar.dll

The taskband's command channel is `WM_COPYDATA`, and the payload's opcode sits
at `+0x28`. Searched and ruled out:

* `Taskbar.dll`, no `SendMessageW`/`PostMessageW` with `0x4a`, no write of a
  literal `9` into a `+0x28` field.
* `explorer.exe`, the only in-module producers of `WM_COPYDATA` are
  `FUN_1400dcec8` and `FUN_1400df004`, and their only caller chain leads to
  `FUN_1400decbc`, which is the **Feature Experience Direct Launch** path
  (`FEDirectLaunch_WinEHookTest::reason::direct_launched`), not the taskbar.

The marshalling helper is `FUN_1400c3dd0`:

```c
*param_1 = 0;                                    // dwData = 0, cbData = 0
*(int *)(param_1 + 1) = *(int *)(param_2 + 1) * 2 + 2;   // dwFlags
param_1[2] = *param_2;                           // lpData = caller's first qword
```

so the caller supplies a 16-byte `{ pointer-to-payload, size }` pair, and
`lpData` is that pointer. The payload is a separate, larger structure.

The protocol is asynchronous and coroutine-based (`wil::result_macros.h`
assertion path, `FUN_1400bd7b4` allocation helper, `FUN_1400215ec`), so the
opcode is not a literal constant that a grep can find.

## The remaining unknown

**How a caller causes an opcode-9 payload to be delivered to the taskband.**
Equivalently: which code path builds a payload with `9` at `+0x28` and the
window handle at `+4`.

## Options for closing it

### A. Continue statically

Trace who writes the payload's `+0x28` field with the value 9, working back
from the dispatcher's switch. The payload is a C++/Wil structure with an
asynchronous producer, so this is a multi-hop walk through the taskband's
command plumbing. Slow but zero risk to the machine.

### B. One controlled live capture

Observe the taskband's command traffic instead of guessing its layout:

* redirect `SendMessageTimeoutW` in explorer.exe's import table (IAT
  redirection, no code patching), that API is called rarely, so it is nothing
  like the paint-loop hook that caused the earlier stall;
* when a `WM_COPYDATA` is sent to the taskband, dump the payload bytes and
  the `COPYDATASTRUCT`;
* catch one opcode-9 payload and read its layout directly.

This is materially safer than the earlier experiment: the previous stall came
from hooking `MonitorFromRect`, which the taskbar calls thousands of times per
second during its own layout. `SendMessageTimeoutW` is not on any hot path.

### C. Bypass the command protocol entirely

Call `FUN_140067cc8(taskband, payload)` directly with a four-byte payload.
This needs the taskband object pointer, which in turn needs an inline hook on
the dispatcher to capture it, the one option that reintroduces trampoline
risk into the shell, and the least attractive.

### D. Use the shell's own refresh primitive

`case 0x552` in the taskband window procedure is:

```c
SetWindowPos((HWND)wParam, NULL, 0, 0, 0, 0,
              SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
```

i.e. "refresh this window's frame". `FUN_140011960` posts exactly this
message with the displaced window as `wParam`. If refreshing a window's frame
causes the taskband to re-evaluate that window's band, then the fix is simply
to post `WM_0x552` to the taskband window for the window that moved, no
command layout, no object pointer, no inline hook.

**This is the cheapest option to test and the most attractive if it works.**
It needs the taskband window handle, which is a global in explorer.exe
(`DAT_140283398` is used as the taskband window in `FUN_1400115e8`), plus a
check of whether `case 0x552` is reachable from the shell's normal refresh
path.

## Recommendation

Test **D** first, because it is by far the smallest change. If refreshing the
frame does not re-evaluate the band, fall back to **B** for the exact command
layout, then **A** only if necessary. **C** is a last resort: it is the only
option that puts a trampoline into the shell, and that is exactly the class of
risk this project exists to avoid.

Whatever the mechanism, the trigger side is already settled and needs no
further reverse engineering:

```c
SetWinEventHook(EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE,
                 NULL, onLocationChange, 0, 0,
                 WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
```

with `MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)` compared against the
last seen value per window. That is physical, DPI-independent, and cheap.

# Phase 3: Hook design

## What the shim does

The shell's own monitor resolution is intercepted at the import boundary. When
the call originates from the recorded decision function, the answer is replaced
with the physical monitor of the live window handle:

```c
MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
```

`MONITOR_DEFAULTTONEAREST` names a physical display and is unaffected by logical
scaling, which is the whole point: the failure mode is caused by a scaled
coordinate being interpreted as a physical one.

## Why IAT redirection and not an inline trampoline

The first design considered an inline hook (Dobby / MinHook) on the decision
function. It was rejected:

| concern | inline trampoline | IAT redirection |
|---|---|---|
| prologue rewriting | rewrites hot shell code | none |
| RIP-relative fixups | the classic source of trampoline bugs | not applicable |
| original function | needs a reconstructed trampoline | still reachable via `GetProcAddress` |
| rollback | patch must be reversed byte by byte | one pointer write restores it |
| crash blast radius | a bad trampoline crashes the shell | a bad pointer only breaks one import |
| dependency | MinHook or Dobby must be vendored | none |

Because the fix is a *correction of a value the shell asks for*, redirecting the
import is sufficient and strictly safer. No shell code is modified.

The cost is that the hook sees every `MonitorFromWindow` call in the importing
module, so the caller is checked against the recorded decision function's address
range before any correction is applied. Everything else passes through untouched.

## Layout

```
experimental/injector/
  CMakeLists.txt          MSVC, x64 only, static CRT
  build.ps1               locates MSVC Build Tools via vswhere, no dev prompt needed
  fingerprints.json       per-build table (source of truth)
  src/
    support.h             SHA-256, wildcard AOB scanner, module helpers, logging
    iat.h                 import directory walk, slot discovery and patching
    fingerprints.h        GENERATED from fingerprints.json
    TaskbarFix.cpp        the shim
  loader/
    inject.py             no-admin loader
```

## Fail-safe chain

Every step below refuses to act rather than acting wrongly:

1. `ProgrammableTaskbarStatus` must be `2`. Any other value means the user asked
   for a different taskbar layout, and the shim does nothing.
2. The target module's SHA-256 must match a table entry exactly. A Windows
   update that changes the shell disables the fix instead of corrupting it.
3. The AOB pattern must match **exactly one** site in the module. Zero matches
   (the function changed) or several matches (the pattern is too broad) both
   abort the install.
4. The module must actually import `USER32!MonitorFromWindow`; if it does not,
   the install aborts.

The shim never changes shell behaviour on a build it does not recognise.

## Why no administrator rights are needed

`explorer.exe` runs at the same integrity level as the interactive user session.
A process at the same integrity level can open it for write access, so the
loader maps the DLL directly. There is no remote-thread injection, no service,
no UAC prompt and no scheduled task. That matters for distribution: the fix can
be applied by an ordinary user, and can be applied per-user.

## Build result

```
TaskbarFix.dll   135.5 KB
imports          KERNEL32.dll, ADVAPI32.dll
```

No `USER32.dll` import (the one API needed is resolved with `GetProcAddress` at
runtime), no `VCRUNTIME140.dll`, no `api-ms-win-crt-*`. The CRT is linked
statically so the shim cannot fail to load on a machine without the Visual C++
redistributable, and cannot introduce a second runtime into the shell.

## Known gap

The fingerprint table is currently empty. `experimental/scripts/gen_fingerprints.py` emits a
sentinel entry and `kBuildCount = 0`, so the shim installs nothing and the shell
behaves natively. The table is populated once the decision function in
`explorer.exe` has been confirmed by both static and dynamic analysis.

Populating it requires, for each supported build:

* the module SHA-256 (`experimental/scripts/peinfo.py info <module>`),
* the decision function's AOB pattern (`experimental/scripts/aobgen.py --file <module> --rva <rva>`),
* the decision function's RVA and byte length.

The generator verifies the pattern is unique inside the module before emitting
it, so an over-broad signature cannot ship.

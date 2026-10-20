# Security policy

## Scope

Dual Monitor Taskbar Fix reads and writes **one** per-user registry value and
may restart Explorer:

```
HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced
    MMTaskbarMode   (REG_DWORD)
```

It is the same value Windows' own Settings app writes when you pick
"Taskbar where window is open". Nothing else on the machine is touched.

## What this project does not do

* It does not require administrator rights. It writes to `HKEY_CURRENT_USER`
  only, so it cannot affect other accounts or machine-wide state.
* It does not inject code, load a DLL into `explorer.exe`, patch the shell, or
  hook any Windows API. There is no binary blob, no driver and no service.
* It does not open a network connection.
* It does not install anything. `npm/bin/dual-monitor-taskbar-fix.js` is a
  single JavaScript file with no dependencies, and the three PowerShell commands
  in the README need nothing at all.
* It does not change any other setting, and it does not write to `HKLM`.

## Reversibility

Every change is reversible:

* The previous value is written to `~/.dualmonitortaskbarfix-backup.json`
  before anything is changed, including the case where the value did not exist
  before.
* `npx dual-monitor-taskbar-fix --reset` puts the previous value back, including
  removing the value again if it was not set before.
* The same change can be made entirely through the Settings UI, and reverted
  the same way.

## Reporting a vulnerability

Report security issues privately rather than through a public issue. Include
your Windows build (`winver`), your display configuration, and reproduction
steps.

## A note on the `experimental/` directory

`experimental/` contains research tooling, including an `explorer.exe` injector
that was built while the investigation still believed the shell had a placement
bug. **It is not part of the fix, is not needed, and is not covered by this
policy's guarantees.** It is kept because it is the evidence behind
`docs/analysis/`, and because it is a working, fail-safe demonstration of how
the Windows 11 taskbar's per-monitor placement is implemented.

If you are reading this to decide whether to run something from this
repository: use the three PowerShell commands in the README, or
`npx dual-monitor-taskbar-fix --apply`. Do not run anything in `experimental/`.

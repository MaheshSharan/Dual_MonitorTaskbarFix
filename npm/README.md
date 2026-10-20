# dual-monitor-taskbar-fix

Make each monitor's Windows 11 taskbar show only the windows that are actually
on that monitor.

Windows 11 has this feature and it is off by default. The setting that controls
it is not named by the Settings app, and the value name that circulates online
for it belongs to a different setting entirely.

No administrator rights. No network access beyond fetching the package. No
dependencies.

## Use it

```powershell
npx dual-monitor-taskbar-fix --apply     # switch to "taskbar where window is open"
npx dual-monitor-taskbar-fix --reset     # put the previous value back
npx dual-monitor-taskbar-fix --status    # report the current mode
```

`--apply` backs the previous value up to
`~/.dualmonitortaskbarfix-backup.json`, then restarts Explorer so the shell
re-reads the setting. `--reset` restores exactly what was there before.

## Or set it directly

```powershell
Set-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced' -Name MMTaskbarMode -Value 2 -Type DWord
Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2; Start-Process explorer.exe
```

## What it changes

```
HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced
    MMTaskbarMode   (REG_DWORD)

    0   All taskbars                                        (the default)
    1   Main taskbar and taskbar where window is open
    2   Taskbar where window is open                        (what most people want)
```

In mode 0 every window's button is drawn on every taskbar, so a button never
appears to leave the monitor it came from. In mode 2 each taskbar shows only the
windows on its own monitor, and buttons follow windows as they are dragged
between displays.

## Requirements

* Windows 11, version 22H2 or later
* Two or more displays in extended mode
* Node.js 16 or later

## Licence

MIT

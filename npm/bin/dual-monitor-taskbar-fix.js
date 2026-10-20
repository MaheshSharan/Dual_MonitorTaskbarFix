#!/usr/bin/env node
/*
 * dual-monitor-taskbar-fix - make each monitor's Windows 11 taskbar show only
 * the windows that are actually on that monitor.
 *
 * Usage:
 *   dual-monitor-taskbar-fix --apply    switch to "taskbar where window is open"
 *   dual-monitor-taskbar-fix --reset    put the previous value back
 *   dual-monitor-taskbar-fix --status   report the current mode (default)
 *   dual-monitor-taskbar-fix --help     show this help
 *
 * Flags:
 *   --no-restart   write the registry value but leave Explorer running
 *
 * Registry key:
 *   HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced
 *       MMTaskbarMode  REG_DWORD
 *         0  All taskbars                              (Windows default)
 *         1  Main taskbar and taskbar where window is open
 *         2  Taskbar where window is open
 *
 * No administrator rights needed. No network access. No dependencies.
 */

'use strict';

const os   = require('os');
const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REG_KEY   = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced';
const REG_VALUE = 'MMTaskbarMode';
const BACKUP    = path.join(os.homedir(), '.dualmonitortaskbarfix-backup.json');

// Compiled once; used in every readMode() call.
const MODE_RE = new RegExp(REG_VALUE + '\\s+REG_DWORD\\s+0x([0-9a-fA-F]+)');

const MODES = {
  0: 'All taskbars',
  1: 'Main taskbar and taskbar where window is open',
  2: 'Taskbar where window is open',
};

// Explorer must restart to pick up the registry change.
const RESTART_CMD =
  'Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue; ' +
  'Start-Sleep -Seconds 2; Start-Process explorer.exe';

// ---------------------------------------------------------------------------

function reg(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('reg.exe', args, { encoding: 'utf8', windowsHide: true });
  } catch (e) {
    const detail = ((e.stdout || '') + (e.stderr || '')).trim();
    if (allowFailure) return detail;
    throw new Error(`reg.exe ${args.join(' ')} failed: ${detail}`);
  }
}

function readMode() {
  const out = reg(['query', REG_KEY, '/v', REG_VALUE], { allowFailure: true });
  const m   = out.match(MODE_RE);
  return m ? parseInt(m[1], 16) : null;
}

function writeMode(n) {
  reg(['add', REG_KEY, '/v', REG_VALUE, '/t', 'REG_DWORD', '/d', String(n), '/f']);
}

function readBackup() {
  try {
    return JSON.parse(fs.readFileSync(BACKUP, 'utf8'));
  } catch {
    return null;
  }
}

function writeBackup(data) {
  try {
    fs.writeFileSync(BACKUP, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`  warning: could not write ${BACKUP}: ${e.message}`);
  }
}

function restartExplorer() {
  console.log('Restarting Explorer so the shell re-reads the setting...');
  try {
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', RESTART_CMD],
      { stdio: 'ignore', timeout: 30_000 }
    );
    console.log('Done. The shell is back up.');
  } catch {
    console.error('  warning: could not restart Explorer automatically.');
    console.error('  Run this yourself:');
    console.error(`    ${RESTART_CMD}`);
  }
}

// Returns display info lines via PowerShell, or null on failure.
function displayLayout() {
  const ps =
    'Add-Type -AssemblyName System.Windows.Forms; ' +
    '[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { ' +
    "'{0}  {1}x{2} at ({3},{4}){5}' -f $_.DeviceName, $_.Bounds.Width, $_.Bounds.Height, " +
    "$_.Bounds.X, $_.Bounds.Y, $(if ($_.Primary) { ' (primary)' } else { '' }) }";
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { encoding: 'utf8', windowsHide: true, timeout: 15_000 }
    );
    return out.split(/\r?\n/).filter((l) => l.trim());
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------

function cmdStatus() {
  const mode      = readMode();
  const effective = mode ?? 0;

  console.log('Windows multi-display taskbar mode');
  console.log(`  ${REG_KEY}\\${REG_VALUE} = ${mode === null ? 'not set (defaults to 0)' : mode}`);
  if (mode !== null) console.log(`  meaning: ${MODES[mode] ?? 'unknown'}`);

  const displays = displayLayout();
  if (displays?.length) {
    console.log('\ndisplay layout');
    displays.forEach((l) => console.log(`  ${l}`));
  }

  console.log('');
  if (effective === 2) {
    console.log('OK: each taskbar shows only the windows on that monitor.');
  } else {
    console.log(`NOT ISOLATED: mode is '${MODES[effective] ?? '?'}'.`);
    console.log("  Every window's button is drawn on every taskbar.");
    console.log("  Run with --apply to switch to 'Taskbar where window is open'.");
  }
  return 0;
}

function cmdApply(noRestart) {
  const before = readMode();
  if (before === 2) {
    console.log("Already set to 'Taskbar where window is open'.");
  } else {
    writeBackup({ value_name: REG_VALUE, previous: before, when: new Date().toISOString() });
    writeMode(2);
    console.log(`Set ${REG_VALUE} = 2 (Taskbar where window is open).`);
    console.log(
      before === null
        ? `  Previous value (not set) saved to ${BACKUP}`
        : `  Previous value (${before}, '${MODES[before] ?? '?'}') saved to ${BACKUP}`
    );
  }
  if (!noRestart) {
    console.log('');
    restartExplorer();
  }
  return 0;
}

function cmdReset(noRestart) {
  const backup = readBackup();
  if (backup?.previous != null) {
    const previous = Number(backup.previous);
    writeMode(previous);
    console.log(`Restored ${REG_VALUE} = ${previous} (${MODES[previous] ?? '?'}).`);
  } else {
    writeMode(0);
    console.log(`No saved value found; reset ${REG_VALUE} to 0 (${MODES[0]}).`);
    console.log("That is the Windows default — every window's button will appear on every taskbar again.");
  }
  if (!noRestart) {
    console.log('');
    restartExplorer();
  }
  return 0;
}

function usage() {
  console.log(`dual-monitor-taskbar-fix — per-monitor Windows 11 taskbar isolation

Usage:
  dual-monitor-taskbar-fix --apply      switch to "taskbar where window is open"
  dual-monitor-taskbar-fix --reset      put the previous value back
  dual-monitor-taskbar-fix --status     report the current mode (default)

Flags:
  --no-restart   write the registry value but leave Explorer running

No administrator rights needed. No network access. No dependencies.`);
}

// ---------------------------------------------------------------------------

function main() {
  if (process.platform !== 'win32') {
    console.error('dual-monitor-taskbar-fix only runs on Windows.');
    process.exit(1);
  }

  const argv      = process.argv.slice(2);
  const flags     = new Set(argv.filter((a) => a.startsWith('--')));
  const noRestart = flags.has('--no-restart');

  if (flags.has('--apply'))               return cmdApply(noRestart);
  if (flags.has('--reset'))               return cmdReset(noRestart);
  if (flags.has('--status'))              return cmdStatus();
  if (flags.has('--help') || flags.has('-h')) { usage(); return 0; }

  // No flags → default to status.
  return cmdStatus();
}

process.exit(main());

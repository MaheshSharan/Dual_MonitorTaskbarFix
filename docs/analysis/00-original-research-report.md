# Modifying Windows 11 Taskbar for Per-Monitor Isolation

> **This is the original research report that started the investigation. Its
> central conclusion is wrong, and the work it recommends was unnecessary.**
>
> It concludes that the shell's taskbar placement logic is broken and needs to
> be reverse-engineered and patched. In fact the placement logic is correct.
> The taskbar was simply in the "All taskbars" mode, which is controlled by
> `MMTaskbarMode`. See `07-correction.md` for the corrected root cause and
> `../../README.md` for the full story.
>
> The report is kept verbatim because it is a good example of how a plausible,
> well-researched document can point the wrong way: it cites
> `ProgrammableTaskbarStatus` as the setting that governs per-monitor taskbar
> behaviour, and that value name belongs to a different setting.

**Executive Summary:** Windows 11's taskbar was rewritten using WinUI, leaving behind many legacy customization hooks. Out-of-the-box, Windows offers "Show taskbar on all displays" and "Show app icons on taskbar where window is open" settings, but these can misbehave (as reported by users). No official API exists to natively isolate taskbar buttons per monitor. The solution space splits into in-process hooks and external monitors. Injecting code into `explorer.exe` allows direct control over taskbar rendering but risks breaking on updates. An out-of-process approach using UI Automation or WinEvent hooks can detect windows moving between monitors, but it cannot easily hide taskbar buttons without interacting with the shell. Alternative solutions include overlaying custom per-monitor taskbars (as done by DisplayFusion/Actual) or replacing the shell. Each approach has trade-offs in complexity, reliability, and maintenance cost.

**Problem & Requirements:** We have a dual-monitor Windows 11 setup (laptop panel + external display, extended desktop, likely different DPIs). The goal is: **each monitor's taskbar shows only the windows on that monitor**. Functional requirements include: when a window moves between monitors, its taskbar button must move to the corresponding taskbar (with minimal delay), and windows should only appear on the taskbar of their current monitor. Minimize flicker or visual artifacts; support maximized/fullscreen, UAC prompts (secure desktop), and virtual desktops. The solution should respect AppUserModelID grouping (so pinned/app-grouped windows behave normally on their monitor's taskbar). **Success criteria:** windows appear only on their current monitor's taskbar, with no duplicate or missing icons; minimal performance overhead; stability across common desktop actions (move, resize, minimize/maximize, unplug monitor, switch desktops).

**Assumptions & Constraints:** We assume Windows 11 (≥22H2 or later) with two monitors in extended mode. Explorer's taskbar code runs in `explorer.exe` (64-bit on Win11). We have administrative rights (for hooking/injection) and can sign code if needed. We do not control third-party apps' code. Taskbar button creation is internal to the Windows shell with **no documented extension point** for modifying which buttons appear on each monitor's taskbar. Solutions requiring unsupported hooks or undocumented interfaces risk breakage on OS updates. We will consider both documented APIs (e.g., Shell COM, UI Automation) and necessary undocumented tricks.

## Windows Shell and Taskbar Architecture

The Windows taskbar is implemented inside the Explorer shell. In Windows 10, **taskbar logic was embedded in the Explorer process**; Windows 11 rearchitected it in WinUI, rewriting the shell's primary navigation. Legacy COM interfaces (like `ITaskbarList`, `ITaskbarList3/4`) exist for apps to control their own buttons (progress, overlays), but the shell itself decides which windows get buttons and where. When any top-level window is created and shown, the shell automatically creates a taskbar button for it and sends the window a `WM_TASKBARBUTTONCREATED` message. There is *no public API* to hide a window's button selectively. Internally, ExplorerPatcher and 7+Taskbar Tweaker demonstrate that the shell uses COM-based task bar classes (`CTaskGroup`, `CWindowTaskItem`, `CTaskBtnGroup` etc.) and that intercepting their vtable methods can alter grouping and visibility. However, Windows 11's WinUI taskbar may no longer use these exact classes or methods.

Taskbar items are grouped by AppUserModelID (AUMID) for pinning and grouping. Changing a window's AUMID can affect its grouping, but does not directly control multi-monitor placement. The new shell supports multiple monitors and per-monitor behaviors via user settings ("Taskbar behaviors" in Settings), but bugs have been reported where windows don't move their taskbar buttons when moved between monitors. Virtual desktops complicate the picture: windows on inactive desktops are hidden entirely and have no taskbar button on the current desktop.

Windows accessibility APIs like UI Automation (UIA) and MSAA provide **events** (e.g., object creation, location-change, focus-change) that can detect windows moving or appearing. Similarly, `SetWinEventHook` can capture global UI events such as `EVENT_OBJECT_CREATE`, `EVENT_OBJECT_LOCATIONCHANGE`, or `EVENT_SYSTEM_MOVESIZEEND` for all windows (with the right privileges). These can track when a window appears or changes position, allowing determination of which monitor it is on via `MonitorFromWindow` and `GetMonitorInfo` (bearing in mind DPI-awareness). However, these hooks are passive; they do not by themselves change taskbar behavior.

## Potential Approaches

### 1. Explorer Injection & Hooking

**Design:** Inject a DLL into `explorer.exe` to intercept taskbar control functions. This could use IAT patching or inline hooks (e.g., via Microsoft Detours or MinHook). For example, one might hook the internal taskbar creation routines or window-procedure handling of the taskbar band. The goal would be: when a button is created for a window, detect the window's monitor (`HMONITOR = MonitorFromWindow(hWnd)`) and *suppress* creation on wrong monitors. One might hook `CreateWindowEx` (since Explorer's taskbar likely creates button windows via that), or hook methods like `CTaskBtnGroup::ShouldShowToolTip` (as 7+Taskbar Tweaker does for other purposes). Another tactic: after Explorer creates a taskbar button (a `HWND` child in the taskbar), call `ShowWindow(hBtnWnd, SW_HIDE)` on it if its associated app window is on a different monitor. To find the button, hook Explorer's internal mapping or use `SetWindowLongPtr` hooks to tag windows.

**Injection Points & Hooks:** Use global Windows hooks or a shell extension to load a DLL into Explorer. Once injected, set hooks on APIs like `CreateWindowExW`, `SetWindowPos`, `ShowWindow`, and relevant COM methods. ExplorerPatcher illustrates hooking via Import Address Table patches (e.g. user32 functions) and inline hook of Explorer methods. One could also subclass `Shell_TrayWnd` (the taskbar) via `SetWindowSubclass` to intercept notifications about button creation. Additionally, handle `TaskbarButtonCreated` messages for new windows to apply logic.

**Pros/Cons:**
- **Pros:** Complete control, can hide/show buttons at the source. Low latency, since it runs in-process. Can directly query window positions and simulate built-in behaviors.
- **Cons:** Highly brittle. Relies on undocumented Explorer internals; Windows updates or changes in WinUI taskbar could break hooks. Requires hooking system processes (potential security/UAC issues) and signed code. Injection complexities: 64-bit vs 32-bit Explorer, UAC, DEP, code signing/UIAccess. Maintenance is heavy (must detect Explorer version).

**Pseudocode Example:**
```cpp
// In injected explorer DLL:
LRESULT CALLBACK TaskButtonWndProc(HWND hWnd, UINT msg, WPARAM wp, LPARAM lp) {
    if (msg == WM_CREATE) {
        HWND appWnd = ...; // map button to application HWND
        HMONITOR hm = MonitorFromWindow(appWnd, MONITOR_DEFAULTTONEAREST);
        if (hm != targetMonitor) {
            ShowWindow(hWnd, SW_HIDE);
        }
    }
    return CallOriginalWndProc(...);
}
```
Or hooking COM vtable (hypothetical):
```cpp
bool Hook_ShouldShowButton(CTaskItem* pItem) {
    HWND app = pItem->GetWindow();
    if (MonitorFromWindow(app, MONITOR_DEFAULTTONEAREST) != assignedMonitor) {
        return false; // suppress button rendering
    }
    return Original_ShouldShowButton(pItem);
}
```

### 2. Global Event Hook (SetWinEventHook)

**Design:** Run a helper process (or service) that sets `SetWinEventHook` for events like `EVENT_OBJECT_CREATE`, `EVENT_OBJECT_LOCATIONCHANGE`, and `EVENT_SYSTEM_FOREGROUND`. Whenever a top-level window appears or moves, the hook callback receives the window handle. The helper can determine the window's current monitor via `MonitorFromWindow`. If it's on Monitor A, and we're enforcing "button only on that monitor's taskbar," then the helper would instruct the shell to ensure the taskbar button is only on Monitor A's taskbar.

However, the Windows shell does not provide a public IPC to hide a specific taskbar button. A possible hack: if we wanted to **remove** a window from a monitor's taskbar, we could move the window off-screen and back (rare hack), or minimize it? None of these are acceptable. More likely, this approach **cannot directly hide buttons**. Instead, it might continuously check whether the system’s setting "show apps where window is open" is honored, and if not, programmatically toggle the setting or restart Explorer (clunky and not per-window).

**Hooks and Behavior:** `SetWinEventHook(EVENT_OBJECT_LOCATIONCHANGE, ..., WINEVENT_OUTOFCONTEXT)` catches moves. `EVENT_OBJECT_SHOW` or `EVENT_OBJECT_CREATE` catches new windows. Filtering for windows (ignore tooltips/children) is needed. The hook proc runs out-of-process, so be mindful of 32/64-bit issues. It cannot call UIA patterns or COM from high-integrity processes easily without UIAccess. It may only log or instruct via external means.

**Pros/Cons:**
- **Pros:** No injection into Explorer. All operations are in user-land (possibly even without admin if using OUTOFCONTEXT). Less risk of crashing Explorer or being banned by signature requirements. Good for monitoring or triggering application logic.
- **Cons:** Cannot modify Explorer's state directly. At best could send (undocumented) IPC or emulate UI actions (e.g., sending WM commands to Explorer windows), which is fragile. There's no documented message like "hide this taskbar button," so this likely fails at fulfilling core requirement without injection. Also, global hooks can be expensive (slows UI) and need message loop.

This approach might be better for *monitoring* and *logging* changes (or driving a separate taskbar UI). On its own, it cannot satisfy hiding/showing icons.

### 3. UI Automation / Accessibility Events

**Design:** Similar to global hooks, a background process or DLL can use UI Automation (UIA) or MSAA to subscribe to events on the "Taskbar" UI elements. For example, UIA can find all elements under the TaskBar control and detect children being added or changed. One could then collapse or remove elements. In practice, UIA is meant for read-only automation; it does not allow modifying the UI of other processes. Even if one finds the AutomationElement for a taskbar button, there is no UIA pattern to *hide* it. UIA events would duplicate SetWinEventHook capability and suffer similar limitations.

**Pros/Cons:**
- **Pros:** Similar to event hook but using a higher-level API; can identify specific UI elements. Might work around some threading issues.
- **Cons:** Cannot programmatically remove or hide elements. More complex setup (requires UIA COM calls, thread apartment model). Same limitations as WinEventHook. Could supplement other approaches (e.g., update a custom overlay) but cannot achieve hiding itself.

### 4. Separate Per-Monitor Taskbar

**Design:** Instead of modifying Explorer's taskbar, disable or hide the secondary-monitor taskbar(s), and create custom windows that act as taskbars on each monitor. These custom taskbars would enumerate all top-level windows on their monitor, and draw buttons for them. They could also integrate AppUserModelIDs, jump lists, Start menu, tray icons, etc. This is essentially what DisplayFusion or Actual does. It requires hooking or hiding the native taskbar (via settings or lower-level hacks) so only the main Explorer taskbar remains (or none, and you mimic all taskbars).

**Pros/Cons:**
- **Pros:** Complete freedom, you control exactly what appears on each monitor. You can implement the desired "isolated" behavior directly. Isolated from Explorer's updates (except compatibility for enumerating windows).
- **Cons:** Very heavy lift. You essentially re-implement the taskbar UI (buttons, grouping, tray, clock, start menu). This duplicates a huge part of the shell UI. Integration with Windows UI (like Start menu hotkeys, press Win, notifications) becomes complex. Security issues, hooks to capture applications for icons, etc. Also high maintenance (needs to emulate each shell feature). Better approached as a product than a small engineering project.

### 5. Shell Replacement / Partial Shell

**Design:** Replace the Windows shell with a custom one that provides per-monitor taskbars. Windows allows a custom shell (via registry `HKLM\…\Winlogon\Shell`), but fully replacing Explorer means losing standard desktop, start menu, etc. A compromise is to patch Explorer to load a different taskbar module, but Microsoft has removed many extension points in WinUI.

**Pros/Cons:**
- **Pros:** Total control if done perfectly.
- **Cons:** Nearly impossible to fully replicate Explorer's shell features. Windows may reject unsigned or incomplete shells. Highly discouraged for a simple feature.

### 6. Existing Settings & Third-Party Tools

**Design:** Use Windows built-in “Taskbar where window is open” setting. In Windows 11 Settings → Personalization → Taskbar → Taskbar behaviors, set “Show my taskbar on all displays” and “Show app icons where window is open”. This *should* cause each window’s icon to appear only on its current monitor’s taskbar. Many users report this sometimes fails, but it is the intended behavior (and was default in Windows 10). Registry hacks (setting `MMTaskbarEnabled`) and Group Policy can enforce similar toggles. Third-party apps like DisplayFusion or Actual Multiple Monitors provide more flexible multi-monitor taskbars (some can duplicate pinned icons on all monitors, etc.); they may allow “Show only windows on this monitor” modes.

**Pros/Cons:**
- **Pros:** Zero development cost. Windows settings cover many use-cases. Third-party tools may suffice if they offer the needed mode.
- **Cons:** The built-in setting may not work in all cases (especially buggy programs or specific monitors). Third-party tools are proprietary and may not precisely meet the isolation requirement (they often aim to show all windows on all taskbars or one taskbar for all). Also, relying on user settings or external apps doesn’t scale to an enterprise deployment easily.

## Windows APIs and Concepts

- **Shell COM APIs:** `ITaskbarList3/4` (in `Shobjidl_core.h`) allow an app to interact with its own taskbar buttons (thumbnails, progress, overlays). There is no COM API for controlling visibility of other process’s buttons. AppUserModelID (AUMID) is used by the shell to group and identify taskbar entries. Changing the AUMID of a window can affect its grouping, but not monitor assignment.
- **UI Automation & WinEvents:** `SetWinEventHook` (in `WinUser.h`) can register for system-level UI events. For example, hooking `EVENT_OBJECT_CREATE`/`DESTROY`/`SHOW`/`HIDE`/`LOCATIONCHANGE` can track top-level windows. An out-of-context hook receives notifications in the hooking process’s thread (requires a message loop). The hook function can call `MonitorFromWindow(hWnd, MONITOR_DEFAULTTONEAREST)` to determine which monitor a window is on. `EVENT_SYSTEM_FOREGROUND` can track active window changes. UIA can similarly subscribe to AutomationFocusChanged or StructureChanged events, but cannot modify UI.
- **Monitor Mapping:** `MonitorFromWindow(HWND, flags)` and `GetMonitorInfo` (WinUser API) map a window to a monitor rectangle. For per-monitor DPI, use `GetDpiForWindow(HWND)` (Win10+) or the older `GetDeviceCaps` on monitor DC. The hook code and any injected DLL must declare appropriate DPI awareness (e.g., PROCESS_PER_MONITOR_DPI_AWARE) to get accurate sizes. Remember that in multi-DPI setups, windows moving between monitors may receive DPI change messages (`WM_DPICHANGED`), affecting their size.
- **Window Hierarchy & Z-order:** Taskbar buttons may have parent windows (e.g., the “TrayWnd” or `ReBarWindow32` or a WinUI equivalent). Manipulating an owned window may need careful handling of z-order. Fullscreen or topmost windows can suppress the taskbar (e.g., games hide it), which should be respected. Owner/owned relationships mean a child window might not appear on taskbar (common dialogs are usually hidden from taskbar by default). Hooks should account for window styles (like `WS_EX_APPWINDOW`, `WS_EX_TOOLWINDOW`).
- **Virtual Desktops:** Use `IVirtualDesktopManager` (in `Shobjidl_core.h`) to query if a window is on the current desktop (`IsWindowOnCurrentVirtualDesktop`) or get its desktop ID. Only windows on the active desktop should be shown. When desktops switch, the hooking logic should hide buttons for windows now invisible.

## Hooks and Code Considerations

- **Language & Libraries:** C++/Win32 is recommended for low-level Windows API and COM access. C#/.NET could use P/Invoke for some parts, but UI hooks typically require unmanaged code. Use Visual Studio with Windows 11 SDK. Code must be built for 64-bit (Explorer is 64-bit) and possibly 32-bit (for hooking other processes).
- **COM Threading:** If the code uses COM (e.g., `CoCreateInstance(CLSID_VirtualDesktopManager, IID_IVirtualDesktopManager)` or UI Automation), initialize COM appropriately: `CoInitializeEx(NULL, COINIT_APARTMENTTHREADED)` on an STA or `COINIT_MULTITHREADED` on a worker thread. Explorer’s COM calls (if hooking COM vtables) may require matching its threading model (likely STA for UI).
- **Security/Privileges:** Injecting into Explorer or using global WinEventHooks may require running as administrator or using UIAccess privileges. System processes (e.g., UAC secure desktop) are out-of-scope (taskbar is disabled on secure desktop). Code injection often requires the DLL to be code-signed or placed in a secure folder (especially for UIAccess, but 64-bit Explorer may load any DLL if injected via CreateRemoteThread from admin).
- **64-bit vs 32-bit:** Modern Windows 11 explorer.exe is 64-bit. Shell extensions and hooks must match bitness. A 32-bit helper cannot hook a 64-bit process; you’d need separate versions. Also, 32-bit apps have their own taskbar interactions (rarely relevant on 64-bit OS, but for completeness).
- **Undocumented Interfaces:** Using COM interfaces like `IVirtualDesktopManagerInternal` (undocumented) could allow catching desktop-switch events. Some taskbar behaviors might hide behind internal COM (e.g., `ITrayNotify` is a known reverse-engineered interface for the notification area). These are risky: Windows 11’s code may not support them or could change.

## Sample Hook Code Snippets

**Detect monitor and hide/show taskbar button:** (inside injected Explorer DLL)
```cpp
HWINEVENTHOOK hHook = SetWinEventHook(
    EVENT_OBJECT_CREATE, EVENT_OBJECT_LOCATIONCHANGE, NULL,
    [](HWINEVENTHOOK hook, DWORD event, HWND hwnd, LONG idObject, LONG idChild, DWORD dwEventThread, DWORD dwmsEventTime) {
        // Filter for top-level windows (idObject == OBJID_WINDOW && idChild == CHILDID_SELF)
        if (idObject == OBJID_WINDOW && idChild == CHILDID_SELF && IsTaskbarButton(hwnd)) {
            HMONITOR hm = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            if (hm != expectedMonitorFor(hwnd)) {
                // Hide or relocate
                ShowWindow(hwnd, SW_HIDE);
            }
        }
    },
    0, 0, WINEVENT_OUTOFCONTEXT);
```
Here `IsTaskbarButton(hwnd)` is a hypothetical function that checks if `hwnd` is a button in the taskbar (e.g., by checking parent class or other ID). `expectedMonitorFor(hwnd)` would map the button’s associated app window’s monitor.

**Hooking CreateWindowEx in Explorer:** (using Detours or MinHook)
```cpp
static HWND (WINAPI *orig_CreateWindowExW)(...) = CreateWindowExW;
HWND WINAPI MyCreateWindowExW(...) {
    HWND hwnd = orig_CreateWindowExW(...);
    if (hwnd) {
        // Check if Explorer created a taskbar button
        WCHAR cls[32];
        GetClassNameW(hwnd, cls, _countof(cls));
        if (wcscmp(cls, L"TaskBarThumbnailWnd") == 0 /* example class */) {
            HWND appWnd = GetRelatedAppWindow(hwnd);
            HMONITOR hm = MonitorFromWindow(appWnd, MONITOR_DEFAULTTONEAREST);
            if (hm != targetMonitor) {
                ShowWindow(hwnd, SW_HIDE);
            }
        }
    }
    return hwnd;
}
```
This requires identifying the internal window class of taskbar button UI (WinUI may have different names).

## Alternative Approaches & AppUserModelID

- **AppUserModelID Grouping:** Windows groups and reuses taskbar buttons by AUMID. For isolation, one might *invent* distinct AUMIDs per-monitor so that a window moved to monitor 2 appears as if from a different “app group” on monitor 2’s bar. In theory, changing the AUMID at runtime (`SetCurrentProcessExplicitAppUserModelID`) could force Explorer to treat it as a separate task. But AUMIDs persist across sessions and moving windows without proper re-registration is complex. Also, it likely would not change the monitor where the icon is shown; it just affects grouping. Therefore AUMID alone is not a solution.
- **Windows Taskbar Settings:** As an alternative or fallback, document the built-in steps: enable “Show my taskbar on all displays” and “Show app icons on taskbars where window is open” in Settings. This often achieves the desired effect without coding. You can script the registry (`HKCU\...\Explorer\Advanced\MMTaskbarEnabled`) to toggle this behavior.
- **Third-Party Tools:** DisplayFusion, Actual Multiple Monitors, and similar utilities implement custom taskbars. They may offer an “individual taskbar per monitor” mode and even replicate pinned items. These rely on injection and WinAPI akin to what we describe here. For example, DisplayFusion can show all windows on all taskbars or only on the monitor they’re open. These tools, however, are closed-source. They serve as proof-of-concept that the behavior is achievable but may not isolate windows as strictly as required (some show all windows everywhere).

## Reliability, Maintenance, and Updates

Any solution using undocumented or hook-based techniques will risk breakage on Windows updates. The Windows 11 taskbar is being actively developed (e.g., insider previews adding and moving features). To mitigate:
- **Use Documented APIs First:** Rely on official settings (like registry toggle `MMTaskbarEnabled`) or COM interfaces (VirtualDesktopManager) whenever possible.
- **Feature Detection:** If injection is used, query Explorer’s version or inspect exported symbols to adapt to known changes (e.g., different window class names or function addresses). Use conditional code for major Windows versions. ExplorerPatcher shows a “Version Compatibility” system.
- **Minimize Undocumented Calls:** Avoid deep dependency on internal vtable layouts; if a hook is needed, try to hook well-known user32/dialog functions instead of COM vtables.
- **Automated Testing:** Implement a test suite that performs window moves, multi-DPI setups, and verifies taskbar state. Run it automatically on new Windows builds.
- **Telemetry & Rollback:** If deployed broadly, include telemetry to detect failures (taskbar icons missing). Prepare a fallback (e.g., disabling hooks) if a Windows update breaks the extension. Provide clear rollback instructions (like a script to unregister the DLL or restore registry).

## Testing Plan

- **Unit Tests:** For any helper code (e.g., window enumeration functions, monitor mapping logic).
- **Integration Tests:** Automated tests that run on a lab machine with multi-monitor: simulate creating windows on different monitors, moving/resizing them, switching virtual desktops, making windows fullscreen, creating UAC prompts, then checking (via UIA or image recognition) which taskbar icons appear where.
- **Manual Test Cases:**
  1. **Window Move:** Open a window on Monitor 1, verify icon on Taskbar 1. Drag it to Monitor 2, verify icon moves to Taskbar 2.
  2. **Multiple Windows:** Multiple windows across monitors; ensure no icon duplicates or misses.
  3. **Taskbar Overflow:** Open many windows so icons overflow; ensure overflow UI appears on correct monitor’s taskbar.
  4. **Fullscreen/Minimize:** Maximize a game on Monitor 1 (taskbar should auto-hide), switch focus back; ensure taskbars restore properly.
  5. **UAC/Secure Desktop:** Open UAC prompt (or switch to lock screen); taskbars should hide (Windows behavior) without crashing the hook.
  6. **DPI Scaling:** Use monitors with different DPI settings; check that moving high-DPI windows works and icons still map correctly.
  7. **Virtual Desktops:** Switch virtual desktops; windows not on the current desktop should vanish from taskbars (per normal behavior) even if they are on the current monitor physically.
- **Performance Metrics:** Monitor CPU and memory usage of hooks vs baseline. Check latency in moving icons (<100ms ideally). Ensure no noticeable UI lag in animations or opening apps.

## Comparison of Approaches

| Approach               | Complexity      | Reliability        | Performance        | Maintenance Cost | Security Impact |
|------------------------|-----------------|--------------------|--------------------|------------------|-----------------|
| **Explorer injection/hooks**  | High            | Low-medium (fragile) | High (in-process)  | High             | Elevated (must inject into system process; might need UIAccess or signing) |
| **WinEventHooks (out-of-proc)** | Medium          | Medium (less OS-dependent) | Low-medium (hook overhead) | Medium           | Medium (needs global hooks, may require admin) |
| **UI Automation**      | Medium-High     | Medium             | Low-medium         | Medium          | Medium          |
| **Custom Taskbar (external)** | Very High       | High (controlled code) | Low (drawn UI)   | Very High        | Medium (custom UI handling) |
| **Shell Replacement**  | Very High       | Low                | N/A (not viable)   | Very High        | High (replaces core shell) |
| **Built-in Settings**  | Very Low        | Medium (buggy)     | N/A (system)       | None             | None (user-level setting) |
| **Third-Party Tool**   | N/A (existing)  | Varies (proprietary)| Varies           | Low (no dev)     | Varies          |

In summary, **Explorer injection** offers the most direct control but is the hardest to implement and maintain. **Global hooks/UIA** are easier to deploy but cannot directly enforce hiding icons without creative tricks or additional components. **Custom taskbar** or **shell replacement** essentially re-create Windows UI at great cost. The recommended path is to attempt a hybrid: use official settings where possible, and if injection is needed, constrain it to minimal hooks with robust version checks.
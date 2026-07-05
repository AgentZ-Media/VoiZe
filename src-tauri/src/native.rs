use std::cell::{Cell, RefCell};
use std::ptr::NonNull;
use std::rc::Rc;
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::Duration;

use objc2::MainThreadMarker;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags, NSScreen};
use tauri::{Emitter, Manager, PhysicalPosition};
use tauri_plugin_clipboard_manager::ClipboardExt;

const HUD_WIDTH: i32 = 180;
const HUD_HEIGHT: i32 = 54;
const HUD_BOTTOM_OFFSET: f64 = 218.0;

thread_local! {
    static MONITORS: RefCell<Vec<Retained<AnyObject>>> = const { RefCell::new(Vec::new()) };
}

fn hotkey_store() -> &'static Mutex<String> {
    static HOTKEY: OnceLock<Mutex<String>> = OnceLock::new();
    HOTKEY.get_or_init(|| Mutex::new("Fn".into()))
}

fn handsfree_store() -> &'static Mutex<String> {
    static HOTKEY: OnceLock<Mutex<String>> = OnceLock::new();
    HOTKEY.get_or_init(|| Mutex::new("Fn+Space".into()))
}

pub(crate) fn on_main<T: Send + 'static>(
    app: &tauri::AppHandle,
    f: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(Duration::from_secs(3))
        .map_err(|_| "Timed out on the main thread.".to_string())
}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
}

pub(crate) fn accessibility_trusted() -> bool {
    unsafe { AXIsProcessTrusted() }
}

#[tauri::command]
pub fn accessibility_status() -> bool {
    accessibility_trusted()
}

#[tauri::command]
pub fn request_accessibility() -> bool {
    let _ = std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        .status();
    accessibility_trusted()
}

fn modifier_flag(token: &str) -> Option<NSEventModifierFlags> {
    match token {
        "fn" | "function" => Some(NSEventModifierFlags::Function),
        "ctrl" | "control" => Some(NSEventModifierFlags::Control),
        "opt" | "option" | "alt" => Some(NSEventModifierFlags::Option),
        "cmd" | "command" | "super" | "meta" => Some(NSEventModifierFlags::Command),
        "shift" => Some(NSEventModifierFlags::Shift),
        _ => None,
    }
}

fn hotkey_active(flags: NSEventModifierFlags, hotkey: &str) -> bool {
    let normalized = hotkey
        .to_lowercase()
        .replace(' ', "")
        .replace('⌥', "opt")
        .replace('⌘', "cmd")
        .replace('^', "ctrl");
    let mut wanted = NSEventModifierFlags::empty();
    for token in normalized.split('+') {
        let Some(flag) = modifier_flag(token) else {
            return false;
        };
        wanted |= flag;
    }
    if wanted.is_empty() {
        return false;
    }
    let independent = flags.intersection(NSEventModifierFlags::DeviceIndependentFlagsMask);
    independent == wanted
}

fn key_code(token: &str) -> Option<u16> {
    match token {
        "space" => Some(49),
        "esc" | "escape" => Some(53),
        _ => None,
    }
}

fn chord_active(flags: NSEventModifierFlags, key: u16, hotkey: &str) -> bool {
    let normalized = hotkey
        .to_lowercase()
        .replace(' ', "")
        .replace('⌥', "opt")
        .replace('⌘', "cmd")
        .replace('^', "ctrl");
    let mut wanted = NSEventModifierFlags::empty();
    let mut wanted_key = None;
    for token in normalized.split('+') {
        if let Some(flag) = modifier_flag(token) {
            wanted |= flag;
        } else if let Some(code) = key_code(token) {
            wanted_key = Some(code);
        } else {
            return false;
        }
    }
    if wanted_key != Some(key) {
        return false;
    }
    let independent = flags.intersection(NSEventModifierFlags::DeviceIndependentFlagsMask);
    independent == wanted
}

fn start_monitors_on_main(app: tauri::AppHandle) {
    MONITORS.with(|m| {
        if !m.borrow().is_empty() {
            return;
        }
        let active = Rc::new(Cell::new(false));
        let flags_app = app.clone();
        let on_flags = move |flags: NSEventModifierFlags| {
            let hotkey = hotkey_store()
                .lock()
                .map(|h| h.clone())
                .unwrap_or_else(|_| "Fn".into());
            let now_active = hotkey_active(flags, &hotkey);
            let was_active = active.get();
            if now_active && !was_active {
                active.set(true);
                let _ = flags_app.emit("activation-start", ());
            } else if !now_active && was_active {
                active.set(false);
                let _ = flags_app.emit("activation-stop", ());
            }
        };
        let key_app = app.clone();
        let on_key = move |event: &NSEvent| {
            if event.isARepeat() {
                return;
            }
            let hotkey = handsfree_store()
                .lock()
                .map(|h| h.clone())
                .unwrap_or_else(|_| "Fn+Space".into());
            if chord_active(event.modifierFlags(), event.keyCode(), &hotkey) {
                let _ = key_app.emit("handsfree-toggle", ());
            } else if chord_active(event.modifierFlags(), event.keyCode(), "Esc") {
                let _ = key_app.emit("activation-cancel", ());
            }
        };

        let mut monitors = m.borrow_mut();
        let global_flags = on_flags.clone();
        let global_block = block2::RcBlock::new(move |event: NonNull<NSEvent>| {
            global_flags(unsafe { event.as_ref().modifierFlags() });
        });
        if let Some(monitor) = NSEvent::addGlobalMonitorForEventsMatchingMask_handler(
            NSEventMask::FlagsChanged,
            &global_block,
        ) {
            monitors.push(monitor);
        }

        let local_block = block2::RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
            on_flags(unsafe { event.as_ref().modifierFlags() });
            event.as_ptr()
        });
        if let Some(monitor) = unsafe {
            NSEvent::addLocalMonitorForEventsMatchingMask_handler(
                NSEventMask::FlagsChanged,
                &local_block,
            )
        } {
            monitors.push(monitor);
        }

        let global_key = on_key.clone();
        let global_key_block = block2::RcBlock::new(move |event: NonNull<NSEvent>| {
            global_key(unsafe { event.as_ref() });
        });
        if let Some(monitor) = NSEvent::addGlobalMonitorForEventsMatchingMask_handler(
            NSEventMask::KeyDown,
            &global_key_block,
        ) {
            monitors.push(monitor);
        }

        let local_key_block =
            block2::RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
                on_key(unsafe { event.as_ref() });
                event.as_ptr()
            });
        if let Some(monitor) = unsafe {
            NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &local_key_block)
        } {
            monitors.push(monitor);
        }
    });
}

fn stop_monitors_on_main() {
    MONITORS.with(|m| {
        for monitor in m.borrow_mut().drain(..) {
            unsafe { NSEvent::removeMonitor(&monitor) };
        }
    });
}

#[tauri::command]
pub fn activation_start(
    app: tauri::AppHandle,
    hotkey: String,
    hands_free_hotkey: String,
) -> Result<(), String> {
    if let Ok(mut h) = hotkey_store().lock() {
        *h = hotkey;
    }
    if let Ok(mut h) = handsfree_store().lock() {
        *h = hands_free_hotkey;
    }
    let app2 = app.clone();
    on_main(&app, move || start_monitors_on_main(app2))
}

#[tauri::command]
pub fn activation_stop(app: tauri::AppHandle) -> Result<(), String> {
    on_main(&app, stop_monitors_on_main)
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventCreateKeyboardEvent(
        source: *const std::ffi::c_void,
        virtual_key: u16,
        key_down: bool,
    ) -> *const std::ffi::c_void;
    fn CGEventSetFlags(event: *const std::ffi::c_void, flags: u64);
    fn CGEventPost(tap: u32, event: *const std::ffi::c_void);
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: *const std::ffi::c_void);
}

const K_CG_HID_EVENT_TAP: u32 = 0;
const K_CG_EVENT_FLAG_MASK_COMMAND: u64 = 1 << 20;
const KEY_V: u16 = 0x09;

fn send_cmd_v() {
    unsafe {
        let down = CGEventCreateKeyboardEvent(std::ptr::null(), KEY_V, true);
        if !down.is_null() {
            CGEventSetFlags(down, K_CG_EVENT_FLAG_MASK_COMMAND);
            CGEventPost(K_CG_HID_EVENT_TAP, down);
            CFRelease(down);
        }
        let up = CGEventCreateKeyboardEvent(std::ptr::null(), KEY_V, false);
        if !up.is_null() {
            CGEventSetFlags(up, K_CG_EVENT_FLAG_MASK_COMMAND);
            CGEventPost(K_CG_HID_EVENT_TAP, up);
            CFRelease(up);
        }
    }
}

#[tauri::command]
pub fn play_status_sound(kind: String) {
    let sound = match kind.as_str() {
        "start" => "Tink",
        "stop" => "Pop",
        "success" => "Glass",
        "error" => "Basso",
        _ => "Tink",
    };
    let path = format!("/System/Library/Sounds/{sound}.aiff");
    let _ = std::process::Command::new("/usr/bin/afplay")
        .arg(path)
        .spawn();
}

#[tauri::command]
pub async fn deliver_text(
    app: tauri::AppHandle,
    text: String,
    mode: String,
    restore_clipboard: bool,
) -> Result<String, String> {
    let previous = app.clipboard().read_text().ok();
    app.clipboard()
        .write_text(text)
        .map_err(|e| e.to_string())?;
    if mode == "clipboard" {
        return Ok("clipboard".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(Duration::from_millis(90));
        send_cmd_v();
        if restore_clipboard {
            if let Some(old) = previous {
                std::thread::sleep(Duration::from_secs(30));
                let _ = app.clipboard().write_text(old);
            }
        }
        Ok::<_, String>("insert".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn position_hud(app: tauri::AppHandle) -> Result<(), String> {
    let Some(win) = app.get_webview_window("main") else {
        return Ok(());
    };

    #[cfg(target_os = "macos")]
    {
        let position = on_main(&app, || {
            let mtm = MainThreadMarker::new()?;
            let screen = NSScreen::mainScreen(mtm)?;
            let frame = screen.convertRectToBacking(screen.frame());
            let visible = screen.convertRectToBacking(screen.visibleFrame());
            let x = frame.origin.x + ((frame.size.width - HUD_WIDTH as f64) / 2.0).max(0.0);
            let y = frame.origin.y + frame.size.height
                - visible.origin.y
                - HUD_HEIGHT as f64
                - HUD_BOTTOM_OFFSET;
            Some((x.round() as i32, y.max(18.0).round() as i32))
        })?;
        if let Some((x, y)) = position {
            win.set_position(PhysicalPosition::new(x, y))
                .map_err(|e| e.to_string())?;
            return Ok(());
        }
    }

    let monitor = win
        .current_monitor()
        .map_err(|e| e.to_string())?
        .or(win.primary_monitor().map_err(|e| e.to_string())?);
    let Some(monitor) = monitor else {
        return Ok(());
    };
    let size = monitor.size();
    let pos = monitor.position();
    let x = pos.x + ((size.width as i32 - HUD_WIDTH) / 2).max(0);
    let y = pos.y + size.height as i32 - HUD_HEIGHT - 328;
    win.set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn show_settings_window(app: &tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
        let _ = app.set_dock_visibility(true);
    }
    let Some(win) = app.get_webview_window("settings") else {
        return Ok(());
    };
    win.show().map_err(|e| e.to_string())?;
    let _ = win.unminimize();
    win.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn show_settings(app: tauri::AppHandle, section: Option<String>) -> Result<(), String> {
    show_settings_window(&app)?;
    let _ = app.emit("settings-open", section.unwrap_or_else(|| "general".into()));
    Ok(())
}

use tauri::image::Image;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Emitter;

use crate::native;

fn tray_icon() -> Image<'static> {
    const S: usize = 18;
    let mut rgba = vec![0u8; S * S * 4];
    let bars: [(f32, f32); 7] = [
        (3.0, 5.0),
        (5.0, 10.0),
        (7.0, 14.0),
        (9.0, 8.0),
        (11.0, 14.0),
        (13.0, 10.0),
        (15.0, 5.0),
    ];
    for y in 0..S {
        for x in 0..S {
            let mut a: f32 = 0.0;
            for (cx, height) in bars {
                let half_h = height / 2.0;
                let top = 8.5 - half_h;
                let bottom = 8.5 + half_h;
                let dx = (x as f32 - cx).abs();
                let inside_y = y as f32 >= top && y as f32 <= bottom;
                if inside_y {
                    a = a.max((1.0 - (dx - 0.72).max(0.0)).clamp(0.0, 1.0));
                }
            }
            // Small speech spark in the upper-right, distinct from Otto's orb.
            let sx = x as f32 - 14.6;
            let sy = y as f32 - 3.4;
            let spark = (1.0 - ((sx * sx + sy * sy).sqrt() - 1.4).max(0.0)).clamp(0.0, 1.0);
            a = a.max(spark * 0.82);
            let i = (y * S + x) * 4;
            rgba[i] = 0;
            rgba[i + 1] = 0;
            rgba[i + 2] = 0;
            rgba[i + 3] = (a * 255.0) as u8;
        }
    }
    Image::new_owned(rgba, S as u32, S as u32)
}

pub fn setup(app: &tauri::AppHandle) -> tauri::Result<()> {
    let dictate = MenuItemBuilder::with_id("dictate", "Diktat starten/stoppen").build(app)?;
    let history = MenuItemBuilder::with_id("history", "Verlauf").build(app)?;
    let settings = MenuItemBuilder::with_id("settings", "Einstellungen...").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "VoiZe beenden").build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&dictate)
        .separator()
        .item(&history)
        .item(&settings)
        .separator()
        .item(&quit)
        .build()?;

    TrayIconBuilder::with_id("voize-tray")
        .icon(tray_icon())
        .icon_as_template(true)
        .tooltip("VoiZe")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "dictate" => {
                let _ = app.emit("tray-dictate", ());
            }
            "history" => {
                let _ = native::show_settings_window(app);
                let _ = app.emit("settings-open", "history");
            }
            "settings" => {
                let _ = native::show_settings_window(app);
                let _ = app.emit("settings-open", "general");
            }
            "quit" => {
                // Hard exit: `app.exit(0)` shuts down gracefully and can hang
                // on in-flight plugin/background threads (updater, model load),
                // leaving a zombie process. macOS then reactivates that zombie
                // on the next launch instead of starting fresh, so the app
                // appears permanently broken until it is force-killed. Exiting
                // the process directly guarantees a clean slate on relaunch.
                std::process::exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                let _ = native::show_settings_window(app);
                let _ = app.emit("settings-open", "general");
            }
        })
        .build(app)?;
    Ok(())
}

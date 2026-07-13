use objc2_app_kit::NSWorkspace;
use serde::Serialize;
use std::path::Path;
use std::process::Command;

use crate::native;

#[derive(Serialize, Clone)]
pub struct ScreenContext {
    pub app_name: Option<String>,
    pub bundle_id: Option<String>,
    pub window_title: Option<String>,
    pub selected_text: Option<String>,
    pub accessibility: bool,
}

#[derive(Serialize)]
pub struct ApplicationIdentity {
    pub app_name: String,
    pub bundle_id: String,
}

#[tauri::command]
pub fn screen_context(app: tauri::AppHandle) -> Result<ScreenContext, String> {
    native::on_main(&app, current_screen_context)
}

pub(crate) fn current_screen_context() -> ScreenContext {
    let ws = NSWorkspace::sharedWorkspace();
    let front = ws.frontmostApplication();
    let (app_name, bundle_id, window_title) = match front {
        Some(a) => {
            let title = native::focused_window_title(a.processIdentifier());
            (
                a.localizedName().map(|s| s.to_string()),
                a.bundleIdentifier().map(|s| s.to_string()),
                title,
            )
        }
        None => (None, None, None),
    };
    ScreenContext {
        app_name,
        bundle_id,
        window_title,
        selected_text: None,
        accessibility: native::accessibility_trusted(),
    }
}

#[tauri::command]
pub async fn pick_application() -> Result<Option<ApplicationIdentity>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let output = Command::new("/usr/bin/osascript")
            .args([
                "-e",
                "POSIX path of (choose application with title \"VoiZe\" with prompt \"App für die Nachbearbeitung auswählen:\" as alias)",
            ])
            .output()
            .map_err(|error| format!("Die App-Auswahl konnte nicht geöffnet werden: {error}"))?;
        if !output.status.success() {
            let message = String::from_utf8_lossy(&output.stderr);
            if message.contains("-128") || message.to_lowercase().contains("canceled") {
                return Ok(None);
            }
            return Err(format!("Die App-Auswahl ist fehlgeschlagen: {}", message.trim()));
        }

        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let info_plist = Path::new(&path).join("Contents/Info.plist");
        let bundle_output = Command::new("/usr/libexec/PlistBuddy")
            .args(["-c", "Print :CFBundleIdentifier"])
            .arg(&info_plist)
            .output()
            .map_err(|error| format!("Die App-Kennung konnte nicht gelesen werden: {error}"))?;
        let bundle_id = String::from_utf8_lossy(&bundle_output.stdout)
            .trim()
            .to_string();
        if !bundle_output.status.success() || bundle_id.is_empty() {
            return Err("Die ausgewählte App hat keine lesbare Bundle-ID.".into());
        }
        let app_name = Path::new(&path)
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or(&bundle_id)
            .to_string();
        Ok(Some(ApplicationIdentity {
            app_name,
            bundle_id,
        }))
    })
    .await
    .map_err(|error| format!("Die App-Auswahl wurde unterbrochen: {error}"))?
}

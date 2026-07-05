use objc2_app_kit::NSWorkspace;
use serde::Serialize;

use crate::native;

#[derive(Serialize)]
pub struct ScreenContext {
    pub app_name: Option<String>,
    pub bundle_id: Option<String>,
    pub window_title: Option<String>,
    pub selected_text: Option<String>,
    pub accessibility: bool,
}

#[tauri::command]
pub fn screen_context(app: tauri::AppHandle) -> Result<ScreenContext, String> {
    native::on_main(&app, || {
        let ws = NSWorkspace::sharedWorkspace();
        let front = ws.frontmostApplication();
        let (app_name, bundle_id) = match front {
            Some(a) => (
                a.localizedName().map(|s| s.to_string()),
                a.bundleIdentifier().map(|s| s.to_string()),
            ),
            None => (None, None),
        };
        ScreenContext {
            app_name,
            bundle_id,
            window_title: None,
            selected_text: None,
            accessibility: native::accessibility_trusted(),
        }
    })
}

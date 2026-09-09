#[tauri::command]
pub fn control_main_window(window: tauri::WebviewWindow, action: String) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Window controls are only available in Mivlet.".into());
    }
    let result = match action.as_str() {
        "minimize" => window.minimize(),
        "maximize" => {
            if window.is_maximized().map_err(|error| error.to_string())? {
                window.unmaximize()
            } else {
                window.maximize()
            }
        }
        "close" => window.close(),
        "drag" => window.start_dragging(),
        _ => return Err("Unknown window action.".into()),
    };
    result.map_err(|error| error.to_string())
}

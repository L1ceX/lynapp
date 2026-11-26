use crate::i18n::tr;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

const TRAY_ID: &str = "lynapp-tray";

static HIDDEN_FOR_GAME: AtomicBool = AtomicBool::new(false);

pub fn is_hidden_for_game() -> bool {
    HIDDEN_FOR_GAME.load(Ordering::Relaxed)
}

pub fn hide_to_tray(app: &AppHandle) -> Result<(), String> {
    if app.tray_by_id(TRAY_ID).is_none() {
        let open_item = MenuItem::with_id(app, "open", tr("Open lynapp", "Открыть lynapp"), true, None::<&str>)
            .map_err(|e| e.to_string())?;
        let sep = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
        let quit_item = MenuItem::with_id(app, "quit", tr("Quit", "Выход"), true, None::<&str>)
            .map_err(|e| e.to_string())?;
        let menu = Menu::with_items(app, &[&open_item, &sep, &quit_item]).map_err(|e| e.to_string())?;

        let mut builder = TrayIconBuilder::with_id(TRAY_ID)
            .tooltip("lynapp")
            .menu(&menu)
            .on_menu_event(|app, event| match event.id.as_ref() {
                "open" => {
                    let _ = restore_from_tray(app);
                }
                "quit" => {
                    app.exit(0);
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
                    let _ = restore_from_tray(tray.app_handle());
                }
            });

        if let Some(icon) = app.default_window_icon().cloned() {
            builder = builder.icon(icon);
        }
        builder.build(app).map_err(|e| e.to_string())?;
    }

    HIDDEN_FOR_GAME.store(true, Ordering::Relaxed);
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }
    Ok(())
}

pub fn restore_from_tray(app: &AppHandle) -> Result<(), String> {
    HIDDEN_FOR_GAME.store(false, Ordering::Relaxed);
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
    if let Some(tray) = app.remove_tray_by_id(TRAY_ID) {
        let _ = tray.set_visible(false);
    }
    Ok(())
}

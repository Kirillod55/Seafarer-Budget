// Prevents an extra console window on Windows in release builds. DO NOT REMOVE!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, State, WindowEvent,
};

const TRAY_ID: &str = "main";

/// Is the tray icon on? Off is remembered as an empty file next to the program's settings.
struct TrayOn(AtomicBool);

fn tray_off_flag(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join("tray-off"))
}

#[tauri::command]
fn tray_enabled(state: State<'_, TrayOn>) -> bool {
    state.0.load(Ordering::Relaxed)
}

#[tauri::command]
fn set_tray_enabled(app: AppHandle, state: State<'_, TrayOn>, on: bool) -> Result<(), String> {
    state.0.store(on, Ordering::Relaxed);
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_visible(on).map_err(|e| e.to_string())?;
    }
    if let Some(flag) = tray_off_flag(&app) {
        if on {
            let _ = fs::remove_file(flag);
        } else {
            if let Some(dir) = flag.parent() {
                fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            }
            fs::write(flag, b"").map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Brings the window back from the tray, the taskbar or behind other windows.
fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn main() {
    tauri::Builder::default()
        // one window only: a second launch brings the running window to the front and exits (must be the first plugin)
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        // self-update from GitHub Releases (latest.json, signed) and the restart after it
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // the tray: a click opens the window, the menu has «Открыть» and «Выйти» (the only way to really quit)
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "Открыть", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Выйти", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            let mut tray = TrayIconBuilder::with_id(TRAY_ID)
                .tooltip("Seafarer Budget")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            let on = !tray_off_flag(app.handle()).is_some_and(|flag| flag.exists());
            app.manage(TrayOn(AtomicBool::new(on)));
            tray.build(app)?.set_visible(on)?;
            Ok(())
        })
        // with the tray icon on, the window's ✕ hides it there and the program keeps running; with it off, ✕ closes
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.state::<TrayOn>().0.load(Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![tray_enabled, set_tray_enabled])
        .run(tauri::generate_context!())
        .expect("error while running Seafarer Budget");
}

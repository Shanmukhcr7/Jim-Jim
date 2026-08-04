#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod config;
mod network;
mod webrtc;
mod capture;
mod input;

use tracing::{info, error};
use tracing_appender::rolling;
use std::fs;
use tokio::sync::mpsc;
use enigo::{Enigo, Mouse, Keyboard, Coordinate, Button, Direction, Key};
use std::sync::Mutex;
use tauri::{SystemTray, SystemTrayMenu, SystemTrayMenuItem, CustomMenuItem, SystemTrayEvent, Manager};

#[tauri::command]
fn get_device_info() -> Result<config::AppConfig, String> {
    config::load_or_generate_config().map_err(|e| e.to_string())
}

#[tauri::command]
fn log_message(msg: String) {
    info!("REACT: {}", msg);
}

#[tauri::command]
async fn send_signaling_message(
    sender: tauri::State<'_, network::SignalingSender>,
    payload: String,
) -> Result<(), String> {
    sender.0.send(payload).await.map_err(|e| e.to_string())
}

// Input Simulation State
struct InputState(Mutex<Enigo>);

fn map_key(k: &str) -> Option<Key> {
    match k {
        "Backspace" => Some(Key::Backspace),
        "Enter" => Some(Key::Return),
        "Tab" => Some(Key::Tab),
        "Shift" => Some(Key::Shift),
        "Control" => Some(Key::Control),
        "Alt" => Some(Key::Alt),
        "Escape" => Some(Key::Escape),
        "ArrowUp" => Some(Key::UpArrow),
        "ArrowDown" => Some(Key::DownArrow),
        "ArrowLeft" => Some(Key::LeftArrow),
        "ArrowRight" => Some(Key::RightArrow),
        "Delete" => Some(Key::Delete),
        "Meta" => Some(Key::Meta),
        "CapsLock" => Some(Key::CapsLock),
        "Space" | " " => Some(Key::Space),
        s if s.chars().count() == 1 => {
            // For simple characters, enigo usually wants them as chars, or Unicode.
            Some(Key::Unicode(s.chars().next().unwrap()))
        },
        _ => None,
    }
}

#[tauri::command]
fn simulate_input(
    state: tauri::State<'_, InputState>,
    action: String,
    nx: Option<f32>,
    ny: Option<f32>,
    button: Option<String>,
    key: Option<String>,
) -> Result<(), String> {
    let mut enigo = state.0.lock().map_err(|_| "Mutex poisoned")?;
    
    match action.as_str() {
        "MOUSE_MOVE" => {
            if let (Some(nx), Some(ny)) = (nx, ny) {
                let (w, h) = enigo.main_display().unwrap_or((1920, 1080));
                let abs_x = (nx * w as f32) as i32;
                let abs_y = (ny * h as f32) as i32;
                let _ = enigo.move_mouse(abs_x, abs_y, Coordinate::Abs);
            }
        }
        "MOUSE_DOWN" => {
            if let (Some(nx), Some(ny)) = (nx, ny) {
                let (w, h) = enigo.main_display().unwrap_or((1920, 1080));
                let abs_x = (nx * w as f32) as i32;
                let abs_y = (ny * h as f32) as i32;
                let _ = enigo.move_mouse(abs_x, abs_y, Coordinate::Abs);
            }
            if let Some(btn) = button {
                let enigo_btn = match btn.as_str() {
                    "Left" => Button::Left,
                    "Right" => Button::Right,
                    "Middle" => Button::Middle,
                    _ => Button::Left,
                };
                let _ = enigo.button(enigo_btn, Direction::Press);
            }
        }
        "MOUSE_UP" => {
            if let (Some(nx), Some(ny)) = (nx, ny) {
                let (w, h) = enigo.main_display().unwrap_or((1920, 1080));
                let abs_x = (nx * w as f32) as i32;
                let abs_y = (ny * h as f32) as i32;
                let _ = enigo.move_mouse(abs_x, abs_y, Coordinate::Abs);
            }
            if let Some(btn) = button {
                let enigo_btn = match btn.as_str() {
                    "Left" => Button::Left,
                    "Right" => Button::Right,
                    "Middle" => Button::Middle,
                    _ => Button::Left,
                };
                let _ = enigo.button(enigo_btn, Direction::Release);
            }
        }
        "KEY_DOWN" => {
            if let Some(k_str) = key {
                if let Some(enigo_key) = map_key(&k_str) {
                    if let Key::Unicode(c) = enigo_key {
                        let _ = enigo.text(&c.to_string());
                    } else {
                        let _ = enigo.key(enigo_key, Direction::Press);
                    }
                }
            }
        }
        "KEY_UP" => {
            if let Some(k_str) = key {
                if let Some(enigo_key) = map_key(&k_str) {
                    if !matches!(enigo_key, Key::Unicode(_)) {
                        let _ = enigo.key(enigo_key, Direction::Release);
                    }
                }
            }
        }
        "MOUSE_SCROLL" => {
            use enigo::Axis;
            if let Some(dy) = ny {
                let _ = enigo.scroll(dy as i32, Axis::Vertical);
            }
            if let Some(dx) = nx {
                let _ = enigo.scroll(dx as i32, Axis::Horizontal);
            }
        }
        _ => {}
    }
    
    Ok(())
}


fn main() -> anyhow::Result<()> {
    let _ = fs::create_dir_all("logs");
    let file_appender = rolling::daily("logs", "googlejim.log");
    let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);
    
    tracing_subscriber::fmt()
        .with_writer(non_blocking)
        .with_ansi(false)
        .init();

    info!("Starting GoogleJim MVP Desktop App...");

    let (tx, rx) = mpsc::channel(100);

    let quit = CustomMenuItem::new("quit".to_string(), "Quit");
    let show = CustomMenuItem::new("show".to_string(), "Show");
    let hide = CustomMenuItem::new("hide".to_string(), "Hide");
    let tray_menu = SystemTrayMenu::new()
        .add_item(show)
        .add_item(hide)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(quit);
    let system_tray = SystemTray::new().with_menu(tray_menu);

    // Launch Tauri Window
    tauri::Builder::default()
        .system_tray(system_tray)
        .on_system_tray_event(|app, event| match event {
            SystemTrayEvent::MenuItemClick { id, .. } => {
                match id.as_str() {
                    "quit" => { std::process::exit(0); }
                    "show" => {
                        if let Some(window) = app.get_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "hide" => {
                        if let Some(window) = app.get_window("main") {
                            let _ = window.hide();
                        }
                    }
                    _ => {}
                }
            }
            SystemTrayEvent::DoubleClick { .. } => {
                if let Some(window) = app.get_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            _ => {}
        })
        .on_window_event(|event| match event.event() {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                let _ = event.window().hide();
                api.prevent_close();
            }
            _ => {}
        })
        .manage(network::SignalingSender(tx))
        .manage(InputState(Mutex::new(Enigo::new(&enigo::Settings::default()).unwrap())))
        .manage(capture::CaptureState { running: Mutex::new(None) })
        .setup(|app| {
            let app_handle = app.handle();
            // Load config inside setup to pass to listener
            if let Ok(cfg) = config::load_or_generate_config() {
                tauri::async_runtime::spawn(async move {
                    network::start_background_listener(
                        app_handle, 
                        cfg.signaling_server_url, 
                        cfg.device_id,
                        rx
                    ).await;
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_device_info, 
            send_signaling_message,
            simulate_input,
            log_message,
            capture::start_capture,
            capture::stop_capture
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");

    Ok(())
}

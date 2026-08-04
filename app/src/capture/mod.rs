use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::Manager;
use xcap::Monitor;
use image::codecs::jpeg::JpegEncoder;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use tracing::{info, error};

pub struct CaptureState {
    pub running: std::sync::Mutex<Option<Arc<AtomicBool>>>,
}

#[tauri::command]
pub fn start_capture(app_handle: tauri::AppHandle, state: tauri::State<'_, CaptureState>) -> Result<(), String> {
    let mut running_lock = state.running.lock().map_err(|e| e.to_string())?;
    
    if running_lock.is_some() {
        return Ok(()); // Already running
    }
    
    let running = Arc::new(AtomicBool::new(true));
    *running_lock = Some(running.clone());

    std::thread::spawn(move || {
        info!("Native capture thread started");
        
        let mut enigo_instance = enigo::Enigo::new(&enigo::Settings::default()).unwrap();
        
        loop {
            if !running.load(Ordering::SeqCst) {
                break;
            }
            
            let monitors = match Monitor::all() {
                Ok(m) => m,
                Err(e) => {
                    error!("Failed to get monitors: {}", e);
                    std::thread::sleep(Duration::from_secs(1));
                    continue;
                }
            };
            
            let primary = monitors.into_iter().next();
            if let Some(monitor) = primary {
                use enigo::Mouse;
                if let Ok((x, y)) = enigo_instance.location() {
                    let w = monitor.width().unwrap_or(1920) as f32;
                    let h = monitor.height().unwrap_or(1080) as f32;
                    let nx = (x as f32) / w;
                    let ny = (y as f32) / h;
                    let _ = app_handle.emit_all("mouse_position", serde_json::json!({ "nx": nx, "ny": ny }));
                }

                if let Ok(image) = monitor.capture_image() {
                    let mut buffer = Vec::new();
                    // Compress to JPEG with 35% quality for ultra-low latency & small payload size
                    let mut encoder = JpegEncoder::new_with_quality(&mut buffer, 35);
                    if let Ok(_) = encoder.encode_image(&image) {
                        let b64 = STANDARD.encode(&buffer);
                        let _ = app_handle.emit_all("video_frame", b64);
                    }
                }
            } else {
                std::thread::sleep(Duration::from_secs(1));
            }
            
            // Aim for ~15-20 fps (50-60ms)
            std::thread::sleep(Duration::from_millis(33)); // ~30 fps
        }
        
        info!("Native capture thread stopped");
    });
    
    Ok(())
}

#[tauri::command]
pub fn stop_capture(state: tauri::State<'_, CaptureState>) -> Result<(), String> {
    let mut running_lock = state.running.lock().map_err(|e| e.to_string())?;
    if let Some(running) = running_lock.take() {
        running.store(false, Ordering::SeqCst);
    }
    Ok(())
}

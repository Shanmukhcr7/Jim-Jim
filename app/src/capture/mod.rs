use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tauri::Manager;
use xcap::Monitor;
use image::codecs::jpeg::JpegEncoder;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use tracing::{info, warn, error};

// ── Capture configuration ────────────────────────────────────────────
// WGC (Windows Graphics Capture) is enabled via the "wgc" feature in
// Cargo.toml. This replaces the old GDI/BitBlt backend and correctly
// captures GPU-accelerated apps (Chrome, Electron, DirectX, OpenGL).
const TARGET_FPS: u64 = 15;
const FRAME_INTERVAL_MS: u64 = 1000 / TARGET_FPS; // ~67 ms
const JPEG_QUALITY: u8 = 75;

// ── State ─────────────────────────────────────────────────────────────
pub struct CaptureState {
    pub running: std::sync::Mutex<Option<Arc<AtomicBool>>>,
    pub latest_frame: Arc<RwLock<String>>,
}

// ── Tauri commands ────────────────────────────────────────────────────

#[tauri::command]
pub fn get_latest_frame(state: tauri::State<'_, CaptureState>) -> Result<String, String> {
    if let Ok(f) = state.latest_frame.read() {
        Ok(f.clone())
    } else {
        Ok(String::new())
    }
}

/// Start the background capture thread.
///
/// # Parameters
/// - `target_id`: The remote client device ID. When set, FRAME and
///   CURSOR_SYNC messages are pushed directly over the WebSocket by the
///   Rust thread, bypassing the WebView2 timer throttle that occurs when
///   the application window is minimised.
/// - `monitor_index`: Zero-based index of the monitor to capture.
///   Defaults to 0 (primary monitor). Calling code that does not pass
///   this parameter continues to receive primary-monitor frames.
#[tauri::command]
pub fn start_capture(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, CaptureState>,
    target_id: Option<String>,
    monitor_index: Option<usize>,
) -> Result<(), String> {
    let mut running_lock = state.running.lock().map_err(|e| e.to_string())?;

    if running_lock.is_some() {
        return Ok(()); // Already running
    }

    let running = Arc::new(AtomicBool::new(true));
    *running_lock = Some(running.clone());

    let frame_ref = state.latest_frame.clone();
    // Default to monitor 0 (primary) when no index is supplied.
    let monitor_index = monitor_index.unwrap_or(0);

    std::thread::spawn(move || {
        info!(
            "Capture thread started — WGC backend, monitor_index={}, fps={}, jpeg_quality={}",
            monitor_index, TARGET_FPS, JPEG_QUALITY
        );

        let mut enigo_instance = enigo::Enigo::new(&enigo::Settings::default()).unwrap();
        let mut last_b64 = String::new();

        loop {
            if !running.load(Ordering::SeqCst) {
                break;
            }

            // ── Monitor selection ────────────────────────────────────
            let monitors = match Monitor::all() {
                Ok(m) => m,
                Err(e) => {
                    error!("Failed to enumerate monitors: {}", e);
                    std::thread::sleep(Duration::from_secs(1));
                    continue;
                }
            };

            // Use requested monitor index; fall back to the first
            // monitor if the index is out of range (e.g. a secondary
            // monitor was disconnected mid-session).
            let monitor = monitors.into_iter().nth(monitor_index).or_else(|| {
                warn!(
                    "Monitor index {} not found — falling back to primary monitor.",
                    monitor_index
                );
                Monitor::all().ok()?.into_iter().next()
            });

            if let Some(monitor) = monitor {
                // ── Cursor position ──────────────────────────────────
                use enigo::Mouse;
                if let Ok((x, y)) = enigo_instance.location() {
                    let w = monitor.width().unwrap_or(1920) as f32;
                    let h = monitor.height().unwrap_or(1080) as f32;
                    let nx = (x as f32) / w;
                    let ny = (y as f32) / h;
                    let _ = app_handle.emit_all(
                        "mouse_position",
                        serde_json::json!({ "nx": nx, "ny": ny }),
                    );

                    if let Some(tid) = &target_id {
                        if let Some(sender) =
                            app_handle.try_state::<crate::network::SignalingSender>()
                        {
                            let payload = serde_json::json!({
                                "type": "CURSOR_SYNC",
                                "target_id": tid,
                                "nx": nx,
                                "ny": ny
                            })
                            .to_string();
                            let _ = sender.0.try_send(payload);
                        }
                    }
                }

                // ── Screen capture (WGC when feature is enabled) ─────
                match monitor.capture_image() {
                    Ok(image) => {
                        // xcap returns RGBA; strip alpha for JPEG encoding.
                        let rgb_image =
                            image::DynamicImage::ImageRgba8(image).into_rgb8();

                        let mut buffer = Vec::new();
                        let mut encoder =
                            JpegEncoder::new_with_quality(&mut buffer, JPEG_QUALITY);

                        match encoder.encode_image(&rgb_image) {
                            Ok(_) => {
                                let b64 = STANDARD.encode(&buffer);

                                // Only transmit when the frame has changed.
                                if b64 != last_b64 {
                                    last_b64 = b64.clone();

                                    // Update the in-memory latest frame
                                    // (used by get_latest_frame command).
                                    if let Ok(mut f) = frame_ref.write() {
                                        *f = b64.clone();
                                    }

                                    // Push the FRAME directly through the
                                    // Rust WebSocket channel so it continues
                                    // to work when the app window is minimised
                                    // (WebView2 throttles timers when hidden).
                                    if let Some(tid) = &target_id {
                                        if let Some(sender) = app_handle
                                            .try_state::<crate::network::SignalingSender>()
                                        {
                                            let payload = serde_json::json!({
                                                "type": "FRAME",
                                                "target_id": tid,
                                                "frame": b64
                                            })
                                            .to_string();
                                            // try_send: if the channel is full,
                                            // drop the stale frame rather than
                                            // blocking or queuing it.
                                            if let Err(e) = sender.0.try_send(payload) {
                                                warn!(
                                                    "Frame dropped (network congestion): {}",
                                                    e
                                                );
                                            }
                                        }
                                    }
                                }
                            }
                            Err(e) => {
                                error!("JPEG encode failed: {}", e);
                            }
                        }
                    }
                    Err(e) => {
                        // This can happen legitimately for DRM-protected content
                        // or when the UAC secure desktop is active; both are
                        // Windows security restrictions that cannot be bypassed.
                        error!(
                            "monitor.capture_image() failed: {}. \
                             This may be a DRM surface, UAC secure desktop, \
                             or a transient WGC error.",
                            e
                        );
                    }
                }
            } else {
                // No monitors found at all — wait before retrying.
                warn!("No monitors available. Waiting 1 s before retry.");
                std::thread::sleep(Duration::from_secs(1));
            }

            // Throttle to TARGET_FPS.
            std::thread::sleep(Duration::from_millis(FRAME_INTERVAL_MS));
        }

        info!("Capture thread stopped.");
    });

    Ok(())
}

#[tauri::command]
pub fn stop_capture(state: tauri::State<'_, CaptureState>) -> Result<(), String> {
    let mut running_lock = state.running.lock().map_err(|e| e.to_string())?;
    if let Some(running) = running_lock.take() {
        running.store(false, Ordering::SeqCst);
        info!("Capture thread signalled to stop.");
    }
    Ok(())
}

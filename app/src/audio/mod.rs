use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tracing::{info, error};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use bytemuck::cast_slice;
use tauri::Manager;

pub struct AudioState {
    pub running: Mutex<Option<Arc<AtomicBool>>>,
}

#[tauri::command]
pub fn start_audio_capture(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AudioState>,
    target_id: String,
) -> Result<(), String> {
    let mut running_lock = state.running.lock().map_err(|e| e.to_string())?;
    if running_lock.is_some() {
        return Ok(());
    }

    let running = Arc::new(AtomicBool::new(true));
    *running_lock = Some(running.clone());
    
    std::thread::spawn(move || {
        let host = cpal::default_host();
        let device = match host.default_output_device() {
            Some(d) => d,
            None => {
                error!("No default output device for audio capture.");
                return;
            }
        };

        info!("Starting audio capture on output device.");
        
        let config = match device.default_output_config() {
            Ok(c) => c,
            Err(e) => {
                error!("Failed to get audio config: {}", e);
                return;
            }
        };

        let sample_rate = config.sample_rate();
        let channels = config.channels();
        
        info!("Audio format: {} Hz, {} channels", sample_rate, channels);
        
        let running_clone = running.clone();
        
        let err_fn = |err| error!("Audio stream error: {}", err);
        
        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => {
                device.build_input_stream(
                    config.into(),
                    move |data: &[f32], _: &_| {
                        if !running_clone.load(Ordering::SeqCst) { return; }
                        
                        let byte_data: &[u8] = cast_slice(data);
                        let b64 = STANDARD.encode(byte_data);
                        
                        if let Some(sender) = app_handle.try_state::<crate::network::SignalingSender>() {
                            let payload = serde_json::json!({
                                "type": "AUDIO",
                                "target_id": &target_id,
                                "data": b64,
                                "sample_rate": sample_rate,
                                "channels": channels
                            }).to_string();
                            let _ = sender.0.try_send(payload);
                        }
                    },
                    err_fn,
                    None
                )
            },
            _ => {
                error!("Unsupported audio sample format. Expected F32.");
                return;
            }
        };

        let stream = match stream {
            Ok(s) => s,
            Err(e) => {
                error!("Failed to build audio stream: {}", e);
                return;
            }
        };

        if let Err(e) = stream.play() {
            error!("Failed to play audio stream: {}", e);
            return;
        }

        // Keep thread alive while running
        while running.load(Ordering::SeqCst) {
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        
        info!("Audio thread stopped.");
    });

    Ok(())
}

#[tauri::command]
pub fn stop_audio_capture(state: tauri::State<'_, AudioState>) -> Result<(), String> {
    let mut running_lock = state.running.lock().map_err(|e| e.to_string())?;
    if let Some(running) = running_lock.take() {
        running.store(false, Ordering::SeqCst);
    }
    Ok(())
}

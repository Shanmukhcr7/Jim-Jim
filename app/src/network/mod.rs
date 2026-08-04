use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};
use futures_util::{StreamExt, SinkExt};
use tracing::{info, error};
use tokio::sync::mpsc;
use tauri::Manager;

pub struct SignalingSender(pub mpsc::Sender<String>);

pub async fn start_background_listener(
    app_handle: tauri::AppHandle,
    server_url: String,
    my_device_id: String,
    mut rx: mpsc::Receiver<String>
) {
    let ws_url = if server_url.ends_with('/') {
        format!("{}{}", server_url, my_device_id)
    } else {
        format!("{}/{}", server_url, my_device_id)
    };
    
    info!("Starting background listener on {}", ws_url);
    
    loop {
        match connect_async(&ws_url).await {
            Ok((ws_stream, _)) => {
                info!("Background listener connected!");
                let (mut write, mut read) = ws_stream.split();
                
                loop {
                    tokio::select! {
                        msg_opt = read.next() => {
                            if let Some(msg) = msg_opt {
                                match msg {
                                    Ok(Message::Text(text)) => {
                                        info!("Received message: {}", text);
                                        if let Ok(json_val) = serde_json::from_str::<serde_json::Value>(&text) {
                                            let msg_type = json_val["type"].as_str().unwrap_or("");
                                            if msg_type == "CONNECTION_REQUEST" {
                                                let _ = app_handle.emit_all("incoming_request", json_val);
                                            } else {
                                                // Forward all other WebRTC signaling messages
                                                let _ = app_handle.emit_all("webrtc_signaling", json_val);
                                            }
                                        }
                                    }
                                    Ok(_) => {},
                                    Err(e) => {
                                        error!("WebSocket read error: {}", e);
                                        break;
                                    }
                                }
                            } else {
                                error!("WebSocket stream closed by server.");
                                break;
                            }
                        }
                        out_msg_opt = rx.recv() => {
                            if let Some(out_msg) = out_msg_opt {
                                info!("Sending outgoing message...");
                                if let Err(e) = write.send(Message::Text(out_msg)).await {
                                    error!("Failed to send out_msg: {}", e);
                                    break;
                                }
                            } else {
                                // MPSC channel dropped, should never happen if App is alive
                                break;
                            }
                        }
                    }
                }
            }
            Err(e) => {
                error!("Failed to connect background listener: {}. Retrying in 5s...", e);
            }
        }
        
        tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
    }
}

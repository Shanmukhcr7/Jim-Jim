mod config;

use tracing::{info, error};
use tracing_appender::rolling;
use std::fs;

fn main() -> anyhow::Result<()> {
    // 1. Setup daily file logging to `logs/remotelink.log`
    let _ = fs::create_dir_all("logs");
    let file_appender = rolling::daily("logs", "remotelink.log");
    let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);
    
    tracing_subscriber::fmt()
        .with_writer(non_blocking)
        .with_ansi(false) // Better for file logs
        .init();

    info!("Starting RemoteLink MVP...");

    // 2. Initialize or Load Configuration
    let cfg = match config::load_or_generate_config() {
        Ok(c) => c,
        Err(e) => {
            error!("Failed to initialize configuration: {}", e);
            return Err(e);
        }
    };

    info!("==================================");
    info!("Device Name : {}", cfg.device_name);
    info!("Device ID   : {}", cfg.device_id);
    info!("OS Version  : {}", cfg.os_version);
    info!("Fingerprint : {}", cfg.machine_fingerprint);
    info!("==================================");
    
    // Hold main thread for MVP skeleton
    std::thread::park();
    Ok(())
}

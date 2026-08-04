use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use rand::RngCore;
use argon2::{
    password_hash::{rand_core::OsRng, PasswordHasher, SaltString},
    Argon2,
};
use x25519_dalek::{StaticSecret, PublicKey};
use sysinfo::System;

#[derive(Serialize, Deserialize, Debug)]
pub struct AppConfig {
    pub device_id: String,
    pub device_name: String,
    pub os_version: String,
    pub machine_fingerprint: String,
    pub password_hash: String,
    pub signaling_server_url: String,
}

pub fn load_or_generate_config() -> anyhow::Result<AppConfig> {
    let config_dir = Path::new("config");
    fs::create_dir_all(config_dir)?;

    let config_path = config_dir.join("config.toml");
    let keys_path = config_dir.join("keys.pem");

    // Load if exists
    if config_path.exists() && keys_path.exists() {
        let content = fs::read_to_string(&config_path)?;
        let config: AppConfig = toml::from_str(&content)?;
        return Ok(config);
    }

    // --- First Launch Initialization ---
    
    // 1. Generate Identity Strings
    let device_id = generate_device_id();
    
    let mut sys = System::new_all();
    sys.refresh_all();
    let os_version = System::os_version().unwrap_or_else(|| "Unknown Windows".into());
    let device_name = hostname::get()
        .map(|h| h.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "Unknown PC".into());
    let machine_fingerprint = machine_uid::get()
        .unwrap_or_else(|_| generate_device_id());

    // 2. Hash Password (Argon2id)
    // NOTE: For the MVP skeleton, we generate a secure default password.
    // In Module 7, the UI will prompt the user to input their own.
    let raw_password = "12345678";
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();
    let password_hash = argon2.hash_password(raw_password.as_bytes(), &salt)
        .unwrap()
        .to_string();

    let config = AppConfig {
        device_id,
        device_name,
        os_version,
        machine_fingerprint,
        password_hash,
        signaling_server_url: "ws://h10ifdl5y9wzocojecyc0h31.148.230.67.167.sslip.io/ws".to_string(),
    };

    // 3. Generate ECDH Keypair (x25519)
    let secret = StaticSecret::random_from_rng(OsRng);
    let public = PublicKey::from(&secret);
    
    let keys_content = format!(
        "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n-----BEGIN PUBLIC KEY-----\n{}\n-----END PUBLIC KEY-----\n",
        hex::encode(secret.to_bytes()),
        hex::encode(public.as_bytes())
    );

    // 4. Save to disk
    fs::write(&config_path, toml::to_string(&config)?)?;
    fs::write(&keys_path, keys_content)?;

    Ok(config)
}

fn generate_device_id() -> String {
    let mut rng = rand::thread_rng();
    let p1 = rng.next_u32() % 1000;
    let p2 = rng.next_u32() % 1000;
    let p3 = rng.next_u32() % 1000;
    format!("{:03}{:03}{:03}", p1, p2, p3)
}

# RemoteLink Developer Guide

This guide explains how to start and test the MVP components of the RemoteLink project on your local Windows machine.

## Prerequisites
- **Python 3.11+** (For the Signaling Server)
- **Rust Toolchain** (For the Windows App)
- **Node.js & pnpm** (For the Tauri UI)

---

## 1. Start the In-Memory Signaling Server
The signaling server handles device registration and routes WebRTC connection requests. It must be running before the application can connect.

Open a terminal and navigate to the project root:
```powershell
cd signaling-server
# Create a virtual environment (optional but recommended)
python -m venv venv
.\venv\Scripts\activate

# Install dependencies using standard pip
pip install -r requirements.txt

# Run the server
uvicorn main:app --reload --port 8000
```
*The server will start at `ws://localhost:8000/ws/{device_id}`.*

---

## 2. Run the Unified Windows Application
The Rust application generates your Device ID on first launch and acts as both the Host and the Client.

Open a second terminal:
```powershell
cd app
cargo run
```

### What to expect on first run:
1. The app will automatically generate your **Device ID**, **Password Hash**, and **Keypairs**.
2. It will save these locally inside `app/config/config.toml` and `app/config/keys.pem`.
3. It will print your Device ID and OS Fingerprint directly into the console.
4. It will create a local log file at `app/logs/remotelink.log`.

---

## 3. Developing the UI (Tauri)
To work on the React frontend that allows you to enter a target Device ID, you will run the Tauri development server:
```powershell
cd app/ui
pnpm install
pnpm dev
```

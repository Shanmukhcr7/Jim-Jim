# RemoteLink

A secure, native Windows remote desktop application for legitimate remote administration and support.

## Project Structure
- `backend/`: Unified Python FastAPI application handling REST APIs, WebSocket signaling, and SQLite database.
- `apps/controller/`: React + Tauri Controller UI for managing devices and viewing streams.
- `agent/`: Rust-based Windows Agent capturing screen and listening for connections.
- `shared/`: Shared Protobuf definitions.

## Execution
Run `.\start_all.ps1` to launch all components natively on Windows.

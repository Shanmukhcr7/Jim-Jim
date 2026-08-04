import logging
from fastapi import WebSocket

logger = logging.getLogger("uvicorn")

class DeviceRegistry:
    def __init__(self):
        self.active_devices: dict[str, WebSocket] = {}

    def register(self, device_id: str, websocket: WebSocket):
        self.active_devices[device_id] = websocket
        logger.info(f"[REGISTRY] Registered device {device_id}. Total active: {len(self.active_devices)}")

    def unregister(self, device_id: str):
        if device_id in self.active_devices:
            del self.active_devices[device_id]
            logger.info(f"[REGISTRY] Unregistered device {device_id}. Total active: {len(self.active_devices)}")
            
    def get_device(self, device_id: str) -> WebSocket | None:
        return self.active_devices.get(device_id)

# Singleton registry instance
registry = DeviceRegistry()

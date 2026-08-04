from fastapi import WebSocket

class DeviceRegistry:
    def __init__(self):
        self.active_devices: dict[str, WebSocket] = {}

    def register(self, device_id: str, websocket: WebSocket):
        self.active_devices[device_id] = websocket

    def unregister(self, device_id: str):
        if device_id in self.active_devices:
            del self.active_devices[device_id]
            
    def get_device(self, device_id: str) -> WebSocket | None:
        return self.active_devices.get(device_id)

# Singleton registry instance
registry = DeviceRegistry()

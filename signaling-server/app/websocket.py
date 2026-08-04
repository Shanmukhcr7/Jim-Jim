from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from .registry import registry
import json

router = APIRouter()

@router.websocket("/ws/{device_id}")
async def websocket_endpoint(websocket: WebSocket, device_id: str):
    await websocket.accept()
    registry.register(device_id, websocket)
    try:
        while True:
            data = await websocket.receive_text()
            
            # Simple In-Memory Routing
            # Decodes the envelope to find target_id and forwards the payload (Offer/Answer/ICE)
            try:
                message = json.loads(data)
                target_id = message.get("target_id")
                
                target_ws = registry.get_device(target_id)
                if target_ws:
                    await target_ws.send_text(data)
            except Exception:
                pass
                
    except WebSocketDisconnect:
        registry.unregister(device_id)

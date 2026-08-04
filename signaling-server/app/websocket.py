import logging
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from .registry import registry
import json

logger = logging.getLogger("uvicorn")
router = APIRouter()

@router.websocket("/ws/{device_id}")
async def websocket_endpoint(websocket: WebSocket, device_id: str):
    await websocket.accept()
    logger.info(f"[WS] WebSocket connected for device_id: {device_id}")
    registry.register(device_id, websocket)
    try:
        while True:
            data = await websocket.receive_text()
            logger.info(f"[WS] Message received from {device_id}: {data}")
            
            # Simple In-Memory Routing
            try:
                message = json.loads(data)
                target_id = message.get("target_id")
                
                if target_id:
                    logger.info(f"[WS] Routing message from {device_id} -> {target_id}")
                    target_ws = registry.get_device(target_id)
                    
                    if target_ws:
                        await target_ws.send_text(data)
                        logger.info(f"[WS] Successfully sent message to {target_id}")
                    else:
                        logger.warning(f"[WS] TARGET NOT FOUND: {target_id} is not in registry!")
                else:
                    logger.warning(f"[WS] No target_id found in message from {device_id}")
                    
            except json.JSONDecodeError:
                logger.error(f"[WS] Failed to decode JSON from {device_id}")
            except Exception as e:
                logger.error(f"[WS] Error processing message from {device_id}: {e}")
                
    except WebSocketDisconnect:
        logger.info(f"[WS] WebSocket disconnected for device_id: {device_id}")
        registry.unregister(device_id)

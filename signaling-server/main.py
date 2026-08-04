from fastapi import FastAPI
from app.websocket import router

app = FastAPI(title="RemoteLink Signaling Server (In-Memory)")

app.include_router(router)

@app.get("/health")
def health():
    return {"status": "online"}

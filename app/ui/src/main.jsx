import React, { useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom/client';
import { invoke } from '@tauri-apps/api/tauri';
import { listen } from '@tauri-apps/api/event';
import './index.css';

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

const appLog = (msg) => {
    console.log(msg);
    invoke('log_message', { msg: String(msg) }).catch(()=>{});
};

function App() {
  const [deviceInfo, setDeviceInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  
  const [targetId, setTargetId] = useState('');
  const [password, setPassword] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState('');
  
  const [sessionActive, setSessionActive] = useState(false);
  const [isHost, setIsHost] = useState(false);
  const [remoteCursor, setRemoteCursor] = useState(null);
  
  const imageRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const dataChannelRef = useRef(null);
  const activeTargetRef = useRef(null);
  const iceCandidateQueueRef = useRef([]);
  const frameBufferRef = useRef({});

  useEffect(() => {
    async function loadData() {
      try {
        const data = await invoke('get_device_info');
        setDeviceInfo(data);
      } catch (e) {
        console.error("Failed to load device info:", e);
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, []);

  useEffect(() => {
    if (!deviceInfo) return;
    
    let unlistenReq, unlistenWebrtc, unlistenVideo, unlistenCursor;
    let isSubscribed = true;
    
    async function setupListeners() {
      const uReq = await listen('incoming_request', (event) => {
        const req = event.payload;
        appLog("Incoming request received from " + req.source_id);
        
        // Auto-Accept Logic (UltraViewer Style)
        if (req.password === "12345678") {
            appLog("Password valid! Auto-accepting...");
            acceptConnection(req.source_id);
        } else {
            appLog("Rejected connection: wrong password");
        }
      });
      if (isSubscribed) unlistenReq = uReq; else uReq();
      
      const uVideo = await listen('video_frame', (event) => {
        const dc = dataChannelRef.current;
        if (dc && dc.readyState === "open") {
            if (dc.bufferedAmount < 500000) { // Allow ~3-4 frames to buffer (prevents stuttering) while keeping latency low
                try {
                    const b64 = event.payload;
                    const CHUNK_SIZE = 16000;
                    const totalChunks = Math.ceil(b64.length / CHUNK_SIZE);
                    const frameId = Date.now() % 100000;
                    
                    for (let i = 0; i < totalChunks; i++) {
                        const chunk = b64.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
                        dc.send(`V|${frameId}|${i}|${totalChunks}|${chunk}`);
                    }
                } catch(e) {}
            }
        }
      });
      if (isSubscribed) unlistenVideo = uVideo; else uVideo();

      const uCursor = await listen('mouse_position', (event) => {
          const dc = dataChannelRef.current;
          if (dc && dc.readyState === "open") {
              const pos = event.payload;
              try {
                  dc.send(JSON.stringify({ action: "CURSOR_POS", nx: pos.nx, ny: pos.ny }));
              } catch(e) {}
          }
      });
      if (isSubscribed) unlistenCursor = uCursor; else uCursor();
      
      const uWebrtc = await listen('webrtc_signaling', async (event) => {
        const msg = event.payload;
        appLog(`WEBRTC MSG Received: ${msg.type}`);
        
        if (msg.type === "OFFER") {
            try {
                appLog("Processing OFFER...");
                activeTargetRef.current = msg.source_id;
                setIsHost(false);
                
                const pc = new RTCPeerConnection(ICE_SERVERS);
                peerConnectionRef.current = pc;
                iceCandidateQueueRef.current = [];
                
                pc.ondatachannel = (e) => {
                    appLog("Data channel received");
                    dataChannelRef.current = e.channel;
                    e.channel.onmessage = (msgEvent) => {
                        const text = msgEvent.data;
                        if (typeof text === 'string' && text.startsWith('V|')) {
                            // MJPEG Video Chunk
                            const parts = text.split('|');
                            if (parts.length >= 5) {
                                const fId = parts[1];
                                const idx = parseInt(parts[2], 10);
                                const total = parseInt(parts[3], 10);
                                const data = parts.slice(4).join('|');
                                
                                const buffer = frameBufferRef.current;
                                if (!buffer[fId]) {
                                    buffer[fId] = { received: 0, total: total, chunks: new Array(total), time: Date.now() };
                                }
                                
                                if (!buffer[fId].chunks[idx]) {
                                    buffer[fId].chunks[idx] = data;
                                    buffer[fId].received++;
                                    
                                    if (buffer[fId].received === total) {
                                        if (imageRef.current) {
                                            imageRef.current.src = `data:image/jpeg;base64,${buffer[fId].chunks.join('')}`;
                                        }
                                        delete buffer[fId];
                                    }
                                }
                                
                                // Cleanup dropped frames
                                const now = Date.now();
                                for (const id in buffer) {
                                    if (now - buffer[id].time > 500) {
                                        delete buffer[id];
                                    }
                                }
                            }
                        } else if (typeof text === 'string') {
                            try {
                                const parsed = JSON.parse(text);
                                if (parsed.action === "CURSOR_POS") {
                                    setRemoteCursor({ nx: parsed.nx, ny: parsed.ny });
                                }
                            } catch(e) {}
                        }
                    };
                };
                
                pc.onicecandidate = (e) => {
                    if (e.candidate) {
                        invoke('send_signaling_message', {
                            payload: JSON.stringify({
                                type: "ICE", target_id: msg.source_id, source_id: deviceInfo?.device_id, candidate: e.candidate
                            })
                        }).catch(err => appLog("Send ICE error: " + err));
                    }
                };
                
                await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
                appLog("Remote description set!");
                
                for (const c of iceCandidateQueueRef.current) {
                    try {
                        await pc.addIceCandidate(new RTCIceCandidate(c));
                    } catch(e) { appLog("Buffered ICE err: " + e); }
                }
                iceCandidateQueueRef.current = [];
                
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                appLog("Local description set (Answer). Sending ANSWER...");
                
                await invoke('send_signaling_message', {
                    payload: JSON.stringify({
                        type: "ANSWER", target_id: msg.source_id, source_id: deviceInfo?.device_id, sdp: answer
                    })
                });
                appLog("ANSWER sent successfully!");
                
                setSessionActive(true);
                setConnectionStatus("");
            } catch (err) {
                appLog(`Error processing OFFER: ${err}`);
            }
        } 
        else if (msg.type === "ANSWER") {
            appLog("Processing ANSWER...");
            try {
                if (peerConnectionRef.current) {
                    await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(msg.sdp));
                    appLog("Remote description set for ANSWER!");
                }
            } catch (err) {
                appLog(`Error processing ANSWER: ${err}`);
            }
        } 
        else if (msg.type === "ICE") {
            try {
                if (peerConnectionRef.current) {
                    if (peerConnectionRef.current.remoteDescription) {
                        await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(msg.candidate));
                    } else {
                        appLog("Buffering ICE candidate (remoteDescription not set yet)");
                        iceCandidateQueueRef.current.push(msg.candidate);
                    }
                }
            } catch (err) {
                appLog(`Error adding ICE: ${err}`);
            }
        }
      });
      if (isSubscribed) unlistenWebrtc = uWebrtc; else uWebrtc();
    }
    
    setupListeners();

    return () => {
      isSubscribed = false;
      if (unlistenReq) unlistenReq();
      if (unlistenWebrtc) unlistenWebrtc();
      if (unlistenVideo) unlistenVideo();
      if (unlistenCursor) unlistenCursor();
    };
  }, [deviceInfo]);

  const handleConnect = async (e) => {
    e.preventDefault();
    if (!targetId || !password) return;
    
    setConnecting(true);
    setConnectionStatus("Sending request...");
    // Strip spaces for internal signaling
    const cleanTargetId = targetId.replace(/\s+/g, '');
    activeTargetRef.current = cleanTargetId;
    
    try {
      await invoke('send_signaling_message', {
        payload: JSON.stringify({
            type: "CONNECTION_REQUEST",
            source_id: deviceInfo.device_id,
            target_id: cleanTargetId,
            password: password
        })
      });
      setConnectionStatus("Authenticating and connecting...");
    } catch (e) {
      setConnectionStatus("Error: " + e);
      setConnecting(false);
    }
  };

  const acceptConnection = async (source_id) => {
    activeTargetRef.current = source_id;
    setIsHost(true);
    setConnectionStatus(`Session active with ${source_id}...`);
    
    try {
        const pc = new RTCPeerConnection(ICE_SERVERS);
        peerConnectionRef.current = pc;
        iceCandidateQueueRef.current = [];
        
        const dc = pc.createDataChannel("input", {
            ordered: false,
            maxRetransmits: 0
        });
        
        dc.onmessage = (e) => {
            const text = e.data;
            if (typeof text === 'string' && !text.startsWith('V|')) {
                try {
                    const input = JSON.parse(text);
                    invoke('simulate_input', {
                        action: input.action, 
                        nx: input.nx !== undefined ? input.nx : null, 
                        ny: input.ny !== undefined ? input.ny : null, 
                        button: input.button !== undefined ? input.button : null, 
                        key: input.key !== undefined ? input.key : null
                    }).catch(()=>{});
                } catch(e) {}
            }
        };
        dataChannelRef.current = dc;
        
        pc.onicecandidate = (e) => {
            if (e.candidate) {
                invoke('send_signaling_message', {
                    payload: JSON.stringify({
                        type: "ICE", target_id: source_id, source_id: deviceInfo.device_id, candidate: e.candidate
                    })
                }).catch(err => appLog("Send ICE error: " + err));
            }
        };
        
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        appLog("Local description set (Offer). Sending OFFER...");
        
        await invoke('send_signaling_message', {
            payload: JSON.stringify({
                type: "OFFER", target_id: source_id, source_id: deviceInfo.device_id, sdp: offer
            })
        });
        
        appLog("OFFER sent! Starting background capture engine.");
        await invoke('start_capture');
        
        setSessionActive(true);
    } catch (e) {
        appLog(`Session start failed: ${e}`);
        setConnectionStatus("Failed to start session.");
    }
  };
  
  const disconnect = async () => {
      if (isHost) {
          await invoke('stop_capture').catch(()=>{});
      }
      window.location.reload();
  };

  useEffect(() => {
      if (sessionActive && !isHost) {
          const handleKeyDown = (e) => {
              e.preventDefault();
              sendInput("KEY_DOWN", e);
          };
          const handleKeyUp = (e) => {
              e.preventDefault();
              sendInput("KEY_UP", e);
          };
          window.addEventListener('keydown', handleKeyDown);
          window.addEventListener('keyup', handleKeyUp);
          return () => {
              window.removeEventListener('keydown', handleKeyDown);
              window.removeEventListener('keyup', handleKeyUp);
          };
      }
  }, [sessionActive, isHost]);

  const sendInput = (action, e) => {
      if (isHost || !dataChannelRef.current || dataChannelRef.current.readyState !== "open") return;
      const payload = { action };
      if (e && e.type.startsWith("mouse") && imageRef.current) {
          const rect = imageRef.current.getBoundingClientRect();
          const img = imageRef.current;
          
          const intrinsicW = img.naturalWidth;
          const intrinsicH = img.naturalHeight;
          if (!intrinsicW || !intrinsicH) return;
          
          const containerRatio = rect.width / rect.height;
          const intrinsicRatio = intrinsicW / intrinsicH;
          
          let displayW, displayH, offsetX, offsetY;
          
          if (containerRatio > intrinsicRatio) {
              displayH = rect.height;
              displayW = displayH * intrinsicRatio;
              offsetX = (rect.width - displayW) / 2;
              offsetY = 0;
          } else {
              displayW = rect.width;
              displayH = displayW / intrinsicRatio;
              offsetX = 0;
              offsetY = (rect.height - displayH) / 2;
          }
          
          const relativeX = e.clientX - rect.left - offsetX;
          const relativeY = e.clientY - rect.top - offsetY;
          
          // Clamp values to prevent clicking completely outside the remote screen area
          let nx = relativeX / displayW;
          let ny = relativeY / displayH;
          nx = Math.max(0, Math.min(1, nx));
          ny = Math.max(0, Math.min(1, ny));
          
          payload.nx = nx;
          payload.ny = ny;
          if (e.type === "mousedown" || e.type === "mouseup") {
              payload.button = e.button === 0 ? "Left" : e.button === 2 ? "Right" : "Middle";
          }
      } else if (e && e.type.startsWith("key")) {
          payload.key = e.key;
      } else if (e && e.type === "wheel") {
          // Normalize wheel delta to a smaller integer for smooth scrolling
          payload.nx = e.deltaX !== 0 ? (e.deltaX > 0 ? 1 : -1) : 0;
          payload.ny = e.deltaY !== 0 ? (e.deltaY > 0 ? -1 : 1) : 0; // Negative because Enigo scroll(1) goes UP, but deltaY>0 means scroll down
      }
      dataChannelRef.current.send(JSON.stringify(payload));
  };
  
  if (sessionActive) {
      return (
          <div style={{width: '100vw', height: '100vh', background: '#000', display: 'flex', flexDirection: 'column'}}>
              <div style={{padding: '10px', background: '#1e293b', display: 'flex', justifyContent: 'space-between', color: '#fff', zIndex: 10}}>
                  <div>{isHost ? "Hosting Session - UltraViewer Mode Active" : "Remote Control Active"}</div>
                  <button onClick={disconnect} style={{padding: '5px 15px', cursor: 'pointer', background: '#ef4444', color: '#fff', border: 'none', borderRadius: '5px'}}>Disconnect</button>
              </div>
              <div style={{flex: 1, position: 'relative', overflow: 'hidden'}}>
                  {!isHost && (
                      <div style={{width: '100%', height: '100%', position: 'relative'}}>
                          <img 
                              ref={imageRef}
                              style={{width: '100%', height: '100%', objectFit: 'contain', background: '#0f172a', display: 'block'}}
                              draggable={false}
                              onMouseMove={(e) => sendInput("MOUSE_MOVE", e)}
                              onMouseDown={(e) => sendInput("MOUSE_DOWN", e)}
                              onMouseUp={(e) => sendInput("MOUSE_UP", e)}
                              onWheel={(e) => sendInput("MOUSE_SCROLL", e)}
                              onContextMenu={(e) => e.preventDefault()}
                          />
                          {remoteCursor && (
                              <div style={{
                                  position: 'absolute',
                                  top: 0, left: 0, width: '100%', height: '100%',
                                  pointerEvents: 'none'
                              }}>
                                  <div style={{
                                      position: 'absolute',
                                      left: `${(() => {
                                          if (!imageRef.current || !imageRef.current.naturalWidth) return 0;
                                          const rect = imageRef.current.getBoundingClientRect();
                                          const intrinsicRatio = imageRef.current.naturalWidth / imageRef.current.naturalHeight;
                                          const containerRatio = rect.width / rect.height;
                                          let displayW, offsetX;
                                          if (containerRatio > intrinsicRatio) {
                                              displayW = rect.height * intrinsicRatio;
                                              offsetX = (rect.width - displayW) / 2;
                                          } else {
                                              displayW = rect.width;
                                              offsetX = 0;
                                          }
                                          return offsetX + (remoteCursor.nx * displayW);
                                      })()}px`,
                                      top: `${(() => {
                                          if (!imageRef.current || !imageRef.current.naturalWidth) return 0;
                                          const rect = imageRef.current.getBoundingClientRect();
                                          const intrinsicRatio = imageRef.current.naturalWidth / imageRef.current.naturalHeight;
                                          const containerRatio = rect.width / rect.height;
                                          let displayH, offsetY;
                                          if (containerRatio > intrinsicRatio) {
                                              displayH = rect.height;
                                              offsetY = 0;
                                          } else {
                                              displayH = rect.width / intrinsicRatio;
                                              offsetY = (rect.height - displayH) / 2;
                                          }
                                          return offsetY + (remoteCursor.ny * displayH);
                                      })()}px`,
                                      width: '10px', height: '10px',
                                      backgroundColor: 'red',
                                      borderRadius: '50%',
                                      transform: 'translate(-50%, -50%)',
                                      boxShadow: '0 0 4px white',
                                      zIndex: 1000,
                                      transition: 'left 0.05s linear, top 0.05s linear'
                                  }} />
                              </div>
                          )}
                      </div>
                  )}
                  {isHost && (
                      <div style={{display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', color: '#64748b', fontSize: '1.5rem', textAlign: 'center'}}>
                          Your screen is being actively streamed to the remote client natively.<br/>
                          (No Chromium popups or sharing icons!)
                      </div>
                  )}
              </div>
          </div>
      );
  }

  return (
    <div className="container" style={{display: 'flex', flexDirection: 'column', gap: '1rem', minHeight: '100vh'}}>
      <div className="header" style={{marginBottom: '0.5rem', marginTop: '2rem'}}>
        <h1 className="title">GoogleJim</h1>
        <p className="subtitle">Secure Peer-to-Peer Access (UltraViewer Mode)</p>
      </div>

      {loading ? (
        <div className="loader"></div>
      ) : deviceInfo ? (
        <div style={{display: 'flex', gap: '2rem', maxWidth: '1000px', width: '100%', margin: '0 auto', alignItems: 'stretch'}}>
          
          <div className="glass-card" style={{flex: 1, margin: 0, padding: '2rem', display: 'flex', flexDirection: 'column', justifyContent: 'center'}}>
            <h2 style={{color: '#60a5fa', marginBottom: '1.5rem', fontSize: '1.2rem', textAlign: 'center'}}>Allow Remote Control</h2>
            <div className="info-group">
              <div className="info-label">Your ID</div>
              <div className="info-value" style={{fontSize: '2rem', letterSpacing: '4px'}}>
                {deviceInfo.device_id ? deviceInfo.device_id.replace(/(\d{3})(?=\d)/g, '$1 ') : ''}
              </div>
            </div>
            
            <div className="info-group">
              <div className="info-label">Password</div>
              <div style={{ textAlign: 'center', color: '#10b981', fontSize: '1.5rem', marginBottom: '1rem', letterSpacing: '4px', fontWeight: 'bold' }}>
                12345678
              </div>
            </div>
          </div>

          <div className="glass-card" style={{flex: 1, margin: 0, padding: '2rem', display: 'flex', flexDirection: 'column', justifyContent: 'center'}}>
            <h2 style={{color: '#60a5fa', marginBottom: '1.5rem', fontSize: '1.2rem', textAlign: 'center'}}>Control Remote Computer</h2>
            <form onSubmit={handleConnect} className="connect-form" style={{gap: '1.5rem'}}>
              <div className="input-group">
                <label className="info-label">Partner ID</label>
                <input 
                  type="text" 
                  className="glass-input" 
                  placeholder="e.g. 123 456 789" 
                  value={targetId}
                  onChange={(e) => setTargetId(e.target.value)}
                  disabled={connecting}
                  style={{fontSize: '1.2rem', padding: '1rem'}}
                />
              </div>
              
              <div className="input-group">
                <label className="info-label">Password</label>
                <input 
                  type="password" 
                  className="glass-input" 
                  placeholder="Password" 
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={connecting}
                  style={{fontSize: '1.2rem', padding: '1rem'}}
                />
              </div>

              {connectionStatus && (
                <div className="status-text" style={{margin: '0.5rem 0'}}>{connectionStatus}</div>
              )}

              <button 
                type="submit" 
                className={`btn-connect ${connecting ? 'btn-loading' : ''}`}
                disabled={connecting}
                style={{marginTop: 'auto', padding: '1.2rem', fontSize: '1.1rem'}}
              >
                {connecting ? 'Connecting...' : 'Connect to partner'}
              </button>
            </form>
          </div>
          
        </div>
      ) : (
        <p style={{textAlign: 'center', color: '#f87171'}}>Failed to load device identity.</p>
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);

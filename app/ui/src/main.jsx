import React, { useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom/client';
import { invoke } from '@tauri-apps/api/tauri';
import { listen } from '@tauri-apps/api/event';
import './index.css';

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
  const [monitorIndex, setMonitorIndex] = useState(0); // 0 = primary monitor
  
  // Debug Info State
  const [debugInfo, setDebugInfo] = useState({
      framesReceived: 0,
      lastFrameSize: 0,
      errorCount: 0,
      lastError: ''
  });
  const debugInfoRef = useRef(debugInfo);
  useEffect(() => { debugInfoRef.current = debugInfo; }, [debugInfo]);
  const updateDebug = (updater) => {
      setDebugInfo(prev => ({...prev, ...updater}));
  };

  const imageRef = useRef(null);
  const containerRef = useRef(null);
  const cursorRef = useRef(null);

  const activeTargetRef = useRef(null);
  const isHostRef = useRef(false);

  // Audio Playback State
  const audioCtxRef = useRef(null);
  const nextPlayTimeRef = useRef(0);

  const initAudio = () => {
      if (!audioCtxRef.current) {
          audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
          nextPlayTimeRef.current = 0;
      }
      if (audioCtxRef.current.state === 'suspended') {
          audioCtxRef.current.resume();
      }
  };

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
    
    let unlistenReq, unlistenWebrtc;
    let isSubscribed = true;
    
    async function setupListeners() {
      const uReq = await listen('incoming_request', (event) => {
        const req = event.payload;
        appLog("Incoming request received from " + req.source_id);
        
        if (req.password === "12345678") {
            appLog("Password valid! Auto-accepting...");
            acceptConnection(req.source_id);
        } else {
            appLog("Rejected connection: wrong password");
        }
      });
      if (isSubscribed) unlistenReq = uReq; else uReq();
      
      const uWebrtc = await listen('webrtc_signaling', async (event) => {
        const msg = event.payload;
        
        if (msg.type === "FRAME" && !isHostRef.current) {
            updateDebug({
                framesReceived: debugInfoRef.current.framesReceived + 1,
                lastFrameSize: msg.frame.length
            });
            if (imageRef.current) {
                imageRef.current.src = `data:image/jpeg;base64,${msg.frame}`;
            }
            return;
        }
        
        if (msg.type === "CURSOR_SYNC" && !isHostRef.current) {
            if (cursorRef.current && imageRef.current) {
                cursorRef.current.style.display = 'block';
                const rect = imageRef.current.getBoundingClientRect();
                const img = imageRef.current;
                const intrinsicW = img.naturalWidth || 1920;
                const intrinsicH = img.naturalHeight || 1080;
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
                const parentRect = cursorRef.current.parentElement.getBoundingClientRect();
                const imageX = rect.left - parentRect.left;
                const imageY = rect.top - parentRect.top;
                
                const relativeX = imageX + offsetX + (msg.nx * displayW);
                const relativeY = imageY + offsetY + (msg.ny * displayH);
                cursorRef.current.style.left = `${relativeX}px`;
                cursorRef.current.style.top = `${relativeY}px`;
            }
            return;
        }
        
        if (msg.type === "INPUT" && isHostRef.current) {
            const input = msg.input;
            invoke('simulate_input', {
                action: input.action, 
                nx: input.nx !== undefined ? input.nx : null, 
                ny: input.ny !== undefined ? input.ny : null, 
                button: input.button !== undefined ? input.button : null, 
                key: input.key !== undefined ? input.key : null
            }).catch(()=>{});
            return;
        }

        if (msg.type === "AUDIO" && !isHostRef.current) {
            if (audioCtxRef.current) {
                try {
                    const binaryString = window.atob(msg.data);
                    const bytes = new Uint8Array(binaryString.length);
                    for (let i = 0; i < binaryString.length; i++) {
                        bytes[i] = binaryString.charCodeAt(i);
                    }
                    const floatArray = new Float32Array(bytes.buffer);
                    
                    const buffer = audioCtxRef.current.createBuffer(msg.channels, floatArray.length / msg.channels, msg.sample_rate);
                    for (let channel = 0; channel < msg.channels; channel++) {
                        const channelData = buffer.getChannelData(channel);
                        for (let i = 0; i < floatArray.length / msg.channels; i++) {
                            channelData[i] = floatArray[i * msg.channels + channel];
                        }
                    }
                    
                    const source = audioCtxRef.current.createBufferSource();
                    source.buffer = buffer;
                    source.connect(audioCtxRef.current.destination);
                    
                    if (nextPlayTimeRef.current < audioCtxRef.current.currentTime) {
                        nextPlayTimeRef.current = audioCtxRef.current.currentTime + 0.05; // 50ms buffer
                    }
                    
                    source.start(nextPlayTimeRef.current);
                    nextPlayTimeRef.current += buffer.duration;
                } catch (e) {
                    console.error("Audio playback error", e);
                }
            }
            return;
        }

        if (msg.type === "ACCEPT") {
            try {
                appLog("Connection ACCEPTED by host! Starting Client mode.");
                activeTargetRef.current = msg.source_id;
                isHostRef.current = false;
                setIsHost(false);
                setSessionActive(true);
                setConnectionStatus("");
            } catch (err) {
                appLog(`Error processing ACCEPT: ${err}`);
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
    };
  }, [deviceInfo]);

  const handleConnect = async (e) => {
    e.preventDefault();
    if (!targetId || !password) return;
    
    initAudio(); // Required to unlock Web Audio API on user gesture

    setConnecting(true);
    setConnectionStatus("Sending request...");
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
    isHostRef.current = true;
    setIsHost(true);
    setConnectionStatus(`Session active with ${source_id}...`);
    
    try {
        await invoke('send_signaling_message', {
            payload: JSON.stringify({
                type: "ACCEPT", target_id: source_id, source_id: deviceInfo.device_id
            })
        });
        
        appLog("ACCEPT sent! Starting background capture engine.");
        await invoke('start_capture', { targetId: source_id, monitorIndex: monitorIndex });
        await invoke('start_audio_capture', { targetId: source_id }).catch(e => appLog("Audio failed: " + e));
        
        setSessionActive(true);
    } catch (e) {
        appLog(`Session start failed: ${e}`);
        setConnectionStatus("Failed to start session.");
    }
  };
  
  const disconnect = async () => {
      if (isHost) {
          await invoke('stop_capture').catch(()=>{});
          await invoke('stop_audio_capture').catch(()=>{});
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
      if (isHost || !activeTargetRef.current) return;
      const payload = { action };
      if (e && e.type.startsWith("mouse") && imageRef.current) {
          const rect = imageRef.current.getBoundingClientRect();
          const img = imageRef.current;
          const intrinsicW = img.naturalWidth || 1920;
          const intrinsicH = img.naturalHeight || 1080;
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
          payload.nx = e.deltaX !== 0 ? (e.deltaX > 0 ? 1 : -1) : 0;
          payload.ny = e.deltaY !== 0 ? (e.deltaY > 0 ? -1 : 1) : 0; 
      }
      invoke('send_signaling_message', {
          payload: JSON.stringify({ type: "INPUT", target_id: activeTargetRef.current, input: payload })
      }).catch(()=>{});
  };
  
  if (sessionActive) {
      return (
          <div style={{width: '100vw', height: '100vh', background: '#000', display: 'flex', flexDirection: 'column'}}>
              <div style={{padding: '10px', background: '#1e293b', display: 'flex', justifyContent: 'space-between', color: '#fff', zIndex: 10}}>
                  <div>{isHost ? "Hosting Session - UltraViewer Mode Active" : "Remote Control Active"}</div>
                  <button onClick={disconnect} style={{padding: '5px 15px', cursor: 'pointer', background: '#ef4444', color: '#fff', border: 'none', borderRadius: '5px'}}>Disconnect</button>
              </div>
              
              <div style={{
                  position: 'absolute', top: 50, left: 10, background: 'rgba(0,0,0,0.8)', 
                  color: '#0f0', padding: '10px', borderRadius: '5px', zIndex: 9999,
                  fontFamily: 'monospace', fontSize: '12px', pointerEvents: 'none'
              }}>
                  <strong>DEBUG OVERLAY</strong><br/>
                  Role: {isHost ? "HOST" : "CLIENT"}<br/>
                  Frames Rendered: {debugInfo.framesReceived}<br/>
                  Last Frame Size: {debugInfo.lastFrameSize} bytes<br/>
                  Errors: {debugInfo.errorCount}<br/>
                  Last Error: {debugInfo.lastError || "None"}
              </div>

              <div style={{flex: 1, position: 'relative', overflow: 'hidden'}}>
                  {!isHost && (
                    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
                        <div 
                            ref={containerRef}
                            style={{ width: '100%', height: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center' }}
                        >
                            <img 
                                ref={imageRef}
                                style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                                onMouseMove={(e) => sendInput("MOUSE_MOVE", e)}
                                onMouseDown={(e) => sendInput("MOUSE_DOWN", e)}
                                onMouseUp={(e) => sendInput("MOUSE_UP", e)}
                                onWheel={(e) => sendInput("MOUSE_SCROLL", e)}
                                draggable="false"
                                onContextMenu={(e) => e.preventDefault()}
                            />
                        </div>
                        <div 
                            ref={cursorRef}
                            style={{
                                position: 'absolute',
                                width: '12px',
                                height: '12px',
                                backgroundColor: 'rgba(255, 0, 0, 0.7)',
                                border: '2px solid white',
                                borderRadius: '50%',
                                pointerEvents: 'none',
                                display: 'none',
                                zIndex: 9999,
                                transform: 'translate(-50%, -50%)',
                                boxShadow: '0 0 4px rgba(0,0,0,0.5)'
                            }}
                        />
                    </div>
                  )}
                  {isHost && (
                      <div style={{display: 'flex', flexDirection: 'column', height: '100%', alignItems: 'center', justifyContent: 'center', color: '#64748b', fontSize: '1.5rem', textAlign: 'center'}}>
                          Your screen is being actively streamed to the remote client natively.<br/>
                          (No WebRTC, Pure WebSocket Relay)
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

            <div className="info-group" style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <div className="info-label" style={{ marginBottom: '0.5rem' }}>Select Monitor to Stream</div>
              <select
                value={monitorIndex}
                onChange={(e) => setMonitorIndex(parseInt(e.target.value, 10))}
                className="glass-input"
                style={{ width: '100%', maxWidth: '250px', padding: '0.8rem', fontSize: '1rem', background: 'rgba(30, 41, 59, 0.7)', color: 'white', border: '1px solid rgba(148, 163, 184, 0.2)' }}
              >
                <option value={0}>Monitor 1 (Primary)</option>
                <option value={1}>Monitor 2</option>
                <option value={2}>Monitor 3</option>
                <option value={3}>Monitor 4</option>
              </select>
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

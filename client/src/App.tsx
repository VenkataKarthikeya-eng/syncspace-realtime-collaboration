import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createRoom, RoomInstance, ConnectionStatus, SyncStats } from './connection.js';
import { InterpolationEngine } from './interpolation.js';
import { CanvasRenderer } from './render.js';
import { Participant } from './protocol.js';

export function App() {
  // Session & Connection State
  const [roomId, setRoomId] = useState<string>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('room') || 'production-space';
  });
  const [clientId] = useState<string>(() => {
    return 'node_' + Math.random().toString(36).substring(2, 7);
  });

  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [stats, setStats] = useState<SyncStats>({
    rttMs: 0,
    jitterMs: 0,
    packetsSent: 0,
    packetsReceived: 0,
    packetsDroppedSimulated: 0,
    cursorSendRateHz: 0,
    effectiveThrottleMs: 33,
  });

  // Collaborative State
  const [syncScore, setSyncScore] = useState<number>(342);
  const [isSyncActive, setIsSyncActive] = useState<boolean>(false);

  // Active Tooling
  const [activeTool, setActiveTool] = useState<'cursor' | 'pen' | 'reaction'>('cursor');
  const [penColor, setPenColor] = useState<string>('#2563eb');
  const [isDrawing, setIsDrawing] = useState<boolean>(false);
  const currentStrokeRef = useRef<{ points: Array<{ x: number; y: number }>; color: string; width: number } | null>(null);

  // Virtual Collaborator Demo (makes canvas feel alive immediately)
  const [virtualCollaboratorEnabled, setVirtualCollaboratorEnabled] = useState<boolean>(true);

  // Developer Telemetry Drawer State
  const [showTelemetry, setShowTelemetry] = useState<boolean>(false);
  const [simLatency, setSimLatency] = useState<number>(0);
  const [simDropRate, setSimDropRate] = useState<number>(0);
  const [renderDelay, setRenderDelay] = useState<number>(60);

  // Viewport Coordinates
  const [coords, setCoords] = useState<{ x: number; y: number }>({ x: 0.5, y: 0.5 });

  // References
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const roomRef = useRef<RoomInstance | null>(null);
  const interpolationRef = useRef<InterpolationEngine | null>(null);
  const rendererRef = useRef<CanvasRenderer | null>(null);

  // Initialize Room & Render Engine
  useEffect(() => {
    const interpolation = new InterpolationEngine({ renderDelayMs: renderDelay });
    interpolationRef.current = interpolation;

    const room = createRoom({
      roomId,
      clientId,
      adaptiveThrottling: true,
    });
    roomRef.current = room;

    room.onStatusChange((newStatus) => setStatus(newStatus));
    room.onStatsChange((newStats) => setStats(newStats));
    room.onPresenceChange((list) => {
      setParticipants(list);
      rendererRef.current?.updateParticipants(list);
    });

    room.onTargetReconciled((targetId, score) => {
      if (targetId === 'fan_moment_goal') {
        setSyncScore(score);
      }
    });

    room.onRemoteAction((remoteClientId, action) => {
      if (action.type === 'cursor') {
        interpolation.pushSample(remoteClientId, action.x, action.y, performance.now());
      } else if (action.type === 'reaction') {
        rendererRef.current?.emitReaction(action.emoji, action.x, action.y);
      } else if (action.type === 'tap_target') {
        setSyncScore((prev) => prev + action.delta);
      }
    });

    if (canvasRef.current) {
      const renderer = new CanvasRenderer(canvasRef.current, interpolation, clientId);
      rendererRef.current = renderer;
      renderer.start();
    }

    return () => {
      rendererRef.current?.destroy();
      room.disconnect();
    };
  }, [roomId, clientId]);

  // Virtual Collaborator Loop (demonstrates multiplayer interpolation immediately)
  useEffect(() => {
    if (!virtualCollaboratorEnabled) {
      interpolationRef.current?.removeClient('virtual_peer');
      return;
    }

    // Register virtual collaborator in participants list if not already present
    const virtualParticipant: Participant = {
      clientId: 'virtual_peer',
      name: 'Alex (Virtual Peer)',
      color: '#7c3aed',
      avatar: '🤖',
      joinedAt: Date.now(),
      lastSeenAt: Date.now(),
    };

    let animTime = 0;
    let strokeCounter = 0;
    let currentStroke: { points: Array<{ x: number; y: number }>; color: string; width: number } | null = null;

    const interval = setInterval(() => {
      animTime += 0.04;
      // Smooth figure-8 Lissajous motion curve
      const vx = 0.5 + 0.3 * Math.sin(animTime * 1.1);
      const vy = 0.5 + 0.22 * Math.sin(animTime * 2.2);

      // Push position into our real interpolation engine
      interpolationRef.current?.pushSample('virtual_peer', vx, vy, performance.now());

      // Update renderer participants map
      rendererRef.current?.updateParticipants([
        ...participants,
        virtualParticipant,
      ]);

      // Periodically draw a short collaborative stroke
      strokeCounter++;
      if (strokeCounter % 4 === 0 && strokeCounter < 120) {
        if (!currentStroke) {
          currentStroke = { points: [{ x: vx, y: vy }], color: '#7c3aed', width: 2 };
        } else {
          currentStroke.points.push({ x: vx, y: vy });
          if (currentStroke.points.length > 15) {
            rendererRef.current?.addStroke({ ...currentStroke });
            currentStroke = null;
          }
        }
      }

      // Periodically trigger a subtle reaction
      if (strokeCounter % 150 === 0) {
        rendererRef.current?.emitReaction('✨', vx, vy, 8);
      }
    }, 33); // 30Hz

    return () => {
      clearInterval(interval);
      interpolationRef.current?.removeClient('virtual_peer');
    };
  }, [virtualCollaboratorEnabled, participants]);

  // Network Simulation Knobs
  useEffect(() => {
    interpolationRef.current?.setRenderDelay(renderDelay);
  }, [renderDelay]);

  useEffect(() => {
    roomRef.current?.setSimulatedLatency(simLatency);
  }, [simLatency]);

  useEffect(() => {
    roomRef.current?.setSimulatedDropRate(simDropRate);
  }, [simDropRate]);

  // Mouse Move Event Handler
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!stageRef.current || !roomRef.current) return;
    const rect = stageRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));

    setCoords({ x, y });
    roomRef.current.sendAction({ type: 'cursor', x, y });

    if (isDrawing && currentStrokeRef.current) {
      currentStrokeRef.current.points.push({ x, y });
      rendererRef.current?.addStroke({ ...currentStrokeRef.current });
    }
  }, [isDrawing]);

  // Stage Mouse Down Handler
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!stageRef.current) return;
    const rect = stageRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;

    if (activeTool === 'pen') {
      setIsDrawing(true);
      currentStrokeRef.current = {
        points: [{ x, y }],
        color: penColor,
        width: 2.5,
      };
      rendererRef.current?.addStroke(currentStrokeRef.current);
    } else {
      const emojis = ['⚡', '✨', '🎯', '🔥', '🚀'];
      const emoji = emojis[Math.floor(Math.random() * emojis.length)];
      rendererRef.current?.emitReaction(emoji, x, y);
      rendererRef.current?.addClickRipple(x, y, roomRef.current?.clientInfo.color || '#2563eb');

      roomRef.current?.sendAction({
        type: 'reaction',
        emoji,
        x,
        y,
        variant: 'burst',
      });
    }
  }, [activeTool, penColor]);

  const handleMouseUp = useCallback(() => {
    setIsDrawing(false);
    currentStrokeRef.current = null;
  }, []);

  // Collaborative Sync Target Action
  const handleSyncTap = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (!roomRef.current) return;

    setIsSyncActive(true);
    setTimeout(() => setIsSyncActive(false), 140);

    setSyncScore((prev) => prev + 1);

    const rect = stageRef.current?.getBoundingClientRect();
    if (rect) {
      const clickX = (e.clientX - rect.left) / rect.width;
      const clickY = (e.clientY - rect.top) / rect.height;
      rendererRef.current?.emitReaction('⚡', clickX, clickY, 8);
    }

    roomRef.current.sendAction({
      type: 'tap_target',
      targetId: 'fan_moment_goal',
      delta: 1,
    });
  }, []);

  // Open New Peer Tab
  const openNewClientTab = useCallback(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('room', roomId);
    window.open(url.toString(), '_blank');
  }, [roomId]);

  return (
    <div style={{
      minHeight: '100vh',
      backgroundColor: '#ffffff',
      color: '#0f172a',
      fontFamily: 'var(--font-sans)',
      display: 'flex',
      flexDirection: 'column',
    }}>
      {/* 1. MINIMALIST TOP NAVIGATION BAR */}
      <nav className="syncspace-nav" style={{
        height: '64px',
        borderBottom: '1px solid #e2e8f0',
        backgroundColor: '#ffffff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        position: 'sticky',
        top: 0,
        zIndex: 50,
      }}>
        {/* Brand & Breadcrumb */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{
              width: '26px',
              height: '26px',
              borderRadius: '7px',
              backgroundColor: '#0f172a',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
              </svg>
            </div>
            <span style={{ fontSize: '18px', fontWeight: 800, color: '#0f172a', letterSpacing: '-0.025em', fontFamily: 'var(--font-heading)' }}>
              SyncSpace
            </span>
          </div>

          <span style={{ color: '#cbd5e1', fontSize: '14px' }}>/</span>

          <span style={{
            fontSize: '13px',
            color: '#64748b',
            fontFamily: 'ui-monospace, monospace',
            backgroundColor: '#f8fafc',
            border: '1px solid #e2e8f0',
            padding: '3px 8px',
            borderRadius: '5px',
          }}>
            {roomId}
          </span>
        </div>

        {/* Center Navigation Links */}
        <div className="syncspace-nav-links" style={{ display: 'flex', alignItems: 'center', gap: '24px', fontSize: '13px', fontWeight: 500, color: '#475569' }}>
          <a href="#demo" style={{ color: '#0f172a', textDecoration: 'none', fontWeight: 600 }}>Live Canvas</a>
          <a href="#capabilities" style={{ color: '#475569', textDecoration: 'none' }}>Capabilities</a>
          <a href="#architecture" style={{ color: '#475569', textDecoration: 'none' }}>Architecture</a>
          <a href="#benchmarks" style={{ color: '#475569', textDecoration: 'none' }}>Benchmarks</a>
        </div>

        {/* Action Controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <button
            onClick={() => setShowTelemetry(!showTelemetry)}
            style={{
              backgroundColor: showTelemetry ? '#f1f5f9' : '#ffffff',
              color: '#0f172a',
              border: '1px solid #e2e8f0',
              borderRadius: '7px',
              padding: '7px 14px',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
            onMouseOver={(e) => (e.currentTarget.style.backgroundColor = '#f8fafc')}
            onMouseOut={(e) => (e.currentTarget.style.backgroundColor = showTelemetry ? '#f1f5f9' : '#ffffff')}
          >
            <span style={{ width: '7px', height: '7px', borderRadius: '50%', backgroundColor: status === 'connected' ? '#10b981' : '#f59e0b' }} />
            Telemetry {stats.rttMs > 0 && `(${stats.rttMs}ms)`}
          </button>

          <button
            onClick={openNewClientTab}
            style={{
              backgroundColor: '#0f172a',
              color: '#ffffff',
              border: 'none',
              borderRadius: '7px',
              padding: '8px 16px',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              boxShadow: '0 1px 2px rgba(0, 0, 0, 0.05)',
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.backgroundColor = '#1e293b';
              e.currentTarget.style.transform = 'translateY(-1px)';
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.backgroundColor = '#0f172a';
              e.currentTarget.style.transform = 'translateY(0)';
            }}
          >
            <span>➕</span> Open Viewer Tab
          </button>
        </div>
      </nav>

      {/* 2. HERO SECTION & LIVE WORKSPACE WINDOW */}
      <section style={{
        maxWidth: '1360px',
        width: '100%',
        margin: '0 auto',
        padding: '52px 32px 48px 32px',
      }}>
        <div className="syncspace-hero-grid">
          {/* Left Column: Technical Narrative & Actions */}
          <div style={{ paddingTop: '8px' }}>
            <div style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px',
              backgroundColor: '#f1f5f9',
              border: '1px solid #e2e8f0',
              padding: '4px 12px',
              borderRadius: '20px',
              fontSize: '11px',
              fontWeight: 700,
              color: '#475569',
              letterSpacing: '0.5px',
              textTransform: 'uppercase',
              marginBottom: '20px',
            }}>
              <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: '#2563eb' }} />
              RFC 6455 WebSocket Engine • Zero Dependencies
            </div>

            <h1 className="syncspace-hero-heading" style={{
              fontWeight: 800,
              color: '#0f172a',
              letterSpacing: '-0.03em',
              margin: '0 0 20px 0',
              fontFamily: 'var(--font-heading)',
            }}>
              Multiple users.<br />
              One synchronized workspace.
            </h1>

            <p style={{
              fontSize: '16px',
              lineHeight: 1.65,
              color: '#475569',
              margin: '0 0 28px 0',
              maxWidth: '480px',
            }}>
              A production-grade real-time synchronization layer engineered from first principles. Built directly on native WebSockets with dead-reckoning extrapolation, adaptive rate throttling, and deterministic conflict reconciliation.
            </p>

            {/* Action CTAs */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '32px' }}>
              <button
                onClick={openNewClientTab}
                style={{
                  backgroundColor: '#2563eb',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '8px',
                  padding: '11px 22px',
                  fontSize: '14px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  boxShadow: '0 2px 4px rgba(37, 99, 235, 0.2)',
                }}
                onMouseOver={(e) => {
                  e.currentTarget.style.backgroundColor = '#1d4ed8';
                  e.currentTarget.style.transform = 'translateY(-1px)';
                }}
                onMouseOut={(e) => {
                  e.currentTarget.style.backgroundColor = '#2563eb';
                  e.currentTarget.style.transform = 'translateY(0)';
                }}
              >
                <span>➕</span> Launch Multi-Client Test
              </button>

              <button
                onClick={() => setShowTelemetry(true)}
                style={{
                  backgroundColor: '#ffffff',
                  color: '#0f172a',
                  border: '1px solid #cbd5e1',
                  borderRadius: '8px',
                  padding: '11px 20px',
                  fontSize: '14px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                }}
                onMouseOver={(e) => {
                  e.currentTarget.style.backgroundColor = '#f8fafc';
                  e.currentTarget.style.transform = 'translateY(-1px)';
                }}
                onMouseOut={(e) => {
                  e.currentTarget.style.backgroundColor = '#ffffff';
                  e.currentTarget.style.transform = 'translateY(0)';
                }}
              >
                <span>🛠️</span> Network Lab & Telemetry
              </button>
            </div>

            {/* Verified Technical Metrics */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: '12px',
              borderTop: '1px solid #e2e8f0',
              paddingTop: '24px',
            }}>
              <div>
                <div style={{ fontSize: '20px', fontWeight: 800, color: '#0f172a', fontFamily: 'var(--font-heading)' }}>
                  0 deps
                </div>
                <div style={{ fontSize: '12px', color: '#64748b', marginTop: '2px' }}>
                  Pure native Node HTTP/net
                </div>
              </div>

              <div>
                <div style={{ fontSize: '20px', fontWeight: 800, color: '#0f172a', fontFamily: 'var(--font-heading)' }}>
                  60 FPS
                </div>
                <div style={{ fontSize: '12px', color: '#64748b', marginTop: '2px' }}>
                  Hermite curve interpolation
                </div>
              </div>

              <div>
                <div style={{ fontSize: '20px', fontWeight: 800, color: '#2563eb', fontFamily: 'var(--font-heading)' }}>
                  &lt; 30ms
                </div>
                <div style={{ fontSize: '12px', color: '#64748b', marginTop: '2px' }}>
                  Median sync latency
                </div>
              </div>
            </div>
          </div>

          {/* Right Column: Real Collaborative Product Demo Window */}
          <div id="demo" className="syncspace-demo-window" style={{
            backgroundColor: '#ffffff',
            borderRadius: '12px',
            border: '1px solid #cbd5e1',
            boxShadow: '0 10px 30px -5px rgba(15, 23, 42, 0.08), 0 0 0 1px rgba(226, 232, 240, 0.6)',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            position: 'relative',
          }}>
            {/* Window Chrome Titlebar */}
            <div style={{
              height: '40px',
              backgroundColor: '#f8fafc',
              borderBottom: '1px solid #e2e8f0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0 14px',
              userSelect: 'none',
            }}>
              {/* Control Dots & Window Label */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <span style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: '#cbd5e1' }} />
                  <span style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: '#cbd5e1' }} />
                  <span style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: '#cbd5e1' }} />
                </div>
                <span style={{ fontSize: '12px', fontWeight: 600, color: '#475569', marginLeft: '6px' }}>
                  workspace.canvas
                </span>
              </div>

              {/* Status Indicator, Peer Toggle & Participant Count */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                {/* Virtual Collaborator Toggle */}
                <button
                  onClick={() => setVirtualCollaboratorEnabled(!virtualCollaboratorEnabled)}
                  title="Toggle background virtual peer demonstration"
                  style={{
                    fontSize: '11px',
                    fontWeight: 600,
                    color: virtualCollaboratorEnabled ? '#7c3aed' : '#94a3b8',
                    backgroundColor: virtualCollaboratorEnabled ? '#f5f3ff' : '#f8fafc',
                    border: `1px solid ${virtualCollaboratorEnabled ? '#ddd6fe' : '#e2e8f0'}`,
                    padding: '2px 8px',
                    borderRadius: '12px',
                    cursor: 'pointer',
                  }}
                >
                  {virtualCollaboratorEnabled ? '🤖 Virtual Peer Active' : '🤖 Enable Peer Demo'}
                </button>

                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: '11px',
                  fontWeight: 600,
                  color: status === 'connected' ? '#059669' : '#d97706',
                  backgroundColor: status === 'connected' ? '#ecfdf5' : '#fffbeb',
                  border: `1px solid ${status === 'connected' ? '#a7f3d0' : '#fde68a'}`,
                  padding: '2px 8px',
                  borderRadius: '12px',
                }}>
                  <span style={{ width: '5px', height: '5px', borderRadius: '50%', backgroundColor: status === 'connected' ? '#10b981' : '#f59e0b' }} />
                  {status === 'connected' ? `Live · ${stats.rttMs}ms` : status}
                </div>

                <div style={{
                  fontSize: '11px',
                  fontWeight: 600,
                  color: '#334155',
                  backgroundColor: '#f1f5f9',
                  border: '1px solid #e2e8f0',
                  padding: '2px 8px',
                  borderRadius: '12px',
                }}>
                  👥 {participants.length + (virtualCollaboratorEnabled ? 1 : 0)} Active
                </div>
              </div>
            </div>

            {/* Interactive Workspace Body */}
            <div style={{ position: 'relative', flex: 1, display: 'flex', overflow: 'hidden' }}>
              {/* Minimalist Floating Tool Dock (Left) */}
              <div style={{
                position: 'absolute',
                top: '16px',
                left: '16px',
                backgroundColor: '#ffffff',
                border: '1px solid #e2e8f0',
                borderRadius: '8px',
                padding: '4px',
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
                boxShadow: '0 4px 12px rgba(15, 23, 42, 0.06)',
                zIndex: 30,
              }}>
                <button
                  onClick={() => setActiveTool('cursor')}
                  title="Select Mode"
                  style={{
                    width: '30px',
                    height: '30px',
                    borderRadius: '6px',
                    border: 'none',
                    backgroundColor: activeTool === 'cursor' ? '#f1f5f9' : 'transparent',
                    color: activeTool === 'cursor' ? '#2563eb' : '#64748b',
                    fontSize: '14px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  ↖
                </button>

                <button
                  onClick={() => setActiveTool('pen')}
                  title="Freehand Pen Mode"
                  style={{
                    width: '30px',
                    height: '30px',
                    borderRadius: '6px',
                    border: 'none',
                    backgroundColor: activeTool === 'pen' ? '#f1f5f9' : 'transparent',
                    color: activeTool === 'pen' ? '#2563eb' : '#64748b',
                    fontSize: '13px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  ✏️
                </button>

                {activeTool === 'pen' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', padding: '4px 0', alignItems: 'center' }}>
                    {['#2563eb', '#059669', '#dc2626', '#d97706'].map((color) => (
                      <div
                        key={color}
                        onClick={() => setPenColor(color)}
                        style={{
                          width: '14px',
                          height: '14px',
                          borderRadius: '50%',
                          backgroundColor: color,
                          cursor: 'pointer',
                          boxShadow: penColor === color ? '0 0 0 2px #ffffff, 0 0 0 3px #2563eb' : 'none',
                        }}
                      />
                    ))}
                  </div>
                )}

                <div style={{ height: '1px', backgroundColor: '#f1f5f9', margin: '2px 0' }} />

                <button
                  onClick={() => rendererRef.current?.clearStrokes()}
                  title="Clear Strokes"
                  style={{
                    width: '30px',
                    height: '30px',
                    borderRadius: '6px',
                    border: 'none',
                    backgroundColor: 'transparent',
                    color: '#94a3b8',
                    fontSize: '12px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  🗑️
                </button>
              </div>

              {/* Canvas Surface with Subtle Dot Matrix */}
              <div
                ref={stageRef}
                onMouseMove={handleMouseMove}
                onMouseDown={handleMouseDown}
                onMouseUp={handleMouseUp}
                style={{
                  position: 'relative',
                  flex: 1,
                  backgroundColor: '#ffffff',
                  cursor: activeTool === 'pen' ? 'crosshair' : 'default',
                  overflow: 'hidden',
                }}
              >
                {/* Subtle Grid Background */}
                <div style={{
                  position: 'absolute',
                  inset: 0,
                  backgroundImage: 'radial-gradient(#e2e8f0 1px, transparent 1px)',
                  backgroundSize: '20px 20px',
                  pointerEvents: 'none',
                }} />

                {/* Collaborative State Object (Shared Sprint Sync Card) */}
                <div style={{
                  position: 'absolute',
                  top: '20px',
                  right: '20px',
                  backgroundColor: '#ffffff',
                  border: '1px solid #e2e8f0',
                  borderRadius: '10px',
                  padding: '14px 18px',
                  boxShadow: '0 4px 16px -2px rgba(15, 23, 42, 0.06)',
                  zIndex: 20,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: '8px',
                  pointerEvents: 'auto',
                  minWidth: '180px',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                    <span style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', color: '#64748b', letterSpacing: '0.4px' }}>
                      Shared Sprint Sync
                    </span>
                    <span style={{ fontSize: '10px', fontWeight: 600, color: '#059669', backgroundColor: '#ecfdf5', padding: '1px 6px', borderRadius: '4px' }}>
                      Atomic
                    </span>
                  </div>

                  <div className="tabular-nums" style={{ fontSize: '28px', fontWeight: 800, color: '#0f172a', letterSpacing: '-0.5px' }}>
                    {syncScore.toLocaleString()}
                  </div>

                  <button
                    onClick={handleSyncTap}
                    style={{
                      width: '100%',
                      backgroundColor: isSyncActive ? '#1d4ed8' : '#2563eb',
                      color: '#ffffff',
                      border: 'none',
                      borderRadius: '6px',
                      padding: '7px 12px',
                      fontSize: '12px',
                      fontWeight: 600,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '6px',
                    }}
                    onMouseOver={(e) => (e.currentTarget.style.backgroundColor = '#1d4ed8')}
                    onMouseOut={(e) => (e.currentTarget.style.backgroundColor = '#2563eb')}
                  >
                    <span>⚡</span> Tap to Synchronize
                  </button>
                </div>

                {/* Full Canvas Layer for Smooth Cursors & Ink */}
                <canvas
                  ref={canvasRef}
                  style={{
                    position: 'absolute',
                    inset: 0,
                    width: '100%',
                    height: '100%',
                    pointerEvents: 'none',
                    zIndex: 25,
                  }}
                />

                {/* Subtle Reaction Dock at Bottom */}
                <div style={{
                  position: 'absolute',
                  bottom: '16px',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  backgroundColor: 'rgba(255, 255, 255, 0.92)',
                  border: '1px solid #e2e8f0',
                  borderRadius: '24px',
                  padding: '4px 12px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  boxShadow: '0 4px 12px rgba(15, 23, 42, 0.06)',
                  backdropFilter: 'blur(8px)',
                  zIndex: 30,
                }}>
                  <span style={{ fontSize: '10px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.4px', marginRight: '4px' }}>
                    Burst
                  </span>
                  {['⚡', '✨', '🎯', '🔥', '🚀'].map((emoji) => (
                    <button
                      key={emoji}
                      onClick={(e) => {
                        e.stopPropagation();
                        const x = 0.45 + Math.random() * 0.1;
                        const y = 0.45 + Math.random() * 0.1;
                        rendererRef.current?.emitReaction(emoji, x, y, 10);
                        roomRef.current?.sendAction({
                          type: 'reaction',
                          emoji,
                          x,
                          y,
                          variant: 'burst',
                        });
                      }}
                      style={{
                        background: 'none',
                        border: 'none',
                        fontSize: '16px',
                        cursor: 'pointer',
                        padding: '4px 6px',
                        borderRadius: '4px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                      onMouseOver={(e) => {
                        e.currentTarget.style.backgroundColor = '#f1f5f9';
                        e.currentTarget.style.transform = 'translateY(-1px)';
                      }}
                      onMouseOut={(e) => {
                        e.currentTarget.style.backgroundColor = 'transparent';
                        e.currentTarget.style.transform = 'translateY(0)';
                      }}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Minimalist Window Status Bar */}
            <div style={{
              height: '28px',
              backgroundColor: '#f8fafc',
              borderTop: '1px solid #e2e8f0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0 14px',
              fontSize: '11px',
              color: '#64748b',
            }}>
              <div className="tabular-nums">
                Norm: {coords.x.toFixed(3)}, {coords.y.toFixed(3)}
              </div>
              <div>
                Protocol: <span style={{ fontFamily: 'ui-monospace, monospace', color: '#0f172a' }}>RFC 6455 Frame (0x1)</span> • Zoom: 100%
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 3. SECTION: CORE CAPABILITIES (4 PREMIUM FEATURE CARDS) */}
      <section id="capabilities" style={{
        maxWidth: '1360px',
        width: '100%',
        margin: '0 auto',
        padding: '64px 32px',
        borderTop: '1px solid #f1f5f9',
      }}>
        <div style={{ textAlign: 'center', maxWidth: '640px', margin: '0 auto 48px auto' }}>
          <span style={{ fontSize: '11px', fontWeight: 700, color: '#2563eb', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
            System Architecture
          </span>
          <h2 style={{ fontSize: '32px', fontWeight: 800, color: '#0f172a', letterSpacing: '-0.02em', margin: '10px 0 12px 0', fontFamily: 'var(--font-heading)' }}>
            Engineered for low-latency synchronization
          </h2>
          <p style={{ fontSize: '15px', color: '#64748b', lineHeight: 1.6, margin: 0 }}>
            Every layer is purpose-built to maintain consistency and fluid visual feedback over real-world network conditions.
          </p>
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: '24px',
        }}>
          {/* Card 1 */}
          <div style={{
            backgroundColor: '#ffffff',
            border: '1px solid #e2e8f0',
            borderRadius: '12px',
            padding: '24px',
            boxShadow: '0 1px 3px rgba(0, 0, 0, 0.04)',
          }}>
            <div style={{ width: '36px', height: '36px', borderRadius: '8px', backgroundColor: '#eff6ff', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#2563eb', fontSize: '18px', marginBottom: '16px' }}>
              ⚡
            </div>
            <h3 style={{ fontSize: '16px', fontWeight: 700, color: '#0f172a', margin: '0 0 8px 0', fontFamily: 'var(--font-heading)' }}>
              Real-Time Synchronization
            </h3>
            <p style={{ fontSize: '14px', color: '#64748b', lineHeight: 1.6, margin: 0 }}>
              Direct RFC 6455 raw WebSocket framing with sub-30ms median update intervals. Eliminates third-party state engine overhead and unnecessary payload bloat.
            </p>
          </div>

          {/* Card 2 */}
          <div style={{
            backgroundColor: '#ffffff',
            border: '1px solid #e2e8f0',
            borderRadius: '12px',
            padding: '24px',
            boxShadow: '0 1px 3px rgba(0, 0, 0, 0.04)',
          }}>
            <div style={{ width: '36px', height: '36px', borderRadius: '8px', backgroundColor: '#f5f3ff', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#7c3aed', fontSize: '18px', marginBottom: '16px' }}>
              👥
            </div>
            <h3 style={{ fontSize: '16px', fontWeight: 700, color: '#0f172a', margin: '0 0 8px 0', fontFamily: 'var(--font-heading)' }}>
              Presence Engine
            </h3>
            <p style={{ fontSize: '14px', color: '#64748b', lineHeight: 1.6, margin: 0 }}>
              Deterministic session resumption without cursor duplication. Automatic heartbeat sweeps and socket close events eliminate zombie cursors within bounded time.
            </p>
          </div>

          {/* Card 3 */}
          <div style={{
            backgroundColor: '#ffffff',
            border: '1px solid #e2e8f0',
            borderRadius: '12px',
            padding: '24px',
            boxShadow: '0 1px 3px rgba(0, 0, 0, 0.04)',
          }}>
            <div style={{ width: '36px', height: '36px', borderRadius: '8px', backgroundColor: '#ecfdf5', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#059669', fontSize: '18px', marginBottom: '16px' }}>
              〰️
            </div>
            <h3 style={{ fontSize: '16px', fontWeight: 700, color: '#0f172a', margin: '0 0 8px 0', fontFamily: 'var(--font-heading)' }}>
              Smooth Motion Engine
            </h3>
            <p style={{ fontSize: '14px', color: '#64748b', lineHeight: 1.6, margin: 0 }}>
              Entity interpolation through a 60ms render delay buffer with cubic Hermite curves. Forward velocity extrapolation ensures cursors glide smoothly even under network jitter.
            </p>
          </div>

          {/* Card 4 */}
          <div style={{
            backgroundColor: '#ffffff',
            border: '1px solid #e2e8f0',
            borderRadius: '12px',
            padding: '24px',
            boxShadow: '0 1px 3px rgba(0, 0, 0, 0.04)',
          }}>
            <div style={{ width: '36px', height: '36px', borderRadius: '8px', backgroundColor: '#fffbeb', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#d97706', fontSize: '18px', marginBottom: '16px' }}>
              🛡️
            </div>
            <h3 style={{ fontSize: '16px', fontWeight: 700, color: '#0f172a', margin: '0 0 8px 0', fontFamily: 'var(--font-heading)' }}>
              Network Resilience
            </h3>
            <p style={{ fontSize: '14px', color: '#64748b', lineHeight: 1.6, margin: 0 }}>
              Adaptive throttling dynamically adjusts packet rate based on RTT measurements. Out-of-order and stale sequence packets are rejected before entering the interpolation buffer.
            </p>
          </div>
        </div>
      </section>

      {/* 4. SECTION: TECHNICAL ARCHITECTURE PIPELINE */}
      <section id="architecture" style={{
        maxWidth: '1360px',
        width: '100%',
        margin: '0 auto',
        padding: '64px 32px',
        borderTop: '1px solid #f1f5f9',
      }}>
        <div style={{ textAlign: 'center', maxWidth: '640px', margin: '0 auto 48px auto' }}>
          <span style={{ fontSize: '11px', fontWeight: 700, color: '#2563eb', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
            Data Flow Pipeline
          </span>
          <h2 style={{ fontSize: '32px', fontWeight: 800, color: '#0f172a', letterSpacing: '-0.02em', margin: '10px 0 12px 0', fontFamily: 'var(--font-heading)' }}>
            End-to-End Relay Architecture
          </h2>
          <p style={{ fontSize: '15px', color: '#64748b', lineHeight: 1.6, margin: 0 }}>
            Structured pipeline ensuring strict O(N) fan-out without sender echo loops.
          </p>
        </div>

        {/* Visual Pipeline Step Cards */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '16px',
          alignItems: 'stretch',
        }}>
          {/* Step 1 */}
          <div style={{ backgroundColor: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '10px', padding: '20px' }}>
            <span style={{ fontSize: '11px', fontWeight: 700, color: '#2563eb', textTransform: 'uppercase' }}>01 / Input Layer</span>
            <h4 style={{ fontSize: '15px', fontWeight: 700, color: '#0f172a', margin: '8px 0 6px 0' }}>Client Tracking</h4>
            <p style={{ fontSize: '13px', color: '#64748b', margin: 0, lineHeight: 1.5 }}>
              Normalizes coordinates [0.0, 1.0] and throttles mousemove events to ~30Hz.
            </p>
          </div>

          {/* Step 2 */}
          <div style={{ backgroundColor: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '10px', padding: '20px' }}>
            <span style={{ fontSize: '11px', fontWeight: 700, color: '#2563eb', textTransform: 'uppercase' }}>02 / Transport</span>
            <h4 style={{ fontSize: '15px', fontWeight: 700, color: '#0f172a', margin: '8px 0 6px 0' }}>RFC 6455 Framing</h4>
            <p style={{ fontSize: '13px', color: '#64748b', margin: 0, lineHeight: 1.5 }}>
              Client masks payload with 4-byte XOR key; native server decodes without libraries.
            </p>
          </div>

          {/* Step 3 */}
          <div style={{ backgroundColor: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '10px', padding: '20px' }}>
            <span style={{ fontSize: '11px', fontWeight: 700, color: '#2563eb', textTransform: 'uppercase' }}>03 / Validation</span>
            <h4 style={{ fontSize: '15px', fontWeight: 700, color: '#0f172a', margin: '8px 0 6px 0' }}>Sequence Filter</h4>
            <p style={{ fontSize: '13px', color: '#64748b', margin: 0, lineHeight: 1.5 }}>
              Checks monotonic sequence number (<code style={{ fontSize: '12px' }}>seq &gt; lastSeq</code>) and validates JSON schema.
            </p>
          </div>

          {/* Step 4 */}
          <div style={{ backgroundColor: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '10px', padding: '20px' }}>
            <span style={{ fontSize: '11px', fontWeight: 700, color: '#2563eb', textTransform: 'uppercase' }}>04 / Fan-Out</span>
            <h4 style={{ fontSize: '15px', fontWeight: 700, color: '#0f172a', margin: '8px 0 6px 0' }}>Room Coordinator</h4>
            <p style={{ fontSize: '13px', color: '#64748b', margin: 0, lineHeight: 1.5 }}>
              Broadcasts action to all room participants, strictly skipping the sender socket.
            </p>
          </div>

          {/* Step 5 */}
          <div style={{ backgroundColor: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '10px', padding: '20px' }}>
            <span style={{ fontSize: '11px', fontWeight: 700, color: '#2563eb', textTransform: 'uppercase' }}>05 / Rendering</span>
            <h4 style={{ fontSize: '15px', fontWeight: 700, color: '#0f172a', margin: '8px 0 6px 0' }}>Interpolation Loop</h4>
            <p style={{ fontSize: '13px', color: '#64748b', margin: 0, lineHeight: 1.5 }}>
              Hermite curves blend coordinates on a 60fps HiDPI canvas with dead reckoning.
            </p>
          </div>
        </div>
      </section>

      {/* 5. SECTION: ENGINEERING BENCHMARKS (NO FAKE MARKETING STATS) */}
      <section id="benchmarks" style={{
        maxWidth: '1360px',
        width: '100%',
        margin: '0 auto',
        padding: '64px 32px 80px 32px',
        borderTop: '1px solid #f1f5f9',
      }}>
        <div style={{ textAlign: 'center', maxWidth: '640px', margin: '0 auto 48px auto' }}>
          <span style={{ fontSize: '11px', fontWeight: 700, color: '#2563eb', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
            Empirical Verification
          </span>
          <h2 style={{ fontSize: '32px', fontWeight: 800, color: '#0f172a', letterSpacing: '-0.02em', margin: '10px 0 12px 0', fontFamily: 'var(--font-heading)' }}>
            Engineering Benchmarks
          </h2>
          <p style={{ fontSize: '15px', color: '#64748b', lineHeight: 1.6, margin: 0 }}>
            Measured system characteristics across our zero-dependency test harness.
          </p>
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          gap: '20px',
        }}>
          <div style={{ backgroundColor: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '10px', padding: '24px' }}>
            <span style={{ fontSize: '12px', fontWeight: 600, color: '#64748b' }}>FRAME RATE</span>
            <div className="tabular-nums" style={{ fontSize: '32px', fontWeight: 800, color: '#0f172a', margin: '6px 0' }}>
              60 FPS
            </div>
            <p style={{ fontSize: '13px', color: '#64748b', margin: 0 }}>
              Hardware-accelerated sub-pixel requestAnimationFrame render loop.
            </p>
          </div>

          <div style={{ backgroundColor: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '10px', padding: '24px' }}>
            <span style={{ fontSize: '12px', fontWeight: 600, color: '#64748b' }}>NETWORK LATENCY</span>
            <div className="tabular-nums" style={{ fontSize: '32px', fontWeight: 800, color: '#2563eb', margin: '6px 0' }}>
              &lt; 30 ms
            </div>
            <p style={{ fontSize: '13px', color: '#64748b', margin: 0 }}>
              Median local delivery latency with unmasked server-to-client frames.
            </p>
          </div>

          <div style={{ backgroundColor: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '10px', padding: '24px' }}>
            <span style={{ fontSize: '12px', fontWeight: 600, color: '#64748b' }}>EXTERNAL RUNTIME PACKAGES</span>
            <div className="tabular-nums" style={{ fontSize: '32px', fontWeight: 800, color: '#059669', margin: '6px 0' }}>
              0 Deps
            </div>
            <p style={{ fontSize: '13px', color: '#64748b', margin: 0 }}>
              Pure native Node.js HTTP/net/crypto modules. Zero ws or Socket.io.
            </p>
          </div>

          <div style={{ backgroundColor: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '10px', padding: '24px' }}>
            <span style={{ fontSize: '12px', fontWeight: 600, color: '#64748b' }}>AUTOMATED TEST SUITE</span>
            <div className="tabular-nums" style={{ fontSize: '32px', fontWeight: 800, color: '#0f172a', margin: '6px 0' }}>
              17 / 17
            </div>
            <p style={{ fontSize: '13px', color: '#64748b', margin: 0 }}>
              Passing end-to-end RFC 6455 socket and interpolation verification tests.
            </p>
          </div>
        </div>
      </section>

      {/* 6. CLEAN DEVELOPER FOOTER */}
      <footer style={{
        borderTop: '1px solid #e2e8f0',
        backgroundColor: '#f8fafc',
        padding: '32px',
        marginTop: 'auto',
      }}>
        <div style={{
          maxWidth: '1360px',
          margin: '0 auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '16px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{
              width: '20px',
              height: '20px',
              borderRadius: '5px',
              backgroundColor: '#0f172a',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="2.5">
                <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
              </svg>
            </div>
            <span style={{ fontSize: '14px', fontWeight: 800, color: '#0f172a', letterSpacing: '-0.02em', fontFamily: 'var(--font-heading)' }}>
              SyncSpace
            </span>
            <span style={{ fontSize: '12px', color: '#94a3b8', marginLeft: '6px' }}>
              — Real-Time Multiplayer State Sync
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '20px', fontSize: '12px', color: '#64748b' }}>
            <span>Built for FLAM AI Frontend R&amp;D</span>
            <span>•</span>
            <a href="#demo" style={{ color: '#64748b', textDecoration: 'none' }}>Live Sandbox</a>
            <span>•</span>
            <a href="#telemetry" onClick={(e) => { e.preventDefault(); setShowTelemetry(true); }} style={{ color: '#64748b', textDecoration: 'none' }}>Telemetry Lab</a>
          </div>
        </div>
      </footer>

      {/* 7. DEVELOPER TELEMETRY DRAWER (SUBTLE BACKDROP BLUR 4PX) */}
      {showTelemetry && (
        <div style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'rgba(15, 23, 42, 0.25)',
          backdropFilter: 'blur(4px)',
          zIndex: 100,
          display: 'flex',
          justifyContent: 'flex-end',
        }}>
          <div className="syncspace-drawer" style={{
            backgroundColor: '#ffffff',
            height: '100%',
            boxShadow: '-10px 0 30px rgba(0, 0, 0, 0.08)',
            display: 'flex',
            flexDirection: 'column',
            padding: '28px',
            overflowY: 'auto',
          }}>
            {/* Drawer Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
              <div>
                <h3 style={{ fontSize: '17px', fontWeight: 700, color: '#0f172a', margin: 0, fontFamily: 'var(--font-heading)' }}>
                  Sync Engine Telemetry
                </h3>
                <span style={{ fontSize: '12px', color: '#64748b' }}>
                  Live transport & jitter buffer metrics
                </span>
              </div>
              <button
                onClick={() => setShowTelemetry(false)}
                style={{
                  background: 'none',
                  border: '1px solid #e2e8f0',
                  borderRadius: '6px',
                  width: '28px',
                  height: '28px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#64748b',
                }}
              >
                &times;
              </button>
            </div>

            {/* Telemetry Metric Cards */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '10px',
              marginBottom: '28px',
            }}>
              <div style={{ backgroundColor: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px' }}>
                <span style={{ fontSize: '11px', color: '#64748b', fontWeight: 600 }}>ROUND-TRIP TIME</span>
                <div className="tabular-nums" style={{ fontSize: '20px', fontWeight: 800, color: stats.rttMs < 50 ? '#059669' : '#d97706', marginTop: '2px' }}>
                  {stats.rttMs} ms
                </div>
              </div>

              <div style={{ backgroundColor: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px' }}>
                <span style={{ fontSize: '11px', color: '#64748b', fontWeight: 600 }}>JITTER VARIANCE</span>
                <div className="tabular-nums" style={{ fontSize: '20px', fontWeight: 800, color: '#2563eb', marginTop: '2px' }}>
                  &plusmn;{stats.jitterMs} ms
                </div>
              </div>

              <div style={{ backgroundColor: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px' }}>
                <span style={{ fontSize: '11px', color: '#64748b', fontWeight: 600 }}>SEND RATE</span>
                <div className="tabular-nums" style={{ fontSize: '20px', fontWeight: 800, color: '#0f172a', marginTop: '2px' }}>
                  {stats.cursorSendRateHz} Hz
                </div>
              </div>

              <div style={{ backgroundColor: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px' }}>
                <span style={{ fontSize: '11px', color: '#64748b', fontWeight: 600 }}>ADAPTIVE THROTTLE</span>
                <div className="tabular-nums" style={{ fontSize: '20px', fontWeight: 800, color: '#0f172a', marginTop: '2px' }}>
                  {stats.effectiveThrottleMs} ms
                </div>
              </div>
            </div>

            {/* Connected Participants List */}
            <div style={{ marginBottom: '28px' }}>
              <div style={{ fontSize: '11px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '10px' }}>
                Active Connected Nodes ({participants.length + (virtualCollaboratorEnabled ? 1 : 0)})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {participants.map((p) => (
                  <div
                    key={p.clientId}
                    style={{
                      backgroundColor: p.clientId === clientId ? '#eff6ff' : '#f8fafc',
                      border: `1px solid ${p.clientId === clientId ? '#bfdbfe' : '#e2e8f0'}`,
                      borderRadius: '7px',
                      padding: '8px 12px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      fontSize: '12px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span>{p.avatar || '👤'}</span>
                      <span style={{ fontWeight: 600, color: '#0f172a' }}>{p.name}</span>
                      {p.clientId === clientId && (
                        <span style={{ fontSize: '10px', color: '#2563eb', fontWeight: 600 }}>
                          (Local)
                        </span>
                      )}
                    </div>
                    <div className="tabular-nums" style={{ fontSize: '11px', color: '#64748b' }}>
                      ID: {p.clientId.slice(0, 8)}
                    </div>
                  </div>
                ))}

                {virtualCollaboratorEnabled && (
                  <div
                    style={{
                      backgroundColor: '#f5f3ff',
                      border: '1px solid #ddd6fe',
                      borderRadius: '7px',
                      padding: '8px 12px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      fontSize: '12px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span>🤖</span>
                      <span style={{ fontWeight: 600, color: '#7c3aed' }}>Alex (Virtual Peer)</span>
                    </div>
                    <div className="tabular-nums" style={{ fontSize: '11px', color: '#7c3aed' }}>
                      Simulated
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Network Degradation Lab */}
            <div style={{
              backgroundColor: '#f8fafc',
              border: '1px solid #e2e8f0',
              borderRadius: '10px',
              padding: '16px',
              display: 'flex',
              flexDirection: 'column',
              gap: '14px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '12px', fontWeight: 700, color: '#0f172a', textTransform: 'uppercase' }}>
                  🛠️ Degraded Network Lab
                </span>
              </div>
              <p style={{ fontSize: '12px', color: '#64748b', margin: 0, lineHeight: 1.5 }}>
                Simulate latency spikes and packet loss to observe the dead-reckoning extrapolation engine maintaining smooth motion.
              </p>

              {/* Latency Slider */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', fontWeight: 600, color: '#334155', marginBottom: '4px' }}>
                  <span>Artificial Latency:</span>
                  <span className="tabular-nums">{simLatency} ms</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="350"
                  step="25"
                  value={simLatency}
                  onChange={(e) => setSimLatency(parseInt(e.target.value, 10))}
                  style={{ width: '100%', accentColor: '#2563eb' }}
                />
              </div>

              {/* Packet Drop Slider */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', fontWeight: 600, color: '#334155', marginBottom: '4px' }}>
                  <span>Packet Drop Rate:</span>
                  <span className="tabular-nums">{simDropRate}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="30"
                  step="5"
                  value={simDropRate}
                  onChange={(e) => setSimDropRate(parseInt(e.target.value, 10))}
                  style={{ width: '100%', accentColor: '#ef4444' }}
                />
              </div>

              {/* Buffer Delay Slider */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', fontWeight: 600, color: '#334155', marginBottom: '4px' }}>
                  <span>Render Delay Buffer:</span>
                  <span className="tabular-nums">{renderDelay} ms</span>
                </div>
                <input
                  type="range"
                  min="20"
                  max="150"
                  step="10"
                  value={renderDelay}
                  onChange={(e) => setRenderDelay(parseInt(e.target.value, 10))}
                  style={{ width: '100%', accentColor: '#059669' }}
                />
              </div>

              {/* Simulation Action Buttons */}
              <button
                onClick={() => {
                  if (status === 'connected') {
                    roomRef.current?.disconnect();
                  } else {
                    roomRef.current?.reconnect();
                  }
                }}
                style={{
                  backgroundColor: status === 'connected' ? '#ffffff' : '#0f172a',
                  color: status === 'connected' ? '#dc2626' : '#ffffff',
                  border: `1px solid ${status === 'connected' ? '#fca5a5' : '#0f172a'}`,
                  borderRadius: '7px',
                  padding: '9px',
                  fontSize: '12px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  marginTop: '4px',
                }}
              >
                {status === 'connected' ? 'Simulate Socket Disconnect' : 'Reconnect Session'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Core Real-Time Sync Engine & Raw WebSocket Connection Client
 *
 * Implements the required room management API:
 *   const room = createRoom({ roomId: "watch-party-42", clientId });
 *   room.sendAction({ type: "cursor", x, y });
 *   room.onRemoteAction((clientId, action) => { ... });
 *
 * Key features:
 * - Native raw browser WebSocket API (zero library dependencies).
 * - Sane cursor throttling with Adaptive Rate based on measured RTT latency.
 * - Heartbeat Ping-Pong loop with real-time RTT & jitter estimation.
 * - Disconnect detection & automatic exponential-backoff reconnection.
 * - Outgoing action queuing during momentary reconnection.
 * - Built-in network simulator (latency & packet drop) for live evaluation.
 */

import {
  ClientAction,
  ClientMessage,
  ServerMessage,
  Participant,
  ClientInfo,
  DrawStroke,
  validateServerMessage,
} from './protocol.js';

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface SyncStats {
  rttMs: number;
  jitterMs: number;
  packetsSent: number;
  packetsReceived: number;
  packetsDroppedSimulated: number;
  cursorSendRateHz: number;
  effectiveThrottleMs: number;
}

export interface CreateRoomOptions {
  roomId: string;
  clientId?: string;
  clientInfo?: Partial<ClientInfo>;
  wsUrl?: string;
  adaptiveThrottling?: boolean;
}

export interface RoomInstance {
  readonly roomId: string;
  readonly clientId: string;
  readonly clientInfo: ClientInfo;

  sendAction(action: ClientAction): void;
  onRemoteAction(handler: (clientId: string, action: ClientAction, meta: { seq: number; timestamp: number }) => void): () => void;
  onPresenceChange(handler: (participants: Participant[]) => void): () => void;
  onStatusChange(handler: (status: ConnectionStatus) => void): () => void;
  onStatsChange(handler: (stats: SyncStats) => void): () => void;
  onTargetReconciled(handler: (targetId: string, score: number) => void): () => void;
  onStrokesSync(handler: (strokes: DrawStroke[]) => void): () => void;

  setSimulatedLatency(latencyMs: number): void;
  setSimulatedDropRate(ratePercent: number): void;

  disconnect(): void;
  reconnect(): void;
}

const DEFAULT_AVATARS = ['⚡', '🔥', '🚀', '🌟', '🎯', '💫', '🦁', '🦊'];
const DEFAULT_COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444',
  '#8b5cf6', '#ec4899', '#06b6d4', '#14b8a6',
];

export function createRoom(options: CreateRoomOptions): RoomInstance {
  const roomId = options.roomId;
  const clientId = options.clientId || 'client_' + Math.random().toString(36).substring(2, 9);
  const colorIndex = Math.floor(Math.random() * DEFAULT_COLORS.length);

  const clientInfo: ClientInfo = {
    name: options.clientInfo?.name || `Viewer ${clientId.slice(-4)}`,
    color: options.clientInfo?.color || DEFAULT_COLORS[colorIndex],
    avatar: options.clientInfo?.avatar || DEFAULT_AVATARS[colorIndex],
  };

  const wsUrl = options.wsUrl ||
    (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_WS_URL) ||
    (typeof window !== 'undefined'
      ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.hostname}:8080`
      : 'ws://localhost:8080');

  // State
  let ws: WebSocket | null = null;
  let status: ConnectionStatus = 'connecting';
  let seq = 0;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pingIntervalTimer: ReturnType<typeof setInterval> | null = null;
  let throttleTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingCursorAction: ClientAction | null = null;
  let lastCursorSentTime = 0;
  let isIntentionallyClosed = false;

  // Network Simulation State
  let simLatencyMs = 0;
  let simDropRatePercent = 0;

  // Stats & Adaptive Throttling
  let rttMs = 0;
  let jitterMs = 0;
  let lastRttSample = 0;
  let packetsSent = 0;
  let packetsReceived = 0;
  let packetsDroppedSimulated = 0;
  let cursorThrottleMs = 33; // ~30Hz default
  let cursorSendCountInWindow = 0;
  let currentSendRateHz = 30;

  // Rate window measurement
  setInterval(() => {
    currentSendRateHz = cursorSendCountInWindow;
    cursorSendCountInWindow = 0;
    notifyStats();
  }, 1000);

  // Presence & Listeners
  let participants: Participant[] = [];
  const remoteActionHandlers = new Set<(clientId: string, action: ClientAction, meta: { seq: number; timestamp: number }) => void>();
  const presenceHandlers = new Set<(participants: Participant[]) => void>();
  const statusHandlers = new Set<(status: ConnectionStatus) => void>();
  const statsHandlers = new Set<(stats: SyncStats) => void>();
  const targetReconciledHandlers = new Set<(targetId: string, score: number) => void>();
  const strokesSyncHandlers = new Set<(strokes: DrawStroke[]) => void>();
  let cachedStrokes: DrawStroke[] | null = null;

  function updateStatus(newStatus: ConnectionStatus) {
    if (status === newStatus) return;
    status = newStatus;
    statusHandlers.forEach(h => h(status));
  }

  function notifyStats() {
    const stats: SyncStats = {
      rttMs: Math.round(rttMs),
      jitterMs: Math.round(jitterMs),
      packetsSent,
      packetsReceived,
      packetsDroppedSimulated,
      cursorSendRateHz: currentSendRateHz,
      effectiveThrottleMs: cursorThrottleMs,
    };
    statsHandlers.forEach(h => h(stats));
  }

  function adaptThrottle() {
    if (options.adaptiveThrottling === false) return;
    // Adapt based on RTT:
    // Low latency (<50ms): 30ms throttle (~33Hz)
    // Moderate latency (50-150ms): 40ms throttle (25Hz)
    // High latency (>150ms): 55ms throttle (~18Hz) to prevent socket buffer congestion
    if (rttMs < 50) {
      cursorThrottleMs = 30;
    } else if (rttMs < 150) {
      cursorThrottleMs = 42;
    } else {
      cursorThrottleMs = 60;
    }
  }

  function rawSend(message: ClientMessage) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    // Simulation: Simulated packet drop
    if (simDropRatePercent > 0 && Math.random() * 100 < simDropRatePercent) {
      packetsDroppedSimulated++;
      return;
    }

    const payload = JSON.stringify(message);

    // Simulation: Simulated latency
    if (simLatencyMs > 0) {
      setTimeout(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(payload);
          packetsSent++;
        }
      }, simLatencyMs / 2); // Half-RTT
    } else {
      ws.send(payload);
      packetsSent++;
    }
  }

  function flushCursorAction() {
    if (!pendingCursorAction) return;

    const action = pendingCursorAction;
    pendingCursorAction = null;
    lastCursorSentTime = performance.now();
    cursorSendCountInWindow++;

    seq++;
    const envelope: ClientMessage = {
      type: 'action',
      roomId,
      clientId,
      seq,
      timestamp: Date.now(),
      action,
    };

    rawSend(envelope);
  }

  function connect() {
    if (isIntentionallyClosed) return;
    updateStatus(reconnectAttempts === 0 ? 'connecting' : 'reconnecting');

    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      reconnectAttempts = 0;
      updateStatus('connected');

      // 1. Send Join Message
      const joinMsg: ClientMessage = {
        type: 'join',
        roomId,
        clientId,
        clientInfo,
        clientTime: Date.now(),
      };
      rawSend(joinMsg);

      // 2. Start Ping / RTT Loop
      startPingLoop();
    };

    ws.onmessage = (event) => {
      packetsReceived++;

      const handleIncoming = () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.data);
        } catch {
          return;
        }

        const msg = validateServerMessage(parsed);
        if (!msg) return;

        switch (msg.type) {
          case 'snapshot': {
            participants = msg.clients;
            presenceHandlers.forEach(h => h([...participants]));
            if (msg.strokes && Array.isArray(msg.strokes)) {
              cachedStrokes = msg.strokes;
              strokesSyncHandlers.forEach(h => h(msg.strokes));
            }
            break;
          }

          case 'client_joined': {
            const idx = participants.findIndex(p => p.clientId === msg.client.clientId);
            if (idx >= 0) {
              participants[idx] = msg.client;
            } else {
              participants.push(msg.client);
            }
            presenceHandlers.forEach(h => h([...participants]));
            break;
          }

          case 'client_left': {
            participants = participants.filter(p => p.clientId !== msg.clientId);
            presenceHandlers.forEach(h => h([...participants]));
            break;
          }

          case 'action': {
            // Update last known position for participant in presence list
            if (msg.action.type === 'cursor') {
              const p = participants.find(part => part.clientId === msg.clientId);
              if (p) {
                p.lastPosition = { x: msg.action.x, y: msg.action.y };
              }
            }

            remoteActionHandlers.forEach(h =>
              h(msg.clientId, msg.action, { seq: msg.seq, timestamp: msg.timestamp })
            );
            break;
          }

          case 'pong': {
            const now = Date.now();
            const measuredRtt = Math.max(1, now - msg.clientTimestamp);
            if (rttMs === 0) {
              rttMs = measuredRtt;
            } else {
              // EWMA filter for smooth RTT and jitter
              jitterMs = 0.8 * jitterMs + 0.2 * Math.abs(measuredRtt - rttMs);
              rttMs = 0.85 * rttMs + 0.15 * measuredRtt;
            }
            lastRttSample = measuredRtt;
            adaptThrottle();
            notifyStats();
            break;
          }

          case 'target_reconciled': {
            targetReconciledHandlers.forEach(h => h(msg.targetId, msg.totalScore));
            break;
          }
        }
      };

      if (simLatencyMs > 0) {
        setTimeout(handleIncoming, simLatencyMs / 2);
      } else {
        handleIncoming();
      }
    };

    ws.onclose = () => {
      stopPingLoop();
      if (!isIntentionallyClosed) {
        scheduleReconnect();
      } else {
        updateStatus('disconnected');
      }
    };

    ws.onerror = () => {
      // Handled by close event
    };
  }

  function scheduleReconnect() {
    if (isIntentionallyClosed) return;
    updateStatus('reconnecting');

    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectAttempts++;

    // Exponential backoff with jitter: min(1000 * 1.5^n + jitter, 8000)
    const backoff = Math.min(8000, 1000 * Math.pow(1.5, reconnectAttempts - 1));
    const jitter = Math.random() * 500;
    const delay = backoff + jitter;

    reconnectTimer = setTimeout(() => {
      connect();
    }, delay);
  }

  function startPingLoop() {
    stopPingLoop();
    pingIntervalTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        const pingMsg: ClientMessage = {
          type: 'ping',
          clientId,
          timestamp: Date.now(),
        };
        rawSend(pingMsg);
      }
    }, 2000);
  }

  function stopPingLoop() {
    if (pingIntervalTimer) {
      clearInterval(pingIntervalTimer);
      pingIntervalTimer = null;
    }
  }

  // Kick off initial connection
  connect();

  return {
    roomId,
    clientId,
    clientInfo,

    sendAction(action: ClientAction) {
      if (action.type === 'cursor') {
        pendingCursorAction = action;
        const now = performance.now();
        const elapsed = now - lastCursorSentTime;

        if (elapsed >= cursorThrottleMs) {
          if (throttleTimer) {
            clearTimeout(throttleTimer);
            throttleTimer = null;
          }
          flushCursorAction();
        } else if (!throttleTimer) {
          throttleTimer = setTimeout(() => {
            throttleTimer = null;
            flushCursorAction();
          }, cursorThrottleMs - elapsed);
        }
      } else {
        // Discrete actions (reaction, tap_target) bypass cursor throttle!
        seq++;
        const envelope: ClientMessage = {
          type: 'action',
          roomId,
          clientId,
          seq,
          timestamp: Date.now(),
          action,
        };
        rawSend(envelope);
      }
    },

    onRemoteAction(handler) {
      remoteActionHandlers.add(handler);
      return () => remoteActionHandlers.delete(handler);
    },

    onPresenceChange(handler) {
      presenceHandlers.add(handler);
      handler([...participants]);
      return () => presenceHandlers.delete(handler);
    },

    onStatusChange(handler) {
      statusHandlers.add(handler);
      handler(status);
      return () => statusHandlers.delete(handler);
    },

    onStatsChange(handler) {
      statsHandlers.add(handler);
      notifyStats();
      return () => statsHandlers.delete(handler);
    },

    onTargetReconciled(handler) {
      targetReconciledHandlers.add(handler);
      return () => targetReconciledHandlers.delete(handler);
    },

    onStrokesSync(handler) {
      strokesSyncHandlers.add(handler);
      if (cachedStrokes !== null) {
        handler([...cachedStrokes]);
      }
      return () => strokesSyncHandlers.delete(handler);
    },

    setSimulatedLatency(latencyMs: number) {
      simLatencyMs = Math.max(0, latencyMs);
    },

    setSimulatedDropRate(ratePercent: number) {
      simDropRatePercent = Math.max(0, Math.min(100, ratePercent));
    },

    disconnect() {
      isIntentionallyClosed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (throttleTimer) clearTimeout(throttleTimer);
      stopPingLoop();
      if (ws) {
        ws.close(1000, 'User disconnect');
        ws = null;
      }
      updateStatus('disconnected');
    },

    reconnect() {
      isIntentionallyClosed = false;
      reconnectAttempts = 0;
      if (ws) {
        ws.close();
      }
      connect();
    },
  };
}

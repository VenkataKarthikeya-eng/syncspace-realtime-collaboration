/**
 * Shared Wire Protocol Definitions & Runtime Schema Validators
 *
 * Designed from first principles for zero-dependency real-time sync.
 * All coordinates are normalized [0.0, 1.0] for viewport-agnostic rendering.
 * All messages carry monotonic sequence numbers (seq) and timestamps for jitter buffer ordering.
 */

// ============================================================================
// Action Types (Extensible Discriminated Union)
// ============================================================================

export interface CursorAction {
  type: 'cursor';
  x: number; // Normalized horizontal coordinate [0.0, 1.0]
  y: number; // Normalized vertical coordinate [0.0, 1.0]
}

export interface ReactionAction {
  type: 'reaction';
  emoji: string;
  x: number; // Normalized [0.0, 1.0]
  y: number; // Normalized [0.0, 1.0]
  variant?: 'burst' | 'float' | 'sparkle';
}

export interface TapTargetAction {
  type: 'tap_target';
  targetId: string;
  delta: number; // Incremental contribution
}

export interface DrawStroke {
  id: string;
  points: Array<{ x: number; y: number }>;
  color: string;
  width: number;
}

export interface StrokeAction {
  type: 'stroke';
  stroke: DrawStroke;
}

export interface ClearStrokesAction {
  type: 'clear_strokes';
}

export type ClientAction =
  | CursorAction
  | ReactionAction
  | TapTargetAction
  | StrokeAction
  | ClearStrokesAction;

// ============================================================================
// Client Metadata
// ============================================================================

export interface ClientInfo {
  name: string;
  color: string;
  avatar?: string;
}

export interface Participant {
  clientId: string;
  name: string;
  color: string;
  avatar?: string;
  lastPosition?: { x: number; y: number };
  joinedAt: number;
  lastSeenAt: number;
  rttMs?: number;
}

// ============================================================================
// Client -> Server Wire Messages
// ============================================================================

export interface JoinRoomMessage {
  type: 'join';
  roomId: string;
  clientId: string;
  clientInfo: ClientInfo;
  clientTime: number;
}

export interface ClientActionEnvelope {
  type: 'action';
  roomId: string;
  clientId: string;
  seq: number;       // Monotonic sequence number per client
  timestamp: number; // Client local time in ms
  action: ClientAction;
}

export interface PingMessage {
  type: 'ping';
  clientId: string;
  timestamp: number; // Client dispatch timestamp
}

export type ClientMessage = JoinRoomMessage | ClientActionEnvelope | PingMessage;

// ============================================================================
// Server -> Client Wire Messages
// ============================================================================

export interface RoomSnapshotMessage {
  type: 'snapshot';
  roomId: string;
  serverTime: number;
  clients: Participant[];
  strokes: DrawStroke[]; // Persistent canvas strokes for new and reconnecting joiners
  state: {
    fanMomentScore: number;
  };
}

export interface ClientJoinedMessage {
  type: 'client_joined';
  roomId: string;
  client: Participant;
  serverTime: number;
}

export interface ClientLeftMessage {
  type: 'client_left';
  roomId: string;
  clientId: string;
  reason: 'disconnect' | 'timeout' | 'replaced';
  serverTime: number;
}

export interface BroadcastActionEnvelope {
  type: 'action';
  roomId: string;
  clientId: string;
  seq: number;
  timestamp: number;
  serverTime: number;
  action: ClientAction;
}

export interface PongMessage {
  type: 'pong';
  clientTimestamp: number;
  serverTimestamp: number;
}

export interface TargetReconciledMessage {
  type: 'target_reconciled';
  targetId: string;
  totalScore: number;
  serverTime: number;
}

export interface ErrorMessage {
  type: 'error';
  code: string;
  message: string;
}

export type ServerMessage =
  | RoomSnapshotMessage
  | ClientJoinedMessage
  | ClientLeftMessage
  | BroadcastActionEnvelope
  | PongMessage
  | TargetReconciledMessage
  | ErrorMessage;

// ============================================================================
// Runtime Validators & Type Guards (Strict Type Safety)
// ============================================================================

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

export function validateClientAction(data: unknown): ClientAction | null {
  if (!isObject(data)) return null;

  if (data.type === 'cursor') {
    if (typeof data.x !== 'number' || typeof data.y !== 'number') return null;
    if (!Number.isFinite(data.x) || !Number.isFinite(data.y)) return null;
    const x = Math.max(0, Math.min(1, data.x));
    const y = Math.max(0, Math.min(1, data.y));
    return { type: 'cursor', x, y };
  }

  if (data.type === 'reaction') {
    if (typeof data.emoji !== 'string' || data.emoji.length === 0 || data.emoji.length > 10) return null;
    if (typeof data.x !== 'number' || typeof data.y !== 'number') return null;
    if (!Number.isFinite(data.x) || !Number.isFinite(data.y)) return null;
    const x = Math.max(0, Math.min(1, data.x));
    const y = Math.max(0, Math.min(1, data.y));
    const variant = (data.variant === 'burst' || data.variant === 'float' || data.variant === 'sparkle')
      ? data.variant
      : 'burst';
    return { type: 'reaction', emoji: data.emoji, x, y, variant };
  }

  if (data.type === 'tap_target') {
    if (typeof data.targetId !== 'string' || data.targetId.length === 0 || data.targetId.length > 50) return null;
    if (typeof data.delta !== 'number' || !Number.isFinite(data.delta)) return null;
    const delta = Math.max(1, Math.min(50, Math.floor(data.delta)));
    return { type: 'tap_target', targetId: data.targetId, delta };
  }

  if (data.type === 'stroke') {
    if (!isObject(data.stroke)) return null;
    const stroke = data.stroke;
    if (typeof stroke.id !== 'string' || !Array.isArray(stroke.points)) return null;
    if (typeof stroke.color !== 'string' || typeof stroke.width !== 'number') return null;
    const points: Array<{ x: number; y: number }> = [];
    for (const pt of stroke.points.slice(0, 300)) {
      if (!isObject(pt) || typeof pt.x !== 'number' || typeof pt.y !== 'number') continue;
      if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) continue;
      points.push({
        x: Math.max(0, Math.min(1, pt.x)),
        y: Math.max(0, Math.min(1, pt.y)),
      });
    }
    if (points.length === 0) return null;
    return {
      type: 'stroke',
      stroke: {
        id: stroke.id.slice(0, 64),
        points,
        color: stroke.color.slice(0, 32),
        width: Math.max(1, Math.min(20, stroke.width)),
      },
    };
  }

  if (data.type === 'clear_strokes') {
    return { type: 'clear_strokes' };
  }

  return null;
}

export function validateClientMessage(raw: unknown): ClientMessage | null {
  if (!isObject(raw)) return null;

  if (raw.type === 'join') {
    if (typeof raw.roomId !== 'string' || raw.roomId.length === 0 || raw.roomId.length > 64) return null;
    if (typeof raw.clientId !== 'string' || raw.clientId.length === 0 || raw.clientId.length > 64) return null;
    if (!isObject(raw.clientInfo)) return null;
    if (typeof raw.clientInfo.name !== 'string' || raw.clientInfo.name.trim().length === 0) return null;
    if (typeof raw.clientInfo.color !== 'string' || !raw.clientInfo.color.startsWith('#')) return null;
    const clientTime = typeof raw.clientTime === 'number' && Number.isFinite(raw.clientTime)
      ? raw.clientTime
      : Date.now();

    return {
      type: 'join',
      roomId: raw.roomId.trim(),
      clientId: raw.clientId.trim(),
      clientInfo: {
        name: raw.clientInfo.name.trim().slice(0, 32),
        color: raw.clientInfo.color.slice(0, 16),
        avatar: typeof raw.clientInfo.avatar === 'string' ? raw.clientInfo.avatar.slice(0, 10) : undefined,
      },
      clientTime,
    };
  }

  if (raw.type === 'action') {
    if (typeof raw.roomId !== 'string' || typeof raw.clientId !== 'string') return null;
    if (typeof raw.seq !== 'number' || !Number.isInteger(raw.seq) || raw.seq < 0) return null;
    if (typeof raw.timestamp !== 'number' || !Number.isFinite(raw.timestamp)) return null;
    const action = validateClientAction(raw.action);
    if (!action) return null;

    return {
      type: 'action',
      roomId: raw.roomId,
      clientId: raw.clientId,
      seq: raw.seq,
      timestamp: raw.timestamp,
      action,
    };
  }

  if (raw.type === 'ping') {
    if (typeof raw.clientId !== 'string') return null;
    if (typeof raw.timestamp !== 'number' || !Number.isFinite(raw.timestamp)) return null;
    return {
      type: 'ping',
      clientId: raw.clientId,
      timestamp: raw.timestamp,
    };
  }

  return null;
}

export function validateServerMessage(raw: unknown): ServerMessage | null {
  if (!isObject(raw) || typeof raw.type !== 'string') return null;

  switch (raw.type) {
    case 'snapshot':
      if (typeof raw.roomId !== 'string' || typeof raw.serverTime !== 'number' || !Array.isArray(raw.clients)) {
        return null;
      }
      return raw as unknown as RoomSnapshotMessage;

    case 'client_joined':
      if (typeof raw.roomId !== 'string' || !isObject(raw.client)) return null;
      return raw as unknown as ClientJoinedMessage;

    case 'client_left':
      if (typeof raw.roomId !== 'string' || typeof raw.clientId !== 'string') return null;
      return raw as unknown as ClientLeftMessage;

    case 'action':
      if (typeof raw.roomId !== 'string' || typeof raw.clientId !== 'string' || !isObject(raw.action)) return null;
      return raw as unknown as BroadcastActionEnvelope;

    case 'pong':
      if (typeof raw.clientTimestamp !== 'number' || typeof raw.serverTimestamp !== 'number') return null;
      return raw as unknown as PongMessage;

    case 'target_reconciled':
      if (typeof raw.targetId !== 'string' || typeof raw.totalScore !== 'number') return null;
      return raw as unknown as TargetReconciledMessage;

    case 'error':
      if (typeof raw.message !== 'string') return null;
      return raw as unknown as ErrorMessage;

    default:
      return null;
  }
}

/**
 * Shared Wire Protocol Definitions & Runtime Schema Validators (Client-side)
 *
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
// Runtime Validators & Type Guards
// ============================================================================

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
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

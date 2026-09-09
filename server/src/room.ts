/**
 * Room and State Management Layer
 *
 * Manages participant presence, snapshot generation on join,
 * conflict-free action relaying (O(N) fan-out without sender echo),
 * sequence number validation, and graceful disconnect cleanup.
 */

import {
  Participant,
  ClientInfo,
  ClientActionEnvelope,
  BroadcastActionEnvelope,
  RoomSnapshotMessage,
  ClientJoinedMessage,
  ClientLeftMessage,
  TargetReconciledMessage,
  PongMessage,
  DrawStroke,
} from './protocol.js';

export interface SocketConnection {
  id: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  isAlive: boolean;
}

interface RoomMember {
  participant: Participant;
  socket: SocketConnection;
  lastSeq: number;
}

export class Room {
  public readonly id: string;
  private members = new Map<string, RoomMember>();
  private strokes: DrawStroke[] = [];
  private fanMomentScore = 0;
  private scoreBroadcastScheduled = false;

  constructor(id: string) {
    this.id = id;
  }

  /**
   * Current number of connected participants.
   */
  public get size(): number {
    return this.members.size;
  }

  /**
   * Adds or resumes a client connection into the room.
   * Handles re-connections gracefully without duplicating presence.
   */
  public addMember(
    clientId: string,
    clientInfo: ClientInfo,
    socket: SocketConnection
  ): void {
    const now = Date.now();
    const existing = this.members.get(clientId);

    if (existing) {
      // Client reconnected with the same ID - replace socket without duplicating presence
      try {
        existing.socket.close(1000, 'Replaced by new connection');
      } catch {
        // Socket already closed
      }

      existing.socket = socket;
      existing.participant.lastSeenAt = now;
      existing.participant.name = clientInfo.name;
      existing.participant.color = clientInfo.color;
      if (clientInfo.avatar) existing.participant.avatar = clientInfo.avatar;

      // Deliver fresh snapshot to the reconnected client
      this.sendSnapshot(clientId);
      return;
    }

    const participant: Participant = {
      clientId,
      name: clientInfo.name,
      color: clientInfo.color,
      avatar: clientInfo.avatar,
      joinedAt: now,
      lastSeenAt: now,
    };

    this.members.set(clientId, {
      participant,
      socket,
      lastSeq: 0,
    });

    // 1. Send state snapshot to the newly joined client
    this.sendSnapshot(clientId);

    // 2. Broadcast 'client_joined' to all other room members
    const joinedMsg: ClientJoinedMessage = {
      type: 'client_joined',
      roomId: this.id,
      client: participant,
      serverTime: now,
    };

    this.broadcast(JSON.stringify(joinedMsg), clientId);
  }

  /**
   * Removes a member from the room and notifies peers.
   */
  public removeMember(
    clientId: string,
    reason: 'disconnect' | 'timeout' | 'replaced' = 'disconnect'
  ): void {
    const member = this.members.get(clientId);
    if (!member) return;

    this.members.delete(clientId);

    const leftMsg: ClientLeftMessage = {
      type: 'client_left',
      roomId: this.id,
      clientId,
      reason,
      serverTime: Date.now(),
    };

    this.broadcast(JSON.stringify(leftMsg), clientId);
  }

  /**
   * Relays an action to all other participants after sequence & ordering validation.
   */
  public handleAction(clientId: string, envelope: ClientActionEnvelope): void {
    const member = this.members.get(clientId);
    if (!member) return;

    const now = Date.now();
    member.participant.lastSeenAt = now;

    // Reject out-of-order stale packets
    if (envelope.seq <= member.lastSeq) {
      // Discard stale update to preserve ordering integrity
      return;
    }
    member.lastSeq = envelope.seq;

    // Update server-tracked state
    if (envelope.action.type === 'cursor') {
      member.participant.lastPosition = {
        x: envelope.action.x,
        y: envelope.action.y,
      };
    } else if (envelope.action.type === 'tap_target') {
      this.fanMomentScore += envelope.action.delta;
      this.scheduleScoreReconciliation();
    } else if (envelope.action.type === 'stroke') {
      this.strokes.push(envelope.action.stroke);
      if (this.strokes.length > 500) {
        this.strokes.shift(); // Enforce bounded memory
      }
    } else if (envelope.action.type === 'clear_strokes') {
      this.strokes = [];
    }

    // Broadcast to everyone ELSE (no echo back to sender)
    const broadcastEnvelope: BroadcastActionEnvelope = {
      type: 'action',
      roomId: this.id,
      clientId,
      seq: envelope.seq,
      timestamp: envelope.timestamp,
      serverTime: now,
      action: envelope.action,
    };

    this.broadcast(JSON.stringify(broadcastEnvelope), clientId);
  }

  /**
   * Handles client ping and responds with server timestamp for RTT calculation.
   */
  public handlePing(clientId: string, clientTimestamp: number): void {
    const member = this.members.get(clientId);
    if (!member) return;

    const now = Date.now();
    member.participant.lastSeenAt = now;

    const pong: PongMessage = {
      type: 'pong',
      clientTimestamp,
      serverTimestamp: now,
    };

    try {
      member.socket.send(JSON.stringify(pong));
    } catch {
      // Socket failed
    }
  }

  /**
   * Returns snapshot of all active participants and state.
   */
  private sendSnapshot(clientId: string): void {
    const member = this.members.get(clientId);
    if (!member) return;

    const clients: Participant[] = [];
    for (const m of this.members.values()) {
      clients.push({ ...m.participant });
    }

    const snapshot: RoomSnapshotMessage = {
      type: 'snapshot',
      roomId: this.id,
      serverTime: Date.now(),
      clients,
      strokes: [...this.strokes],
      state: {
        fanMomentScore: this.fanMomentScore,
      },
    };

    try {
      member.socket.send(JSON.stringify(snapshot));
    } catch {
      // Socket failed
    }
  }

  /**
   * Efficient fan-out broadcast to room members, optionally skipping the sender.
   */
  private broadcast(payload: string, excludeClientId?: string): void {
    for (const [id, member] of this.members.entries()) {
      if (excludeClientId && id === excludeClientId) continue;
      try {
        member.socket.send(payload);
      } catch {
        // Socket error will be handled by connection close event
      }
    }
  }

  /**
   * Throttles reconciliation broadcast for high-frequency collaborative tap targets.
   */
  private scheduleScoreReconciliation(): void {
    if (this.scoreBroadcastScheduled) return;
    this.scoreBroadcastScheduled = true;

    setTimeout(() => {
      this.scoreBroadcastScheduled = false;
      const msg: TargetReconciledMessage = {
        type: 'target_reconciled',
        targetId: 'fan_moment_goal',
        totalScore: this.fanMomentScore,
        serverTime: Date.now(),
      };
      this.broadcast(JSON.stringify(msg));
    }, 50);
  }

  /**
   * Checks for stale or dead connections (inactive beyond threshold).
   */
  public reapStaleMembers(maxInactivityMs: number): void {
    const now = Date.now();
    for (const [clientId, member] of this.members.entries()) {
      if (now - member.participant.lastSeenAt > maxInactivityMs) {
        try {
          member.socket.close(1006, 'Inactivity timeout');
        } catch {
          // Ignore
        }
        this.removeMember(clientId, 'timeout');
      }
    }
  }
}

/**
 * Production-grade, Zero-Dependency RFC 6455 WebSocket Server
 *
 * Implements the WebSocket protocol from first principles using Node's built-in
 * `http`, `crypto`, and `net` modules. Zero external socket or state-sync dependencies.
 *
 * Features:
 * - RFC 6455 §4.2 Handshake (SHA-1 Sec-WebSocket-Accept)
 * - RFC 6455 §5.2 Frame Parser with variable length (7-bit, 16-bit, 64-bit)
 * - 4-byte XOR client mask decoding
 * - TCP packet fragment reassembly & multi-frame buffer parsing
 * - Server-to-client unmasked frame encoder
 * - Control frame support: Ping (0x9), Pong (0xA), Close (0x8)
 * - Heartbeat & ghost connection cleanup
 * - Room routing & protocol validation
 */

import http from 'node:http';
import crypto from 'node:crypto';
import net from 'node:net';
import { Room, SocketConnection } from './room.js';
import { validateClientMessage, ClientMessage, ErrorMessage } from './protocol.js';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// RFC 6455 Opcodes
const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

export interface ServerOptions {
  port?: number;
  host?: string;
  heartbeatIntervalMs?: number;
  inactivityTimeoutMs?: number;
}

export class ZeroWsConnection implements SocketConnection {
  public readonly id: string;
  public isAlive = true;
  private socket: net.Socket;
  private rxBuffer = Buffer.alloc(0);
  private messageFragments: Buffer[] = [];
  private messageOpcode: number | null = null;
  private onMessageCallback?: (text: string) => void;
  private onCloseCallback?: (code: number, reason: string) => void;
  private closed = false;

  constructor(socket: net.Socket, id: string) {
    this.socket = socket;
    this.id = id;

    this.socket.on('data', (chunk: Buffer) => this.handleData(chunk));
    this.socket.on('error', (err) => {
      // Socket error - tear down cleanly
      this.close(1006, 'Socket error: ' + err.message);
    });
    this.socket.on('close', () => {
      this.close(1000, 'Socket closed');
    });
  }

  public onMessage(cb: (text: string) => void): void {
    this.onMessageCallback = cb;
  }

  public onClose(cb: (code: number, reason: string) => void): void {
    this.onCloseCallback = cb;
  }

  /**
   * Encodes and sends a UTF-8 text frame (unmasked for server->client per RFC 6455 §5.1)
   */
  public send(data: string): void {
    if (this.closed || !this.socket.writable) return;
    const payload = Buffer.from(data, 'utf8');
    const frame = ZeroWsConnection.encodeFrame(OPCODE_TEXT, payload);
    this.socket.write(frame);
  }

  /**
   * Sends a Ping control frame (0x9)
   */
  public sendPing(payload = Buffer.alloc(0)): void {
    if (this.closed || !this.socket.writable) return;
    const frame = ZeroWsConnection.encodeFrame(OPCODE_PING, payload);
    this.socket.write(frame);
  }

  /**
   * Sends a Pong control frame (0xA)
   */
  public sendPong(payload = Buffer.alloc(0)): void {
    if (this.closed || !this.socket.writable) return;
    const frame = ZeroWsConnection.encodeFrame(OPCODE_PONG, payload);
    this.socket.write(frame);
  }

  /**
   * Closes the connection with an RFC 6455 Close frame (0x8)
   */
  public close(code = 1000, reason = 'Normal closure'): void {
    if (this.closed) return;
    this.closed = true;
    this.isAlive = false;

    try {
      if (this.socket.writable) {
        const reasonBuf = Buffer.from(reason.slice(0, 123), 'utf8');
        const payload = Buffer.alloc(2 + reasonBuf.length);
        payload.writeUInt16BE(code, 0);
        reasonBuf.copy(payload, 2);

        const closeFrame = ZeroWsConnection.encodeFrame(OPCODE_CLOSE, payload);
        this.socket.write(closeFrame, () => {
          this.socket.end();
        });
      } else {
        this.socket.destroy();
      }
    } catch {
      this.socket.destroy();
    }

    if (this.onCloseCallback) {
      this.onCloseCallback(code, reason);
    }
  }

  /**
   * Parses incoming TCP bytes, reassembles frames, and handles fragmented payloads.
   */
  private handleData(chunk: Buffer): void {
    this.isAlive = true;
    this.rxBuffer = Buffer.concat([this.rxBuffer, chunk]);

    while (this.rxBuffer.length >= 2) {
      const firstByte = this.rxBuffer[0];
      const secondByte = this.rxBuffer[1];

      const fin = (firstByte & 0x80) !== 0;
      const opcode = firstByte & 0x0f;
      const masked = (secondByte & 0x80) !== 0;
      let payloadLen = secondByte & 0x7f;

      let headerSize = 2;

      // Extended payload length parsing
      if (payloadLen === 126) {
        if (this.rxBuffer.length < 4) return; // Wait for full header
        payloadLen = this.rxBuffer.readUInt16BE(2);
        headerSize = 4;
      } else if (payloadLen === 127) {
        if (this.rxBuffer.length < 10) return; // Wait for full header
        const bigLen = this.rxBuffer.readBigUInt64BE(2);
        if (bigLen > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.close(1009, 'Payload too large');
          return;
        }
        payloadLen = Number(bigLen);
        headerSize = 10;
      }

      // RFC 6455 §5.1: Client-to-server frames MUST be masked
      if (!masked) {
        this.close(1002, 'Protocol error: client frame unmasked');
        return;
      }

      const maskKeyOffset = headerSize;
      const payloadOffset = maskKeyOffset + 4;
      const totalFrameSize = payloadOffset + payloadLen;

      if (this.rxBuffer.length < totalFrameSize) {
        // Full frame has not arrived yet over TCP stream; wait for more data
        return;
      }

      // Extract mask key and payload
      const maskKey = this.rxBuffer.subarray(maskKeyOffset, payloadOffset);
      const maskedPayload = this.rxBuffer.subarray(payloadOffset, totalFrameSize);

      // Unmask payload (RFC 6455 §5.3: byte[i] = masked[i] ^ maskKey[i % 4])
      const unmaskedPayload = Buffer.alloc(payloadLen);
      for (let i = 0; i < payloadLen; i++) {
        unmaskedPayload[i] = maskedPayload[i] ^ maskKey[i % 4];
      }

      // Slide remaining TCP buffer
      this.rxBuffer = this.rxBuffer.subarray(totalFrameSize);

      // Handle Control Frames (must not be fragmented)
      if (opcode === OPCODE_PING) {
        this.sendPong(unmaskedPayload);
        continue;
      }

      if (opcode === OPCODE_PONG) {
        this.isAlive = true;
        continue;
      }

      if (opcode === OPCODE_CLOSE) {
        let code = 1000;
        let reason = 'Normal closure';
        if (unmaskedPayload.length >= 2) {
          code = unmaskedPayload.readUInt16BE(0);
          reason = unmaskedPayload.subarray(2).toString('utf8');
        }
        this.close(code, reason);
        return;
      }

      // Handle Data Frames (Text / Continuation)
      if (opcode === OPCODE_TEXT || opcode === OPCODE_BINARY) {
        this.messageOpcode = opcode;
        this.messageFragments = [unmaskedPayload];
      } else if (opcode === OPCODE_CONTINUATION) {
        this.messageFragments.push(unmaskedPayload);
      }

      if (fin) {
        const fullPayload = Buffer.concat(this.messageFragments);
        this.messageFragments = [];

        if (this.messageOpcode === OPCODE_TEXT) {
          const text = fullPayload.toString('utf8');
          if (this.onMessageCallback) {
            this.onMessageCallback(text);
          }
        }
        this.messageOpcode = null;
      }
    }
  }

  /**
   * Encodes a WebSocket frame (Server-to-client frames MUST NOT be masked)
   */
  private static encodeFrame(opcode: number, payload: Buffer): Buffer {
    const payloadLen = payload.length;
    let headerSize = 2;

    if (payloadLen >= 126 && payloadLen <= 65535) {
      headerSize = 4;
    } else if (payloadLen > 65535) {
      headerSize = 10;
    }

    const frame = Buffer.alloc(headerSize + payloadLen);

    // FIN = 1, RSV = 0, Opcode
    frame[0] = 0x80 | (opcode & 0x0f);

    // MASK = 0 (server->client)
    if (payloadLen < 126) {
      frame[1] = payloadLen;
      payload.copy(frame, 2);
    } else if (payloadLen <= 65535) {
      frame[1] = 126;
      frame.writeUInt16BE(payloadLen, 2);
      payload.copy(frame, 4);
    } else {
      frame[1] = 127;
      frame.writeBigUInt64BE(BigInt(payloadLen), 2);
      payload.copy(frame, 10);
    }

    return frame;
  }
}

export class RealtimeServer {
  private httpServer: http.Server;
  private rooms = new Map<string, Room>();
  private clientRoomIndex = new Map<string, { roomId: string; clientId: string }>();
  private heartbeatTimer?: NodeJS.Timeout;
  private options: Required<ServerOptions>;

  constructor(options: ServerOptions = {}) {
    this.options = {
      port: options.port ?? 8080,
      host: options.host ?? '0.0.0.0',
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 15000,
      inactivityTimeoutMs: options.inactivityTimeoutMs ?? 45000,
    };

    this.httpServer = http.createServer((req, res) => {
      // Health check & status endpoint
      if (req.url === '/health' || req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'ok',
            activeRooms: this.rooms.size,
            uptimeSeconds: Math.floor(process.uptime()),
          })
        );
        return;
      }

      res.writeHead(404);
      res.end();
    });

    this.httpServer.on('upgrade', (req, socket: net.Socket, head) => {
      this.handleUpgrade(req, socket, head);
    });
  }

  /**
   * Performs the RFC 6455 HTTP upgrade handshake.
   */
  private handleUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
    const upgradeHeader = req.headers['upgrade'];
    const secWsKey = req.headers['sec-websocket-key'];
    const secWsVersion = req.headers['sec-websocket-version'];

    if (
      !upgradeHeader ||
      upgradeHeader.toLowerCase() !== 'websocket' ||
      !secWsKey ||
      secWsVersion !== '13'
    ) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    // Compute SHA-1 Accept hash: Base64(SHA1(Sec-WebSocket-Key + WS_GUID))
    const acceptKey = crypto
      .createHash('sha1')
      .update(secWsKey + WS_GUID)
      .digest('base64');

    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`,
      '\r\n',
    ];

    socket.write(headers.join('\r\n'));

    const connectionId = 'conn_' + crypto.randomUUID().slice(0, 8);
    const connection = new ZeroWsConnection(socket, connectionId);

    connection.onMessage((rawText) => {
      this.handleClientMessage(connection, rawText);
    });

    connection.onClose((code, reason) => {
      this.handleClientClose(connection);
    });
  }

  /**
   * Routes and validates incoming client messages.
   */
  private handleClientMessage(conn: ZeroWsConnection, rawText: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      this.sendError(conn, 'INVALID_JSON', 'Message must be valid JSON');
      return;
    }

    const message: ClientMessage | null = validateClientMessage(parsed);
    if (!message) {
      this.sendError(conn, 'MALFORMED_MESSAGE', 'Message failed schema validation');
      return;
    }

    switch (message.type) {
      case 'join': {
        const { roomId, clientId, clientInfo } = message;
        let room = this.rooms.get(roomId);
        if (!room) {
          room = new Room(roomId);
          this.rooms.set(roomId, room);
        }

        // Map connection to room
        this.clientRoomIndex.set(conn.id, { roomId, clientId });
        room.addMember(clientId, clientInfo, conn);
        break;
      }

      case 'action': {
        const mapping = this.clientRoomIndex.get(conn.id);
        if (!mapping) {
          this.sendError(conn, 'NOT_IN_ROOM', 'Must join a room before sending actions');
          return;
        }

        const room = this.rooms.get(mapping.roomId);
        if (room) {
          room.handleAction(mapping.clientId, message);
        }
        break;
      }

      case 'ping': {
        const mapping = this.clientRoomIndex.get(conn.id);
        if (mapping) {
          const room = this.rooms.get(mapping.roomId);
          if (room) {
            room.handlePing(mapping.clientId, message.timestamp);
          }
        }
        break;
      }
    }
  }

  /**
   * Graceful disconnection and zombie-pruning.
   */
  private handleClientClose(conn: ZeroWsConnection): void {
    const mapping = this.clientRoomIndex.get(conn.id);
    if (!mapping) return;

    this.clientRoomIndex.delete(conn.id);
    const room = this.rooms.get(mapping.roomId);
    if (room) {
      room.removeMember(mapping.clientId, 'disconnect');
      if (room.size === 0) {
        this.rooms.delete(mapping.roomId);
      }
    }
  }

  private sendError(conn: ZeroWsConnection, code: string, message: string): void {
    const errorMsg: ErrorMessage = {
      type: 'error',
      code,
      message,
    };
    conn.send(JSON.stringify(errorMsg));
  }

  /**
   * Periodic heartbeat timer checking stale connections.
   */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const [roomId, room] of this.rooms.entries()) {
        room.reapStaleMembers(this.options.inactivityTimeoutMs);
        if (room.size === 0) {
          this.rooms.delete(roomId);
        }
      }
    }, this.options.heartbeatIntervalMs);
  }

  public start(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer.listen(this.options.port, this.options.host, () => {
        console.log(`[RealtimeServer] RFC 6455 Zero-WS Server running on ws://${this.options.host}:${this.options.port}`);
        this.startHeartbeat();
        resolve();
      });
    });
  }

  public stop(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    return new Promise((resolve) => {
      this.httpServer.close(() => resolve());
    });
  }
}

// Direct execution entrypoint
if (process.argv[1]?.includes('server')) {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
  const host = process.env.HOST || '0.0.0.0';
  const server = new RealtimeServer({ port, host });
  server.start().catch((err) => {
    console.error('Fatal server error:', err);
    process.exit(1);
  });
}

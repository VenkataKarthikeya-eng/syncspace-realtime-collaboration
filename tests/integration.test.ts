/**
 * Comprehensive Integration & Unit Test Suite
 *
 * Tests:
 * 1. RFC 6455 WebSocket Handshake & Masked Frame Parsing
 * 2. Room Presence & Snapshot Delivery
 * 3. Broadcast Fan-out (No Sender Echo)
 * 4. Monotonic Sequence Ordering & Stale Packet Dropping
 * 5. Collaborative Tap Conflict Reconciliation
 * 6. Disconnect Detection & Cleanup
 * 7. Client Interpolation, Hermite Smoothing & Dead-Reckoning Extrapolation
 */

import net from 'node:net';
import crypto from 'node:crypto';
import { RealtimeServer, ZeroWsConnection } from '../server/src/server.js';
import { InterpolationEngine } from '../client/src/interpolation.js';

const TEST_PORT = 8089;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// Helper to encode a client-to-server masked WebSocket frame
function createMaskedFrame(opcode: number, payload: Buffer): Buffer {
  const maskKey = crypto.randomBytes(4);
  const payloadLen = payload.length;
  let headerSize = 2;

  if (payloadLen >= 126 && payloadLen <= 65535) {
    headerSize = 4;
  } else if (payloadLen > 65535) {
    headerSize = 10;
  }

  const frame = Buffer.alloc(headerSize + 4 + payloadLen);
  frame[0] = 0x80 | (opcode & 0x0f); // FIN = 1

  if (payloadLen < 126) {
    frame[1] = 0x80 | payloadLen; // MASK = 1
    maskKey.copy(frame, 2);
  } else if (payloadLen <= 65535) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(payloadLen, 2);
    maskKey.copy(frame, 4);
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(payloadLen), 2);
    maskKey.copy(frame, 10);
  }

  const payloadOffset = headerSize + 4;
  for (let i = 0; i < payloadLen; i++) {
    frame[payloadOffset + i] = payload[i] ^ maskKey[i % 4];
  }

  return frame;
}

// Helper to parse unmasked server-to-client frames from raw socket stream
function parseServerFrame(buffer: Buffer): { opcode: number; text: string; nextOffset: number } | null {
  if (buffer.length < 2) return null;
  const firstByte = buffer[0];
  const secondByte = buffer[1];
  const opcode = firstByte & 0x0f;
  let payloadLen = secondByte & 0x7f;
  let headerSize = 2;

  if (payloadLen === 126) {
    if (buffer.length < 4) return null;
    payloadLen = buffer.readUInt16BE(2);
    headerSize = 4;
  } else if (payloadLen === 127) {
    if (buffer.length < 10) return null;
    payloadLen = Number(buffer.readBigUInt64BE(2));
    headerSize = 10;
  }

  if (buffer.length < headerSize + payloadLen) return null;

  const payload = buffer.subarray(headerSize, headerSize + payloadLen);
  return {
    opcode,
    text: payload.toString('utf8'),
    nextOffset: headerSize + payloadLen,
  };
}

async function runTests() {
  console.log('=== STARTING REAL-TIME MULTIPLAYER SYNC TEST SUITE ===\n');
  let testsPassed = 0;
  let testsTotal = 0;

  function assert(condition: boolean, testName: string) {
    testsTotal++;
    if (condition) {
      console.log(`[PASS] ${testName}`);
      testsPassed++;
    } else {
      console.error(`[FAIL] ${testName}`);
      process.exitCode = 1;
    }
  }

  // --------------------------------------------------------------------------
  // Test Section 1: Interpolation Engine Math & Extrapolation
  // --------------------------------------------------------------------------
  console.log('--- 1. Testing Interpolation & Extrapolation Engine ---');
  {
    const engine = new InterpolationEngine({
      renderDelayMs: 50,
      maxExtrapolateMs: 100,
      dampingFactor: 0.02,
    });

    // Push two samples: at t=100 (x=0.1) and t=150 (x=0.3)
    engine.pushSample('client-A', 0.1, 0.1, 100);
    engine.pushSample('client-A', 0.3, 0.3, 150);

    // Sample at renderTime = 125 (t_now = 175, delay = 50ms) -> exactly mid-way
    const midPos = engine.getInterpolatedPosition('client-A', 175);
    assert(midPos !== null, 'Interpolation returns position during nominal window');
    assert(!midPos!.isExtrapolating, 'Not extrapolating during nominal window');
    // Smoothstep at alpha=0.5: 3*(0.25) - 2*(0.125) = 0.5 -> x should be 0.2
    assert(Math.abs(midPos!.x - 0.2) < 0.01, `Interpolated coordinate is ~0.2 (got ${midPos?.x})`);

    // Sample at renderTime = 180 (t_now = 230, delay = 50ms, 30ms ahead of newest sample at 150)
    // Should activate DEAD RECKONING EXTRAPOLATION
    const extrapPos = engine.getInterpolatedPosition('client-A', 230);
    assert(extrapPos !== null && extrapPos.isExtrapolating, 'Activates extrapolation when buffer starves');
    assert(extrapPos!.x > 0.3, `Extrapolated position projects forward (got ${extrapPos?.x})`);

    // Push a sample with an older timestamp -> out-of-order packet must be discarded
    engine.pushSample('client-A', 0.05, 0.05, 90);
    const afterStale = engine.getInterpolatedPosition('client-A', 175);
    assert(Math.abs(afterStale!.x - 0.2) < 0.01, 'Stale out-of-order sample is safely ignored');

    // Test cleanup
    engine.removeClient('client-A');
    assert(engine.getInterpolatedPosition('client-A', 175) === null, 'Client buffer pruned cleanly on leave');
  }

  // --------------------------------------------------------------------------
  // Test Section 2: RFC 6455 Server Handshake & Network Frame Relay
  // --------------------------------------------------------------------------
  console.log('\n--- 2. Testing RFC 6455 WebSocket Server & Multi-client Sync ---');
  const server = new RealtimeServer({ port: TEST_PORT });
  await server.start();

  function connectTestClient(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ port: TEST_PORT, host: '127.0.0.1' }, () => {
        const secKey = crypto.randomBytes(16).toString('base64');
        const req = [
          'GET / HTTP/1.1',
          'Host: 127.0.0.1',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${secKey}`,
          'Sec-WebSocket-Version: 13',
          '\r\n',
        ].join('\r\n');
        socket.write(req);
      });

      socket.once('data', (data) => {
        const str = data.toString('utf8');
        if (str.includes('HTTP/1.1 101 Switching Protocols') && str.includes('Sec-WebSocket-Accept:')) {
          resolve(socket);
        } else {
          reject(new Error('Handshake failed: ' + str));
        }
      });
      socket.once('error', reject);
    });
  }

  try {
    const client1 = await connectTestClient();
    assert(true, 'Client 1 RFC 6455 Handshake 101 Switching Protocols Succeeded');

    // Buffer for client 1
    let c1Buffer = Buffer.alloc(0);
    const c1Messages: any[] = [];
    client1.on('data', (chunk) => {
      c1Buffer = Buffer.concat([c1Buffer, chunk]);
      while (true) {
        const frame = parseServerFrame(c1Buffer);
        if (!frame) break;
        c1Buffer = c1Buffer.subarray(frame.nextOffset);
        if (frame.opcode === 0x1) {
          c1Messages.push(JSON.parse(frame.text));
        }
      }
    });

    // Client 1 joins 'room-test'
    const joinMsg1 = Buffer.from(
      JSON.stringify({
        type: 'join',
        roomId: 'room-test',
        clientId: 'c1',
        clientInfo: { name: 'Alice', color: '#ff0000' },
      })
    );
    client1.write(createMaskedFrame(0x1, joinMsg1));

    // Wait for snapshot on Client 1
    await new Promise((r) => setTimeout(r, 80));
    assert(c1Messages.length > 0 && c1Messages[0].type === 'snapshot', 'Client 1 received room snapshot');
    assert(c1Messages[0].clients.length === 1 && c1Messages[0].clients[0].clientId === 'c1', 'Snapshot includes Client 1');

    // Client 2 connects
    const client2 = await connectTestClient();
    let c2Buffer = Buffer.alloc(0);
    const c2Messages: any[] = [];
    client2.on('data', (chunk) => {
      c2Buffer = Buffer.concat([c2Buffer, chunk]);
      while (true) {
        const frame = parseServerFrame(c2Buffer);
        if (!frame) break;
        c2Buffer = c2Buffer.subarray(frame.nextOffset);
        if (frame.opcode === 0x1) {
          c2Messages.push(JSON.parse(frame.text));
        }
      }
    });

    const joinMsg2 = Buffer.from(
      JSON.stringify({
        type: 'join',
        roomId: 'room-test',
        clientId: 'c2',
        clientInfo: { name: 'Bob', color: '#00ff00' },
      })
    );
    client2.write(createMaskedFrame(0x1, joinMsg2));

    await new Promise((r) => setTimeout(r, 80));

    // Verify Client 2 received snapshot containing both clients
    const c2Snapshot = c2Messages.find((m) => m.type === 'snapshot');
    assert(c2Snapshot !== undefined && c2Snapshot.clients.length === 2, 'Client 2 received snapshot with both participants');

    // Verify Client 1 received 'client_joined' for Client 2
    const c1JoinedMsg = c1Messages.find((m) => m.type === 'client_joined');
    assert(c1JoinedMsg !== undefined && c1JoinedMsg.client.clientId === 'c2', 'Client 1 notified of Client 2 join');

    // Client 1 sends a cursor action
    const cursorActionMsg = Buffer.from(
      JSON.stringify({
        type: 'action',
        roomId: 'room-test',
        clientId: 'c1',
        seq: 1,
        timestamp: Date.now(),
        action: { type: 'cursor', x: 0.45, y: 0.85 },
      })
    );
    client1.write(createMaskedFrame(0x1, cursorActionMsg));

    await new Promise((r) => setTimeout(r, 80));

    // Verify Client 2 received the cursor action
    const c2Action = c2Messages.find((m) => m.type === 'action' && m.clientId === 'c1');
    assert(c2Action !== undefined && c2Action.action.x === 0.45, 'Client 2 received Client 1 cursor action');

    // Verify Client 1 did NOT receive an echo of its own cursor action!
    const c1Echo = c1Messages.find((m) => m.type === 'action' && m.clientId === 'c1');
    assert(c1Echo === undefined, 'Client 1 does NOT receive echo of its own action (No O(N^2) echo bugs)');

    // Client 1 sends out-of-order action (seq 1 after seq 1) -> must be dropped
    const staleActionMsg = Buffer.from(
      JSON.stringify({
        type: 'action',
        roomId: 'room-test',
        clientId: 'c1',
        seq: 1, // Stale seq!
        timestamp: Date.now(),
        action: { type: 'cursor', x: 0.99, y: 0.99 },
      })
    );
    client1.write(createMaskedFrame(0x1, staleActionMsg));
    await new Promise((r) => setTimeout(r, 80));
    const c2Stale = c2Messages.filter((m) => m.type === 'action' && m.clientId === 'c1');
    assert(c2Stale.length === 1, 'Stale sequence number action was safely dropped by server');

    // Client 1 sends tap_target (collaborative fan moment)
    const tapMsg = Buffer.from(
      JSON.stringify({
        type: 'action',
        roomId: 'room-test',
        clientId: 'c1',
        seq: 2,
        timestamp: Date.now(),
        action: { type: 'tap_target', targetId: 'fan_moment_goal', delta: 5 },
      })
    );
    client1.write(createMaskedFrame(0x1, tapMsg));
    await new Promise((r) => setTimeout(r, 120));

    const reconMsg = c2Messages.find((m) => m.type === 'target_reconciled');
    assert(reconMsg !== undefined && reconMsg.totalScore >= 5, 'Collaborative tap target reconciled across clients');

    // --------------------------------------------------------------------------
    // Test Section 3: Canvas Drawing Persistence & Real-time Stroke Sync
    // --------------------------------------------------------------------------
    console.log('\n--- 3. Testing Canvas Stroke Persistence & Real-time Sync ---');

    // Client 1 draws two strokes
    const stroke1 = {
      id: 'stroke_1',
      points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }, { x: 0.25, y: 0.25 }],
      color: '#2563eb',
      width: 2.5,
    };
    const stroke2 = {
      id: 'stroke_2',
      points: [{ x: 0.3, y: 0.3 }, { x: 0.4, y: 0.4 }, { x: 0.45, y: 0.45 }],
      color: '#dc2626',
      width: 3.0,
    };

    client1.write(createMaskedFrame(0x1, Buffer.from(JSON.stringify({
      type: 'action',
      roomId: 'room-test',
      clientId: 'c1',
      seq: 3,
      timestamp: Date.now(),
      action: { type: 'stroke', stroke: stroke1 },
    }))));

    client1.write(createMaskedFrame(0x1, Buffer.from(JSON.stringify({
      type: 'action',
      roomId: 'room-test',
      clientId: 'c1',
      seq: 4,
      timestamp: Date.now(),
      action: { type: 'stroke', stroke: stroke2 },
    }))));

    await new Promise((r) => setTimeout(r, 80));

    // Client 2 should receive live broadcast for both strokes
    const c2Stroke1 = c2Messages.find((m) => m.type === 'action' && m.action?.type === 'stroke' && m.action.stroke.id === 'stroke_1');
    const c2Stroke2 = c2Messages.find((m) => m.type === 'action' && m.action?.type === 'stroke' && m.action.stroke.id === 'stroke_2');
    assert(c2Stroke1 !== undefined, 'Client 2 received live broadcast of stroke 1');
    assert(c2Stroke2 !== undefined, 'Client 2 received live broadcast of stroke 2');

    // Client 3 (New Viewer Tab) connects AFTER strokes were drawn
    const client3 = await connectTestClient();
    let c3Buffer = Buffer.alloc(0);
    const c3Messages: any[] = [];
    client3.on('data', (chunk) => {
      c3Buffer = Buffer.concat([c3Buffer, chunk]);
      while (true) {
        const frame = parseServerFrame(c3Buffer);
        if (!frame) break;
        c3Buffer = c3Buffer.subarray(frame.nextOffset);
        if (frame.opcode === 0x1) {
          c3Messages.push(JSON.parse(frame.text));
        }
      }
    });

    client3.write(createMaskedFrame(0x1, Buffer.from(JSON.stringify({
      type: 'join',
      roomId: 'room-test',
      clientId: 'c3',
      clientInfo: { name: 'Charlie', color: '#8b5cf6' },
    }))));

    await new Promise((r) => setTimeout(r, 100));

    // Verify Client 3 snapshot immediately contains both existing strokes!
    const c3Snapshot = c3Messages.find((m) => m.type === 'snapshot');
    assert(c3Snapshot !== undefined, 'Client 3 received room snapshot upon joining');
    assert(Array.isArray(c3Snapshot?.strokes), 'Client 3 snapshot contains strokes array');
    assert(
      c3Snapshot?.strokes?.length === 2 &&
      c3Snapshot.strokes[0].id === 'stroke_1' &&
      c3Snapshot.strokes[1].id === 'stroke_2',
      'Client 3 (Viewer Tab) immediately received all persisted canvas strokes!'
    );

    // Client 1 draws a 3rd stroke while Client 3 is watching
    const stroke3 = {
      id: 'stroke_3',
      points: [{ x: 0.5, y: 0.5 }, { x: 0.6, y: 0.6 }],
      color: '#059669',
      width: 2.0,
    };
    client1.write(createMaskedFrame(0x1, Buffer.from(JSON.stringify({
      type: 'action',
      roomId: 'room-test',
      clientId: 'c1',
      seq: 5,
      timestamp: Date.now(),
      action: { type: 'stroke', stroke: stroke3 },
    }))));

    await new Promise((r) => setTimeout(r, 80));

    // Verify Client 3 instantly receives the 3rd stroke
    const c3Stroke3 = c3Messages.find((m) => m.type === 'action' && m.action?.type === 'stroke' && m.action.stroke.id === 'stroke_3');
    assert(c3Stroke3 !== undefined, 'Client 3 instantly received live broadcast of stroke 3 from Client 1');

    // Client 1 clears strokes
    client1.write(createMaskedFrame(0x1, Buffer.from(JSON.stringify({
      type: 'action',
      roomId: 'room-test',
      clientId: 'c1',
      seq: 6,
      timestamp: Date.now(),
      action: { type: 'clear_strokes' },
    }))));

    await new Promise((r) => setTimeout(r, 80));

    const c3Clear = c3Messages.find((m) => m.type === 'action' && m.action?.type === 'clear_strokes');
    assert(c3Clear !== undefined, 'Client 3 received clear_strokes broadcast');

    // Client 4 connects after clear: snapshot must have 0 strokes
    const client4 = await connectTestClient();
    let c4Buffer = Buffer.alloc(0);
    const c4Messages: any[] = [];
    client4.on('data', (chunk) => {
      c4Buffer = Buffer.concat([c4Buffer, chunk]);
      while (true) {
        const frame = parseServerFrame(c4Buffer);
        if (!frame) break;
        c4Buffer = c4Buffer.subarray(frame.nextOffset);
        if (frame.opcode === 0x1) {
          c4Messages.push(JSON.parse(frame.text));
        }
      }
    });

    client4.write(createMaskedFrame(0x1, Buffer.from(JSON.stringify({
      type: 'join',
      roomId: 'room-test',
      clientId: 'c4',
      clientInfo: { name: 'Dana', color: '#ec4899' },
    }))));

    await new Promise((r) => setTimeout(r, 100));
    const c4Snapshot = c4Messages.find((m) => m.type === 'snapshot');
    assert(c4Snapshot !== undefined && c4Snapshot.strokes?.length === 0, 'Client 4 snapshot reflects cleared strokes state');

    client3.destroy();
    client4.destroy();

    // Disconnect Client 2 and verify Client 1 receives client_left
    // Send standard RFC 6455 Close frame (0x8)
    const closePayload = Buffer.alloc(2);
    closePayload.writeUInt16BE(1000, 0);
    client2.write(createMaskedFrame(0x8, closePayload));
    client2.end();

    let leftMsg = c1Messages.find((m) => m.type === 'client_left');
    for (let i = 0; i < 10 && !leftMsg; i++) {
      await new Promise((r) => setTimeout(r, 50));
      leftMsg = c1Messages.find((m) => m.type === 'client_left');
    }

    if (!leftMsg) {
      console.log('c1Messages received at disconnect:', JSON.stringify(c1Messages, null, 2));
    }
    assert(leftMsg !== undefined && leftMsg.clientId === 'c2', 'Client 1 received client_left when Client 2 disconnected');

    client1.destroy();
  } finally {
    await server.stop();
  }

  console.log(`\n=== TEST SUITE FINISHED: ${testsPassed}/${testsTotal} TESTS PASSED ===\n`);
  if (testsPassed === testsTotal) {
    console.log('ALL TESTS PASSED WITH 100% SUCCESS!');
  } else {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});

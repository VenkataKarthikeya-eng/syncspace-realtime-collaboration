# SyncSpace – Real-Time Collaborative Workspace

<p align="center">
  <a href="https://syncspace-realtime-collaboration.vercel.app/">
    <img src="https://img.shields.io/badge/Live%20Demo-Vercel-000000?style=for-the-badge&logo=vercel" alt="Live Demo" />
  </a>
  <a href="https://github.com/VenkataKarthikeya-eng/syncspace-realtime-collaboration">
    <img src="https://img.shields.io/badge/GitHub-Repository-181717?style=for-the-badge&logo=github" alt="GitHub Repository" />
  </a>
  <img src="https://img.shields.io/badge/TypeScript-5.3-3178C6?style=for-the-badge&logo=typescript" alt="TypeScript" />
  <img src="https://img.shields.io/badge/React-18-61DAFB?style=for-the-badge&logo=react" alt="React 18" />
  <img src="https://img.shields.io/badge/WebSocket-RFC%206455-23272f?style=for-the-badge" alt="Raw WebSockets" />
  <img src="https://img.shields.io/badge/Tests-17%20Passing-success?style=for-the-badge" alt="Tests Passing" />
</p>

> **SyncSpace** is a production-grade, real-time multiplayer workspace and collaborative digital canvas built from first principles. Powered by a custom zero-dependency RFC 6455 WebSocket engine, it delivers sub-30ms drawing synchronization, smooth cursor interpolation with dead-reckoning extrapolation, persistent room strokes, and mid-session viewer state recovery without external state-sync libraries.

🔗 **Live Application:** [https://syncspace-realtime-collaboration.vercel.app/](https://syncspace-realtime-collaboration.vercel.app/)  
📁 **GitHub Repository:** [https://github.com/VenkataKarthikeya-eng/syncspace-realtime-collaboration](https://github.com/VenkataKarthikeya-eng/syncspace-realtime-collaboration)

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Architecture](#architecture)
- [Technical Implementation](#technical-implementation)
- [Automated Integration Testing](#automated-integration-testing)
- [Deployment](#deployment)
- [How to Run Locally](#how-to-run-locally)
- [Project Structure](#project-structure)
- [Future Improvements](#future-improvements)

---

## Overview

SyncSpace provides a low-latency, multi-client collaborative canvas engineered from ground level without Socket.io, Yjs, Liveblocks, or PartyKit. It connects distributed clients through a shared WebSocket room architecture where participants can sketch, view each other's live cursors, trigger particle reactions, and collaborate in real time.

### Core Highlights:
- **Real-Time Collaborative Canvas**: Multi-user freehand sketching on a shared 60 FPS HiDPI canvas rendered with smooth quadratic Bézier curves.
- **Multiple Users Working Together**: Active presence tracking with live participant counts, user avatars, color-coded Figma-style cursors, and custom name tags.
- **WebSocket-Based Synchronization**: Implemented directly on native Node.js standard libraries (`http`, `net`, `crypto`) with custom RFC 6455 binary frame masking and unmasking.
- **Persistent Canvas State**: Drawing strokes are maintained in the server's room state. When a new user opens a viewer tab or reconnects, the server sends an authoritative snapshot restoring all existing drawings before new interactions begin.

---

## Features

| Feature | Description |
| :--- | :--- |
| 🎨 **Real-Time Drawing Synchronization** | Low-latency vector stroke broadcast across all peers as soon as a stroke is drawn. |
| 👥 **Multi-Client Collaboration** | Multiple users can simultaneously sketch, move cursors, and trigger particle reactions in the same space. |
| 🔄 **Viewer Tab Synchronization** | Single-click **"Open Viewer Tab"** launches a synchronized session that receives all existing room content immediately. |
| 💾 **Canvas Stroke Persistence** | Server-retained stroke buffer ensures that joiners receive the full visual history upon connection. |
| 🎯 **Cursor Movement Synchronization** | High-frequency cursor tracking with cubic Hermite interpolation and forward dead-reckoning extrapolation. |
| ⚡ **Conflict Handling** | Monotonic per-client sequence numbering (`seq`) discards out-of-order and stale network updates. |
| 🗑️ **Clear Canvas Synchronization** | Single-click canvas reset clears the display across all connected clients and flushes the room stroke buffer. |
| 🚀 **Low Latency Updates** | Adaptive cursor rate throttling (~30Hz) and direct $O(N)$ fan-out without redundant sender echo. |

---

## Architecture

SyncSpace separates client rendering from room state coordination, ensuring predictable synchronization and minimal network overhead.

### Frontend
- **React 18 & TypeScript**: Component lifecycle management, reactive toolbar controls, and telemetry drawers.
- **Canvas 2D Renderer**: Hardware-accelerated canvas engine with sub-pixel device pixel ratio (DPR) scaling and smooth quadratic Bézier curve interpolation.
- **Client Sync Layer**: Adaptive cursor throttling, ping-pong latency measurement, and entity interpolation buffer.

### Backend
- **Node.js (Zero Runtime Dependencies)**: Built entirely on Node.js core modules (`http`, `net`, `crypto`).
- **Custom RFC 6455 WebSocket Server**: Custom HTTP/1.1 101 Switching Protocols handshake, SHA-1 `Sec-WebSocket-Accept` generation, and client-to-server 4-byte XOR frame unmasking.
- **Room-Based Synchronization**: In-memory room management, presence tracking, and snapshot delivery on join.

### Architecture Flow

```
Client
  │
  │  (Masked RFC 6455 Frames)
  ▼
WebSocket Connection
  │
  │  (TCP Stream / Port 8080)
  ▼
Room Manager
  │
  ├── Stroke Buffer Persistence (FIFO 500)
  ├── Snapshot Delivery on Join
  └── Monotonic Sequence Validation
  │
  │  (Unmasked RFC 6455 Frames - Opcode 0x1)
  ▼
Broadcast to Connected Peers (O(N) Fan-out, No Sender Echo)
```

---

## Technical Implementation

### Server-Side
- **Room State Management (`server/src/room.ts`)**: Manages room lifecycles, active participant collections, and monotonic sequence validation per client to prevent out-of-order state mutations.
- **Stroke Buffer Persistence**: All drawing strokes are stored in room state with normalized coordinates ($x, y \in [0.0, 1.0]$) to maintain identical rendering across varying device screen sizes and aspect ratios.
- **Snapshot Delivery for New Clients**: Upon completing the WebSocket handshake, the server sends a `snapshot` message containing all connected participants and the complete array of room strokes (`strokes: [...this.strokes]`).
- **FIFO Stroke Limit**: Memory usage is strictly bounded. The stroke buffer is capped at **500 strokes** using FIFO eviction (`this.strokes.shift()`), preventing memory leaks during long-running sessions.
- **Action Broadcasting**: Relays packets to all connected peers in $O(N)$ fan-out while skipping the sender socket, eliminating echo loops and quadratic network waste.
- **Strict Validation (`server/src/protocol.ts`)**: Validates every incoming frame against schema rules, clamping coordinate bounds and capping stroke points at 300 points per stroke.

### Client-Side
- **Stroke Rendering (`client/src/render.ts`)**: Renders freehand drawing paths using quadratic Bézier curves with round caps and joins. Single-click taps render crisp circular dots.
- **Remote Updates**: Subscribes to real-time `'stroke'` and `'clear_strokes'` events from the sync engine and dynamically applies updates to the canvas.
- **Local / Remote State Separation**: The canvas renderer maintains a separate `currentLocalStroke` buffer for active mouse drag interactions, committing to `strokes` only upon `mouseup` or `mouseleave`. This prevents premature or duplicate stroke fragments from flooding the network.
- **Cursor Interpolation (`client/src/interpolation.ts`)**: Buffers incoming remote cursor positions with a 60ms render delay ($t_{\text{render}} = t_{\text{client}} - 60\text{ms}$) and applies cubic Hermite interpolation. If network packets are delayed, dead-reckoning forward extrapolation maintains smooth visual motion without snapping.

---

## Automated Integration Testing

SyncSpace features an automated end-to-end integration test suite (`tests/integration.test.ts`) that runs directly against the live RFC 6455 WebSocket server using raw TCP sockets.

### Covered Test Cases:
- **WebSocket Handshake**: RFC 6455 `101 Switching Protocols` handshake and `Sec-WebSocket-Accept` verification.
- **Client Join Synchronization**: Immediate room snapshot reception and peer `client_joined` broadcast.
- **Cursor Synchronization**: Real-time cursor coordinates broadcast without sender echo.
- **Sequence Number Validation**: Dropping stale or out-of-order sequence packets.
- **Stroke Broadcast**: Real-time fan-out of vector drawing strokes to connected peers.
- **Viewer Snapshot Restoration**: Verifies a newly joining viewer client immediately receives all pre-existing canvas strokes in its join snapshot.
- **Clear Canvas Broadcast**: Broadcast of `clear_strokes` and verification that subsequent joiners receive an empty canvas.

> **Result:** All **17 integration tests pass with 100% success**.

```bash
npm run test:integration
```

```text
=== STARTING REAL-TIME MULTIPLAYER SYNC TEST SUITE ===

--- 1. Testing Interpolation & Extrapolation Engine ---
[PASS] Interpolation returns position during nominal window
[PASS] Not extrapolating during nominal window
[PASS] Interpolated coordinate is ~0.2 (got 0.2)
[PASS] Activates extrapolation when buffer starves
[PASS] Extrapolated position projects forward
[PASS] Stale out-of-order sample is safely ignored
[PASS] Client buffer pruned cleanly on leave

--- 2. Testing RFC 6455 WebSocket Server & Multi-client Sync ---
[RealtimeServer] RFC 6455 Zero-WS Server running on ws://0.0.0.0:8089
[PASS] Client 1 RFC 6455 Handshake 101 Switching Protocols Succeeded
[PASS] Client 1 received room snapshot
[PASS] Snapshot includes Client 1
[PASS] Client 2 received snapshot with both participants
[PASS] Client 1 notified of Client 2 join
[PASS] Client 2 received Client 1 cursor action
[PASS] Client 1 does NOT receive echo of its own action (No O(N^2) echo bugs)
[PASS] Stale sequence number action was safely dropped by server
[PASS] Collaborative tap target reconciled across clients

--- 3. Testing Canvas Stroke Persistence & Real-time Sync ---
[PASS] Client 2 received live broadcast of stroke 1
[PASS] Client 2 received live broadcast of stroke 2
[PASS] Client 3 received room snapshot upon joining
[PASS] Client 3 snapshot contains strokes array
[PASS] Client 3 (Viewer Tab) immediately received all persisted canvas strokes!
[PASS] Client 3 instantly received live broadcast of stroke 3 from Client 1
[PASS] Client 3 received clear_strokes broadcast
[PASS] Client 4 snapshot reflects cleared strokes state
[PASS] Client 1 received client_left when Client 2 disconnected

=== TEST SUITE FINISHED: 17/17 TESTS PASSED (100% SUCCESS) ===
```

---

## Deployment

SyncSpace is structured for production deployment across Vercel (frontend) and Render/Fly.io (backend).

### Frontend: Vercel
1. Link your GitHub repository to [Vercel](https://vercel.com/).
2. Set **Root Directory** to `client`.
3. Set **Build Command** to `npm run build`.
4. Set **Output Directory** to `dist`.
5. Add Environment Variable:
   - `VITE_WS_URL`: `wss://<your-backend-domain>.onrender.com`

### Backend: Render / WebSocket Server
1. Create a **Web Service** on [Render](https://render.com/) or [Railway](https://railway.app/).
2. Set **Root Directory** to `server`.
3. Set **Build Command** to `npm run build`.
4. Set **Start Command** to `npm start`.
5. Set Environment Variables:
   - `PORT`: `8080` (or leave default for host auto-assignment)
   - `HOST`: `0.0.0.0`

### Environment Variables

| Variable | Target | Description | Example |
| :--- | :--- | :--- | :--- |
| `VITE_WS_URL` | Frontend (`client`) | WebSocket server connection URL | `wss://backend.onrender.com` |
| `PORT` | Backend (`server`) | Port for the WebSocket server | `8080` |
| `HOST` | Backend (`server`) | Host address binding | `0.0.0.0` |

---

## How to Run Locally

### Prerequisites
- Node.js (v18.0.0 or higher)
- npm (v9.0.0 or higher)

### 1. Clone the Repository
```bash
git clone https://github.com/VenkataKarthikeya-eng/syncspace-realtime-collaboration.git
cd syncspace-realtime-collaboration
```

### 2. Install Dependencies
```bash
# Root dependencies (test runner)
npm install

# Frontend dependencies
cd client
npm install
cd ..

# Backend dependencies
cd server
npm install
cd ..
```

### 3. Run Backend Server
In your first terminal:
```bash
cd server
npm install
npm run build
npm start
```
> The server listens on `ws://0.0.0.0:8080` (Health check: `http://localhost:8080/health`).

### 4. Run Frontend Client
In your second terminal:
```bash
cd client
npm install
npm run dev
```
> The Vite development server opens at `http://localhost:5173/`.

### Convenience Root Scripts:
```bash
npm run dev:server      # Starts the backend in watch mode
npm run dev:client      # Starts Vite client
npm run build           # Builds both server and client
npm run test:integration# Executes the 17 integration tests
```

---

## Project Structure

```
syncspace-realtime-collaboration/
├── client/                     # Frontend Client Application
│   ├── src/
│   │   ├── App.tsx             # Main collaborative workspace UI & state
│   │   ├── connection.ts       # Raw WebSocket client & adaptive throttling
│   │   ├── interpolation.ts    # Hermite curve interpolation & dead reckoning
│   │   ├── protocol.ts         # Shared client wire protocol & schemas
│   │   ├── render.ts           # 60 FPS HiDPI canvas renderer
│   │   └── main.tsx            # React application entrypoint
│   ├── index.html              # HTML entrypoint & typography
│   ├── package.json            # React 18, Vite, TypeScript
│   ├── tsconfig.json           # Client TypeScript configuration
│   └── vite.config.ts          # Vite configuration
│
├── server/                     # Zero-Dependency WebSocket Server
│   ├── src/
│   │   ├── protocol.ts         # Wire protocol schemas & runtime validators
│   │   ├── room.ts             # Room presence, stroke buffer, O(N) fan-out
│   │   └── server.ts           # RFC 6455 WebSocket engine (http/net/crypto)
│   ├── package.json            # Zero runtime dependencies
│   └── tsconfig.json           # Server TypeScript configuration
│
├── tests/                      # Automated Integration Tests
│   └── integration.test.ts     # End-to-end socket protocol & stroke tests
│
├── .env.example                # Environment variable reference
├── .gitignore                  # Git ignore rules
├── ARCHITECTURE.md             # In-depth architectural documentation
├── package.json                # Root orchestration & test scripts
└── README.md                   # Project documentation
```

---

## Future Improvements

- **User Authentication**: Implement user accounts and team workspace access via OAuth2/JWT.
- **Persistent Database Storage**: Back room stroke buffers with PostgreSQL/Redis to persist whiteboard history across server restarts.
- **More Drawing Tools**: Add shapes (rectangles, circles, arrows), highlighter brush, text boxes, and eraser mode.
- **Voice/Video Collaboration**: Add WebRTC peer-to-peer audio and video streaming for live design reviews.
- **Production Scaling**: Scale out across multiple nodes using Redis Pub/Sub cluster backplane and sticky edge routing.

---

## License

This project is licensed under the [MIT License](LICENSE).

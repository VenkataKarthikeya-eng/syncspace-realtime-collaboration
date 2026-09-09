/**
 * Client-side Entity Interpolation & Dead-Reckoning Extrapolation Engine
 *
 * Designed to provide buttery-smooth 60fps cursor motion over irregular network delivery.
 *
 * Principles:
 * 1. Render Delay Buffer (Entity Interpolation):
 *    Remote cursors are rendered at t_render = t_client - renderDelayMs (~60ms).
 *    This ensures that under nominal conditions (30Hz updates = ~33ms interval),
 *    there is always a sample before and after t_render, enabling smooth Hermite interpolation.
 *
 * 2. Dead Reckoning & Velocity Extrapolation (Bonus):
 *    If network jitter or packet loss causes buffer starvation (t_render > t_latest),
 *    the engine projects future movement using the calculated velocity vector with
 *    exponential decay damping (up to maxExtrapolateMs = 120ms).
 *
 * 3. Error Smoothing (Hermite Blending):
 *    When a real packet arrives following an extrapolation window, any positional
 *    divergence is blended smoothly back into the trajectory rather than snapping.
 *
 * 4. Bounded Memory:
 *    Sliding buffer capped at 20 entries per client; entries older than 500ms are discarded.
 */

export interface PositionSample {
  x: number;
  y: number;
  timestamp: number; // Server-synchronized or arrival timestamp
}

export interface RenderedCursor {
  x: number;
  y: number;
  isExtrapolating: boolean;
  velocity: { vx: number; vy: number };
}

export interface InterpolationConfig {
  renderDelayMs: number;       // Interpolation delay buffer (default 60ms)
  maxExtrapolateMs: number;    // Maximum forward prediction window (default 120ms)
  dampingFactor: number;       // Velocity decay during extrapolation (default 0.015)
  errorBlendDurationMs: number;// Duration to smooth out extrapolation errors (default 60ms)
}

const DEFAULT_CONFIG: InterpolationConfig = {
  renderDelayMs: 60,
  maxExtrapolateMs: 120,
  dampingFactor: 0.015,
  errorBlendDurationMs: 60,
};

interface ClientBuffer {
  samples: PositionSample[];
  lastError: { x: number; y: number; startTime: number } | null;
  lastCalculated: RenderedCursor;
}

export class InterpolationEngine {
  private buffers = new Map<string, ClientBuffer>();
  private config: InterpolationConfig;

  constructor(config: Partial<InterpolationConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  public setRenderDelay(delayMs: number): void {
    this.config.renderDelayMs = Math.max(10, Math.min(300, delayMs));
  }

  /**
   * Pushes a new authoritative position sample for a remote client.
   */
  public pushSample(clientId: string, x: number, y: number, timestamp = performance.now()): void {
    let buffer = this.buffers.get(clientId);
    if (!buffer) {
      buffer = {
        samples: [],
        lastError: null,
        lastCalculated: { x, y, isExtrapolating: false, velocity: { vx: 0, vy: 0 } },
      };
      this.buffers.set(clientId, buffer);
    }

    // Ignore out-of-order timestamps
    const lastSample = buffer.samples[buffer.samples.length - 1];
    if (lastSample && timestamp <= lastSample.timestamp) {
      return;
    }

    // If we were extrapolating, record error between predicted position and new sample
    if (buffer.lastCalculated.isExtrapolating) {
      buffer.lastError = {
        x: buffer.lastCalculated.x - x,
        y: buffer.lastCalculated.y - y,
        startTime: performance.now(),
      };
    }

    buffer.samples.push({ x, y, timestamp });

    // Enforce memory bounds: max 20 samples, discard older than 500ms
    if (buffer.samples.length > 20) {
      buffer.samples.shift();
    }
    const cutoff = timestamp - 500;
    while (buffer.samples.length > 2 && buffer.samples[0].timestamp < cutoff) {
      buffer.samples.shift();
    }
  }

  /**
   * Samples the smoothly interpolated / extrapolated cursor coordinate at render time.
   */
  public getInterpolatedPosition(clientId: string, now = performance.now()): RenderedCursor | null {
    const buffer = this.buffers.get(clientId);
    if (!buffer || buffer.samples.length === 0) return null;

    const samples = buffer.samples;

    // Single sample edge-case
    if (samples.length === 1) {
      return {
        x: samples[0].x,
        y: samples[0].y,
        isExtrapolating: false,
        velocity: { vx: 0, vy: 0 },
      };
    }

    // Target render time in the past
    const renderTime = now - this.config.renderDelayMs;

    const newest = samples[samples.length - 1];
    const oldest = samples[0];

    // Case 1: Target render time is older than our oldest sample
    if (renderTime <= oldest.timestamp) {
      return {
        x: oldest.x,
        y: oldest.y,
        isExtrapolating: false,
        velocity: { vx: 0, vy: 0 },
      };
    }

    // Case 2: Target render time is ahead of our newest sample -> EXTRAPOLATION (Dead Reckoning)
    if (renderTime > newest.timestamp) {
      const excessTime = renderTime - newest.timestamp;

      // Calculate velocity from the last two real samples
      const prev = samples[samples.length - 2];
      const dt = newest.timestamp - prev.timestamp;
      let vx = 0;
      let vy = 0;
      if (dt > 0) {
        vx = (newest.x - prev.x) / dt;
        vy = (newest.y - prev.y) / dt;
      }

      if (excessTime <= this.config.maxExtrapolateMs) {
        // Exponential damping decay: v(t) = v0 * exp(-gamma * t)
        const damping = Math.exp(-this.config.dampingFactor * excessTime);
        const extrapX = Math.max(0, Math.min(1, newest.x + vx * excessTime * damping));
        const extrapY = Math.max(0, Math.min(1, newest.y + vy * excessTime * damping));

        buffer.lastCalculated = {
          x: extrapX,
          y: extrapY,
          isExtrapolating: true,
          velocity: { vx: vx * damping, vy: vy * damping },
        };
        return buffer.lastCalculated;
      }

      // Past maximum extrapolation window: clamp to last projected position
      buffer.lastCalculated.isExtrapolating = false;
      return buffer.lastCalculated;
    }

    // Case 3: Target render time is within our sample window -> INTERPOLATION
    // Find surrounding samples P0 (<= renderTime) and P1 (> renderTime)
    let p0 = oldest;
    let p1 = newest;

    for (let i = 0; i < samples.length - 1; i++) {
      if (samples[i].timestamp <= renderTime && samples[i + 1].timestamp >= renderTime) {
        p0 = samples[i];
        p1 = samples[i + 1];
        break;
      }
    }

    const interval = p1.timestamp - p0.timestamp;
    const progress = interval > 0 ? (renderTime - p0.timestamp) / interval : 0;
    const alpha = Math.max(0, Math.min(1, progress));

    // Smoothstep Hermite interpolation: 3a^2 - 2a^3
    const smoothAlpha = alpha * alpha * (3 - 2 * alpha);

    let interpX = p0.x + (p1.x - p0.x) * smoothAlpha;
    let interpY = p0.y + (p1.y - p0.y) * smoothAlpha;

    // Velocity estimate
    const vx = interval > 0 ? (p1.x - p0.x) / interval : 0;
    const vy = interval > 0 ? (p1.y - p0.y) / interval : 0;

    // Blend out any leftover extrapolation error
    if (buffer.lastError) {
      const errorAge = now - buffer.lastError.startTime;
      if (errorAge < this.config.errorBlendDurationMs) {
        const errorWeight = 1 - errorAge / this.config.errorBlendDurationMs;
        interpX += buffer.lastError.x * errorWeight;
        interpY += buffer.lastError.y * errorWeight;
      } else {
        buffer.lastError = null;
      }
    }

    buffer.lastCalculated = {
      x: Math.max(0, Math.min(1, interpX)),
      y: Math.max(0, Math.min(1, interpY)),
      isExtrapolating: false,
      velocity: { vx, vy },
    };

    return buffer.lastCalculated;
  }

  /**
   * Cleanup client buffer when a participant disconnects.
   */
  public removeClient(clientId: string): void {
    this.buffers.delete(clientId);
  }

  /**
   * Reset all buffers (e.g. room switch).
   */
  public clear(): void {
    this.buffers.clear();
  }
}

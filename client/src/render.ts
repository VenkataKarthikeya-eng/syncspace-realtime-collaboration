/**
 * High-Performance Canvas Renderer for SyncSpace
 *
 * Engineered to meet premium SaaS standards (Linear, Figma, Vercel):
 * - HiDPI (retina) canvas scaling with sub-pixel alignment
 * - Smooth quadratic Bézier curves for freehand collaborative strokes
 * - Sleek SVG cursor pointers with clean drop shadows and compact nameplates
 * - Subtle particle physics for emoji reactions (alpha decay, restrained velocities)
 * - Anti-aliased click ripples with zero layout shifts
 */

import { InterpolationEngine, RenderedCursor } from './interpolation.js';
import { Participant } from './protocol.js';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rotation: number;
  vRot: number;
  scale: number;
  alpha: number;
  emoji: string;
  lifetime: number;
  maxLifetime: number;
}

interface ClickRipple {
  x: number;
  y: number;
  color: string;
  radius: number;
  maxRadius: number;
  alpha: number;
}

export interface DrawStroke {
  points: Array<{ x: number; y: number }>;
  color: string;
  width: number;
}

export class CanvasRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private interpolation: InterpolationEngine;
  private animFrameId: number | null = null;
  private particles: Particle[] = [];
  private ripples: ClickRipple[] = [];
  private strokes: DrawStroke[] = [];
  private participantsMap = new Map<string, Participant>();
  private localClientId: string;
  private dpr = 1;

  constructor(
    canvas: HTMLCanvasElement,
    interpolation: InterpolationEngine,
    localClientId: string
  ) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2D canvas context');
    this.ctx = ctx;
    this.interpolation = interpolation;
    this.localClientId = localClientId;

    this.handleResize();
    window.addEventListener('resize', this.handleResize);
  }

  public updateParticipants(participants: Participant[]): void {
    this.participantsMap.clear();
    for (const p of participants) {
      this.participantsMap.set(p.clientId, p);
    }
  }

  public setLocalClientId(id: string): void {
    this.localClientId = id;
  }

  public addStroke(stroke: DrawStroke): void {
    this.strokes.push(stroke);
    if (this.strokes.length > 150) {
      this.strokes.shift(); // Enforce bounded memory
    }
  }

  public clearStrokes(): void {
    this.strokes = [];
  }

  public handleResize = (): void => {
    this.dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    this.canvas.width = Math.floor(rect.width * this.dpr);
    this.canvas.height = Math.floor(rect.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  };

  public emitReaction(emoji: string, normX: number, normY: number, count = 10): void {
    const rect = this.canvas.getBoundingClientRect();
    const px = normX * rect.width;
    const py = normY * rect.height;

    // Subtle click ripple
    this.ripples.push({
      x: px,
      y: py,
      color: '#3b82f6',
      radius: 4,
      maxRadius: 36,
      alpha: 0.6,
    });

    // Spawn restrained emoji particles
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.4;
      const speed = 1.8 + Math.random() * 3.2;
      this.particles.push({
        x: px,
        y: py,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 1.2, // Subtle upward drift
        rotation: (Math.random() - 0.5) * 0.4,
        vRot: (Math.random() - 0.5) * 0.08,
        scale: 0.75 + Math.random() * 0.35,
        alpha: 1.0,
        emoji,
        lifetime: 0,
        maxLifetime: 45 + Math.random() * 20, // ~800ms
      });
    }
  }

  public addClickRipple(normX: number, normY: number, color = '#2563eb'): void {
    const rect = this.canvas.getBoundingClientRect();
    this.ripples.push({
      x: normX * rect.width,
      y: normY * rect.height,
      color,
      radius: 3,
      maxRadius: 32,
      alpha: 0.65,
    });
  }

  public start(): void {
    if (this.animFrameId !== null) return;

    const loop = (timestamp: number) => {
      this.render(timestamp);
      this.animFrameId = requestAnimationFrame(loop);
    };

    this.animFrameId = requestAnimationFrame(loop);
  }

  public stop(): void {
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  public destroy(): void {
    this.stop();
    window.removeEventListener('resize', this.handleResize);
  }

  private render(timestamp: number): void {
    const rect = this.canvas.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;

    // Clear canvas frame
    this.ctx.clearRect(0, 0, width, height);

    // 1. Draw Collaborative Freehand Strokes with Smooth Quadratic Bézier Curves
    for (const stroke of this.strokes) {
      const pts = stroke.points;
      if (pts.length < 2) continue;

      this.ctx.save();
      this.ctx.beginPath();
      this.ctx.strokeStyle = stroke.color;
      this.ctx.lineWidth = stroke.width;
      this.ctx.lineCap = 'round';
      this.ctx.lineJoin = 'round';

      this.ctx.moveTo(pts[0].x * width, pts[0].y * height);

      if (pts.length === 2) {
        this.ctx.lineTo(pts[1].x * width, pts[1].y * height);
      } else {
        // Curve smoothing
        for (let i = 1; i < pts.length - 1; i++) {
          const xc = ((pts[i].x + pts[i + 1].x) / 2) * width;
          const yc = ((pts[i].y + pts[i + 1].y) / 2) * height;
          this.ctx.quadraticCurveTo(pts[i].x * width, pts[i].y * height, xc, yc);
        }
        const last = pts[pts.length - 1];
        this.ctx.lineTo(last.x * width, last.y * height);
      }

      this.ctx.stroke();
      this.ctx.restore();
    }

    // 2. Draw Soft Expanding Ripples
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i];
      r.radius += 1.4;
      r.alpha *= 0.94;

      this.ctx.save();
      this.ctx.beginPath();
      this.ctx.arc(r.x, r.y, r.radius, 0, Math.PI * 2);
      this.ctx.strokeStyle = r.color;
      this.ctx.lineWidth = 1.5 * (1 - r.radius / r.maxRadius);
      this.ctx.globalAlpha = Math.max(0, r.alpha);
      this.ctx.stroke();
      this.ctx.restore();

      if (r.radius >= r.maxRadius || r.alpha <= 0.02) {
        this.ripples.splice(i, 1);
      }
    }

    // 3. Draw Subdued Emoji Particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.09; // Gentle gravity
      p.vx *= 0.98;
      p.rotation += p.vRot;
      p.lifetime++;

      const progress = p.lifetime / p.maxLifetime;
      p.alpha = Math.max(0, 1 - progress);

      this.ctx.save();
      this.ctx.translate(p.x, p.y);
      this.ctx.rotate(p.rotation);
      this.ctx.scale(p.scale, p.scale);
      this.ctx.globalAlpha = p.alpha;
      this.ctx.font = '20px sans-serif';
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'middle';
      this.ctx.fillText(p.emoji, 0, 0);
      this.ctx.restore();

      if (p.lifetime >= p.maxLifetime) {
        this.particles.splice(i, 1);
      }
    }

    // 4. Draw Remote Participants' Cursors
    const now = performance.now();

    for (const [clientId, participant] of this.participantsMap.entries()) {
      if (clientId === this.localClientId) continue; // Do not draw local cursor

      const cursor = this.interpolation.getInterpolatedPosition(clientId, now);
      if (!cursor) continue;

      const px = cursor.x * width;
      const py = cursor.y * height;

      this.drawCursorPointer(px, py, participant, cursor);
    }
  }

  private drawCursorPointer(
    x: number,
    y: number,
    participant: Participant,
    cursor: RenderedCursor
  ): void {
    const color = participant.color || '#2563eb';
    const name = participant.name || 'Viewer';
    const avatar = participant.avatar || '⚡';

    this.ctx.save();
    this.ctx.translate(x, y);

    // Subtle drop shadow for pointer on canvas
    this.ctx.shadowColor = 'rgba(15, 23, 42, 0.16)';
    this.ctx.shadowBlur = 6;
    this.ctx.shadowOffsetX = 0;
    this.ctx.shadowOffsetY = 2;

    // Crisp, slim professional SVG cursor arrow (Figma-style)
    this.ctx.beginPath();
    this.ctx.moveTo(0, 0);
    this.ctx.lineTo(0, 16);
    this.ctx.lineTo(4, 12);
    this.ctx.lineTo(8.5, 20);
    this.ctx.lineTo(11, 19);
    this.ctx.lineTo(6.5, 11);
    this.ctx.lineTo(12, 11);
    this.ctx.closePath();

    this.ctx.fillStyle = color;
    this.ctx.fill();

    this.ctx.strokeStyle = '#ffffff';
    this.ctx.lineWidth = 1.5;
    this.ctx.stroke();

    // Reset shadow for compact name pill
    this.ctx.shadowColor = 'rgba(15, 23, 42, 0.08)';
    this.ctx.shadowBlur = 4;
    this.ctx.shadowOffsetY = 1;

    // Compact Name Tag Pill
    const tagX = 12;
    const tagY = 14;
    const paddingX = 6;
    const tagHeight = 20;

    this.ctx.font = '600 11px Inter, system-ui, sans-serif';
    const tagText = `${avatar} ${name}`;
    const textWidth = this.ctx.measureText(tagText).width;
    const tagWidth = textWidth + paddingX * 2 + (cursor.isExtrapolating ? 8 : 0);

    // Pill background
    this.ctx.beginPath();
    this.ctx.roundRect(tagX, tagY, tagWidth, tagHeight, 5);
    this.ctx.fillStyle = color;
    this.ctx.fill();

    this.ctx.strokeStyle = '#ffffff';
    this.ctx.lineWidth = 1;
    this.ctx.stroke();

    // Text
    this.ctx.fillStyle = '#ffffff';
    this.ctx.textAlign = 'left';
    this.ctx.textBaseline = 'middle';
    this.ctx.fillText(tagText, tagX + paddingX, tagY + tagHeight / 2);

    // Subtle amber indicator if extrapolating due to network latency
    if (cursor.isExtrapolating) {
      this.ctx.beginPath();
      this.ctx.arc(tagX + tagWidth - 5, tagY + tagHeight / 2, 2.5, 0, Math.PI * 2);
      this.ctx.fillStyle = '#f59e0b';
      this.ctx.fill();
    }

    this.ctx.restore();
  }
}

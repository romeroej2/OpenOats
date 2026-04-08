import { useEffect, useRef } from "react";
import { colors } from "../theme";

interface Props {
  level: number; // 0-1
  isActive: boolean;
  color?: string;
  thresholdLevel?: number | null;
  thresholdColor?: string;
  gain?: number;
}

const BAR_COUNT = 16;
const BAR_WIDTH = 7;
const BAR_GAP = 5;
const BAR_STRIDE = BAR_WIDTH + BAR_GAP;
const CLUSTER_WIDTH = BAR_COUNT * BAR_WIDTH + (BAR_COUNT - 1) * BAR_GAP;
const MAX_BAR_HEIGHT = 28;
const MIN_ACTIVE_BAR_HEIGHT = 3;
const SILENCE_BAR_HEIGHT = 4;
const CORNER_RADIUS = 3;
// Wave speed scales with audio level — stationary at silence, fast at loud
const SPATIAL_FREQ = (2 * Math.PI) / BAR_COUNT;
const BASE_TEMPORAL_FREQ = 0.004; // radians per ms at full volume

function normalizeLevel(level: number): number {
  return Math.max(0, Math.min(1, (level - 0.015) / 0.985));
}

function toVisualLevel(normalizedLevel: number): number {
  return Math.pow(normalizedLevel, 0.65);
}

export function WaveformVisualizer({
  level,
  isActive,
  color = colors.accent,
  thresholdLevel = null,
  thresholdColor = colors.warning,
  gain = 1,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animFrameRef = useRef<number>(0);
  const width = 240;
  const height = 32;
  const normalizedLevel = normalizeLevel(level * gain);
  const visualLevel = toVisualLevel(normalizedLevel);
  const normalizedThreshold =
    thresholdLevel == null ? null : normalizeLevel(thresholdLevel * gain);
  const visualThreshold =
    normalizedThreshold == null ? null : toVisualLevel(normalizedThreshold);
  const thresholdY =
    visualThreshold == null ? null : height - visualThreshold * MAX_BAR_HEIGHT;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const startX = (width - CLUSTER_WIDTH) / 2; // 57px

    const drawRoundedBar = (x: number, barHeight: number, fillColor: string) => {
      const y = height - barHeight;
      ctx.fillStyle = fillColor;
      ctx.beginPath();
      ctx.roundRect(x, y, BAR_WIDTH, barHeight, CORNER_RADIUS);
      ctx.fill();
    };

    const drawThreshold = () => {
      if (thresholdY == null) return;
      ctx.save();
      ctx.strokeStyle = thresholdColor;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(startX - 6, thresholdY);
      ctx.lineTo(startX + CLUSTER_WIDTH + 6, thresholdY);
      ctx.stroke();
      ctx.restore();
    };

    const isSilent = !isActive || normalizedLevel < 0.02;

    if (isSilent) {
      cancelAnimationFrame(animFrameRef.current);
      ctx.clearRect(0, 0, width, height);
      for (let i = 0; i < BAR_COUNT; i++) {
        drawRoundedBar(startX + i * BAR_STRIDE, SILENCE_BAR_HEIGHT, colors.border);
      }
      drawThreshold();
      return;
    }

    const loop = () => {
      ctx.clearRect(0, 0, width, height);
      // Wave speed proportional to audio level: silent = barely moves, loud = fast
      const t = performance.now() * BASE_TEMPORAL_FREQ * visualLevel;
      for (let i = 0; i < BAR_COUNT; i++) {
        const wave = 0.5 + 0.5 * Math.sin(i * SPATIAL_FREQ - t);
        const barHeight = Math.max(
          MIN_ACTIVE_BAR_HEIGHT,
          visualLevel * MAX_BAR_HEIGHT * wave
        );
        drawRoundedBar(startX + i * BAR_STRIDE, barHeight, color);
      }
      drawThreshold();
      animFrameRef.current = requestAnimationFrame(loop);
    };

    animFrameRef.current = requestAnimationFrame(loop);

    return () => cancelAnimationFrame(animFrameRef.current);
  }, [level, isActive, color, normalizedLevel, visualLevel, thresholdColor, thresholdY]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{
        width,
        height,
        borderRadius: 4,
        background: colors.surfaceElevated,
      }}
    />
  );
}

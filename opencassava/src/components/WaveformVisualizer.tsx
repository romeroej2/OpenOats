import { useEffect, useRef } from "react";
import { colors } from "../theme";

interface Props {
  level: number; // 0-1
  isActive: boolean;
  color?: string;
  thresholdLevel?: number | null;
  thresholdColor?: string;
  gain?: number;
  width?: number;
}

const BAR_COUNT = 16;
const BAR_WIDTH = 7;
const BAR_GAP = 5;
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
  width = 240,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animFrameRef = useRef<number>(0);
  const levelRef = useRef(level);
  const isActiveRef = useRef(isActive);
  const colorRef = useRef(color);
  const thresholdLevelRef = useRef(thresholdLevel);
  const thresholdColorRef = useRef(thresholdColor);
  const gainRef = useRef(gain);
  const widthRef = useRef(width);
  const height = 32;

  useEffect(() => {
    levelRef.current = level;
    isActiveRef.current = isActive;
    colorRef.current = color;
    thresholdLevelRef.current = thresholdLevel;
    thresholdColorRef.current = thresholdColor;
    gainRef.current = gain;
    widthRef.current = width;
  }, [color, gain, isActive, level, thresholdColor, thresholdLevel, width]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const computeLayout = () => {
      const currentWidth = widthRef.current;
      const availableWidth = Math.max(48, currentWidth - 12);
      const scale = Math.min(1, availableWidth / CLUSTER_WIDTH);
      const barWidth = Math.max(3, BAR_WIDTH * scale);
      const barGap = Math.max(2, BAR_GAP * scale);
      const barStride = barWidth + barGap;
      const clusterWidth = BAR_COUNT * barWidth + (BAR_COUNT - 1) * barGap;
      const startX = Math.max(0, (currentWidth - clusterWidth) / 2);
      const cornerRadius = Math.min(CORNER_RADIUS, barWidth / 2);

      return { barWidth, barStride, clusterWidth, cornerRadius, currentWidth, startX };
    };

    const drawRoundedBar = (
      x: number,
      barHeight: number,
      fillColor: string,
      barWidth: number,
      cornerRadius: number,
    ) => {
      const y = height - barHeight;
      ctx.fillStyle = fillColor;
      ctx.beginPath();
      ctx.roundRect(x, y, barWidth, barHeight, cornerRadius);
      ctx.fill();
    };

    const drawThreshold = (startX: number, clusterWidth: number, thresholdY: number | null) => {
      if (thresholdY == null) return;
      ctx.save();
      ctx.strokeStyle = thresholdColorRef.current;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(startX - 6, thresholdY);
      ctx.lineTo(startX + clusterWidth + 6, thresholdY);
      ctx.stroke();
      ctx.restore();
    };

    const loop = () => {
      const { barWidth, barStride, clusterWidth, cornerRadius, currentWidth, startX } =
        computeLayout();
      const normalizedLevel = normalizeLevel(levelRef.current * gainRef.current);
      const visualLevel = toVisualLevel(normalizedLevel);
      const normalizedThreshold =
        thresholdLevelRef.current == null
          ? null
          : normalizeLevel(thresholdLevelRef.current * gainRef.current);
      const visualThreshold =
        normalizedThreshold == null ? null : toVisualLevel(normalizedThreshold);
      const thresholdY =
        visualThreshold == null ? null : height - visualThreshold * MAX_BAR_HEIGHT;
      const isSilent = !isActiveRef.current || normalizedLevel < 0.02;

      ctx.clearRect(0, 0, currentWidth, height);
      if (isSilent) {
        for (let i = 0; i < BAR_COUNT; i++) {
          drawRoundedBar(startX + i * barStride, SILENCE_BAR_HEIGHT, colors.border, barWidth, cornerRadius);
        }
        drawThreshold(startX, clusterWidth, thresholdY);
        animFrameRef.current = requestAnimationFrame(loop);
        return;
      }

      const t = performance.now() * BASE_TEMPORAL_FREQ * visualLevel;
      for (let i = 0; i < BAR_COUNT; i++) {
        const wave = 0.5 + 0.5 * Math.sin(i * SPATIAL_FREQ - t);
        const barHeight = Math.max(
          MIN_ACTIVE_BAR_HEIGHT,
          visualLevel * MAX_BAR_HEIGHT * wave
        );
        drawRoundedBar(startX + i * barStride, barHeight, colorRef.current, barWidth, cornerRadius);
      }
      drawThreshold(startX, clusterWidth, thresholdY);
      animFrameRef.current = requestAnimationFrame(loop);
    };

    animFrameRef.current = requestAnimationFrame(loop);

    return () => cancelAnimationFrame(animFrameRef.current);
  }, []);

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

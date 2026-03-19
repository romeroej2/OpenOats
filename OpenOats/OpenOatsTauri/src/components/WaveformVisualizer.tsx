import { useEffect, useRef, useState } from "react";
import { colors } from "../theme";

interface Props {
  level: number; // 0-1
  isActive: boolean;
}

export function WaveformVisualizer({ level, isActive }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>();
  const [dataArray, setDataArray] = useState<Float32Array>(new Float32Array(64));

  // Generate waveform data based on level
  useEffect(() => {
    const generateData = () => {
      const newData = new Float32Array(64);
      for (let i = 0; i < 64; i++) {
        // Create a wave pattern with noise
        const base = Math.sin(i * 0.3) * 0.3;
        const noise = (Math.random() - 0.5) * level * 0.7;
        newData[i] = (base + noise) * (isActive ? 1 : 0.1);
      }
      setDataArray(newData);
    };

    generateData();
    const interval = setInterval(generateData, 50);
    return () => clearInterval(interval);
  }, [level, isActive]);

  // Draw waveform
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    const centerY = height / 2;

    let animationId: number;

    const draw = () => {
      ctx.clearRect(0, 0, width, height);

      if (!isActive && level < 0.01) {
        // Draw flat line when inactive
        ctx.strokeStyle = `${colors.border}`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, centerY);
        ctx.lineTo(width, centerY);
        ctx.stroke();
        return;
      }

      // Draw waveform
      const gradient = ctx.createLinearGradient(0, 0, width, 0);
      gradient.addColorStop(0, colors.accent);
      gradient.addColorStop(0.5, colors.accentLight);
      gradient.addColorStop(1, colors.accent);

      ctx.strokeStyle = gradient;
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      ctx.beginPath();

      const barWidth = width / dataArray.length;

      for (let i = 0; i < dataArray.length; i++) {
        const x = i * barWidth + barWidth / 2;
        const amplitude = Math.abs(dataArray[i]) * (height / 2) * (0.5 + level * 0.5);

        if (i === 0) {
          ctx.moveTo(x, centerY - amplitude);
        } else {
          const prevX = (i - 1) * barWidth + barWidth / 2;
          const prevAmp = Math.abs(dataArray[i - 1]) * (height / 2) * (0.5 + level * 0.5);
          const cpX = (prevX + x) / 2;
          ctx.quadraticCurveTo(cpX, centerY - prevAmp, x, centerY - amplitude);
        }
      }

      // Mirror for bottom half
      for (let i = dataArray.length - 1; i >= 0; i--) {
        const x = i * barWidth + barWidth / 2;
        const amplitude = Math.abs(dataArray[i]) * (height / 2) * (0.5 + level * 0.5);

        if (i === dataArray.length - 1) {
          ctx.lineTo(x, centerY + amplitude);
        } else {
          const nextX = (i + 1) * barWidth + barWidth / 2;
          const nextAmp = Math.abs(dataArray[i + 1]) * (height / 2) * (0.5 + level * 0.5);
          const cpX = (x + nextX) / 2;
          ctx.quadraticCurveTo(cpX, centerY + nextAmp, x, centerY + amplitude);
        }
      }

      ctx.closePath();
      ctx.fillStyle = `${colors.accent}20`;
      ctx.fill();
      ctx.stroke();

      animationId = requestAnimationFrame(draw);
    };

    draw();

    return () => cancelAnimationFrame(animationId);
  }, [dataArray, level, isActive]);

  return (
    <canvas
      ref={canvasRef}
      width={120}
      height={24}
      style={{
        width: 120,
        height: 24,
        borderRadius: 4,
        background: colors.surfaceElevated,
      }}
    />
  );
}

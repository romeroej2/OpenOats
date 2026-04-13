import { useEffect, useRef, useState } from "react";
import { GemBadge } from "gem-badges";
import { colors, radius, spacing, typography } from "../theme";
import { WaveformVisualizer } from "./WaveformVisualizer";

interface Props {
  isRunning: boolean;
  isImporting?: boolean;
  isStopping?: boolean;
  capturedSegments?: number;
  processedSegments?: number;
  onStart: () => void;
  onStop: () => void;
  onImport: () => void;
  disabled?: boolean;
  engineWarming?: boolean;
  audioLevelRaw?: number;
  audioLevel?: number;
  audioLevelThem?: number;
  micCaptureMode: "auto" | "push-to-talk";
  micTransmitActive: boolean;
  onPushToTalkPress: () => void;
  onPushToTalkRelease: () => void;
  saveRecording: boolean;
  onSaveRecordingChange: (value: boolean) => void;
  micCalibrationRms?: number | null;
  micThresholdMultiplier: number;
}

function formatDuration(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }

  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

export function CaptureCapsule({
  isRunning,
  isImporting = false,
  isStopping = false,
  capturedSegments = 0,
  processedSegments = 0,
  onStart,
  onStop,
  onImport,
  disabled = false,
  engineWarming = false,
  audioLevelRaw = 0,
  audioLevel = 0,
  audioLevelThem = 0,
  micCaptureMode,
  micTransmitActive,
  onPushToTalkPress,
  onPushToTalkRelease,
  saveRecording,
  onSaveRecordingChange,
  micCalibrationRms = null,
  micThresholdMultiplier,
}: Props) {
  const [duration, setDuration] = useState(0);
  const durationRef = useRef(0);
  const intervalRef = useRef<number | null>(null);

  useEffect(() => {
    if (isRunning && !isStopping) {
      durationRef.current = 0;
      setDuration(0);
      intervalRef.current = window.setInterval(() => {
        durationRef.current += 1;
        setDuration(durationRef.current);
      }, 1000);
    } else {
      if (intervalRef.current) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (!isRunning) {
        setDuration(0);
      }
    }

    return () => {
      if (intervalRef.current) {
        window.clearInterval(intervalRef.current);
      }
    };
  }, [isRunning, isStopping]);

  const isBusy = isRunning || isStopping || isImporting;
  const showTimer = isRunning || isStopping || isImporting || duration > 0;
  const liveBadgeColor = isStopping
    ? colors.warning
    : isRunning
      ? colors.success
      : engineWarming
        ? colors.warning
        : colors.textSecondary;
  const micGateLevel =
    micCalibrationRms == null ? null : micCalibrationRms * micThresholdMultiplier;
  const segmentsLabel =
    isStopping && capturedSegments > 0
      ? `${processedSegments}/${capturedSegments} segments`
      : isImporting
        ? "Importing audio"
        : engineWarming && !isRunning
          ? "Speech engine loading"
          : isRunning
            ? null
            : "Ready beside your meeting";
  const showPushToTalk = isRunning && micCaptureMode === "push-to-talk";
  const primaryActionLabel = isStopping ? "Stopping" : isRunning ? "Stop" : "Record";

  const gemConfig = isStopping
    ? {
        material: "amethyst" as const,
        cut: "round" as const,
        size: 18,
        rotation: 0,
        glow: true,
        glowIntensity: 0.88,
        animate: false,
        renderMode: "auto" as const,
      }
    : isRunning
      ? {
          material: "ruby" as const,
          cut: "round" as const,
          size: 18,
          rotation: 0,
          glow: true,
          glowIntensity: 1.02,
          animate: false,
          renderMode: "auto" as const,
        }
      : {
          material: "emerald" as const,
          cut: "round" as const,
          size: 18,
          rotation: 0,
          glow: true,
          glowIntensity: 0.94,
          animate: false,
          renderMode: "auto" as const,
        };

  return (
    <section
      style={{
        borderRadius: 28,
        border: `1px solid ${colors.border}`,
        background: "rgba(255, 255, 255, 0.92)",
        boxShadow: "0 18px 42px rgba(26, 24, 22, 0.08)",
        padding: `${spacing[3]}px`,
        display: "flex",
        flexDirection: "column",
        gap: spacing[2],
        backdropFilter: "blur(18px)",
        WebkitBackdropFilter: "blur(18px)",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) auto",
          alignItems: "center",
          gap: spacing[2],
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: spacing[1],
            flexWrap: "wrap",
            minWidth: 0,
            overflow: "hidden",
          }}
        >
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: spacing[1],
              padding: `${spacing[1]}px ${spacing[2]}px`,
              borderRadius: radius.full,
              background: `${liveBadgeColor}15`,
              color: liveBadgeColor,
              fontSize: typography.xs,
              fontWeight: 800,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              flexShrink: 0,
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: radius.full,
                background: liveBadgeColor,
                display: "inline-block",
              }}
            />
            {isStopping ? "Syncing" : isRunning ? "Live" : engineWarming ? "Loading" : "Idle"}
          </span>
          {showTimer && (
            <span
              style={{
                fontSize: typography.xl,
                fontWeight: 800,
                color: colors.text,
                fontFamily: "'Cascadia Code', 'SF Mono', Consolas, monospace",
                letterSpacing: "0.04em",
                flexShrink: 0,
              }}
            >
              {formatDuration(duration)}
            </span>
          )}
          <button
            type="button"
            onClick={() => onSaveRecordingChange(!saveRecording)}
            disabled={isBusy}
            aria-pressed={saveRecording}
            title={saveRecording ? "Audio will be saved with the next recording" : "Audio will not be saved"}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: spacing[1],
              padding: `${spacing[1]}px ${spacing[2]}px`,
              borderRadius: radius.full,
              border: `1px solid ${saveRecording ? `${colors.accent}26` : colors.border}`,
              background: saveRecording ? `${colors.accent}10` : colors.surface,
              color: isBusy
                ? colors.textMuted
                : saveRecording
                  ? colors.accent
                  : colors.textSecondary,
              cursor: isBusy ? "not-allowed" : "pointer",
              opacity: isBusy ? 0.55 : 0.92,
              fontSize: typography.xs,
              fontWeight: 700,
              whiteSpace: "nowrap",
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 10,
                height: 10,
                borderRadius: radius.full,
                display: "inline-block",
                background: saveRecording ? colors.accent : "transparent",
                border: `1px solid ${saveRecording ? colors.accent : colors.border}`,
                flexShrink: 0,
              }}
            />
            Save
          </button>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            flexWrap: "wrap",
            gap: spacing[1],
          }}
        >
          <button
            type="button"
            onClick={isRunning ? onStop : onStart}
            disabled={disabled || isStopping}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: spacing[1],
              padding: `${spacing[1]}px ${spacing[2]}px`,
              border: "none",
              borderRadius: radius.full,
              background: isStopping
                ? "linear-gradient(135deg, #2e1c3f 0%, #17121f 100%)"
                : isRunning
                  ? "linear-gradient(135deg, #411a22 0%, #1b1216 100%)"
                  : "linear-gradient(135deg, #173a37 0%, #10191b 100%)",
              color: colors.textInverse,
              cursor: disabled || isStopping ? "not-allowed" : "pointer",
              opacity: disabled || isStopping ? 0.5 : 1,
              fontSize: typography.sm,
              fontWeight: 800,
              boxShadow: isStopping
                ? "0 12px 28px rgba(79, 56, 122, 0.24)"
                : isRunning
                  ? "0 12px 28px rgba(120, 46, 60, 0.26)"
                  : "0 12px 28px rgba(28, 88, 82, 0.24)",
              whiteSpace: "nowrap",
            }}
          >
            <span
              style={{
                width: 28,
                height: 28,
                borderRadius: radius.full,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                background: "rgba(11, 14, 16, 0.34)",
                border: "1px solid rgba(255,255,255,0.16)",
                boxShadow:
                  "inset 0 1px 0 rgba(255,255,255,0.10), 0 4px 10px rgba(0, 0, 0, 0.18)",
                flexShrink: 0,
              }}
            >
              <GemBadge config={gemConfig} />
            </span>
            <span>{primaryActionLabel}</span>
          </button>

          {showPushToTalk && (
            <>
              <button
                type="button"
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  onPushToTalkPress();
                }}
                onPointerUp={(event) => {
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  }
                  onPushToTalkRelease();
                }}
                onPointerCancel={onPushToTalkRelease}
                disabled={isStopping}
                aria-pressed={micTransmitActive}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: `${spacing[1]}px ${spacing[3]}px`,
                  borderRadius: radius.full,
                  border: "none",
                  background: micTransmitActive
                    ? "linear-gradient(135deg, #1c4d33 0%, #12251a 100%)"
                    : "linear-gradient(135deg, #44483f 0%, #1f231d 100%)",
                  color: colors.textInverse,
                  cursor: isStopping ? "not-allowed" : "pointer",
                  opacity: isStopping ? 0.6 : 1,
                  fontSize: typography.sm,
                  fontWeight: 800,
                  whiteSpace: "nowrap",
                }}
              >
                {micTransmitActive ? "Talking" : "Hold to talk"}
              </button>
            </>
          )}

          {!isBusy ? (
            <button type="button" onClick={onImport} disabled={disabled} style={secondaryActionStyle(false)}>
              Import
            </button>
          ) : null}
        </div>
      </div>

      {segmentsLabel ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: spacing[2],
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontSize: typography.sm, color: colors.textSecondary }}>{segmentsLabel}</span>
        </div>
      ) : null}

      {(isRunning || isStopping || isImporting) && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
            gap: spacing[2],
            padding: `${spacing[2]}px ${spacing[3]}px`,
            borderRadius: 20,
            background: colors.surfaceElevated,
            border: `1px solid ${colors.border}`,
          }}
        >
          <LevelPill label="Mic" level={audioLevel} color={colors.success} isActive={isRunning && !isStopping} />
          <LevelPill
            label="Input"
            level={audioLevelRaw}
            color={colors.them}
            isActive={isRunning && !isStopping}
            thresholdLevel={micGateLevel}
            thresholdColor={colors.error}
          />
          <LevelPill
            label="System"
            level={audioLevelThem}
            color={colors.accent}
            isActive={isRunning && !isStopping}
          />
        </div>
      )}
    </section>
  );
}

function LevelPill({
  label,
  level,
  color,
  isActive,
  thresholdLevel,
  thresholdColor,
}: {
  label: string;
  level: number;
  color: string;
  isActive: boolean;
  thresholdLevel?: number | null;
  thresholdColor?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [graphWidth, setGraphWidth] = useState(112);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const updateWidth = () => {
      const nextWidth = Math.max(56, Math.floor(element.clientWidth - 58));
      setGraphWidth(nextWidth);
    };

    updateWidth();

    const observer = new ResizeObserver(() => {
      updateWidth();
    });
    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        minWidth: 0,
        display: "flex",
        alignItems: "center",
        gap: spacing[2],
      }}
    >
      <span
        style={{
          width: 46,
          flexShrink: 0,
          fontSize: typography.xs,
          color: colors.textMuted,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          fontWeight: 700,
        }}
      >
        {label}
      </span>
      <WaveformVisualizer
        width={graphWidth}
        level={level}
        isActive={isActive}
        color={color}
        thresholdLevel={thresholdLevel}
        thresholdColor={thresholdColor}
        gain={label === "System" ? 4 : 8}
      />
    </div>
  );
}

function secondaryActionStyle(active: boolean): React.CSSProperties {
  return {
    padding: `${spacing[2]}px ${spacing[3]}px`,
    borderRadius: radius.full,
    border: `1px solid ${active ? `${colors.accent}28` : colors.border}`,
    background: active ? `${colors.accent}10` : colors.surface,
    color: active ? colors.accent : colors.textSecondary,
    cursor: "pointer",
    fontSize: typography.sm,
    fontWeight: 700,
  };
}

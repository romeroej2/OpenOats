import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { WaveformVisualizer } from "./WaveformVisualizer";
import type { AppSettings } from "../types";
import { colors, spacing, typography } from "../theme";

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
  saveRecording: boolean;
  onSaveRecordingChange: (v: boolean) => void;
  micCalibrationRms?: number | null;
  micThresholdMultiplier: number;
  onMicCalibrationRmsChange: (v: number) => void;
  onMicThresholdMultiplierChange: (v: number) => void;
  onOpenSettings: () => void;
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

export function ControlBar({
  isRunning,
  isImporting = false,
  isStopping = false,
  capturedSegments = 0,
  processedSegments = 0,
  onStart,
  onStop,
  onImport,
  disabled,
  engineWarming = false,
  audioLevelRaw = 0,
  audioLevel = 0,
  audioLevelThem = 0,
  saveRecording,
  onSaveRecordingChange,
  micCalibrationRms = null,
  micThresholdMultiplier,
  onMicThresholdMultiplierChange,
}: Props) {
  const [devices, setDevices] = useState<string[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<string>("default");
  const [sysDevices, setSysDevices] = useState<string[]>([]);
  const [selectedSysDevice, setSelectedSysDevice] = useState<string>("default");
  const [duration, setDuration] = useState(0);
  const durationRef = useRef(0);
  const intervalRef = useRef<number | null>(null);
  const loadSettings = () => invoke<AppSettings>("get_settings");

  useEffect(() => {
    Promise.all([
      invoke<string[]>("list_mic_devices"),
      invoke<string[]>("list_sys_audio_devices"),
      loadSettings(),
    ]).then(([mics, sysDevs, s]) => {
      setDevices(mics);
      setSysDevices(sysDevs);
      if (s.inputDeviceName) setSelectedDevice(s.inputDeviceName);
      if (s.systemAudioDeviceName) setSelectedSysDevice(s.systemAudioDeviceName);
    });
  }, []);

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
  const displayedDuration = isBusy ? duration : 0;
  const micThresholdPercent = Math.round(micThresholdMultiplier * 100);
  const micGateLevel =
    micCalibrationRms == null ? null : micCalibrationRms * micThresholdMultiplier;
  const liveBadgeColor = isStopping ? colors.warning : isRunning ? colors.success : colors.textSecondary;

  const handleDeviceChange = async (device: string) => {
    setSelectedDevice(device);
    try {
      const settings = await loadSettings();
      await invoke("save_settings", {
        newSettings: { ...settings, inputDeviceName: device === "default" ? null : device },
      });
    } catch (e) {
      console.error("Failed to save device:", e);
    }
  };

  const handleSysDeviceChange = async (device: string) => {
    setSelectedSysDevice(device);
    try {
      const settings = await loadSettings();
      await invoke("save_settings", {
        newSettings: { ...settings, systemAudioDeviceName: device === "default" ? null : device },
      });
    } catch (e) {
      console.error("Failed to save sys audio device:", e);
    }
  };

  const buttonStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: spacing[2],
    padding: `${spacing[2]}px ${spacing[3]}px`,
    background: isStopping ? `${colors.warning}20` : isRunning ? `${colors.error}20` : colors.success,
    color: isStopping ? colors.warning : isRunning ? colors.error : "#fff",
    border: isStopping
      ? `1px solid ${colors.warning}50`
      : isRunning
        ? `1px solid ${colors.error}50`
        : "none",
    borderRadius: 999,
    fontSize: typography.md,
    fontWeight: 700,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
    transition: "all 0.2s",
  };

  const statusBadgeStyle = (color: string): React.CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    gap: spacing[1],
    padding: `${spacing[1]}px ${spacing[2]}px`,
    background: `${color}15`,
    color,
    borderRadius: 999,
    fontSize: typography.sm,
    fontWeight: 600,
  });

  const panelStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: spacing[3],
    padding: `${spacing[2]}px ${spacing[3]}px`,
    background: colors.surfaceElevated,
    border: `1px solid ${colors.border}`,
    borderRadius: 14,
    minHeight: 56,
  };

  const sectionLabelStyle: React.CSSProperties = {
    fontSize: typography.xs,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    color: colors.textMuted,
    fontWeight: 700,
  };

  const compactSelectStyle: React.CSSProperties = {
    width: "100%",
    padding: `${spacing[2]}px`,
    background: colors.surface,
    color: colors.text,
    border: `1px solid ${colors.border}`,
    borderRadius: 10,
    fontSize: typography.md,
    cursor: isBusy ? "not-allowed" : "pointer",
    opacity: isBusy ? 0.6 : 1,
  };

  const recordingCardStyle: React.CSSProperties = {
    ...panelStyle,
    flex: "1 1 0",
    minWidth: 320,
    minHeight: 116,
    flexDirection: "column",
    alignItems: "stretch",
    gap: spacing[2],
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: spacing[2],
        padding: `${spacing[2]}px ${spacing[4]}px`,
        background: colors.surface,
        borderBottom: `1px solid ${colors.border}`,
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "stretch", gap: spacing[2] }}>
        {!isRunning && !isStopping && (
          <div style={{ ...panelStyle, flex: "2 1 360px", flexWrap: "wrap", alignItems: "stretch" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: spacing[1], flex: "1 1 180px" }}>
              <span style={sectionLabelStyle}>Mic input</span>
              <select
                value={selectedDevice}
                onChange={(e) => handleDeviceChange(e.target.value)}
                disabled={isBusy}
                style={compactSelectStyle}
              >
                <option value="default">Mic Default</option>
                {devices.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
                {devices.length === 0 && <option value="" disabled>No microphones found</option>}
              </select>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: spacing[1], flex: "1 1 180px" }}>
              <span style={sectionLabelStyle}>System audio</span>
              <select
                value={selectedSysDevice}
                onChange={(e) => handleSysDeviceChange(e.target.value)}
                disabled={isBusy}
                style={compactSelectStyle}
              >
                <option value="default">System Audio Default</option>
                {sysDevices.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        <div style={{ ...panelStyle, flex: isRunning || isStopping ? "1 1 100%" : "3 1 520px", justifyContent: "space-between", flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: spacing[2], flexWrap: "wrap" }}>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: spacing[1],
                fontSize: typography.sm,
                color: isRunning || isStopping ? colors.textMuted : colors.text,
                cursor: isRunning || isStopping ? "not-allowed" : "pointer",
                opacity: isRunning || isStopping ? 0.5 : 1,
                userSelect: "none",
              }}
            >
              <input
                type="checkbox"
                checked={saveRecording}
                onChange={(e) => onSaveRecordingChange(e.target.checked)}
                disabled={isRunning || isStopping}
                style={{ cursor: isRunning || isStopping ? "not-allowed" : "pointer" }}
              />
              Record audio
            </label>

            <button
              onClick={isRunning ? onStop : onStart}
              disabled={disabled || isStopping}
              style={buttonStyle}
            >
              {isStopping ? (
                <>
                  <span
                    style={{
                      display: "inline-block",
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: colors.warning,
                    }}
                  />
                  <span>Stopping...</span>
                </>
              ) : isRunning ? (
                <>
                  <span
                    style={{
                      display: "inline-block",
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: colors.error,
                      animation: "pulse 1.5s ease-in-out infinite",
                    }}
                  />
                  <span>Stop</span>
                </>
              ) : (
                <>
                  <span
                    aria-hidden="true"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 18,
                      height: 18,
                    }}
                  >
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                    >
                      <rect x="9" y="3" width="6" height="12" rx="3" fill="currentColor" />
                      <path
                        d="M6 11a6 6 0 0 0 12 0"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                      />
                      <path
                        d="M12 17v4"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                      />
                      <path
                        d="M8 21h8"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                      />
                    </svg>
                  </span>
                  <span>Record</span>
                </>
              )}
            </button>

            {!isBusy && (
              <button
                onClick={onImport}
                disabled={disabled}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: spacing[2],
                  padding: `${spacing[2]}px ${spacing[3]}px`,
                  background: "transparent",
                  color: colors.textSecondary,
                  border: `1px solid ${colors.border}`,
                  borderRadius: 999,
                  fontSize: typography.md,
                  fontWeight: 600,
                  cursor: disabled ? "not-allowed" : "pointer",
                  opacity: disabled ? 0.5 : 1,
                }}
                title="Import audio"
              >
                <span
                  aria-hidden="true"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 16,
                    height: 16,
                  }}
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path
                      d="M12 4v10"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                    <path
                      d="M8 10l4 4 4-4"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <path
                      d="M5 19h14"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  </svg>
                </span>
                <span>Import audio</span>
              </button>
            )}
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: spacing[2],
              flexWrap: "wrap",
              justifyContent: "flex-end",
            }}
          >
            <span
              style={{
                padding: `${spacing[1]}px ${spacing[2]}px`,
                borderRadius: 999,
                background: `${liveBadgeColor}14`,
                color: liveBadgeColor,
                fontWeight: 700,
                fontSize: typography.sm,
                letterSpacing: "0.04em",
              }}
            >
              {isStopping ? "Processing" : isRunning ? "Live" : "Idle"}
            </span>

            <span
              style={{
                minWidth: 52,
                textAlign: "right",
                fontSize: typography.md,
                fontWeight: 700,
                color: colors.text,
                fontFamily: "SF Mono, Monaco, monospace",
                letterSpacing: "0.04em",
              }}
            >
              {formatDuration(displayedDuration)}
            </span>

            {isStopping && (
              <span style={statusBadgeStyle(colors.textSecondary)}>
                <span>
                  {processedSegments}/{capturedSegments}
                </span>
                <span>segments</span>
              </span>
            )}

            {isImporting && (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: spacing[2],
                  padding: `${spacing[1]}px ${spacing[2]}px`,
                  background: `${colors.accent}15`,
                  color: colors.accent,
                  borderRadius: 999,
                  fontSize: typography.sm,
                  fontWeight: 600,
                  fontFamily: "SF Mono, Monaco, monospace",
                }}
              >
                <span
                  style={{
                    display: "inline-block",
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    border: `2px solid ${colors.accent}`,
                    borderTopColor: "transparent",
                    animation: "spin 0.8s linear infinite",
                    flexShrink: 0,
                  }}
                />
                Importing...
              </span>
            )}

            {engineWarming && !isRunning && (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: spacing[2],
                  padding: `${spacing[1]}px ${spacing[2]}px`,
                  background: `${colors.warning}18`,
                  color: colors.warning,
                  borderRadius: 999,
                  fontSize: typography.sm,
                  fontWeight: 600,
                  fontFamily: "SF Mono, Monaco, monospace",
                }}
                title="STT engine is loading - record will be available shortly"
              >
                <span
                  style={{
                    display: "inline-block",
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    border: `2px solid ${colors.warning}`,
                    borderTopColor: "transparent",
                    animation: "spin 0.8s linear infinite",
                    flexShrink: 0,
                  }}
                />
                STT loading...
              </span>
            )}
          </div>
        </div>
      </div>

      {isRunning && !isStopping ? (
        <div style={{ display: "flex", flexDirection: "column", gap: spacing[2] }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "stretch", gap: spacing[2] }}>
            <div
              style={{
                ...recordingCardStyle,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: spacing[2] }}>
                <span style={sectionLabelStyle}>System</span>
                <span style={{ fontSize: typography.xs, color: colors.textMuted }}>
                  Dashed line = gate threshold
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: spacing[3] }}>
                <span style={{ width: 64, fontSize: typography.sm, color: colors.textSecondary }}>
                  System
                </span>
                <WaveformVisualizer
                  level={audioLevelThem}
                  isActive
                  color={colors.accent}
                  gain={4}
                />
              </div>
            </div>

            <div
              style={{
                ...recordingCardStyle,
                background: colors.background,
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={{ fontSize: typography.sm, color: colors.text, fontWeight: 700 }}>
                  Mic gate
                </span>
                <span style={{ fontSize: typography.xs, color: colors.textMuted }}>
                  Live sensitivity
                </span>
              </div>
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  gap: spacing[1],
                  justifyContent: "center",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: spacing[2] }}>
                  <span style={{ width: 64, fontSize: typography.xs, color: colors.textMuted }}>
                    Sensitivity
                  </span>
                  <input
                    type="range"
                    min={0.1}
                    max={0.8}
                    step={0.05}
                    value={micThresholdMultiplier}
                    onChange={(e) => onMicThresholdMultiplierChange(parseFloat(e.target.value))}
                    style={{
                      flex: 1,
                      cursor: "pointer",
                    }}
                    title="Lower values open the mic more. Higher values gate more quiet audio."
                  />
                  <span
                    style={{
                      minWidth: 44,
                      textAlign: "right",
                      fontSize: typography.sm,
                      color: colors.text,
                      fontFamily: "SF Mono, Monaco, monospace",
                    }}
                  >
                    {micThresholdPercent}%
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "stretch", gap: spacing[2] }}>
            <div
              style={{
                ...recordingCardStyle,
              }}
            >
              <span style={sectionLabelStyle}>Mic in</span>
              <div style={{ display: "flex", alignItems: "center", gap: spacing[3] }}>
                <span style={{ width: 64, fontSize: typography.sm, color: colors.textSecondary }}>
                  Mic in
                </span>
                <WaveformVisualizer
                  level={audioLevelRaw}
                  isActive
                  color={colors.them}
                  thresholdLevel={micGateLevel}
                  thresholdColor={colors.error}
                  gain={8}
                />
              </div>
            </div>

            <div
              style={{
                ...recordingCardStyle,
              }}
            >
              <span style={sectionLabelStyle}>Mic live</span>
              <div style={{ display: "flex", alignItems: "center", gap: spacing[3] }}>
                <span style={{ width: 64, fontSize: typography.sm, color: colors.textSecondary }}>
                  Mic live
                </span>
                <WaveformVisualizer
                  level={audioLevel}
                  isActive
                  color={colors.success}
                  gain={8}
                />
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "stretch", gap: spacing[2] }}>
          {isBusy && (
            <div
              style={{
                ...panelStyle,
                flex: "3 1 520px",
                flexDirection: "column",
                alignItems: "stretch",
                gap: spacing[2],
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: spacing[2] }}>
                <span style={sectionLabelStyle}>Live levels</span>
                <span style={{ fontSize: typography.xs, color: colors.textMuted }}>
                  Dashed line = gate threshold
                </span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: spacing[2] }}>
                <div style={{ display: "flex", alignItems: "center", gap: spacing[3] }}>
                  <span style={{ width: 64, fontSize: typography.sm, color: colors.textSecondary }}>
                    Mic in
                  </span>
                  <WaveformVisualizer
                    level={audioLevelRaw}
                    isActive={isRunning && !isStopping}
                    color={colors.them}
                    thresholdLevel={micGateLevel}
                    thresholdColor={colors.error}
                    gain={8}
                  />
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: spacing[3] }}>
                  <span style={{ width: 64, fontSize: typography.sm, color: colors.textSecondary }}>
                    Mic live
                  </span>
                  <WaveformVisualizer
                    level={audioLevel}
                    isActive={isRunning && !isStopping}
                    color={colors.success}
                    gain={8}
                  />
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: spacing[3] }}>
                  <span style={{ width: 64, fontSize: typography.sm, color: colors.textSecondary }}>
                    System
                  </span>
                  <WaveformVisualizer
                    level={audioLevelThem}
                    isActive={isRunning && !isStopping}
                    color={colors.accent}
                    gain={4}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.6; transform: scale(0.9); }
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

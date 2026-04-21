import { CaptureCapsule } from "./CaptureCapsule";
import { useLiveSessionStore } from "../hooks/useLiveSessionStore";
import type { MicCaptureMode } from "../types";

interface CaptureCapsuleContainerProps {
  isRunning: boolean;
  isImporting?: boolean;
  isStopping?: boolean;
  onStart: () => void;
  onStop: () => void;
  onImport: () => void;
  disabled?: boolean;
  engineWarming?: boolean;
  micCaptureMode: MicCaptureMode;
  onPushToTalkPress: () => void;
  onPushToTalkRelease: () => void;
  saveRecording: boolean;
  onSaveRecordingChange: (value: boolean) => void;
  micCalibrationRms?: number | null;
  micThresholdMultiplier: number;
}

export function CaptureCapsuleContainer(props: CaptureCapsuleContainerProps) {
  const audioLevels = useLiveSessionStore((state) => state.audioLevels);
  const transcriptionProgress = useLiveSessionStore((state) => state.transcriptionProgress);

  return (
    <CaptureCapsule
      {...props}
      capturedSegments={transcriptionProgress.capturedSegments}
      processedSegments={transcriptionProgress.processedSegments}
      audioLevelRaw={audioLevels.raw}
      audioLevel={audioLevels.mic}
      audioLevelThem={audioLevels.them}
      micTransmitActive={audioLevels.micTransmitActive}
    />
  );
}

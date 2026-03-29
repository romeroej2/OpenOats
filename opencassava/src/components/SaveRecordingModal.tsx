import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { colors, typography, spacing } from "../theme";

interface RecordingFiles {
  micPath: string;
  sysPath: string;
}

interface Props {
  files: RecordingFiles;
  sessionId: string;
  onDone: () => void;
}

export function SaveRecordingModal({ files, sessionId, onDone }: Props) {
  const [saveMic, setSaveMic] = useState(true);
  const [saveSys, setSaveSys] = useState(true);
  const [saveMerged, setSaveMerged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      if (saveMic) {
        await invoke("save_recording_file", {
          sourcePath: files.micPath,
          defaultName: `${sessionId}_mic.wav`,
        });
      }
      if (saveSys) {
        await invoke("save_recording_file", {
          sourcePath: files.sysPath,
          defaultName: `${sessionId}_sys.wav`,
        });
      }
      if (saveMerged) {
        await invoke("save_recording_merged", {
          micPath: files.micPath,
          sysPath: files.sysPath,
          defaultName: `${sessionId}_merged.wav`,
        });
      }
      await invoke("discard_recording_files", {
        micPath: files.micPath,
        sysPath: files.sysPath,
      });
      onDone();
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  };

  const handleCancel = async () => {
    await invoke("discard_recording_files", {
      micPath: files.micPath,
      sysPath: files.sysPath,
    }).catch(() => {});
    onDone();
  };

  const overlayStyle: React.CSSProperties = {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.6)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  };

  const modalStyle: React.CSSProperties = {
    background: colors.surface,
    border: `1px solid ${colors.border}`,
    borderRadius: 8,
    padding: `${spacing[4]}px`,
    minWidth: 320,
    display: "flex",
    flexDirection: "column",
    gap: `${spacing[3]}px`,
  };

  const checkRowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: `${spacing[2]}px`,
    color: colors.text,
    fontSize: typography.sm,
    cursor: "pointer",
  };

  const btnRowStyle: React.CSSProperties = {
    display: "flex",
    gap: `${spacing[2]}px`,
    justifyContent: "flex-end",
    marginTop: `${spacing[2]}px`,
  };

  return (
    <div style={overlayStyle}>
      <div style={modalStyle}>
        <div style={{ color: colors.text, fontSize: typography.base, fontWeight: 600 }}>
          Save Recording
        </div>
        <div style={{ color: colors.textMuted, fontSize: typography.sm }}>
          Select which audio files to save:
        </div>

        <label style={checkRowStyle}>
          <input
            type="checkbox"
            checked={saveMic}
            onChange={(e) => setSaveMic(e.target.checked)}
            disabled={saving}
          />
          Microphone (you)
        </label>
        <label style={checkRowStyle}>
          <input
            type="checkbox"
            checked={saveSys}
            onChange={(e) => setSaveSys(e.target.checked)}
            disabled={saving}
          />
          System audio (them)
        </label>
        <label style={checkRowStyle}>
          <input
            type="checkbox"
            checked={saveMerged}
            onChange={(e) => setSaveMerged(e.target.checked)}
            disabled={saving}
          />
          Merged (both channels mixed)
        </label>

        {error && (
          <div style={{ color: "#f87171", fontSize: typography.sm }}>
            {error}
          </div>
        )}

        <div style={btnRowStyle}>
          <button
            onClick={handleCancel}
            disabled={saving}
            style={{
              background: "transparent",
              border: `1px solid ${colors.border}`,
              borderRadius: 4,
              color: colors.textMuted,
              padding: `${spacing[1]}px ${spacing[2]}px`,
              cursor: saving ? "not-allowed" : "pointer",
              fontSize: typography.sm,
            }}
          >
            Discard
          </button>
          <button
            onClick={handleSave}
            disabled={saving || (!saveMic && !saveSys && !saveMerged)}
            style={{
              background: "#6366f1",
              border: "none",
              borderRadius: 4,
              color: "#fff",
              padding: `${spacing[1]}px ${spacing[2]}px`,
              cursor: saving || (!saveMic && !saveSys && !saveMerged) ? "not-allowed" : "pointer",
              opacity: saving || (!saveMic && !saveSys && !saveMerged) ? 0.5 : 1,
              fontSize: typography.sm,
            }}
          >
            {saving ? "Saving…" : "Save Selected"}
          </button>
        </div>
      </div>
    </div>
  );
}

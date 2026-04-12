import { useState, useEffect, useCallback } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  Utterance,
  Suggestion,
  KBResult,
  AppSettings,
  EnhancedNotes,
  SessionDetails,
  SttStatus,
  TranscriptionProgress,
} from "./types";
import { CaptureCapsule } from "./components/CaptureCapsule";
import { SaveRecordingModal } from "./components/SaveRecordingModal";
import { TranscriptView } from "./components/TranscriptView";
import { SuggestionsView } from "./components/SuggestionsView";
import { NotesView } from "./components/NotesView";
import { SettingsView } from "./components/SettingsView";
import { TranscriptSearch } from "./components/TranscriptSearch";
import { ExportMenu } from "./components/ExportMenu";
import { AboutView } from "./components/AboutView";
import { CompanionShell, type DrawerKey } from "./components/CompanionShell";
import { SessionHistoryPanel } from "./components/SessionHistoryPanel";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { colors, radius, typography, spacing } from "./theme";

type ModelState = "checking" | "missing" | "downloading" | "ready";
type SuggestionCheckEvent = {
  checkedAt: string;
  surfaced: boolean;
};
type SttSetupStatusEvent = {
  stage: string;
  message: string;
};
type NotesPublishStatusEvent = {
  sessionId: string;
  stage: "generating" | "publishing" | "ready" | "error";
  message: string;
};
type StatusTone = "warning" | "info" | "success" | "error";
type ReleaseCheckState =
  | { status: "checking"; currentVersion: string | null; latestVersion: null; releaseUrl: string }
  | { status: "current"; currentVersion: string; latestVersion: string; releaseUrl: string }
  | { status: "update"; currentVersion: string; latestVersion: string; releaseUrl: string }
  | { status: "error"; currentVersion: string | null; latestVersion: null; releaseUrl: string };

type WhisperModelId =
  | "auto"
  | "tiny"
  | "tiny-en"
  | "base"
  | "base-en"
  | "small"
  | "small-en"
  | "medium"
  | "medium-en"
  | "large-v3-turbo";

function resolveWhisperModel(settings: AppSettings | null): Exclude<WhisperModelId, "auto"> {
  const configured = (settings?.whisperModel || "auto") as WhisperModelId;
  const locale = settings?.transcriptionLocale?.trim().toLowerCase() || "auto";
  const isEnglish = locale.startsWith("en");

  switch (configured) {
    case "tiny":
      return isEnglish ? "tiny-en" : "tiny";
    case "tiny-en":
      return "tiny-en";
    case "base":
      return isEnglish ? "base-en" : "base";
    case "base-en":
      return "base-en";
    case "small":
      return isEnglish ? "small-en" : "small";
    case "small-en":
      return "small-en";
    case "medium":
      return isEnglish ? "medium-en" : "medium";
    case "medium-en":
      return "medium-en";
    case "large-v3-turbo":
      return "large-v3-turbo";
    case "auto":
    default:
      return "base";
  }
}

function sttProviderLabel(provider: string): string {
  if (provider === "faster-whisper") return "faster-whisper";
  if (provider === "parakeet") return "parakeet";
  if (provider === "omni-asr") return "omni-asr";
  if (provider === "cohere-transcribe") return "cohere-transcribe";
  return "whisper-rs";
}

const LATEST_RELEASE_URL = "https://github.com/romeroej2/OpenCassava/releases/latest";
const LATEST_RELEASE_API_URL = "https://api.github.com/repos/romeroej2/OpenCassava/releases/latest";
const REPOSITORY_URL = "https://github.com/romeroej2/OpenCassava";

function normalizeSemver(version: string): number[] {
  const cleaned = version.trim().replace(/^v/i, "").split("-")[0];
  return cleaned.split(".").map((segment) => {
    const value = Number.parseInt(segment, 10);
    return Number.isFinite(value) ? value : 0;
  });
}

function compareVersions(a: string, b: string): number {
  const left = normalizeSemver(a);
  const right = normalizeSemver(b);
  const maxLength = Math.max(left.length, right.length);

  for (let index = 0; index < maxLength; index += 1) {
    const aValue = left[index] ?? 0;
    const bValue = right[index] ?? 0;

    if (aValue > bValue) return 1;
    if (aValue < bValue) return -1;
  }

  return 0;
}

function App() {
  const [modelState, setModelState] = useState<ModelState>("checking");
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [modelError, setModelError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [utterances, setUtterances] = useState<Utterance[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [activeDrawer, setActiveDrawer] = useState<DrawerKey | null>(null);
  const [currentSessionId, setCurrentSessionId] = useState<string | undefined>();
  const [currentSessionNotes, setCurrentSessionNotes] = useState<EnhancedNotes | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [sttStatus, setSttStatus] = useState<SttStatus | null>(null);
  const [transcriptionProgress, setTranscriptionProgress] = useState<TranscriptionProgress>({
    capturedSegments: 0,
    processedSegments: 0,
  });
  const [isGeneratingSuggestion, setIsGeneratingSuggestion] = useState(false);
  const [lastSuggestionCheckAt, setLastSuggestionCheckAt] = useState<string | null>(null);
  const [lastSuggestionCheckSurfaced, setLastSuggestionCheckSurfaced] = useState<boolean | null>(null);
  const [volatileYouText, setVolatileYouText] = useState("");
  const [volatileThemText, setVolatileThemText] = useState("");
  
  const [showSearch, setShowSearch] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<number[]>([]);
  const [currentSearchIndex, setCurrentSearchIndex] = useState(0);
  const [audioLevel, setAudioLevel] = useState(0);
  const [audioLevelRaw, setAudioLevelRaw] = useState(0);
  const [audioLevelThem, setAudioLevelThem] = useState(0);
  const [micTransmitActive, setMicTransmitActive] = useState(true);
  const [isSettingUpStt, setIsSettingUpStt] = useState(false);
  const [sttSetupMessage, setSttSetupMessage] = useState("");
  const [sttSetupStage, setSttSetupStage] = useState("");
  const [installLogLines, setInstallLogLines] = useState<string[]>([]);
  const [stopStatusMessage, setStopStatusMessage] = useState<string | null>(null);
  const [stopStatusTone, setStopStatusTone] = useState<StatusTone>("success");
  const [parakeetWarming, setParakeetWarming] = useState(false);
  const [omniAsrWarming, setOmniAsrWarming] = useState(false);
  const [cohereTranscribeWarming, setCohereTranscribeWarming] = useState(false);
  const [speakerLabels, setSpeakerLabels] = useState<Record<string, string>>({});
  const [releaseCheck, setReleaseCheck] = useState<ReleaseCheckState>({
    status: "checking",
    currentVersion: null,
    latestVersion: null,
    releaseUrl: LATEST_RELEASE_URL,
  });
  const [saveRecording, setSaveRecording] = useState(false);
  const [recordingFiles, setRecordingFiles] = useState<{ micPath: string; sysPath: string } | null>(null);
  const [pushToTalkButtonHeld, setPushToTalkButtonHeld] = useState(false);
  const [pushToTalkShortcutHeld, setPushToTalkShortcutHeld] = useState(false);

  const isPushToTalkMode = settings?.micCaptureMode === "push-to-talk";
  const desiredMicTransmitActive =
    !isPushToTalkMode || pushToTalkButtonHeld || pushToTalkShortcutHeld;

  const handleRenameParticipant = useCallback((key: string, newName: string) => {
    setSpeakerLabels((prev) => ({ ...prev, [key]: newName }));
  }, []);

  useEffect(() => {
    let cancelled = false;

    const checkLatestRelease = async () => {
      try {
        const currentVersion = await getVersion();
        if (cancelled) return;

        setReleaseCheck({
          status: "checking",
          currentVersion,
          latestVersion: null,
          releaseUrl: LATEST_RELEASE_URL,
        });

        const response = await fetch(LATEST_RELEASE_API_URL, {
          headers: {
            Accept: "application/vnd.github+json",
          },
        });

        if (!response.ok) {
          throw new Error(`Release check failed with status ${response.status}`);
        }

        const payload = (await response.json()) as {
          html_url?: string;
          tag_name?: string;
          name?: string;
        };

        const latestVersion = (payload.tag_name || payload.name || "").trim().replace(/^v/i, "");
        if (!latestVersion) {
          throw new Error("Latest release version was missing");
        }

        const releaseUrl = payload.html_url || LATEST_RELEASE_URL;
        const status = compareVersions(latestVersion, currentVersion) > 0 ? "update" : "current";

        if (!cancelled) {
          setReleaseCheck({
            status,
            currentVersion,
            latestVersion,
            releaseUrl,
          });
        }
      } catch (error) {
        if (!cancelled) {
          setReleaseCheck((previous) => ({
            status: "error",
            currentVersion: previous.currentVersion,
            latestVersion: null,
            releaseUrl: previous.releaseUrl,
          }));
        }
        console.error("Failed to check latest release", error);
      }
    };

    checkLatestRelease().catch(console.error);

    return () => {
      cancelled = true;
    };
  }, []);
  // Load settings on mount
  useEffect(() => {
    invoke<AppSettings>("get_settings")
      .then(setSettings)
      .catch(console.error);
  }, []);

  useEffect(() => {
    const handleOpenSettings = () => setActiveDrawer("settings");
    window.addEventListener("open-settings", handleOpenSettings);
    return () => window.removeEventListener("open-settings", handleOpenSettings);
  }, []);

  const handleSettingsChange = useCallback((updated: AppSettings) => {
    setSettings(updated);
  }, []);

  const handleSuggestionSettingsChange = useCallback(
    async (updates: Partial<Pick<AppSettings, "suggestionsEnabled" | "suggestionIntervalSeconds">>) => {
      if (!settings) {
        return;
      }
      const nextSettings = { ...settings, ...updates };
      setSettings(nextSettings);
      try {
        await invoke("save_settings", { newSettings: nextSettings });
      } catch (err) {
        console.error("Failed to save suggestion settings:", err);
        setSettings(settings);
      }
    },
    [settings],
  );

  const refreshSttStatus = useCallback(async () => {
    try {
      const status = await invoke<SttStatus>("get_stt_status");
      setSttStatus(status);
      setParakeetWarming(status.parakeetWarming);
      setOmniAsrWarming(status.omniAsrWarming);
      setCohereTranscribeWarming(status.cohereTranscribeWarming);
      if (status.ready) {
        setActiveDrawer(null);
      }
      setModelError(null);
      setModelState(status.ready ? "ready" : "missing");
    } catch (err) {
      setModelError(String(err));
      setModelState("missing");
    }
  }, []);

  useEffect(() => {
    if (isRunning && isPushToTalkMode) {
      return;
    }

    setPushToTalkButtonHeld(false);
    setPushToTalkShortcutHeld(false);
  }, [isPushToTalkMode, isRunning]);

  useEffect(() => {
    if (!settings) {
      return;
    }

    setMicTransmitActive(desiredMicTransmitActive);
    invoke("set_mic_transmit_active", { active: desiredMicTransmitActive }).catch(console.error);
  }, [desiredMicTransmitActive, settings]);

  // Keyboard shortcuts
  useKeyboardShortcuts({
    onStartStop: () => {
      if (
        modelState === "ready" &&
        !isStopping &&
        !parakeetWarming &&
        !omniAsrWarming &&
        !cohereTranscribeWarming
      ) {
        if (isRunning) {
          void handleStop();
        } else {
          void handleStart();
        }
      }
    },
    onFocusSearch: () => {
      setActiveDrawer(null);
      setShowSearch(true);
    },
    onExportTranscript: () => {
      if (utterances.length > 0) {
        setShowExport(true);
      }
    },
    onToggleSidebar: () =>
      setActiveDrawer((previous) => (previous === "history" ? null : "history")),
    pushToTalkEnabled: isRunning && isPushToTalkMode,
    pushToTalkShortcut: settings?.pushToTalkHotkey ?? "Space",
    onPushToTalkPress: () => setPushToTalkShortcutHeld(true),
    onPushToTalkRelease: () => setPushToTalkShortcutHeld(false),
  });

  // Check STT readiness whenever settings change
  useEffect(() => {
    if (!settings) {
      return;
    }
    refreshSttStatus();
  }, [refreshSttStatus, settings]);

  // Register event listeners once on mount — listeners don't depend on settings
  // and must not re-register on settings changes (would cause duplicate events).
  useEffect(() => {
    const unlisteners = [
      listen<{ text: string; speaker: string; participantId?: string; participantLabel?: string }>("transcript", (e) => {
        const { text, speaker, participantId, participantLabel } = e.payload;
        setUtterances((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            text,
            speaker: speaker === "you" ? "you" : "them",
            participantId: participantId || null,
            participantLabel: participantLabel || null,
            timestamp: new Date().toISOString(),
          },
        ]);

        if (speaker === "you") {
          setVolatileYouText("");
        } else {
          setVolatileThemText("");
        }
      }),

      listen<{ text: string; speaker: string }>("transcript-volatile", (e) => {
        const { text, speaker } = e.payload;
        if (speaker === "you") {
          setVolatileYouText(text);
        } else {
          setVolatileThemText(text);
        }
      }),

      listen<number>("model-download-progress", (e) => {
        setDownloadProgress(e.payload);
      }),

      listen("model-download-done", () => {
        setModelState("ready");
        setDownloadProgress(0);
        setModelError(null);
        setIsSettingUpStt(false);
        setSttSetupMessage("");
        setInstallLogLines([]);
        refreshSttStatus().catch(console.error);
      }),

      listen<SttStatus>("stt-status", (e) => {
        setSttStatus(e.payload);
      }),

      listen<SttSetupStatusEvent>("stt-setup-status", (e) => {
        setSttSetupStage(e.payload.stage);
        setSttSetupMessage(e.payload.message);
      }),

      listen<string>("stt-install-log", (e) => {
        const line = e.payload.trim();
        if (!line) return;
        setInstallLogLines((prev) => [...prev, line].slice(-80));
        
        const percentMatch = line.match(/(\d{1,3})%/);
        if (percentMatch) {
          setDownloadProgress(parseInt(percentMatch[1], 10));
        }
      }),

      listen<{ id: string; kind?: "knowledge_base" | "smart_question"; text: string; kbHits?: KBResult[] }>("suggestion", (e) => {
        setIsGeneratingSuggestion(false);
        setSuggestions((prev) => [
          ...prev,
          {
            id: e.payload.id,
            kind: e.payload.kind || "knowledge_base",
            text: e.payload.text,
            timestamp: new Date().toISOString(),
            kbHits: e.payload.kbHits || [],
          },
        ]);
      }),

      listen("suggestion-generating", () => {
        setIsGeneratingSuggestion(true);
      }),

      listen("suggestion-finished", () => {
        setIsGeneratingSuggestion(false);
      }),

      listen<SuggestionCheckEvent>("suggestion-check-started", (e) => {
        setLastSuggestionCheckAt(e.payload.checkedAt);
        setLastSuggestionCheckSurfaced(false);
      }),

      listen<SuggestionCheckEvent>("suggestion-check-finished", (e) => {
        setLastSuggestionCheckAt(e.payload.checkedAt);
        setLastSuggestionCheckSurfaced(e.payload.surfaced);
      }),

      listen<{ micInput: number; micPostGate: number; them: number; micTransmitActive: boolean }>("audio-level", (e) => {
        setAudioLevelRaw(e.payload.micInput);
        setAudioLevel(e.payload.micPostGate);
        setAudioLevelThem(e.payload.them);
        setMicTransmitActive(e.payload.micTransmitActive);
      }),

      listen<TranscriptionProgress>("transcription-progress", (e) => {
        setTranscriptionProgress(e.payload);
      }),

      listen<NotesPublishStatusEvent>("notes-publish-status", (e) => {
        const { stage, message } = e.payload;
        setStopStatusTone(
          stage === "error"
            ? "error"
            : stage === "ready"
              ? "success"
              : "info",
        );
        setStopStatusMessage(message);

        if (stage === "ready" || stage === "error") {
          window.setTimeout(() => {
            setStopStatusMessage((current) => (current === message ? null : current));
          }, 5000);
        }
      }),

      listen<{ ready: boolean; message: string }>("parakeet-warmup-status", (e) => {
        setParakeetWarming(!e.payload.ready);
      }),

      listen<{ ready: boolean; message: string }>("omni-asr-warmup-status", (e) => {
        setOmniAsrWarming(!e.payload.ready);
      }),

      listen<{ ready: boolean; message: string }>("cohere-transcribe-warmup-status", (e) => {
        setCohereTranscribeWarming(!e.payload.ready);
      }),

      listen<string>("import-complete", () => {
        setIsImporting(false);
        setIsRunning(false);
      }),

      listen<string>("import-error", (e) => {
        setIsImporting(false);
        setIsRunning(false);
        alert(`Import failed: ${e.payload}`);
      }),
    ];

    return () => {
      unlisteners.forEach((p) => p.then((f) => f()));
    };
  }, [refreshSttStatus]);

  const handleDownload = async () => {
    setModelError(null);
    setModelState("downloading");
    setIsSettingUpStt(true);
    setSttSetupStage("prepare");
    setSttSetupMessage("Starting speech-to-text setup...");
    setInstallLogLines([]);
    try {
      await invoke("download_stt_model");
      await refreshSttStatus();
    } catch (e) {
      const message = String(e);
      setModelError(message);
      setSttSetupStage("error");
      setSttSetupMessage(message);
      setInstallLogLines((prev) => [...prev, `[error] ${message}`].slice(-24));
      setModelState("missing");
      setIsSettingUpStt(false);
    }
  };

  const handleStart = async () => {
    try {
      const sessionId = await invoke<string>("start_transcription", { saveRecording });
      setCurrentSessionId(sessionId);
      setUtterances([]);
      setSuggestions([]);
      setCurrentSessionNotes(null);
      setVolatileYouText("");
      setVolatileThemText("");
      setSpeakerLabels({});
      setTranscriptionProgress({ capturedSegments: 0, processedSegments: 0 });
      setIsStopping(false);
      setStopStatusTone("success");
      setStopStatusMessage(null);
      setIsRunning(true);
      setActiveDrawer(null);
    } catch (e) {
      alert(`Failed to start: ${e}`);
    }
  };

  const handleStop = async () => {
    if (isStopping) {
      return;
    }

    setIsStopping(true);
    setStopStatusTone("warning");
    setStopStatusMessage(
      `Recording stopped. Processing remaining segments (${transcriptionProgress.processedSegments}/${transcriptionProgress.capturedSegments}).`,
    );
    setVolatileYouText("");
    setVolatileThemText("");

    try {
      await invoke("stop_transcription");
      setIsRunning(false);

      // Finalize WAV files and show save modal if recording was enabled
      if (saveRecording) {
        try {
          const files = await invoke<{ micPath: string; sysPath: string }>("finish_recording");
          setRecordingFiles(files);
        } catch (e) {
          // Rust cleans up temp files on finalize failure; surface the error to the user.
          setStopStatusTone("error");
          setStopStatusMessage(`Recording could not be saved: ${e}`);
        }
      }

      if (settings?.obsidianVaultPath) {
        setStopStatusTone("info");
        setStopStatusMessage("Recording fully stopped. Generating summary for Obsidian...");
      } else {
        setStopStatusTone("success");
        setStopStatusMessage("Recording fully stopped.");
        window.setTimeout(() => {
          setStopStatusMessage((current) =>
            current === "Recording fully stopped." ? null : current,
          );
        }, 3000);
      }
    } catch (e) {
      setStopStatusTone("error");
      setStopStatusMessage(`Failed to stop recording: ${e}`);
      throw e;
    } finally {
      setIsStopping(false);
    }
  };

  const handleImport = async () => {
    try {
      const sessionId = await invoke<string>("start_import_transcription");
      setCurrentSessionId(sessionId);
      setUtterances([]);
      setSuggestions([]);
      setCurrentSessionNotes(null);
      setVolatileYouText("");
      setVolatileThemText("");
      setTranscriptionProgress({ capturedSegments: 0, processedSegments: 0 });
      setIsImporting(true);
      setIsRunning(true);
      setActiveDrawer(null);
    } catch (e) {
      const msg = String(e);
      // "No file selected" is a normal cancellation — don't alert the user.
      if (!msg.includes("No file selected")) {
        alert(`Failed to import: ${msg}`);
      }
    }
  };

  const handleDismissSuggestion = useCallback((id: string) => {
    setSuggestions((prev) => prev.filter((s) => s.id !== id));
    invoke("suggestion_feedback", { sessionId: currentSessionId, suggestionId: id, helpful: false }).catch(console.error);
  }, [currentSessionId]);

  const handleSearch = (query: string) => {
    setSearchQuery(query);
    if (!query.trim()) {
      setSearchResults([]);
      setCurrentSearchIndex(0);
      return;
    }

    const indices: number[] = [];
    const lowerQuery = query.toLowerCase();
    utterances.forEach((u, i) => {
      if (u.text.toLowerCase().includes(lowerQuery)) {
        indices.push(i);
      }
    });
    setSearchResults(indices);
    setCurrentSearchIndex(0);
  };

  const handleLoadSession = async (sessionId: string) => {
    try {
      const sessionData = await invoke<SessionDetails>("load_session", { id: sessionId });
      setUtterances(sessionData.transcript);
      setCurrentSessionNotes(sessionData.notes ?? null);
      setCurrentSessionId(sessionId);
      setActiveDrawer(null);
    } catch (err) {
      console.error("Failed to load session:", err);
    }
  };

  const activeWhisperModel = resolveWhisperModel(settings);
  const releaseLabel =
    releaseCheck.status === "update"
      ? `Update available: v${releaseCheck.latestVersion}`
      : releaseCheck.status === "current"
        ? `Up to date: v${releaseCheck.currentVersion}`
        : releaseCheck.status === "error"
          ? "Latest release check unavailable"
          : releaseCheck.currentVersion
            ? `Checking latest release for v${releaseCheck.currentVersion}`
            : "Checking latest release";

  if (modelState === "checking") {
    return (
      <div style={centerStyle}>
        <LoadingSpinner />
        <p style={{ color: colors.textSecondary, marginTop: 16 }}>Checking speech-to-text...</p>
      </div>
    );
  }

  if (modelState === "missing") {
    return (
      <div style={centerStyle}>
        <div style={{ textAlign: "center", maxWidth: 320 }}>
          <div style={iconContainerStyle}>🧠</div>
          <h3 style={{ color: colors.text, margin: "0 0 8px", fontSize: 16 }}>
            Transcription Setup Required
          </h3>
          <p style={{ color: colors.textSecondary, fontSize: 13, margin: "0 0 20px", lineHeight: 1.5 }}>
            {sttStatus?.message || `OpenCassava needs ${sttProviderLabel(settings?.sttProvider || "whisper-rs")} to be ready before transcription can start.`}
          </p>
            {modelError && (
              <p style={{ color: colors.error, fontSize: 12, margin: "0 0 16px", lineHeight: 1.5 }}>
                {modelError}
              </p>
            )}
            {installLogLines.length > 0 && (
              <div
                style={{
                  margin: "0 0 16px",
                  maxHeight: 180,
                  overflowY: "auto",
                  textAlign: "left",
                  fontFamily: "monospace",
                  fontSize: 10,
                  color: colors.textMuted,
                  background: colors.surfaceElevated,
                  borderRadius: 4,
                  padding: "6px 8px",
                  lineHeight: 1.6,
                  wordBreak: "break-all",
                }}
              >
                {installLogLines.map((line, i) => (
                  <div key={i}>{line}</div>
                ))}
              </div>
            )}
            <button onClick={handleDownload} style={primaryBtn}>
              {settings?.sttProvider && settings.sttProvider !== "whisper-rs"
                ? `Set up ${sttProviderLabel(settings.sttProvider)}`
                : `Download ${activeWhisperModel} (~150 MB)`}
            </button>
          <button
            onClick={() => {
              window.location.reload();
            }}
            style={{
              ...primaryBtn,
              marginTop: 12,
              background: colors.surface,
              color: colors.text,
              border: `1px solid ${colors.border}`,
            }}
          >
            Refresh app
          </button>
        </div>
      </div>
    );
  }

  if (modelState === "downloading") {
    const isModelStage = sttSetupStage === "model" || settings?.sttProvider === "whisper-rs" || !settings?.sttProvider;
    
    return (
      <div style={centerStyle}>
        <div style={{ textAlign: "center", maxWidth: 280 }}>
          <h3 style={{ color: colors.text, margin: "0 0 16px", fontSize: 16 }}>🧠 Setting up Speech-to-Text</h3>
          
          {!isModelStage ? (
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 16 }}>
              <LoadingSpinner />
            </div>
          ) : (
            <div style={{ marginBottom: 12 }}>
              <div style={{ width: 260, height: 6, background: colors.surfaceElevated, borderRadius: 3, overflow: "hidden" }}>
                <div style={{ width: `${downloadProgress}%`, height: "100%", background: colors.accent, borderRadius: 3, transition: "width 0.3s" }} />
              </div>
            </div>
          )}
          
          <p style={{ color: colors.textSecondary, fontSize: 12, margin: 0 }}>
            {settings?.sttProvider && settings.sttProvider !== "whisper-rs"
              ? `Preparing ${sttProviderLabel(settings.sttProvider)}... ${isModelStage ? `${downloadProgress}%` : ''}`
              : `Downloading ${activeWhisperModel}... ${isModelStage ? `${downloadProgress}%` : ''}`}
          </p>
          {sttSetupMessage && (
            <p style={{ color: colors.textMuted, fontSize: 12, marginTop: 10, lineHeight: 1.5 }}>
              {sttSetupMessage}
            </p>
            )}
            {installLogLines.length > 0 && (
              <div style={{ marginTop: 8, maxHeight: 220, overflowY: "auto", textAlign: "left", fontFamily: "monospace", fontSize: 10, color: colors.textMuted, background: colors.surfaceElevated, borderRadius: 4, padding: "6px 8px", lineHeight: 1.6, wordBreak: "break-all" }}>
                {installLogLines.map((line, i) => (
                  <div key={i}>{line}</div>
                ))}
              </div>
          )}
        </div>
      </div>
    );
  }

  const isLocalUrl = (url?: string) => !url || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(url);
  const isLocalMode =
    (settings?.llmProvider === "ollama" && settings?.embeddingProvider === "ollama") ||
    (settings?.llmProvider === "openai" && settings?.embeddingProvider === "openai" &&
      isLocalUrl(settings?.openAiLlmBaseUrl) && isLocalUrl(settings?.openAiEmbedBaseUrl));
  const kbConnected = !!(settings?.obsidianVaultPath || settings?.kbFolderPath);
  const kbFileCount = settings?.obsidianVaultPath
    ? new Set([...(settings.obsidianKbIncludePaths || []), settings.obsidianNotesFolder]).size
    : settings?.kbFolderPath
      ? 1
      : 0;

  const railItems = [
    { key: "transcript" as const, label: "Transcript", shortLabel: "Tx" },
    {
      key: "suggestions" as const,
      label: "Suggest",
      shortLabel: "Sg",
      badge: suggestions.length > 0 ? suggestions.length : undefined,
    },
    {
      key: "notes" as const,
      label: "Notes",
      shortLabel: "Nt",
      badge: currentSessionNotes ? 1 : undefined,
    },
    { key: "history" as const, label: "History", shortLabel: "Hs" },
    { key: "settings" as const, label: "Settings", shortLabel: "St" },
    { key: "about" as const, label: "About", shortLabel: "Ab", icon: "diamond" as const },
  ];
  const railStatuses: Array<{
    label: string;
    tone: "neutral" | "accent" | "success" | "warning";
    title: string;
  }> = [
    {
      label: isStopping ? "Sync" : isRunning ? "Live" : isImporting ? "Load" : "Idle",
      tone: isStopping
        ? "warning"
        : isRunning
          ? "success"
          : isImporting
            ? "accent"
            : "neutral",
      title: "Capture state",
    },
    {
      label: kbConnected ? "KB" : "No KB",
      tone: kbConnected ? "accent" : "neutral",
      title: kbConnected ? "Knowledge base connected" : "Knowledge base not connected",
    },
    {
      label: isLocalMode ? "Local" : "Cloud",
      tone: isLocalMode ? "success" : "warning",
      title: isLocalMode ? "Local AI mode" : "Cloud AI mode",
    },
  ];
  const drawerMeta: Record<DrawerKey, { title: string; subtitle: string }> = {
    suggestions: {
      title: "Suggestions",
      subtitle: "Live talking points and smart questions without losing the transcript.",
    },
    notes: {
      title: "Notes",
      subtitle: "Generate and refine summaries while the meeting is still happening.",
    },
    history: {
      title: "Session History",
      subtitle: "Jump back into past transcripts, notes, and conversation context.",
    },
    settings: {
      title: "Settings",
      subtitle: "Tune providers, knowledge sources, and capture behavior for the rail.",
    },
    about: {
      title: "About",
      subtitle: "Version, release status, and project links.",
    },
  };

  const paneStyle = (visible: boolean): React.CSSProperties => ({
    display: visible ? "flex" : "none",
    flex: 1,
    minHeight: 0,
    flexDirection: "column",
  });

  return (
    <CompanionShell
      activeDrawer={activeDrawer}
      drawerTitle={activeDrawer ? drawerMeta[activeDrawer].title : ""}
      drawerSubtitle={activeDrawer ? drawerMeta[activeDrawer].subtitle : ""}
      railItems={railItems}
      railStatuses={railStatuses}
      onSelectRailItem={(key) => {
        if (key === "transcript") {
          setActiveDrawer(null);
          return;
        }

        setActiveDrawer((previous) => (previous === key ? null : key));
      }}
      onCloseDrawer={() => setActiveDrawer(null)}
      captureCapsule={
        <CaptureCapsule
          isRunning={isRunning}
          isImporting={isImporting}
          isStopping={isStopping}
          capturedSegments={transcriptionProgress.capturedSegments}
          processedSegments={transcriptionProgress.processedSegments}
          onStart={handleStart}
          onStop={handleStop}
          onImport={handleImport}
          disabled={
            isStopping ||
            isImporting ||
            ((parakeetWarming || omniAsrWarming || cohereTranscribeWarming) && !isRunning)
          }
          engineWarming={(parakeetWarming || omniAsrWarming || cohereTranscribeWarming) && !isRunning}
          audioLevelRaw={audioLevelRaw}
          audioLevel={audioLevel}
          audioLevelThem={audioLevelThem}
          micCaptureMode={settings?.micCaptureMode ?? "auto"}
          pushToTalkHotkey={settings?.pushToTalkHotkey ?? "Space"}
          micTransmitActive={micTransmitActive}
          onPushToTalkPress={() => setPushToTalkButtonHeld(true)}
          onPushToTalkRelease={() => setPushToTalkButtonHeld(false)}
          saveRecording={saveRecording}
          onSaveRecordingChange={setSaveRecording}
          micCalibrationRms={settings?.micCalibrationRms ?? null}
          micThresholdMultiplier={settings?.micThresholdMultiplier ?? 0.6}
        />
      }
      statusBanner={
        stopStatusMessage ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: spacing[2],
              padding: `${spacing[2]}px ${spacing[3]}px`,
              borderRadius: 20,
              border: `1px solid ${
                stopStatusTone === "warning"
                  ? `${colors.warning}25`
                  : stopStatusTone === "error"
                    ? `${colors.error}25`
                    : stopStatusTone === "info"
                      ? `${colors.accent}25`
                      : `${colors.success}25`
              }`,
              background:
                stopStatusTone === "warning"
                  ? `${colors.warning}10`
                  : stopStatusTone === "error"
                    ? `${colors.error}10`
                    : stopStatusTone === "info"
                      ? `${colors.accent}10`
                      : `${colors.success}10`,
              color:
                stopStatusTone === "warning"
                  ? colors.warning
                  : stopStatusTone === "error"
                    ? colors.error
                    : stopStatusTone === "info"
                      ? colors.accent
                      : colors.success,
              fontSize: typography.sm,
              fontWeight: 700,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background:
                  stopStatusTone === "warning"
                    ? colors.warning
                    : stopStatusTone === "error"
                      ? colors.error
                      : stopStatusTone === "info"
                        ? colors.accent
                        : colors.success,
                display: "inline-block",
              }}
            />
            <span>{stopStatusMessage}</span>
          </div>
        ) : undefined
      }
      transcriptUtilities={
        <div style={{ display: "flex", flexDirection: "column", gap: spacing[2] }}>
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: spacing[3],
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: spacing[1] }}>
              <span
                style={{
                  fontSize: typography.xs,
                  color: colors.textMuted,
                  fontWeight: 700,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                }}
              >
                Conversation
              </span>
              <div style={{ fontSize: typography["2xl"], color: colors.text, fontWeight: 700 }}>
                Transcript
              </div>
              <span style={{ fontSize: typography.sm, color: colors.textSecondary }}>
                {utterances.length > 0
                  ? `${utterances.length} saved lines${currentSessionId ? ` in session ${currentSessionId.slice(0, 8)}` : ""}`
                  : "Waiting for the first transcript line"}
              </span>
            </div>

            <div style={{ display: "flex", gap: spacing[2], flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => {
                  setActiveDrawer(null);
                  setShowSearch((current) => !current);
                }}
                style={headerActionButtonStyle(showSearch)}
              >
                {showSearch ? "Hide search" : "Search"}
              </button>
              <button
                type="button"
                onClick={() => setShowExport(true)}
                disabled={utterances.length === 0}
                style={headerActionButtonStyle(false)}
              >
                Export
              </button>
            </div>
          </div>

          {showSearch && (
            <TranscriptSearch
              compact
              onSearch={handleSearch}
              onClose={() => {
                setShowSearch(false);
                handleSearch("");
              }}
              resultCount={searchResults.length}
              currentIndex={currentSearchIndex}
              onNext={() =>
                setCurrentSearchIndex((index) => Math.min(index + 1, searchResults.length - 1))
              }
              onPrev={() => setCurrentSearchIndex((index) => Math.max(index - 1, 0))}
            />
          )}
        </div>
      }
      transcriptContent={
        <TranscriptView
          utterances={utterances}
          volatileYouText={volatileYouText}
          volatileThemText={volatileThemText}
          searchQuery={searchQuery}
          searchResults={searchResults}
          currentSearchIndex={currentSearchIndex}
          speakerLabels={speakerLabels}
          onRenameParticipant={handleRenameParticipant}
          layout="companion"
        />
      }
      drawerContent={
        <>
          <div style={paneStyle(activeDrawer === "history")}>
            <SessionHistoryPanel
              currentSessionId={currentSessionId}
              onSelectSession={(sessionId) => {
                void handleLoadSession(sessionId);
                setActiveDrawer(null);
              }}
              isActive={activeDrawer === "history"}
            />
          </div>

          <div style={paneStyle(activeDrawer === "suggestions")}>
            <SuggestionsView
              compact
              suggestions={suggestions}
              isGenerating={isGeneratingSuggestion}
              kbConnected={kbConnected}
              kbFileCount={kbFileCount}
              lastCheckedAt={lastSuggestionCheckAt}
              lastCheckSurfaced={lastSuggestionCheckSurfaced}
              suggestionsEnabled={settings?.suggestionsEnabled ?? true}
              suggestionIntervalSeconds={settings?.suggestionIntervalSeconds ?? 30}
              onSuggestionsEnabledChange={(enabled) =>
                handleSuggestionSettingsChange({ suggestionsEnabled: enabled })
              }
              onSuggestionIntervalChange={(seconds) =>
                handleSuggestionSettingsChange({ suggestionIntervalSeconds: seconds })
              }
              onDismiss={handleDismissSuggestion}
              onInjectTest={(suggestion) =>
                setSuggestions((previous) => [
                  ...previous,
                  {
                    ...suggestion,
                    timestamp: new Date().toISOString(),
                  },
                ])
              }
            />
          </div>

          <div style={paneStyle(activeDrawer === "settings")}>
            <SettingsView
              compact
              settings={settings}
              onSettingsChange={handleSettingsChange}
              onApiKeysSaved={() => {
                refreshSttStatus().catch(console.error);
              }}
              sttStatus={sttStatus}
              onSetupStt={handleDownload}
              isSettingUpStt={isSettingUpStt}
            />
          </div>

          <div style={paneStyle(activeDrawer === "about")}>
            <AboutView
              compact
              version={releaseCheck.currentVersion}
              releaseLabel={releaseLabel}
              repositoryUrl={REPOSITORY_URL}
              onBack={() => setActiveDrawer(null)}
              onOpenRelease={() => window.open(LATEST_RELEASE_URL, "_blank", "noopener,noreferrer")}
              onOpenRepository={() => window.open(REPOSITORY_URL, "_blank", "noopener,noreferrer")}
            />
          </div>

          <div style={paneStyle(activeDrawer === "notes")}>
            <NotesView
              sessionId={currentSessionId}
              initialNotes={currentSessionNotes}
              onNotesChange={setCurrentSessionNotes}
              isRunning={isRunning}
            />
          </div>
        </>
      }
      modal={
        <>
          {showExport && <ExportMenu utterances={utterances} onClose={() => setShowExport(false)} />}
          {recordingFiles && currentSessionId && (
            <SaveRecordingModal
              files={recordingFiles}
              sessionId={currentSessionId}
              onDone={() => setRecordingFiles(null)}
            />
          )}
        </>
      }
    />
  );
}

function LoadingSpinner() {
  return (
    <div style={{ width: 32, height: 32, border: `3px solid ${colors.surfaceElevated}`, borderTopColor: colors.accent, borderRadius: "50%", animation: "spin 1s linear infinite" }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

const headerActionButtonStyle = (active: boolean): React.CSSProperties => ({
  padding: `${spacing[2]}px ${spacing[3]}px`,
  background: active ? `${colors.accent}10` : colors.surface,
  color: active ? colors.accent : colors.text,
  border: `1px solid ${active ? `${colors.accent}24` : colors.border}`,
  borderRadius: radius.full,
  fontSize: typography.sm,
  fontWeight: 700,
  cursor: "pointer",
  opacity: 1,
});

const centerStyle: React.CSSProperties = {
  height: "100vh",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  background: colors.background,
};

const iconContainerStyle: React.CSSProperties = {
  width: 64,
  height: 64,
  borderRadius: 16,
  background: `${colors.accent}15`,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 32,
  marginBottom: 16,
};

const primaryBtn: React.CSSProperties = {
  padding: "10px 24px",
  background: colors.accent,
  color: colors.textInverse,
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 14,
  fontWeight: 600,
};

export default App;

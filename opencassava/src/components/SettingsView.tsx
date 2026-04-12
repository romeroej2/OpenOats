import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { normalizeShortcut, shortcutFromKeyboardEvent } from "../hotkeys";
import type { ApiKeys, AppSettings, MeetingTemplate, SttStatus } from "../types";
import { colors, typography, spacing } from "../theme";
import { WaveformVisualizer } from "./WaveformVisualizer";
import { PromptsView } from "./PromptsView";

type Tab = "general" | "ai" | "advanced" | "prompts";

const transcriptionLocaleOptions = [
  { value: "auto", label: "Auto Detect" },
  { value: "en-US", label: "English (US)" },
  { value: "en-GB", label: "English (UK)" },
  { value: "es-ES", label: "Spanish (Spain)" },
  { value: "es-CO", label: "Spanish (Colombia)" },
  { value: "es-MX", label: "Spanish (Mexico)" },
  { value: "fr-FR", label: "French" },
  { value: "de-DE", label: "German" },
  { value: "pt-BR", label: "Portuguese (Brazil)" },
  { value: "pt-PT", label: "Portuguese (Portugal)" },
  { value: "it-IT", label: "Italian" },
  { value: "bg-BG", label: "Bulgarian" },
  { value: "hr-HR", label: "Croatian" },
  { value: "cs-CZ", label: "Czech" },
  { value: "da-DK", label: "Danish" },
  { value: "nl-NL", label: "Dutch" },
  { value: "et-EE", label: "Estonian" },
  { value: "fi-FI", label: "Finnish" },
  { value: "el-GR", label: "Greek" },
  { value: "hu-HU", label: "Hungarian" },
  { value: "lv-LV", label: "Latvian" },
  { value: "lt-LT", label: "Lithuanian" },
  { value: "mt-MT", label: "Maltese" },
  { value: "pl-PL", label: "Polish" },
  { value: "ro-RO", label: "Romanian" },
  { value: "ru-RU", label: "Russian" },
  { value: "sk-SK", label: "Slovak" },
  { value: "sl-SI", label: "Slovenian" },
  { value: "sv-SE", label: "Swedish" },
  { value: "uk-UA", label: "Ukrainian" },
];

const whisperModelOptions = [
  { value: "auto", label: "Auto", description: "Base multilingual with automatic language detection for English and Spanish" },
  { value: "tiny", label: "Tiny", description: "Fastest, lowest accuracy" },
  { value: "base", label: "Base", description: "Lightweight multilingual model" },
  { value: "small", label: "Small", description: "Recommended multilingual balance with automatic language detection" },
  { value: "medium", label: "Medium", description: "Higher accuracy, more CPU/RAM" },
  { value: "large-v3-turbo", label: "Large v3 Turbo", description: "Best local multilingual accuracy, heaviest option" },
];

const sttProviderOptions = [
  { value: "whisper-rs", label: "whisper-rs", description: "Current in-process local transcription with ggml Whisper models. No extra dependencies required." },
  { value: "faster-whisper", label: "faster-whisper", description: "Worker-based backend with app-managed Python runtime. Requires Python 3 on your system." },
  { value: "parakeet", label: "parakeet", description: "NVIDIA Parakeet TDT v3 — multilingual, 25 languages, automatic language detection. Requires Python 3 and ~3 GB disk." },
  { value: "omni-asr", label: "Omni-ASR", description: "facebookresearch/omnilingual-asr — supports 1,600+ languages. Requires Python 3 (Linux/macOS) or WSL2 + Python 3 (Windows)." },
];

sttProviderOptions.push({
  value: "cohere-transcribe",
  label: "Cohere Transcribe",
  description:
    "Local CohereLabs/cohere-transcribe-03-2026 via Transformers. Requires Python 3, a Hugging Face token, and a supported explicit locale.",
});

const parakeetModelOptions = [
  { value: "nvidia/parakeet-tdt-0.6b-v3", label: "Parakeet TDT 0.6B v3 (Recommended)", description: "600M params, 25 languages, best speed/accuracy balance." },
  { value: "nvidia/parakeet-tdt_ctc-1.1b", label: "Parakeet TDT 1.1B v2", description: "1.1B params, English-focused, highest accuracy." },
];

const parakeetDeviceOptions = [
  { value: "auto", label: "Auto" },
  { value: "cpu", label: "CPU" },
  { value: "cuda", label: "CUDA (NVIDIA GPU)" },
];

const omniAsrModelOptions = [
  { value: "omniASR_LLM_Unlimited_300M_v2", label: "omniASR LLM Unlimited 300M v2 (Fast)", description: "Fastest unlimited-length model." },
  { value: "omniASR_LLM_Unlimited_1B_v2",   label: "omniASR LLM Unlimited 1B v2",          description: "Balanced speed and accuracy." },
  { value: "omniASR_LLM_Unlimited_3B_v2",   label: "omniASR LLM Unlimited 3B v2",          description: "High accuracy." },
  { value: "omniASR_LLM_Unlimited_7B_v2",   label: "omniASR LLM Unlimited 7B v2 (Best)",   description: "Highest accuracy, requires more VRAM." },
];

const omniAsrDeviceOptions = [
  { value: "auto", label: "Auto" },
  { value: "cpu", label: "CPU" },
  { value: "cuda", label: "CUDA" },
];

const cohereTranscribeModelOptions = [
  {
    value: "CohereLabs/cohere-transcribe-03-2026",
    label: "Cohere Transcribe 03-2026",
    description:
      "Local Cohere multilingual speech-to-text model. Requires gated Hugging Face access.",
  },
];

const cohereTranscribeDeviceOptions = [
  { value: "auto", label: "Auto" },
  { value: "cpu", label: "CPU" },
  { value: "cuda", label: "CUDA" },
  { value: "rocm-windows", label: "ROCm (Windows Experimental)" },
  { value: "wsl-rocm", label: "ROCm via WSL" },
];

const fasterWhisperModelOptions = [
  { value: "tiny", label: "Tiny" },
  { value: "base", label: "Base" },
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large-v3", label: "Large v3" },
];

const fasterWhisperComputeTypeOptions = [
  { value: "default", label: "Default" },
  { value: "int8", label: "INT8" },
  { value: "float16", label: "Float16" },
  { value: "float32", label: "Float32" },
];

const fasterWhisperDeviceOptions = [
  { value: "auto", label: "Auto" },
  { value: "cpu", label: "CPU" },
  { value: "cuda", label: "CUDA" },
];

function resolveWhisperModel(
  locale: string,
  whisperModel: string,
): "tiny" | "tiny-en" | "base" | "base-en" | "small" | "small-en" | "medium" | "medium-en" | "large-v3-turbo" {
  const normalized = locale.trim().toLowerCase();
  const isEnglish = normalized.startsWith("en");

  switch (whisperModel) {
    case "tiny":
      return isEnglish ? "tiny-en" : "tiny";
    case "base":
      return isEnglish ? "base-en" : "base";
    case "small":
      return isEnglish ? "small-en" : "small";
    case "tiny-en":
      return "tiny-en";
    case "base-en":
      return "base-en";
    case "small-en":
      return "small-en";
    case "medium":
      return isEnglish ? "medium-en" : "medium";
    case "medium-en":
      return "medium-en";
    case "large-v3-turbo":
      return "large-v3-turbo";
    default:
      return "base";
  }
}

interface SettingsViewProps {
  settings?: AppSettings | null;
  onSettingsChange?: (settings: AppSettings) => void;
  onApiKeysSaved?: () => void;
  sttStatus?: SttStatus | null;
  onSetupStt?: () => void;
  isSettingUpStt?: boolean;
  compact?: boolean;
}

export function SettingsView({
  settings: initialSettings = null,
  onSettingsChange,
  onApiKeysSaved,
  sttStatus = null,
  onSetupStt,
  isSettingUpStt = false,
  compact = false,
}: SettingsViewProps) {
  const [settings, setSettings] = useState<AppSettings | null>(initialSettings);
  const [apiKeys, setApiKeys] = useState<ApiKeys | null>(null);
  const [templates, setTemplates] = useState<MeetingTemplate[]>([]);
  const [activeTab, setActiveTab] = useState<Tab>("general");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kbFileCount, setKbFileCount] = useState<number>(0);
  const [isIndexingKb, setIsIndexingKb] = useState(false);
  const [kbStatus, setKbStatus] = useState<string | null>(null);
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [calibrationCountdown, setCalibrationCountdown] = useState(0);
  const [calibrationLevel, setCalibrationLevel] = useState(0);
  const [calibrationError, setCalibrationError] = useState<string | null>(null);
  const [micDevices, setMicDevices] = useState<string[]>([]);
  const [systemAudioDevices, setSystemAudioDevices] = useState<string[]>([]);
  const [huggingFaceTokenDraft, setHuggingFaceTokenDraft] = useState("");
  const [isRecordingPushToTalkHotkey, setIsRecordingPushToTalkHotkey] = useState(false);
  // Prerequisite check state
  const [wsl2Status, setWsl2Status] = useState<{ ok: boolean; message: string } | null>(null);
  const [pythonStatus, setPythonStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const isWindows = navigator.userAgent.toLowerCase().includes("windows");
  const isObsidianActive = !!settings?.obsidianVaultPath;
  const hasKbSource = !!(settings?.obsidianVaultPath || settings?.kbFolderPath);


  const countKBFiles = useCallback(async () => {
    try {
      if (!settings) {
        setKbFileCount(0);
        return;
      }
      if (settings.obsidianVaultPath) {
        const includeCount = new Set([
          ...settings.obsidianKbIncludePaths.filter(Boolean),
          settings.obsidianNotesFolder,
        ]).size;
        setKbFileCount(includeCount);
        return;
      }
      setKbFileCount(settings.kbFolderPath ? 1 : 0);
    } catch {
      setKbFileCount(0);
    }
  }, [settings]);

  const syncKnowledgeBase = useCallback(async () => {
    if (!settings || !(settings.obsidianVaultPath || settings.kbFolderPath)) {
      setKbStatus(null);
      setIsIndexingKb(false);
      return;
    }

    try {
      setIsIndexingKb(true);
      setKbStatus("Indexing knowledge base...");
      const addedChunks = await invoke<number>("index_kb");
      setKbStatus(
        addedChunks > 0
          ? `Knowledge base indexed - ${addedChunks} new or updated chunks`
          : "Knowledge base is ready"
      );
      setError(null);
    } catch (err) {
      setKbStatus("Knowledge base indexing failed");
      setError(String(err));
    } finally {
      setIsIndexingKb(false);
    }
  }, [settings]);

  useEffect(() => {
    invoke<ApiKeys>("get_api_keys")
      .then((keys) => {
        setApiKeys(keys);
        setHuggingFaceTokenDraft(keys.huggingFaceToken || "");
      })
      .catch((err) => setError(String(err)));
  }, []);

  useEffect(() => {
    invoke<MeetingTemplate[]>("list_templates")
      .then(setTemplates)
      .catch((err) => setError(String(err)));
  }, []);

  useEffect(() => {
    Promise.allSettled([
      invoke<string[]>("list_mic_devices"),
      invoke<string[]>("list_sys_audio_devices"),
    ]).then(([micsResult, systemResult]) => {
      if (micsResult.status === "fulfilled") {
        setMicDevices(micsResult.value);
      }
      if (systemResult.status === "fulfilled") {
        setSystemAudioDevices(systemResult.value);
      }
    });
  }, []);

  // Check prerequisites when the Advanced tab becomes active or the provider changes
  useEffect(() => {
    if (!settings || activeTab !== "advanced") return;
    const provider = settings.sttProvider;
    if (provider === "omni-asr" && isWindows) {
      invoke<string>("check_wsl2")
        .then(() => setWsl2Status({ ok: true, message: "WSL2 is available and Python 3 is installed inside it." }))
        .catch((err: string) => setWsl2Status({ ok: false, message: err }));
    } else {
      setWsl2Status(null);
    }
    if (
      provider === "faster-whisper" ||
      provider === "parakeet" ||
      provider === "cohere-transcribe"
    ) {
      invoke<string>("check_python")
        .then((cmd) => setPythonStatus({ ok: true, message: `Python 3 found (${cmd}).` }))
        .catch((err: string) => setPythonStatus({ ok: false, message: err }));
    } else {
      setPythonStatus(null);
    }
  }, [settings, activeTab, isWindows]);

  useEffect(() => {
    if (initialSettings) {
      setSettings(initialSettings);
      setKbFileCount(
        initialSettings.obsidianVaultPath
          ? new Set([
              ...initialSettings.obsidianKbIncludePaths.filter(Boolean),
              initialSettings.obsidianNotesFolder,
            ]).size
          : initialSettings.kbFolderPath
            ? 1
            : 0,
      );
      return;
    }

    invoke<AppSettings>("get_settings")
      .then((loadedSettings) => {
        setSettings(loadedSettings);
        setKbFileCount(
          loadedSettings.obsidianVaultPath
            ? new Set([
                ...loadedSettings.obsidianKbIncludePaths.filter(Boolean),
                loadedSettings.obsidianNotesFolder,
              ]).size
            : loadedSettings.kbFolderPath
              ? 1
              : 0,
        );
      })
      .catch((err) => setError(String(err)));
  }, [initialSettings]);

  useEffect(() => {
    if (settings?.micCaptureMode === "push-to-talk") {
      return;
    }

    setIsRecordingPushToTalkHotkey(false);
  }, [settings?.micCaptureMode]);

  useEffect(() => {
    if (settings?.obsidianVaultPath || settings?.kbFolderPath) {
      void syncKnowledgeBase();
    } else {
      setKbStatus(null);
      setIsIndexingKb(false);
    }
  }, [
    settings?.kbFolderPath,
    settings?.obsidianVaultPath,
    settings?.obsidianKbIncludePaths,
    settings?.obsidianNotesFolder,
    settings?.obsidianTranscriptsFolder,
    syncKnowledgeBase,
  ]);

  const flashSaved = useCallback(() => {
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }, []);

  const saveSettings = useCallback(
    async (updated: AppSettings) => {
      try {
        await invoke("save_settings", { newSettings: updated });
        setSettings(updated);
        onSettingsChange?.(updated);
        setError(null);
        flashSaved();
      } catch (err) {
        setError(String(err));
      }
    },
    [flashSaved, onSettingsChange],
  );

  useEffect(() => {
    if (!isRecordingPushToTalkHotkey || !settings) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (
        event.key === "Escape" &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        !event.metaKey
      ) {
        setIsRecordingPushToTalkHotkey(false);
        return;
      }

      const captured = shortcutFromKeyboardEvent(event);
      if (!captured) {
        return;
      }

      setIsRecordingPushToTalkHotkey(false);
      void saveSettings({
        ...settings,
        pushToTalkHotkey: normalizeShortcut(captured) || "Space",
      });
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [isRecordingPushToTalkHotkey, saveSettings, settings]);

  const startCalibration = async () => {
    if (!settings) return;
    setIsCalibrating(true);
    setCalibrationError(null);
    setCalibrationLevel(0);

    const unlisten = await listen<{ level: number }>("calibration-audio-level", (e) => {
      setCalibrationLevel(e.payload.level);
    });

    try {
      await invoke("start_calibration_preview");

      for (let i = 3; i >= 1; i--) {
        setCalibrationCountdown(i);
        await new Promise((r) => setTimeout(r, 1000));
      }
      setCalibrationCountdown(0);

      const rms = await invoke<number>("calibrate_mic_threshold");
      await invoke("stop_calibration_preview").catch(() => {});
      await saveSettings({ ...settings, micCalibrationRms: rms });
    } catch (err) {
      setCalibrationError(String(err));
      await invoke("stop_calibration_preview").catch(() => {});
    } finally {
      unlisten();
      setIsCalibrating(false);
      setCalibrationLevel(0);
    }
  };

  const saveApiKeys = async (updated: ApiKeys) => {
    const previous = apiKeys;
    setApiKeys(updated);
    try {
      await invoke("save_api_keys", { newKeys: updated });
      onApiKeysSaved?.();
      setError(null);
      flashSaved();
    } catch (err) {
      if (previous) {
        setApiKeys(previous);
      }
      setError(String(err));
    }
  };

  const saveHuggingFaceToken = async () => {
    if (!apiKeys) return;
    const updated = { ...apiKeys, huggingFaceToken: huggingFaceTokenDraft };
    await saveApiKeys(updated);
  };

  const chooseFolder = async (
    key: "kbFolderPath" | "notesFolderPath" | "obsidianVaultPath",
  ) => {
    try {
      const selected = await invoke<string | null>("choose_folder");
      if (selected && settings) {
        const updated = { ...settings, [key]: selected };
        await saveSettings(updated);
        if (key === "kbFolderPath" || key === "obsidianVaultPath") {
          void countKBFiles();
        }
      }
    } catch (err) {
      console.error("Failed to choose folder:", err);
    }
  };

  const addObsidianIncludePath = async () => {
    if (!settings?.obsidianVaultPath) {
      return;
    }
    try {
      const relativePath = await invoke<string>("choose_obsidian_include_folder", {
        vaultPath: settings.obsidianVaultPath,
      });
      if (!relativePath) {
        return;
      }
      const nextIncludePaths = Array.from(
        new Set([...settings.obsidianKbIncludePaths, relativePath]),
      );
      await saveSettings({ ...settings, obsidianKbIncludePaths: nextIncludePaths });
      void countKBFiles();
    } catch (err) {
      if (String(err).includes("No folder selected")) {
        return;
      }
      setError(String(err));
    }
  };

  const removeObsidianIncludePath = async (relativePath: string) => {
    if (!settings) {
      return;
    }
    const nextIncludePaths = settings.obsidianKbIncludePaths.filter((value) => value !== relativePath);
    await saveSettings({ ...settings, obsidianKbIncludePaths: nextIncludePaths });
    void countKBFiles();
  };

  if (!settings || !apiKeys) {
    return (
      <div style={{ padding: spacing[4], color: colors.textMuted }}>
        <div style={{ display: "flex", alignItems: "center", gap: spacing[2] }}>
          <span>Loading settings...</span>
        </div>
      </div>
    );
  }

  const isLocalUrl = (url?: string) => !url || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(url);
  const isLocalMode =
    (settings.llmProvider === "ollama" && settings.embeddingProvider === "ollama") ||
    (settings.llmProvider === "openai" && settings.embeddingProvider === "openai" &&
      isLocalUrl(settings.openAiLlmBaseUrl) && isLocalUrl(settings.openAiEmbedBaseUrl));

  // Local styles for SettingsView
  const styles = {
    container: {
      padding: compact ? spacing[3] : spacing[4],
      overflowY: "auto" as const,
      flex: 1,
      minHeight: 0,
      backgroundColor: colors.background,
    },
    header: {
      margin: `0 0 ${spacing[4]}px`,
      color: colors.text,
      fontSize: typography.lg,
      fontWeight: 600,
    },
    tabs: {
      display: "flex" as const,
      gap: spacing[1],
      flexWrap: "wrap" as const,
      marginBottom: spacing[4],
      borderBottom: `1px solid ${colors.border}`,
      paddingBottom: spacing[1],
    },
    tab: (isActive: boolean): React.CSSProperties => ({
      padding: compact ? `${spacing[2]}px` : `${spacing[2]}px ${spacing[3]}px`,
      background: isActive && compact ? `${colors.accent}10` : "transparent",
      border: isActive && compact ? `1px solid ${colors.accent}28` : "none",
      borderBottom: compact ? "none" : isActive ? `2px solid ${colors.accent}` : "2px solid transparent",
      borderRadius: compact ? 12 : 0,
      color: isActive ? colors.accent : colors.textSecondary,
      fontSize: typography.base,
      fontWeight: isActive ? 700 : 500,
      cursor: "pointer",
      transition: "all 0.2s",
    }),
    section: {
      marginBottom: spacing[5],
    },
    sectionTitle: {
      color: colors.textSecondary,
      fontSize: typography.xs,
      textTransform: "uppercase" as const,
      letterSpacing: "1.5px",
      margin: `0 0 ${spacing[2]}px`,
      fontWeight: 600,
    },
    sectionDescription: {
      color: colors.textMuted,
      fontSize: typography.sm,
      margin: `0 0 ${spacing[3]}px`,
      lineHeight: 1.5,
    },
    fieldWrap: {
      marginBottom: spacing[3],
    },
    labelStyle: {
      display: "block" as const,
      fontSize: typography.base,
      color: colors.textSecondary,
      marginBottom: spacing[1],
      fontWeight: 500,
    },
    inputStyle: {
      width: "100%",
      padding: `${spacing[2]}px`,
      background: colors.surface,
      color: colors.text,
      border: `1px solid ${colors.border}`,
      borderRadius: 4,
      fontSize: typography.md,
      boxSizing: "border-box" as const,
      fontFamily: "inherit",
    },
    selectStyle: {
      width: "100%",
      padding: `${spacing[2]}px`,
      background: colors.surface,
      color: colors.text,
      border: `1px solid ${colors.border}`,
      borderRadius: 4,
      fontSize: typography.md,
      cursor: "pointer",
    },
    checkboxStyle: {
      display: "flex",
      alignItems: "center",
      gap: spacing[2],
      cursor: "pointer",
    },
    checkboxInput: {
      width: 16,
      height: 16,
      accentColor: colors.accent,
    },
    checkboxLabel: {
      fontSize: typography.base,
      color: colors.text,
    },
    button: {
      padding: `${spacing[2]}px ${spacing[3]}px`,
      background: colors.accent,
      color: colors.textInverse,
      border: "none",
      borderRadius: 4,
      fontSize: typography.base,
      cursor: "pointer",
      transition: "background 0.2s",
    },
    buttonSecondary: {
      padding: `${spacing[2]}px ${spacing[3]}px`,
      background: "transparent",
      color: colors.textSecondary,
      border: `1px solid ${colors.border}`,
      borderRadius: 4,
      fontSize: typography.base,
      cursor: "pointer",
    },
    statusBadge: (type: "success" | "warning" | "error"): React.CSSProperties => ({
      display: "inline-flex",
      alignItems: "center",
      gap: spacing[1],
      padding: `${spacing[1]}px ${spacing[2]}px`,
      background: type === "success" ? `${colors.success}15` : type === "warning" ? `${colors.warning}15` : `${colors.error}15`,
      color: type === "success" ? colors.success : type === "warning" ? colors.warning : colors.error,
      borderRadius: 4,
      fontSize: typography.sm,
    }),
    grid: {
      display: "grid",
      gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
      gap: spacing[3],
    },
    aiModeCard: (isSelected: boolean): React.CSSProperties => ({
      padding: spacing[3],
      background: isSelected ? `${colors.accent}10` : colors.surface,
      border: `1px solid ${isSelected ? colors.accent : colors.border}`,
      borderRadius: 8,
      cursor: "pointer",
      transition: "all 0.2s",
    }),
    aiModeTitle: {
      fontSize: typography.md,
      fontWeight: 600,
      color: colors.text,
      marginBottom: spacing[1],
    },
    aiModeDesc: {
      fontSize: typography.sm,
      color: colors.textMuted,
      lineHeight: 1.4,
    },
    divider: {
      height: 1,
      background: colors.border,
      margin: `${spacing[4]}px 0`,
    },
  };

  return (
    <div style={styles.container}>
      {!compact && <h3 style={styles.header}>Settings</h3>}

      {/* Tabs */}
      <div style={styles.tabs}>
        <button
          style={styles.tab(activeTab === "general")}
          onClick={() => setActiveTab("general")}
        >
          General
        </button>
        <button
          style={styles.tab(activeTab === "ai")}
          onClick={() => setActiveTab("ai")}
        >
          AI Providers
        </button>
        <button
          style={styles.tab(activeTab === "advanced")}
          onClick={() => setActiveTab("advanced")}
        >
          Advanced
        </button>
        <button
          style={styles.tab(activeTab === "prompts")}
          onClick={() => setActiveTab("prompts")}
        >
          Prompts
        </button>
      </div>

      {/* General Tab */}
      {activeTab === "general" && (
        <div>
          {/* Obsidian Section */}
          <div style={styles.section}>
            <h4 style={styles.sectionTitle}>Knowledge &amp; Notes</h4>
            <p style={styles.sectionDescription}>
              Connect a local Obsidian vault to power suggestions and keep your meeting knowledge in one place. OpenCassava still works without Obsidian for transcription, summaries, and notes.
            </p>
            <div style={styles.fieldWrap}>
              <label style={styles.labelStyle}>Vault</label>
              <div style={{ display: "flex", gap: spacing[2] }}>
                <input
                  type="text"
                  value={settings.obsidianVaultPath || ""}
                  readOnly
                  style={{ ...styles.inputStyle, flex: 1 }}
                  placeholder="Choose a vault..."
                />
                <button
                  style={styles.buttonSecondary}
                  onClick={() => chooseFolder("obsidianVaultPath")}
                >
                  {settings.obsidianVaultPath ? "Change..." : "Choose..."}
                </button>
                {settings.obsidianVaultPath && (
                  <button
                    style={{ ...styles.buttonSecondary, color: colors.error }}
                    onClick={() => {
                      setKbFileCount(0);
                      setKbStatus(null);
                      void saveSettings({
                        ...settings,
                        obsidianVaultPath: null,
                        obsidianKbIncludePaths: [],
                      });
                    }}
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>

            {settings.obsidianVaultPath && (
              <>
                <div style={styles.fieldWrap}>
                  <label style={styles.labelStyle}>Knowledge Folders</label>
                  <div style={{ display: "flex", flexDirection: "column", gap: spacing[2] }}>
                    {settings.obsidianKbIncludePaths.length === 0 && (
                      <span style={{ fontSize: typography.sm, color: colors.textMuted }}>
                        No extra folders added yet. OpenCassava will still index `{settings.obsidianNotesFolder}` for generated notes.
                      </span>
                    )}
                    {settings.obsidianKbIncludePaths.map((relativePath) => (
                      <div
                        key={relativePath}
                        style={{ display: "flex", alignItems: "center", gap: spacing[2] }}
                      >
                        <input
                          type="text"
                          value={relativePath}
                          readOnly
                          style={{ ...styles.inputStyle, flex: 1 }}
                        />
                        <button
                          style={{ ...styles.buttonSecondary, color: colors.error }}
                          onClick={() => void removeObsidianIncludePath(relativePath)}
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                    <div style={{ display: "flex", gap: spacing[2], alignItems: "center" }}>
                      <button
                        style={styles.buttonSecondary}
                        onClick={() => void addObsidianIncludePath()}
                      >
                        Add Folder...
                      </button>
                      <span style={{ fontSize: typography.sm, color: colors.textMuted }}>
                        Choose the folders inside your vault that should be searched for suggestions.
                      </span>
                    </div>
                  </div>
                </div>

                <div style={styles.fieldWrap}>
                  <label style={styles.labelStyle}>Default Notes Template</label>
                  <select
                    value={settings.defaultNotesTemplateId || ""}
                    onChange={(e) =>
                      saveSettings({
                        ...settings,
                        defaultNotesTemplateId: e.target.value || null,
                      })
                    }
                    style={styles.selectStyle}
                  >
                    <option value="">Summary (default)</option>
                    {templates.map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div style={{ marginTop: spacing[2] }}>
                  <span style={styles.statusBadge("success")}>
                    <span>
                      {isIndexingKb
                        ? "Indexing vault..."
                        : kbStatus || `Vault connected - ${kbFileCount > 0 ? `${kbFileCount} folders indexed` : "ready"}`}
                    </span>
                  </span>
                </div>

                <p style={{ ...styles.sectionDescription, marginTop: spacing[3], marginBottom: 0 }}>
                  OpenCassava publishes canonical notes to `{settings.obsidianNotesFolder}` and keeps transcript companions in `{settings.obsidianTranscriptsFolder}`. Generated notes are indexed automatically; transcripts are not.
                </p>
              </>
            )}
          </div>

          {!settings.obsidianVaultPath && settings.kbFolderPath && (
            <p style={{ ...styles.sectionDescription, marginBottom: spacing[4] }}>
              A legacy folder-based knowledge base is still saved in your settings for compatibility, but the main workflow now centers on an Obsidian vault.
            </p>
          )}

          <div style={{ ...styles.divider, display: "none" }} />


          {/* Knowledge Base Section */}
          <div style={{ ...styles.section, display: "none" }}>
            <h4 style={styles.sectionTitle}>Knowledge Base</h4>
            <p style={styles.sectionDescription}>
              Legacy folder source for suggestions. When an Obsidian vault is connected above, this path is kept only for backwards compatibility and is ignored.
            </p>
            <div style={styles.fieldWrap}>
              <label style={styles.labelStyle}>Legacy KB Folder</label>
              <div style={{ display: "flex", gap: spacing[2], alignItems: "center" }}>
                <input
                  type="text"
                  value={settings.kbFolderPath || ""}
                  readOnly
                  style={{ ...styles.inputStyle, flex: 1 }}
                  placeholder="No folder selected..."
                />
                <button
                  style={styles.buttonSecondary}
                  onClick={() => chooseFolder("kbFolderPath")}
                  disabled={isObsidianActive}
                >
                  {settings.kbFolderPath ? "Change..." : "Choose..."}
                </button>
                {settings.kbFolderPath && (
                  <button
                    style={{ ...styles.buttonSecondary, color: colors.error }}
                    disabled={isObsidianActive}
                    onClick={() => {
                      setKbFileCount(0);
                      setKbStatus(null);
                      void saveSettings({ ...settings, kbFolderPath: "" });
                    }}
                  >
                    Clear
                  </button>
                )}
              </div>
              {hasKbSource && (
                <div style={{ marginTop: spacing[2] }}>
                  <span style={styles.statusBadge("success")}>
                    <span>⚡</span>
                    <span>
                      {isIndexingKb
                        ? "Indexing knowledge base..."
                        : kbStatus || `KB Connected ${kbFileCount > 0 ? `· ${kbFileCount} files` : ""}`}
                    </span>
                  </span>
                </div>
              )}
            </div>
          </div>

          <div style={styles.divider} />

          <div style={styles.section}>
            <h4 style={styles.sectionTitle}>Audio &amp; Capture</h4>
            <p style={styles.sectionDescription}>
              Choose the microphone and system audio sources OpenCassava listens to, then
              calibrate the mic gate if you need more aggressive filtering of room noise.
            </p>

            <div style={styles.grid}>
              <div style={styles.fieldWrap}>
                <label style={styles.labelStyle}>Mic Input</label>
                <select
                  value={settings.inputDeviceName || "default"}
                  onChange={(e) =>
                    saveSettings({
                      ...settings,
                      inputDeviceName: e.target.value === "default" ? null : e.target.value,
                    })
                  }
                  style={styles.selectStyle}
                >
                  <option value="default">Default microphone</option>
                  {micDevices.map((device) => (
                    <option key={device} value={device}>
                      {device}
                    </option>
                  ))}
                </select>
              </div>

              <div style={styles.fieldWrap}>
                <label style={styles.labelStyle}>System Audio</label>
                <select
                  value={settings.systemAudioDeviceName || "default"}
                  onChange={(e) =>
                    saveSettings({
                      ...settings,
                      systemAudioDeviceName:
                        e.target.value === "default" ? null : e.target.value,
                    })
                  }
                  style={styles.selectStyle}
                >
                  <option value="default">Default system source</option>
                  {systemAudioDevices.map((device) => (
                    <option key={device} value={device}>
                      {device}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div style={{ ...styles.fieldWrap, marginTop: spacing[3] }}>
              <label style={styles.labelStyle}>Mic Capture Mode</label>
              <select
                value={settings.micCaptureMode ?? "auto"}
                onChange={(e) =>
                  saveSettings({
                    ...settings,
                    micCaptureMode: e.target.value as "auto" | "push-to-talk",
                  })
                }
                style={styles.selectStyle}
              >
                <option value="auto">Auto</option>
                <option value="push-to-talk">Push to talk</option>
              </select>
              <span style={{ fontSize: typography.sm, color: colors.textMuted, marginTop: 4, display: "block" }}>
                Auto keeps the current always-listening behavior. Push to talk only sends mic audio
                to transcription while you hold the live trigger.
              </span>
            </div>

            {settings.micCaptureMode === "push-to-talk" && (
              <div style={{ ...styles.fieldWrap, marginTop: spacing[3] }}>
                <label style={styles.labelStyle}>Push-to-Talk Shortcut</label>
                <div style={{ display: "flex", flexWrap: "wrap", gap: spacing[2] }}>
                  <button
                    style={styles.button}
                    onClick={() =>
                      setIsRecordingPushToTalkHotkey((previous) => !previous)
                    }
                  >
                    {isRecordingPushToTalkHotkey
                      ? "Press keys..."
                      : `Record Shortcut (${normalizeShortcut(settings.pushToTalkHotkey) || "Space"})`}
                  </button>
                  <button
                    style={styles.buttonSecondary}
                    onClick={() =>
                      saveSettings({ ...settings, pushToTalkHotkey: "Space" })
                    }
                  >
                    Reset to Space
                  </button>
                </div>
                <span
                  style={{
                    fontSize: typography.sm,
                    color: isRecordingPushToTalkHotkey ? colors.text : colors.textMuted,
                    marginTop: 4,
                    display: "block",
                  }}
                >
                  {isRecordingPushToTalkHotkey
                    ? "Press a key or combination now. Escape cancels."
                    : `Current shortcut: ${normalizeShortcut(settings.pushToTalkHotkey) || "Space"}. The shortcut works while OpenCassava is focused.`}
                </span>
              </div>
            )}

            <div style={{ ...styles.fieldWrap, marginTop: spacing[3] }}>
              <label style={styles.labelStyle}>Mic Voice Threshold</label>
              {isCalibrating ? (
                <div style={{ display: "flex", flexDirection: "column", gap: spacing[1] }}>
                  <WaveformVisualizer level={calibrationLevel} isActive={true} />
                  <span style={{ fontSize: typography.sm, color: colors.textMuted }}>
                    {calibrationCountdown > 0 ? `Speak normally... ${calibrationCountdown}` : "Processing..."}
                  </span>
                </div>
              ) : (
                <>
                  {settings.micCalibrationRms == null ? (
                    <span style={{ fontSize: typography.sm, color: colors.textMuted }}>
                      Not calibrated - gate is disabled
                    </span>
                  ) : (
                    <>
                      <span style={{ fontSize: typography.sm, color: colors.text }}>
                        Calibrated: {((settings.micCalibrationRms ?? 0) * 1000).toFixed(1)}
                      </span>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: spacing[2],
                          marginTop: spacing[1],
                          flexWrap: "wrap",
                        }}
                      >
                        <label style={{ fontSize: typography.sm, color: colors.text }}>
                          Sensitivity
                        </label>
                        <input
                          type="range"
                          min={0.1}
                          max={0.8}
                          step={0.05}
                          value={settings.micThresholdMultiplier ?? 0.6}
                          onChange={(e) =>
                            saveSettings({
                              ...settings,
                              micThresholdMultiplier: parseFloat(e.target.value),
                            })
                          }
                          style={{ width: 160 }}
                        />
                        <span style={{ fontSize: typography.sm, color: colors.textMuted }}>
                          {((settings.micThresholdMultiplier ?? 0.6) * 100).toFixed(0)}%
                        </span>
                      </div>
                    </>
                  )}
                  {calibrationError && (
                    <span
                      style={{
                        fontSize: typography.sm,
                        color: colors.error,
                        marginTop: spacing[1],
                        display: "block",
                      }}
                    >
                      {calibrationError}
                    </span>
                  )}
                  <button
                    style={{ ...styles.button, marginTop: spacing[1] }}
                    onClick={startCalibration}
                    disabled={isCalibrating}
                  >
                    {settings.micCalibrationRms == null ? "Calibrate" : "Recalibrate"}
                  </button>
                  <span
                    style={{
                      fontSize: typography.sm,
                      color: colors.textMuted,
                      marginTop: 4,
                      display: "block",
                    }}
                  >
                    Audio below this level will be silenced. Recalibrate if you change microphones
                    or your meeting setup.
                  </span>
                </>
              )}
            </div>
          </div>

          <div style={styles.divider} />

          {/* Privacy Section */}
          <div style={styles.section}>
            <h4 style={styles.sectionTitle}>Privacy</h4>
            <label style={styles.checkboxStyle}>
              <input
                type="checkbox"
                checked={settings.hideFromScreenShare}
                onChange={(e) =>
                  saveSettings({ ...settings, hideFromScreenShare: e.target.checked })
                }
                style={styles.checkboxInput}
              />
              <span style={styles.checkboxLabel}>
                Hide from screen sharing
                <span style={{ display: "block", fontSize: typography.sm, color: colors.textMuted, marginTop: 2 }}>
                  Makes the app invisible during screen recordings
                </span>
              </span>
            </label>
          </div>
        </div>
      )}

      {/* AI Providers Tab */}
      {activeTab === "ai" && (
        <div>
          {/* Mode Selection */}
          <div style={styles.section}>
            <h4 style={styles.sectionTitle}>AI Mode</h4>
            <p style={styles.sectionDescription}>
              Choose how OpenCassava processes your data.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: spacing[3] }}>
              <div
                style={styles.aiModeCard(isLocalMode)}
                onClick={() =>
                  saveSettings({
                    ...settings,
                    llmProvider: "ollama",
                    embeddingProvider: "ollama",
                  })
                }
              >
                <div style={styles.aiModeTitle}>🔒 Local Mode</div>
                <div style={styles.aiModeDesc}>
                  Everything runs on your machine. Requires Ollama running locally. Maximum privacy, no data leaves your device.
                </div>
              </div>
              <div
                style={styles.aiModeCard(!isLocalMode)}
                onClick={() =>
                  saveSettings({
                    ...settings,
                    llmProvider: "openrouter",
                    embeddingProvider: "voyage",
                  })
                }
              >
                <div style={styles.aiModeTitle}>☁️ Cloud Mode</div>
                <div style={styles.aiModeDesc}>
                  Uses cloud providers for best quality. Requires API keys. Transcription stays local, only text snippets are sent to cloud.
                </div>
              </div>
            </div>
          </div>

          <div style={styles.divider} />

          {/* LLM Provider Settings */}
          <div style={styles.section}>
            <h4 style={styles.sectionTitle}>Language Model</h4>
            
            {settings.llmProvider === "openrouter" ? (
              <>
                <div style={styles.fieldWrap}>
                  <label style={styles.labelStyle}>OpenRouter API Key</label>
                  <input
                    type="password"
                    value={apiKeys.openRouterApiKey}
                    onChange={(e) =>
                      saveApiKeys({ ...apiKeys, openRouterApiKey: e.target.value })
                    }
                    style={styles.inputStyle}
                    placeholder="sk-or-..."
                  />
                </div>
                <div style={styles.fieldWrap}>
                  <label style={styles.labelStyle}>Model</label>
                  <input
                    type="text"
                    value={settings.selectedModel}
                    onChange={(e) =>
                      saveSettings({ ...settings, selectedModel: e.target.value })
                    }
                    style={styles.inputStyle}
                    placeholder="e.g. google/gemini-2.5-flash-preview"
                  />
                  <span style={{ fontSize: typography.sm, color: colors.textMuted, marginTop: 4, display: "block" }}>
                    Popular: google/gemini-2.5-flash, anthropic/claude-3.5-sonnet, openai/gpt-4o
                  </span>
                </div>
              </>
            ) : settings.llmProvider === "ollama" ? (
              <>
                <div style={styles.fieldWrap}>
                  <label style={styles.labelStyle}>Ollama Base URL</label>
                  <input
                    type="text"
                    value={settings.ollamaBaseUrl}
                    onChange={(e) =>
                      saveSettings({ ...settings, ollamaBaseUrl: e.target.value })
                    }
                    style={styles.inputStyle}
                    placeholder="http://127.0.0.1:11434"
                  />
                </div>
                <div style={styles.fieldWrap}>
                  <label style={styles.labelStyle}>Model</label>
                  <input
                    type="text"
                    value={settings.ollamaLlmModel}
                    onChange={(e) =>
                      saveSettings({ ...settings, ollamaLlmModel: e.target.value })
                    }
                    style={styles.inputStyle}
                    placeholder="e.g. qwen3:8b, llama3.2:3b"
                  />
                </div>
              </>
            ) : (
              <>
                <div style={styles.fieldWrap}>
                  <label style={styles.labelStyle}>Base URL</label>
                  <input
                    type="text"
                    value={settings.openAiLlmBaseUrl}
                    onChange={(e) =>
                      saveSettings({ ...settings, openAiLlmBaseUrl: e.target.value })
                    }
                    style={styles.inputStyle}
                    placeholder="http://127.0.0.1:1234"
                  />
                </div>
                <div style={styles.fieldWrap}>
                  <label style={styles.labelStyle}>API Key (optional)</label>
                  <input
                    type="password"
                    value={apiKeys.openAiLlmApiKey}
                    onChange={(e) =>
                      saveApiKeys({ ...apiKeys, openAiLlmApiKey: e.target.value })
                    }
                    style={styles.inputStyle}
                  />
                </div>
                <div style={styles.fieldWrap}>
                  <label style={styles.labelStyle}>Model</label>
                  <input
                    type="text"
                    value={settings.selectedModel}
                    onChange={(e) =>
                      saveSettings({ ...settings, selectedModel: e.target.value })
                    }
                    style={styles.inputStyle}
                    placeholder="e.g. gpt-4o-mini"
                  />
                </div>
              </>
            )}
          </div>

          <div style={styles.divider} />

          {/* Embedding Provider Settings */}
          <div style={styles.section}>
            <h4 style={styles.sectionTitle}>Embeddings</h4>
            <p style={styles.sectionDescription}>
              Used for knowledge base search.
            </p>

            {settings.embeddingProvider === "voyage" ? (
              <>
                <div style={styles.fieldWrap}>
                  <label style={styles.labelStyle}>Voyage AI API Key</label>
                  <input
                    type="password"
                    value={apiKeys.voyageApiKey}
                    onChange={(e) =>
                      saveApiKeys({ ...apiKeys, voyageApiKey: e.target.value })
                    }
                    style={styles.inputStyle}
                    placeholder="pa-..."
                  />
                </div>
                <div style={{ ...styles.statusBadge("warning"), marginTop: spacing[2] }}>
                  <span>⚡</span>
                  <span>Uses voyage-3-lite model</span>
                </div>
              </>
            ) : settings.embeddingProvider === "ollama" ? (
              <>
                <div style={styles.fieldWrap}>
                  <label style={styles.labelStyle}>Ollama Base URL</label>
                  <input
                    type="text"
                    value={settings.ollamaBaseUrl}
                    onChange={(e) =>
                      saveSettings({ ...settings, ollamaBaseUrl: e.target.value })
                    }
                    style={styles.inputStyle}
                    placeholder="http://127.0.0.1:11434"
                  />
                </div>
                <div style={styles.fieldWrap}>
                  <label style={styles.labelStyle}>Embedding Model</label>
                  <input
                    type="text"
                    value={settings.ollamaEmbedModel}
                    onChange={(e) =>
                      saveSettings({ ...settings, ollamaEmbedModel: e.target.value })
                    }
                    style={styles.inputStyle}
                    placeholder="e.g. nomic-embed-text"
                  />
                </div>
              </>
            ) : (
              <>
                <div style={styles.fieldWrap}>
                  <label style={styles.labelStyle}>Base URL</label>
                  <input
                    type="text"
                    value={settings.openAiEmbedBaseUrl}
                    onChange={(e) =>
                      saveSettings({ ...settings, openAiEmbedBaseUrl: e.target.value })
                    }
                    style={styles.inputStyle}
                    placeholder="http://127.0.0.1:8080"
                  />
                </div>
                <div style={styles.fieldWrap}>
                  <label style={styles.labelStyle}>API Key (optional)</label>
                  <input
                    type="password"
                    value={apiKeys.openAiEmbedApiKey}
                    onChange={(e) =>
                      saveApiKeys({ ...apiKeys, openAiEmbedApiKey: e.target.value })
                    }
                    style={styles.inputStyle}
                  />
                </div>
                <div style={styles.fieldWrap}>
                  <label style={styles.labelStyle}>Model</label>
                  <input
                    type="text"
                    value={settings.openAiEmbedModel}
                    onChange={(e) =>
                      saveSettings({ ...settings, openAiEmbedModel: e.target.value })
                    }
                    style={styles.inputStyle}
                    placeholder="e.g. text-embedding-3-small"
                  />
                </div>
              </>
            )}
          </div>

        </div>
      )}

      {/* Advanced Tab */}
      {activeTab === "advanced" && (
        <div>
          {/* Transcription Section */}
          <div style={styles.section}>
            <h4 style={styles.sectionTitle}>Transcription</h4>
            <div style={styles.fieldWrap}>
              <label style={styles.labelStyle}>STT Provider</label>
              <select
                value={settings.sttProvider}
                onChange={(e) =>
                  saveSettings({ ...settings, sttProvider: e.target.value })
                }
                style={styles.selectStyle}
              >
                {sttProviderOptions.map((option) => (
                  <option 
                    key={option.value} 
                    value={option.value}
                  >
                    {option.label}
                  </option>
                ))}
              </select>
              <span style={{ fontSize: typography.sm, color: colors.textMuted, marginTop: 4, display: "block" }}>
                {sttProviderOptions.find((option) => option.value === settings.sttProvider)?.description}
              </span>
            </div>
            <div style={styles.fieldWrap}>
              <label style={styles.labelStyle}>Language / Locale</label>
              <select
                value={settings.transcriptionLocale}
                onChange={(e) =>
                  saveSettings({ ...settings, transcriptionLocale: e.target.value })
                }
                style={styles.selectStyle}
              >
                {transcriptionLocaleOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span style={{ fontSize: typography.sm, color: colors.textMuted, marginTop: 4, display: "block" }}>
                {settings.sttProvider === "faster-whisper"
                  ? `OpenCassava will use faster-whisper ${settings.fasterWhisperModel}.`
                  : settings.sttProvider === "parakeet"
                  ? `OpenCassava will use Parakeet v3 (${settings.parakeetModel}). Language is auto-detected from audio.`
                  : settings.sttProvider === "omni-asr"
                  ? `OpenCassava will use Omni-ASR (${settings.omniAsrModel}).`
                  : settings.sttProvider === "cohere-transcribe"
                  ? `OpenCassava will use Cohere Transcribe (${settings.cohereTranscribeModel}) with the selected explicit locale. Unsupported or auto locales fall back to whisper-rs.`
                  : `OpenCassava will download and use ${resolveWhisperModel(settings.transcriptionLocale, settings.whisperModel)}. Choose Auto Detect for mixed-language conversations.`}
              </span>
            </div>
            {settings.sttProvider === "whisper-rs" ? (
              <div style={styles.fieldWrap}>
                <label style={styles.labelStyle}>Whisper Model</label>
                <select
                  value={settings.whisperModel}
                  onChange={(e) =>
                    saveSettings({ ...settings, whisperModel: e.target.value })
                  }
                  style={styles.selectStyle}
                >
                  {whisperModelOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <span style={{ fontSize: typography.sm, color: colors.textMuted, marginTop: 4, display: "block" }}>
                  {whisperModelOptions.find((option) => option.value === settings.whisperModel)?.description}. Effective model: `{resolveWhisperModel(settings.transcriptionLocale, settings.whisperModel)}`.
                </span>
              </div>
            ) : settings.sttProvider === "faster-whisper" ? (
              <>
                <div style={styles.fieldWrap}>
                  <label style={styles.labelStyle}>faster-whisper Model</label>
                  <select
                    value={settings.fasterWhisperModel}
                    onChange={(e) =>
                      saveSettings({ ...settings, fasterWhisperModel: e.target.value })
                    }
                    style={styles.selectStyle}
                  >
                    {fasterWhisperModelOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div style={styles.grid}>
                  <div style={styles.fieldWrap}>
                    <label style={styles.labelStyle}>Device</label>
                    <select
                      value={settings.fasterWhisperDevice}
                      onChange={(e) =>
                        saveSettings({ ...settings, fasterWhisperDevice: e.target.value })
                      }
                      style={styles.selectStyle}
                    >
                      {fasterWhisperDeviceOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div style={styles.fieldWrap}>
                    <label style={styles.labelStyle}>Compute Type</label>
                    <select
                      value={settings.fasterWhisperComputeType}
                      onChange={(e) =>
                        saveSettings({ ...settings, fasterWhisperComputeType: e.target.value })
                      }
                      style={styles.selectStyle}
                    >
                      {fasterWhisperComputeTypeOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </>
            ) : settings.sttProvider === "parakeet" ? (
              <>
                <div style={styles.fieldWrap}>
                  <label style={styles.labelStyle}>Parakeet Model</label>
                  <select
                    value={settings.parakeetModel}
                    onChange={(e) =>
                      saveSettings({ ...settings, parakeetModel: e.target.value })
                    }
                    style={styles.selectStyle}
                  >
                    {parakeetModelOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <span style={{ fontSize: typography.sm, color: colors.textMuted, marginTop: 4, display: "block" }}>
                    {parakeetModelOptions.find((option) => option.value === settings.parakeetModel)?.description}
                  </span>
                </div>
                <div style={styles.fieldWrap}>
                  <label style={styles.labelStyle}>Device</label>
                  <select
                    value={settings.parakeetDevice}
                    onChange={(e) =>
                      saveSettings({ ...settings, parakeetDevice: e.target.value })
                    }
                    style={styles.selectStyle}
                  >
                    {parakeetDeviceOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div style={styles.fieldWrap}>
                  <label style={styles.labelStyle}>Speaker diarization</label>
                  <div style={{ display: "flex", alignItems: "center", gap: spacing[2] }}>
                    <input
                      type="checkbox"
                      id="diarization-toggle"
                      checked={settings.diarizationEnabled ?? true}
                      onChange={(e) =>
                        saveSettings({ ...settings, diarizationEnabled: e.target.checked })
                      }
                    />
                    <label htmlFor="diarization-toggle" style={{ fontSize: typography.sm, color: colors.text, cursor: "pointer" }}>
                      Enabled
                    </label>
                  </div>
                  <span style={{ fontSize: typography.sm, color: colors.textMuted, marginTop: 4, display: "block" }}>
                    Automatically identify different speakers in call audio
                  </span>
                </div>
                <div style={styles.fieldWrap}>
                  <label style={styles.labelStyle}>Echo cancellation</label>
                  <div style={{ display: "flex", alignItems: "center", gap: spacing[2] }}>
                    <input
                      type="checkbox"
                      id="echo-cancellation-toggle"
                      checked={settings.echoCancellationEnabled ?? true}
                      onChange={(e) =>
                        saveSettings({ ...settings, echoCancellationEnabled: e.target.checked })
                      }
                    />
                    <label
                      htmlFor="echo-cancellation-toggle"
                      style={{ fontSize: typography.sm, color: colors.text, cursor: "pointer" }}
                    >
                      Enabled
                    </label>
                  </div>
                  <span style={{ fontSize: typography.sm, color: colors.textMuted, marginTop: 4, display: "block" }}>
                    Reduce speaker playback leaking back into the microphone when you are using speakers
                  </span>
                </div>

              </>
            ) : settings.sttProvider === "omni-asr" ? (
              <>
                <div style={styles.fieldWrap}>
                  <label style={styles.labelStyle}>Omni-ASR Model</label>
                  <select
                    value={settings.omniAsrModel}
                    onChange={(e) =>
                      saveSettings({ ...settings, omniAsrModel: e.target.value })
                    }
                    style={styles.selectStyle}
                  >
                    {omniAsrModelOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <span style={{ fontSize: typography.sm, color: colors.textMuted, marginTop: 4, display: "block" }}>
                    {omniAsrModelOptions.find((option) => option.value === settings.omniAsrModel)?.description}
                  </span>
                </div>
                <div style={styles.fieldWrap}>
                  <label style={styles.labelStyle}>Device</label>
                  <select
                    value={settings.omniAsrDevice}
                    onChange={(e) =>
                      saveSettings({ ...settings, omniAsrDevice: e.target.value })
                    }
                    style={styles.selectStyle}
                  >
                    {omniAsrDeviceOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            ) : settings.sttProvider === "cohere-transcribe" ? (
              <>
                <div style={styles.fieldWrap}>
                  <label style={styles.labelStyle}>Cohere Model</label>
                  <select
                    value={settings.cohereTranscribeModel}
                    onChange={(e) =>
                      saveSettings({ ...settings, cohereTranscribeModel: e.target.value })
                    }
                    style={styles.selectStyle}
                  >
                    {cohereTranscribeModelOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <span style={{ fontSize: typography.sm, color: colors.textMuted, marginTop: 4, display: "block" }}>
                    {cohereTranscribeModelOptions.find((option) => option.value === settings.cohereTranscribeModel)?.description}
                  </span>
                </div>
                  <div style={styles.fieldWrap}>
                    <label style={styles.labelStyle}>Device</label>
                    <select
                      value={settings.cohereTranscribeDevice}
                      onChange={(e) =>
                      saveSettings({ ...settings, cohereTranscribeDevice: e.target.value })
                    }
                    style={styles.selectStyle}
                  >
                    {cohereTranscribeDeviceOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                        </option>
                      ))}
                    </select>
                    <span style={{ fontSize: typography.sm, color: colors.textMuted, marginTop: 4, display: "block" }}>
                      {settings.cohereTranscribeDevice === "rocm-windows"
                        ? "Experimental AMD ROCm path on native Windows. Currently intended for Radeon 7900-class GPUs with Python 3.12."
                        : settings.cohereTranscribeDevice === "wsl-rocm"
                        ? "Uses ROCm through WSL on Windows. This is the more conservative AMD GPU path."
                        : "Auto and CPU remain the most compatible options if GPU runtime setup fails."}
                    </span>
                  </div>
                <div style={styles.fieldWrap}>
                  <label style={styles.labelStyle}>Hugging Face Token</label>
                  <input
                    type="password"
                    value={huggingFaceTokenDraft}
                    onChange={(e) => setHuggingFaceTokenDraft(e.target.value)}
                    onBlur={() => {
                      if (huggingFaceTokenDraft !== (apiKeys.huggingFaceToken || "")) {
                        void saveHuggingFaceToken();
                      }
                    }}
                    style={styles.inputStyle}
                    placeholder="hf_..."
                  />
                  <div style={{ display: "flex", alignItems: "center", gap: spacing[2], marginTop: spacing[1] }}>
                    <button
                      style={styles.button}
                      onClick={() => void saveHuggingFaceToken()}
                    >
                      Save token
                    </button>
                    <span style={{ fontSize: typography.sm, color: colors.textMuted }}>
                      Required for gated local model download.
                    </span>
                  </div>
                </div>
                <div style={styles.fieldWrap}>
                  <label style={styles.labelStyle}>Speaker diarization</label>
                  <span style={{ fontSize: typography.sm, color: colors.textMuted, display: "block" }}>
                    Cohere Transcribe does not provide diarization in this integration.
                  </span>
                </div>
              </>
            ) : null}
            {/* WSL2 prerequisite banner — Windows + omni-asr only */}
            {wsl2Status && (
              <div style={{
                marginTop: spacing[2],
                padding: spacing[3],
                background: wsl2Status.ok ? `${colors.success}12` : `${colors.warning}12`,
                border: `1px solid ${wsl2Status.ok ? colors.success : colors.warning}`,
                borderRadius: 6,
              }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: spacing[2] }}>
                  <span style={{ fontSize: 18 }}>{wsl2Status.ok ? "✅" : "⚠️"}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: typography.base, fontWeight: 600, color: colors.text, marginBottom: 4 }}>
                      {wsl2Status.ok ? "WSL2 Ready" : "WSL2 Required for Omni-ASR on Windows"}
                    </div>
                    <div style={{ fontSize: typography.sm, color: colors.textMuted, lineHeight: 1.5 }}>
                      {wsl2Status.message}
                    </div>
                    {!wsl2Status.ok && (
                      <div style={{ marginTop: spacing[2], display: "flex", flexDirection: "column", gap: spacing[1] }}>
                        <div style={{ fontSize: typography.sm, color: colors.text, fontWeight: 500 }}>Setup steps:</div>
                        <ol style={{ margin: 0, paddingLeft: 20, fontSize: typography.sm, color: colors.textMuted, lineHeight: 1.8 }}>
                          <li>Open PowerShell as Administrator and run: <code style={{ background: colors.surface, padding: "1px 4px", borderRadius: 3 }}>wsl --install</code></li>
                          <li>After reboot, open the WSL terminal (Ubuntu) and run:<br/>
                            <code style={{ background: colors.surface, padding: "1px 4px", borderRadius: 3 }}>sudo apt update && sudo apt install -y python3 python3-venv python3-pip</code><br/>
                            <span style={{ fontSize: typography.xs, color: colors.textMuted }}>On Ubuntu 24.04 with Python 3.12, use: <code style={{ background: colors.surface, padding: "1px 4px", borderRadius: 3 }}>python3.12-venv</code> instead of <code style={{ background: colors.surface, padding: "1px 4px", borderRadius: 3 }}>python3-venv</code></span>
                          </li>
                          <li>Then click <strong>Set up Omni-ASR</strong> below.</li>
                        </ol>
                        <a
                          href="https://learn.microsoft.com/en-us/windows/wsl/install"
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ fontSize: typography.sm, color: colors.accent, marginTop: spacing[1] }}
                        >
                          📖 WSL2 Installation Guide →
                        </a>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
            {/* Python prerequisite banner — faster-whisper and parakeet */}
            {pythonStatus && (
              <div style={{
                marginTop: spacing[2],
                padding: spacing[3],
                background: pythonStatus.ok ? `${colors.success}12` : `${colors.warning}12`,
                border: `1px solid ${pythonStatus.ok ? colors.success : colors.warning}`,
                borderRadius: 6,
              }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: spacing[2] }}>
                  <span style={{ fontSize: 18 }}>{pythonStatus.ok ? "✅" : "⚠️"}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: typography.base, fontWeight: 600, color: colors.text, marginBottom: 4 }}>
                      {pythonStatus.ok ? "Python 3 Found" : "Python 3 Required"}
                    </div>
                    <div style={{ fontSize: typography.sm, color: colors.textMuted, lineHeight: 1.5 }}>
                      {pythonStatus.message}
                    </div>
                    {!pythonStatus.ok && (
                      <div style={{ marginTop: spacing[2] }}>
                        <a
                          href="https://python.org/downloads/"
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ fontSize: typography.sm, color: colors.accent }}
                        >
                          📖 Download Python 3 →
                        </a>
                        {isWindows && (
                          <span style={{ fontSize: typography.sm, color: colors.textMuted, marginLeft: spacing[2] }}>
                            (check "Add Python to PATH" during installation)
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
            {settings.sttProvider === "cohere-transcribe" && (
              <div style={{
                marginTop: spacing[2],
                padding: spacing[3],
                background: apiKeys.huggingFaceToken ? `${colors.success}12` : `${colors.warning}12`,
                border: `1px solid ${apiKeys.huggingFaceToken ? colors.success : colors.warning}`,
                borderRadius: 6,
              }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: spacing[2] }}>
                  <span style={{ fontSize: 18 }}>{apiKeys.huggingFaceToken ? "âœ…" : "âš ï¸"}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: typography.base, fontWeight: 600, color: colors.text, marginBottom: 4 }}>
                      {apiKeys.huggingFaceToken ? "Hugging Face Token Saved" : "Hugging Face Token Required"}
                    </div>
                    <div style={{ fontSize: typography.sm, color: colors.textMuted, lineHeight: 1.5 }}>
                      {apiKeys.huggingFaceToken
                        ? "OpenCassava can use this token during local Cohere Transcribe setup."
                        : "Save a Hugging Face token here and make sure your account has accepted access to CohereLabs/cohere-transcribe-03-2026."}
                    </div>
                  </div>
                </div>
              </div>
            )}
            {sttStatus && (
              <div style={{ marginTop: spacing[2], display: "flex", flexDirection: "column", gap: spacing[2] }}>
                <span style={styles.statusBadge(sttStatus.ready ? (sttStatus.usingFallback ? "warning" : "success") : "error")}>
                  <span>{sttStatus.message}</span>
                </span>
                <span style={{ fontSize: typography.sm, color: colors.textMuted }}>
                  Active backend: `{sttStatus.effectiveProvider}` using `{sttStatus.effectiveModel}`.
                </span>
                {(settings.sttProvider === "faster-whisper" || settings.sttProvider === "parakeet" || settings.sttProvider === "omni-asr" || settings.sttProvider === "cohere-transcribe") && (
                  <button
                    style={styles.button}
                    onClick={() => onSetupStt?.()}
                    disabled={isSettingUpStt}
                  >
                    {isSettingUpStt
                      ? `Setting up ${settings.sttProvider}...`
                      : sttStatus.selectedProviderReady
                      ? `Reinstall ${settings.sttProvider}`
                      : `Set up ${settings.sttProvider}`}
                  </button>
                )}
              </div>
            )}
          </div>

          <div style={styles.divider} />

          {/* Reset Section */}
          <div style={styles.section}>
            <h4 style={styles.sectionTitle}>Reset</h4>
            <button
              style={{ ...styles.buttonSecondary, color: colors.error }}
              onClick={() => {
                if (confirm("Reset all settings to defaults? This cannot be undone.")) {
                  // Reset logic would go here
                }
              }}
            >
              Reset to Defaults
            </button>
          </div>
        </div>
      )}

      {/* Prompts Tab */}
      {activeTab === "prompts" && <PromptsView />}

      {/* Status Messages */}
      {error && (
        <div style={{ ...styles.statusBadge("error"), marginTop: spacing[4] }}>
          <span>⚠️</span>
          <span>{error}</span>
        </div>
      )}
      {saved && (
        <div style={{ ...styles.statusBadge("success"), marginTop: spacing[4] }}>
          <span>✓</span>
          <span>Saved</span>
        </div>
      )}
    </div>
  );
}

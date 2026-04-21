import { useSyncExternalStore } from "react";
import type { KBResult, Suggestion, TranscriptionProgress, Utterance } from "../types";

type SpeakerKey = "you" | "them";

export interface AudioLevelsState {
  raw: number;
  mic: number;
  them: number;
  micTransmitActive: boolean;
}

export interface SuggestionStatusState {
  isGenerating: boolean;
  lastCheckedAt: string | null;
  lastCheckSurfaced: boolean | null;
}

export interface LiveSessionState {
  utterances: Utterance[];
  suggestions: Suggestion[];
  volatileYouText: string;
  volatileThemText: string;
  audioLevels: AudioLevelsState;
  transcriptionProgress: TranscriptionProgress;
  suggestionStatus: SuggestionStatusState;
}

interface TranscriptPayload {
  text: string;
  speaker: string;
  participantId?: string;
  participantLabel?: string;
}

interface SuggestionPayload {
  id: string;
  kind?: Suggestion["kind"];
  text: string;
  kbHits?: KBResult[];
}

type Listener = () => void;

const EMPTY_AUDIO_LEVELS: AudioLevelsState = {
  raw: 0,
  mic: 0,
  them: 0,
  micTransmitActive: false,
};

const EMPTY_TRANSCRIPTION_PROGRESS: TranscriptionProgress = {
  capturedSegments: 0,
  processedSegments: 0,
};

const EMPTY_SUGGESTION_STATUS: SuggestionStatusState = {
  isGenerating: false,
  lastCheckedAt: null,
  lastCheckSurfaced: null,
};

const EMPTY_STATE: LiveSessionState = {
  utterances: [],
  suggestions: [],
  volatileYouText: "",
  volatileThemText: "",
  audioLevels: EMPTY_AUDIO_LEVELS,
  transcriptionProgress: EMPTY_TRANSCRIPTION_PROGRESS,
  suggestionStatus: EMPTY_SUGGESTION_STATUS,
};

class LiveSessionStore {
  private state: LiveSessionState = EMPTY_STATE;
  private listeners = new Set<Listener>();

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = () => this.state;

  private commit(nextState: LiveSessionState) {
    if (Object.is(nextState, this.state)) {
      return;
    }
    this.state = nextState;
    this.listeners.forEach((listener) => listener());
  }

  private update(updater: (current: LiveSessionState) => LiveSessionState) {
    this.commit(updater(this.state));
  }

  resetSession = () => {
    this.commit({
      ...EMPTY_STATE,
      audioLevels: this.state.audioLevels.micTransmitActive
        ? { ...EMPTY_AUDIO_LEVELS, micTransmitActive: false }
        : EMPTY_AUDIO_LEVELS,
    });
  };

  replaceTranscript = (utterances: Utterance[]) => {
    this.update((current) => ({
      ...current,
      utterances,
      suggestions: [],
      volatileYouText: "",
      volatileThemText: "",
      transcriptionProgress: EMPTY_TRANSCRIPTION_PROGRESS,
      suggestionStatus: EMPTY_SUGGESTION_STATUS,
    }));
  };

  addTranscriptUtterance = (payload: TranscriptPayload) => {
    const speaker = payload.speaker === "you" ? "you" : "them";
    this.update((current) => ({
      ...current,
      utterances: [
        ...current.utterances,
        {
          id: crypto.randomUUID(),
          text: payload.text,
          speaker,
          participantId: payload.participantId || null,
          participantLabel: payload.participantLabel || null,
          timestamp: new Date().toISOString(),
        },
      ],
      volatileYouText: speaker === "you" ? "" : current.volatileYouText,
      volatileThemText: speaker === "them" ? "" : current.volatileThemText,
    }));
  };

  setVolatileTranscript = (speaker: SpeakerKey, text: string) => {
    this.update((current) =>
      speaker === "you"
        ? { ...current, volatileYouText: text }
        : { ...current, volatileThemText: text },
    );
  };

  setAudioLevels = (audioLevels: AudioLevelsState) => {
    this.update((current) => ({ ...current, audioLevels }));
  };

  setTranscriptionProgress = (transcriptionProgress: TranscriptionProgress) => {
    this.update((current) => ({ ...current, transcriptionProgress }));
  };

  addSuggestion = (payload: SuggestionPayload) => {
    this.update((current) => ({
      ...current,
      suggestions: [
        ...current.suggestions,
        {
          id: payload.id,
          kind: payload.kind || "knowledge_base",
          text: payload.text,
          timestamp: new Date().toISOString(),
          kbHits: payload.kbHits || [],
        },
      ],
      suggestionStatus: {
        ...current.suggestionStatus,
        isGenerating: false,
      },
    }));
  };

  injectSuggestion = (payload: Omit<Suggestion, "timestamp">) => {
    this.update((current) => ({
      ...current,
      suggestions: [
        ...current.suggestions,
        {
          ...payload,
          timestamp: new Date().toISOString(),
        },
      ],
    }));
  };

  dismissSuggestion = (id: string) => {
    this.update((current) => ({
      ...current,
      suggestions: current.suggestions.filter((suggestion) => suggestion.id !== id),
    }));
  };

  setSuggestionGenerating = (isGenerating: boolean) => {
    this.update((current) => ({
      ...current,
      suggestionStatus: {
        ...current.suggestionStatus,
        isGenerating,
      },
    }));
  };

  setSuggestionCheck = (checkedAt: string, surfaced: boolean | null) => {
    this.update((current) => ({
      ...current,
      suggestionStatus: {
        ...current.suggestionStatus,
        lastCheckedAt: checkedAt,
        lastCheckSurfaced: surfaced,
      },
    }));
  };
}

export const liveSessionStore = new LiveSessionStore();

export function useLiveSessionStore<T>(selector: (state: LiveSessionState) => T): T {
  return useSyncExternalStore(
    liveSessionStore.subscribe,
    () => selector(liveSessionStore.getState()),
    () => selector(EMPTY_STATE),
  );
}

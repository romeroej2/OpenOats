import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import type { KBResult, Suggestion, TranscriptionProgress } from "../types";
import { liveSessionStore } from "./useLiveSessionStore";

type SuggestionCheckEvent = {
  checkedAt: string;
  surfaced: boolean;
};

export function useLiveSessionSubscriptions() {
  useEffect(() => {
    const unlisteners = [
      listen<{
        text: string;
        speaker: string;
        participantId?: string;
        participantLabel?: string;
      }>("transcript", (event) => {
        liveSessionStore.addTranscriptUtterance(event.payload);
      }),

      listen<{ text: string; speaker: string }>("transcript-volatile", (event) => {
        liveSessionStore.setVolatileTranscript(
          event.payload.speaker === "you" ? "you" : "them",
          event.payload.text,
        );
      }),

      listen<{ micInput: number; micPostGate: number; them: number; micTransmitActive: boolean }>(
        "audio-level",
        (event) => {
          liveSessionStore.setAudioLevels({
            raw: event.payload.micInput,
            mic: event.payload.micPostGate,
            them: event.payload.them,
            micTransmitActive: event.payload.micTransmitActive,
          });
        },
      ),

      listen<TranscriptionProgress>("transcription-progress", (event) => {
        liveSessionStore.setTranscriptionProgress(event.payload);
      }),

      listen<{
        id: string;
        kind?: Suggestion["kind"];
        text: string;
        kbHits?: KBResult[];
      }>("suggestion", (event) => {
        liveSessionStore.addSuggestion(event.payload);
      }),

      listen("suggestion-generating", () => {
        liveSessionStore.setSuggestionGenerating(true);
      }),

      listen("suggestion-finished", () => {
        liveSessionStore.setSuggestionGenerating(false);
      }),

      listen<SuggestionCheckEvent>("suggestion-check-started", (event) => {
        liveSessionStore.setSuggestionCheck(event.payload.checkedAt, false);
      }),

      listen<SuggestionCheckEvent>("suggestion-check-finished", (event) => {
        liveSessionStore.setSuggestionCheck(event.payload.checkedAt, event.payload.surfaced);
      }),
    ];

    return () => {
      unlisteners.forEach((listener) => {
        listener.then((dispose) => dispose());
      });
    };
  }, []);
}

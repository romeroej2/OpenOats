import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { KBResult, Suggestion } from "../types";
import { liveSessionStore, useLiveSessionStore } from "../hooks/useLiveSessionStore";
import { SuggestionsView } from "./SuggestionsView";

interface SuggestionsDrawerProps {
  currentSessionId?: string;
  kbConnected: boolean;
  kbFileCount: number;
  suggestionsEnabled: boolean;
  suggestionIntervalSeconds: number;
  onSuggestionsEnabledChange: (enabled: boolean) => void;
  onSuggestionIntervalChange: (seconds: number) => void;
}

export function SuggestionsDrawer({
  currentSessionId,
  kbConnected,
  kbFileCount,
  suggestionsEnabled,
  suggestionIntervalSeconds,
  onSuggestionsEnabledChange,
  onSuggestionIntervalChange,
}: SuggestionsDrawerProps) {
  const suggestions = useLiveSessionStore((state) => state.suggestions);
  const suggestionStatus = useLiveSessionStore((state) => state.suggestionStatus);

  const handleDismiss = useCallback(
    (id: string) => {
      liveSessionStore.dismissSuggestion(id);
      invoke("suggestion_feedback", {
        sessionId: currentSessionId,
        suggestionId: id,
        helpful: false,
      }).catch(console.error);
    },
    [currentSessionId],
  );

  const handleInjectTest = useCallback(
    (suggestion: {
      id: string;
      kind: Suggestion["kind"];
      text: string;
      kbHits: KBResult[];
    }) => {
      liveSessionStore.injectSuggestion(suggestion);
    },
    [],
  );

  return (
    <SuggestionsView
      compact
      suggestions={suggestions}
      isGenerating={suggestionStatus.isGenerating}
      kbConnected={kbConnected}
      kbFileCount={kbFileCount}
      lastCheckedAt={suggestionStatus.lastCheckedAt}
      lastCheckSurfaced={suggestionStatus.lastCheckSurfaced}
      suggestionsEnabled={suggestionsEnabled}
      suggestionIntervalSeconds={suggestionIntervalSeconds}
      onSuggestionsEnabledChange={onSuggestionsEnabledChange}
      onSuggestionIntervalChange={onSuggestionIntervalChange}
      onDismiss={handleDismiss}
      onInjectTest={handleInjectTest}
    />
  );
}

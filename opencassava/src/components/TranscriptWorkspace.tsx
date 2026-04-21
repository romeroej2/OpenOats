import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { useLiveSessionStore } from "../hooks/useLiveSessionStore";
import {
  TRANSCRIPT_FOCUS_SEARCH_EVENT,
  TRANSCRIPT_OPEN_EXPORT_EVENT,
} from "../transcriptCommands";
import { colors, radius, spacing, typography } from "../theme";
import { ExportMenu } from "./ExportMenu";
import { TranscriptSearch } from "./TranscriptSearch";
import { TranscriptView } from "./TranscriptView";

interface TranscriptWorkspaceProps {
  currentSessionId?: string;
}

export function TranscriptWorkspace({ currentSessionId }: TranscriptWorkspaceProps) {
  const utterances = useLiveSessionStore((state) => state.utterances);
  const volatileYouText = useLiveSessionStore((state) => state.volatileYouText);
  const volatileThemText = useLiveSessionStore((state) => state.volatileThemText);
  const [speakerLabels, setSpeakerLabels] = useState<Record<string, string>>({});
  const [showSearch, setShowSearch] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [currentSearchIndex, setCurrentSearchIndex] = useState(0);
  const deferredSearchQuery = useDeferredValue(searchQuery);

  useEffect(() => {
    setSpeakerLabels({});
    setSearchQuery("");
    setCurrentSearchIndex(0);
    setShowSearch(false);
  }, [currentSessionId]);

  const searchResults = useMemo(() => {
    const query = deferredSearchQuery.trim().toLowerCase();
    if (!query) {
      return [];
    }

    const matches: number[] = [];
    utterances.forEach((utterance, index) => {
      if (utterance.text.toLowerCase().includes(query)) {
        matches.push(index);
      }
    });
    return matches;
  }, [deferredSearchQuery, utterances]);

  useEffect(() => {
    setCurrentSearchIndex((current) =>
      searchResults.length === 0 ? 0 : Math.min(current, searchResults.length - 1),
    );
  }, [searchResults.length]);

  useEffect(() => {
    const handleFocusSearch = () => {
      setShowSearch(true);
    };
    const handleOpenExport = () => {
      if (utterances.length > 0) {
        setShowExport(true);
      }
    };

    window.addEventListener(TRANSCRIPT_FOCUS_SEARCH_EVENT, handleFocusSearch);
    window.addEventListener(TRANSCRIPT_OPEN_EXPORT_EVENT, handleOpenExport);
    return () => {
      window.removeEventListener(TRANSCRIPT_FOCUS_SEARCH_EVENT, handleFocusSearch);
      window.removeEventListener(TRANSCRIPT_OPEN_EXPORT_EVENT, handleOpenExport);
    };
  }, [utterances.length]);

  const handleRenameParticipant = useCallback((key: string, newName: string) => {
    setSpeakerLabels((previous) => ({ ...previous, [key]: newName }));
  }, []);

  const handleSearch = useCallback((query: string) => {
    startTransition(() => {
      setSearchQuery(query);
      setCurrentSearchIndex(0);
    });
  }, []);

  const clearSearch = useCallback(() => {
    setShowSearch(false);
    setSearchQuery("");
    setCurrentSearchIndex(0);
  }, []);

  return (
    <>
      <div
        style={{
          padding: `${spacing[3]}px ${spacing[4]}px ${spacing[2]}px`,
          borderBottom: `1px solid ${colors.border}`,
          background:
            "linear-gradient(180deg, rgba(255, 255, 255, 0.94) 0%, rgba(250, 248, 245, 0.94) 100%)",
        }}
      >
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
                ? `${utterances.length} saved lines${
                    currentSessionId ? ` in session ${currentSessionId.slice(0, 8)}` : ""
                  }`
                : "Waiting for the first transcript line"}
            </span>
          </div>

          <div style={{ display: "flex", gap: spacing[2], flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => setShowSearch((current) => !current)}
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

        {showSearch ? (
          <div style={{ marginTop: spacing[2] }}>
            <TranscriptSearch
              compact
              onSearch={handleSearch}
              onClose={clearSearch}
              resultCount={searchResults.length}
              currentIndex={currentSearchIndex}
              onNext={() =>
                setCurrentSearchIndex((index) => Math.min(index + 1, searchResults.length - 1))
              }
              onPrev={() => setCurrentSearchIndex((index) => Math.max(index - 1, 0))}
            />
          </div>
        ) : null}
      </div>

      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <TranscriptView
          utterances={utterances}
          volatileYouText={volatileYouText}
          volatileThemText={volatileThemText}
          searchQuery={deferredSearchQuery}
          searchResults={searchResults}
          currentSearchIndex={currentSearchIndex}
          speakerLabels={speakerLabels}
          onRenameParticipant={handleRenameParticipant}
          layout="companion"
        />
      </div>

      {showExport ? <ExportMenu utterances={utterances} onClose={() => setShowExport(false)} /> : null}
    </>
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

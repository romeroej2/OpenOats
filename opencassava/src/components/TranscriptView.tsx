import { useEffect, useRef, useState } from "react";
import type { Utterance } from "../types";
import { colors, radius, spacing, typography } from "../theme";

interface Props {
  utterances: Utterance[];
  volatileYouText?: string;
  volatileThemText?: string;
  searchQuery?: string;
  searchResults?: number[];
  currentSearchIndex?: number;
  speakerLabels: Record<string, string>;
  onRenameParticipant: (key: string, newName: string) => void;
  layout?: "default" | "companion";
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function groupByTimeBucket(utterances: Utterance[]): { time: string; items: Utterance[] }[] {
  const buckets: { time: string; items: Utterance[] }[] = [];
  let currentBucket: { time: string; items: Utterance[] } | null = null;

  for (const utterance of utterances) {
    const time = formatTimestamp(utterance.timestamp);
    const hour = time.split(":")[0];

    if (!currentBucket || currentBucket.time.split(":")[0] !== hour) {
      currentBucket = { time, items: [] };
      buckets.push(currentBucket);
    }

    currentBucket.items.push(utterance);
  }

  return buckets;
}

function escapeRegExp(string: string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function HighlightText({ text, query, isCurrent }: { text: string; query?: string; isCurrent?: boolean }) {
  if (!query || !query.trim()) {
    return <>{text}</>;
  }

  const parts = text.split(new RegExp(`(${escapeRegExp(query)})`, "gi"));

  return (
    <>
      {parts.map((part, index) => {
        const isMatch = part.toLowerCase() === query.toLowerCase();
        if (!isMatch) return part;

        return (
          <mark
            key={index}
            style={{
              background: isCurrent ? `${colors.accent}40` : "#fef3c7",
              color: colors.text,
              padding: "0 3px",
              borderRadius: 4,
              fontWeight: isCurrent ? 700 : 500,
            }}
          >
            {part}
          </mark>
        );
      })}
    </>
  );
}

function SpeakerPill({
  editing,
  draft,
  inputRef,
  label,
  color,
  onDraftChange,
  onCommit,
  onCancel,
  onStartEdit,
}: {
  editing: boolean;
  draft: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  label: string;
  color: string;
  onDraftChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  onStartEdit: () => void;
}) {
  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        onBlur={onCommit}
        onKeyDown={(event) => {
          if (event.key === "Enter") onCommit();
          if (event.key === "Escape") onCancel();
        }}
        style={{
          minWidth: 96,
          padding: `${spacing[1]}px ${spacing[2]}px`,
          borderRadius: radius.full,
          border: `1px solid ${color}`,
          background: colors.surface,
          color,
          fontSize: typography.xs,
          fontWeight: 800,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={onStartEdit}
      title="Rename speaker"
      style={{
        padding: `${spacing[1]}px ${spacing[2]}px`,
        borderRadius: radius.full,
        border: `1px solid ${color}28`,
        background: `${color}12`,
        color,
        fontSize: typography.xs,
        fontWeight: 800,
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        cursor: "text",
      }}
    >
      {label}
    </button>
  );
}

function UtteranceBubble({
  utterance,
  isHighlighted,
  searchQuery,
  speakerLabels,
  onRenameParticipant,
  layout = "default",
}: {
  utterance: Utterance;
  isHighlighted?: boolean;
  searchQuery?: string;
  speakerLabels: Record<string, string>;
  onRenameParticipant: (key: string, newName: string) => void;
  layout?: "default" | "companion";
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const isYou = utterance.speaker === "you";
  const labelKey = utterance.participantId || utterance.speaker || "them";
  const speakerLabel =
    speakerLabels[labelKey] || utterance.participantLabel || (isYou ? "You" : "Them");
  const accent = isYou ? colors.you : colors.them;

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commitEdit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== speakerLabel) {
      onRenameParticipant(labelKey, trimmed);
    }
    setEditing(false);
  };

  return (
    <div
      style={{
        display: "flex",
        justifyContent: isYou ? "flex-end" : "flex-start",
        marginBottom: spacing[3],
        contentVisibility: "auto",
      }}
    >
      <div
        style={{
          width: layout === "companion" ? "92%" : "88%",
          display: "flex",
          flexDirection: "column",
          alignItems: isYou ? "flex-end" : "flex-start",
          gap: spacing[1],
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: spacing[2],
            flexWrap: "wrap",
            justifyContent: isYou ? "flex-end" : "flex-start",
          }}
        >
          <SpeakerPill
            editing={editing}
            draft={draft}
            inputRef={inputRef}
            label={speakerLabel}
            color={accent}
            onDraftChange={setDraft}
            onCommit={commitEdit}
            onCancel={() => setEditing(false)}
            onStartEdit={() => {
              setDraft(speakerLabel);
              setEditing(true);
            }}
          />
          <span
            style={{
              fontSize: typography.xs,
              color: colors.textMuted,
              fontFamily: "'Cascadia Code', 'SF Mono', Consolas, monospace",
            }}
          >
            {formatTimestamp(utterance.timestamp)}
          </span>
        </div>

        <div
          style={{
            width: "100%",
            padding: `${spacing[3]}px`,
            borderRadius: 20,
            border: `1px solid ${isYou ? `${colors.you}26` : colors.border}`,
            background: isYou ? `${colors.you}12` : colors.surface,
            boxShadow: isHighlighted ? "0 12px 28px rgba(45, 138, 135, 0.12)" : "none",
            outline: isHighlighted ? `2px solid ${colors.accent}22` : "none",
          }}
        >
          <span style={{ fontSize: typography.md, color: colors.text, lineHeight: 1.65 }}>
            <HighlightText text={utterance.text} query={searchQuery} isCurrent={isHighlighted} />
          </span>
        </div>
      </div>
    </div>
  );
}

function VolatileIndicator({
  text,
  speaker,
  layout = "default",
}: {
  text: string;
  speaker: "you" | "them";
  layout?: "default" | "companion";
}) {
  const isYou = speaker === "you";
  const accent = isYou ? colors.you : colors.them;

  return (
    <div
      style={{
        display: "flex",
        justifyContent: isYou ? "flex-end" : "flex-start",
        marginBottom: spacing[3],
      }}
    >
      <div
        style={{
          width: layout === "companion" ? "92%" : "88%",
          padding: `${spacing[2]}px ${spacing[3]}px`,
          borderRadius: 18,
          border: `1px dashed ${accent}44`,
          background: `${accent}08`,
          display: "flex",
          alignItems: "center",
          gap: spacing[2],
          opacity: 0.86,
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: accent,
            animation: "pulse 1s ease-in-out infinite",
            display: "inline-block",
          }}
        />
        <span
          style={{
            fontSize: typography.xs,
            color: accent,
            fontWeight: 800,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
          }}
        >
          {isYou ? "You live" : "Them live"}
        </span>
        <span style={{ fontSize: typography.md, color: colors.textSecondary, lineHeight: 1.6 }}>
          {text}
        </span>
      </div>
    </div>
  );
}

export function TranscriptView({
  utterances,
  volatileYouText,
  volatileThemText,
  searchQuery,
  searchResults = [],
  currentSearchIndex = 0,
  speakerLabels,
  onRenameParticipant,
  layout = "default",
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const highlightedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!searchQuery) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [utterances.length, searchQuery]);

  useEffect(() => {
    if (searchResults.length > 0 && highlightedRef.current) {
      highlightedRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [currentSearchIndex, searchResults]);

  if (utterances.length === 0 && !volatileYouText && !volatileThemText) {
    return (
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: spacing[3],
          padding: spacing[5],
          textAlign: "center",
        }}
      >
        <div
          style={{
            width: 72,
            height: 72,
            borderRadius: 22,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: `linear-gradient(145deg, ${colors.accentMuted} 0%, rgba(45, 138, 135, 0.18) 100%)`,
            color: colors.accent,
            fontSize: typography.lg,
            fontWeight: 800,
            letterSpacing: "0.08em",
          }}
        >
          LIVE
        </div>
        <h4
          style={{
            margin: 0,
            color: colors.text,
            fontSize: typography["2xl"],
            fontWeight: 700,
            maxWidth: 360,
            lineHeight: 1.2,
          }}
        >
          Transcript stays here while everything else slides around it.
        </h4>
        <p
          style={{
            margin: 0,
            maxWidth: 340,
            color: colors.textSecondary,
            fontSize: typography.md,
            lineHeight: 1.6,
          }}
        >
          Start capture and OpenCassava will keep the conversation readable in a compact rail next
          to your meeting app.
        </p>
      </div>
    );
  }

  const grouped = groupByTimeBucket(utterances);
  const bucketOffsets = grouped.reduce<number[]>((offsets, bucket, index) => {
    if (index === 0) {
      offsets.push(0);
      return offsets;
    }

    const previousOffset = offsets[index - 1] ?? 0;
    const previousSize = grouped[index - 1]?.items.length ?? 0;
    offsets.push(previousOffset + previousSize);
    return offsets;
  }, []);

  return (
    <div
      style={{
        flex: 1,
        overflowY: "auto",
        padding: `${spacing[4]}px`,
        background: colors.background,
      }}
    >
      {grouped.map((bucket, bucketIndex) => (
        <div key={bucket.time}>
          {bucketIndex > 0 && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: spacing[2],
                margin: `${spacing[4]}px 0 ${spacing[3]}px`,
              }}
            >
              <div style={{ flex: 1, height: 1, background: colors.border }} />
              <span
                style={{
                  fontSize: typography.xs,
                  color: colors.textMuted,
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                  fontWeight: 700,
                }}
              >
                {bucket.time}
              </span>
              <div style={{ flex: 1, height: 1, background: colors.border }} />
            </div>
          )}

          {bucket.items.map((utterance, itemIndex) => {
            const utteranceIndex = (bucketOffsets[bucketIndex] ?? 0) + itemIndex;
            const isHighlighted = searchResults[currentSearchIndex] === utteranceIndex;
            const ref = isHighlighted ? highlightedRef : undefined;

            return (
              <div key={utterance.id} ref={ref}>
                <UtteranceBubble
                  utterance={utterance}
                  isHighlighted={isHighlighted}
                  searchQuery={searchQuery}
                  speakerLabels={speakerLabels}
                  onRenameParticipant={onRenameParticipant}
                  layout={layout}
                />
              </div>
            );
          })}
        </div>
      ))}

      {volatileYouText ? <VolatileIndicator text={volatileYouText} speaker="you" layout={layout} /> : null}
      {volatileThemText ? <VolatileIndicator text={volatileThemText} speaker="them" layout={layout} /> : null}

      <div ref={bottomRef} />

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.45; transform: scale(0.82); }
        }
      `}</style>
    </div>
  );
}

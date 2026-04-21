import { memo, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { KBResult, Suggestion } from "../types";
import { colors, radius, spacing, typography } from "../theme";
import { SuggestionControls } from "./SuggestionControls";

interface Props {
  suggestions: Suggestion[];
  isGenerating?: boolean;
  kbConnected?: boolean;
  kbFileCount?: number;
  lastCheckedAt?: string | null;
  lastCheckSurfaced?: boolean | null;
  suggestionsEnabled?: boolean;
  suggestionIntervalSeconds?: number;
  onSuggestionsEnabledChange?: (enabled: boolean) => void;
  onSuggestionIntervalChange?: (seconds: number) => void;
  onDismiss?: (id: string) => void;
  onInjectTest?: (suggestion: {
    id: string;
    kind: Suggestion["kind"];
    text: string;
    kbHits: KBResult[];
  }) => void;
  compact?: boolean;
}

interface ParsedBullet {
  id: string;
  headline: string;
  detail?: string;
}

function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "Waiting for first analysis";

  const deltaSeconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (deltaSeconds < 5) return "Just now";
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`;

  const minutes = Math.floor(deltaSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function parseBullets(text: string): ParsedBullet[] {
  const lines = text.split("\n");
  const bullets: ParsedBullet[] = [];
  let currentHeadline: string | null = null;
  let currentDetail: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("\u2022") || trimmed.startsWith("-") || trimmed.startsWith("*")) {
      if (currentHeadline) {
        bullets.push({
          id: `bullet-${bullets.length}`,
          headline: currentHeadline,
          detail: currentDetail || undefined,
        });
      }
      currentHeadline = trimmed.slice(1).trim();
      currentDetail = null;
    } else if (trimmed.startsWith(">")) {
      const detail = trimmed.slice(1).trim();
      if (detail) {
        currentDetail = currentDetail ? `${currentDetail} ${detail}` : detail;
      }
    } else if (trimmed && trimmed !== "-" && currentHeadline) {
      currentDetail = currentDetail ? `${currentDetail} ${trimmed}` : trimmed;
    }
  }

  if (currentHeadline) {
    bullets.push({
      id: `bullet-${bullets.length}`,
      headline: currentHeadline,
      detail: currentDetail || undefined,
    });
  }

  return bullets;
}

function EmptyState({
  kbConnected,
  kbFileCount,
  lastCheckedAt,
  lastCheckSurfaced,
}: {
  kbConnected: boolean;
  kbFileCount: number;
  lastCheckedAt?: string | null;
  lastCheckSurfaced?: boolean | null;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: spacing[3],
        padding: `${spacing[4]}px`,
      }}
    >
      <div
        style={{
          padding: `${spacing[3]}px`,
          borderRadius: 22,
          border: `1px solid ${kbConnected ? `${colors.success}22` : colors.border}`,
          background: kbConnected ? `${colors.success}10` : colors.surface,
        }}
      >
        <div
          style={{
            fontSize: typography.xs,
            color: kbConnected ? colors.success : colors.textMuted,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            fontWeight: 700,
          }}
        >
          {kbConnected ? "Ready for context" : "Needs a knowledge source"}
        </div>
        <div
          style={{
            marginTop: spacing[2],
            fontSize: typography.lg,
            color: colors.text,
            fontWeight: 700,
            lineHeight: 1.25,
          }}
        >
          {kbConnected
            ? "Suggestions will appear when the conversation lines up with your knowledge base."
            : "Connect an Obsidian vault or knowledge folder to enable live talking points."}
        </div>
        <div
          style={{
            marginTop: spacing[2],
            fontSize: typography.sm,
            color: colors.textSecondary,
            lineHeight: 1.6,
          }}
        >
          {kbConnected
            ? `${kbFileCount > 0 ? `${kbFileCount} indexed sources available.` : "Knowledge source connected."} Last analysis ${formatRelativeTime(lastCheckedAt)}${lastCheckSurfaced ? " and it surfaced a suggestion." : "."}`
            : "Transcription and notes still work without it."}
        </div>
      </div>
    </div>
  );
}

function BulletRow({ bullet }: { bullet: ParsedBullet }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = !!bullet.detail;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: spacing[1] }}>
      <button
        type="button"
        onClick={() => hasDetail && setExpanded((current) => !current)}
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: spacing[2],
          padding: 0,
          background: "transparent",
          border: "none",
          color: colors.text,
          cursor: hasDetail ? "pointer" : "default",
          textAlign: "left",
        }}
      >
        <span
          style={{
            width: 20,
            height: 20,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: radius.full,
            background: colors.surfaceElevated,
            color: colors.textMuted,
            fontSize: typography.xs,
            fontWeight: 800,
            flexShrink: 0,
            marginTop: 1,
          }}
        >
          {hasDetail ? (expanded ? "-" : "+") : "."}
        </span>
        <span style={{ fontSize: typography.md, lineHeight: 1.5, fontWeight: 600 }}>
          {bullet.headline}
        </span>
      </button>

      {expanded && bullet.detail ? (
        <div
          style={{
            marginLeft: 28,
            fontSize: typography.sm,
            color: colors.textSecondary,
            lineHeight: 1.6,
          }}
        >
          {bullet.detail}
        </div>
      ) : null}
    </div>
  );
}

const SuggestionCard = memo(function SuggestionCard({
  suggestion,
  isPrimary,
  onDismiss,
}: {
  suggestion: Suggestion;
  isPrimary: boolean;
  onDismiss: () => void;
}) {
  const bullets = useMemo(() => parseBullets(suggestion.text), [suggestion.text]);
  const isSmartQuestion = suggestion.kind === "smart_question";

  return (
    <article
      style={{
        padding: `${spacing[3]}px`,
        borderRadius: 22,
        border: `1px solid ${
          isSmartQuestion
            ? `${colors.them}28`
            : isPrimary
              ? `${colors.accent}28`
              : colors.border
        }`,
        background: isSmartQuestion
          ? `${colors.them}10`
          : isPrimary
            ? `${colors.accent}10`
            : colors.surface,
        display: "flex",
        flexDirection: "column",
        gap: spacing[3],
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: spacing[2] }}>
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            padding: `${spacing[1]}px ${spacing[2]}px`,
            borderRadius: radius.full,
            background: isSmartQuestion ? `${colors.them}15` : `${colors.accent}12`,
            color: isSmartQuestion ? colors.them : colors.accent,
            fontSize: typography.xs,
            fontWeight: 800,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          {isSmartQuestion ? "Smart question" : "Talking point"}
        </div>

        <button type="button" onClick={onDismiss} style={dismissButtonStyle}>
          Dismiss
        </button>
      </div>

        <div style={{ display: "flex", flexDirection: "column", gap: spacing[2] }}>
          {bullets.length > 0 ? (
            bullets.map((bullet) => (
              <BulletRow key={`${suggestion.id}-${bullet.id}`} bullet={bullet} />
            ))
          ) : (
          <div
            style={{
              fontSize: typography.md,
              color: colors.text,
              lineHeight: 1.6,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {suggestion.text}
          </div>
        )}
      </div>

      {suggestion.kbHits && suggestion.kbHits.length > 0 ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: spacing[1],
            paddingTop: spacing[2],
            borderTop: `1px solid ${colors.border}`,
          }}
        >
          <span
            style={{
              fontSize: typography.xs,
              color: colors.textMuted,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            Sources
          </span>
          <span style={{ fontSize: typography.sm, color: colors.textSecondary, lineHeight: 1.5 }}>
            {suggestion.kbHits
              .slice(0, 3)
              .map((hit) =>
                hit.headerContext ? `${hit.sourceFile}#${hit.headerContext}` : hit.sourceFile,
              )
              .join(" . ")}
            {suggestion.kbHits.length > 3 ? ` +${suggestion.kbHits.length - 3} more` : ""}
          </span>
        </div>
      ) : null}
    </article>
  );
});

export function SuggestionsView({
  suggestions,
  isGenerating = false,
  kbConnected = false,
  kbFileCount = 0,
  lastCheckedAt = null,
  lastCheckSurfaced = null,
  suggestionsEnabled = true,
  suggestionIntervalSeconds = 30,
  onSuggestionsEnabledChange,
  onSuggestionIntervalChange,
  onDismiss,
  onInjectTest,
  compact = false,
}: Props) {
  const handleInjectTest = async () => {
    const fake: { id: string; kind: Suggestion["kind"]; text: string; kbHits: KBResult[] } = {
      id: crypto.randomUUID(),
      kind: "smart_question",
      text:
        "- Have you covered the decision timeline?\n> Knowing urgency helps you steer the next question.",
      kbHits: [],
    };
    onInjectTest?.(fake);
    await invoke("show_overlay_preview", { id: fake.id, text: fake.text }).catch(() => {});
  };

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        background: colors.background,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: spacing[3], padding: spacing[3] }}>
        {onSuggestionsEnabledChange && onSuggestionIntervalChange ? (
          <SuggestionControls
            suggestionsEnabled={suggestionsEnabled}
            suggestionIntervalSeconds={suggestionIntervalSeconds}
            onSuggestionsEnabledChange={onSuggestionsEnabledChange}
            onSuggestionIntervalChange={onSuggestionIntervalChange}
            compact={compact}
          />
        ) : null}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: spacing[2],
            flexWrap: "wrap",
            padding: `${spacing[2]}px ${spacing[3]}px`,
            borderRadius: 18,
            border: `1px solid ${colors.border}`,
            background: colors.surface,
            fontSize: typography.sm,
            color: colors.textSecondary,
          }}
        >
          <span>
            {isGenerating
              ? "Evaluating live conversation..."
              : `Last analysis ${formatRelativeTime(lastCheckedAt)}${lastCheckSurfaced ? " and it surfaced a suggestion." : "."}`}
          </span>
          <button type="button" onClick={() => void handleInjectTest()} style={dismissButtonStyle}>
            Test overlay
          </button>
        </div>

        {isGenerating ? (
          <div
            style={{
              padding: `${spacing[3]}px`,
              borderRadius: 20,
              border: `1px solid ${colors.accent}22`,
              background: `${colors.accent}10`,
              color: colors.accent,
              fontSize: typography.md,
              fontWeight: 700,
            }}
          >
            Evaluating conversation...
          </div>
        ) : null}

        {suggestions.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: spacing[3] }}>
            {suggestions.map((suggestion, index) => (
              <SuggestionCard
                key={suggestion.id}
                suggestion={suggestion}
                isPrimary={index === 0}
                onDismiss={() => onDismiss?.(suggestion.id)}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            kbConnected={kbConnected}
            kbFileCount={kbFileCount}
            lastCheckedAt={lastCheckedAt}
            lastCheckSurfaced={lastCheckSurfaced}
          />
        )}
      </div>
    </div>
  );
}

const dismissButtonStyle: React.CSSProperties = {
  padding: `${spacing[1]}px ${spacing[2]}px`,
  borderRadius: radius.full,
  border: `1px solid ${colors.border}`,
  background: colors.surface,
  color: colors.textMuted,
  cursor: "pointer",
  fontSize: typography.xs,
  fontWeight: 700,
};

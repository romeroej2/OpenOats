import { colors, spacing, typography } from "../theme";

interface Props {
  suggestionsEnabled: boolean;
  suggestionIntervalSeconds: number;
  onSuggestionsEnabledChange: (enabled: boolean) => void;
  onSuggestionIntervalChange: (seconds: number) => void;
  compact?: boolean;
}

const CADENCE_OPTIONS = [
  { value: 30, label: "30s" },
  { value: 45, label: "45s" },
  { value: 60, label: "1m" },
  { value: 90, label: "90s" },
  { value: 120, label: "2m" },
  { value: 180, label: "3m" },
];

export function SuggestionControls({
  suggestionsEnabled,
  suggestionIntervalSeconds,
  onSuggestionsEnabledChange,
  onSuggestionIntervalChange,
  compact = false,
}: Props) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: compact ? "center" : "flex-start",
        justifyContent: "space-between",
        gap: spacing[3],
        flexWrap: "wrap",
        padding: compact ? `${spacing[2]}px ${spacing[3]}px` : spacing[3],
        background: compact ? colors.surface : colors.surfaceElevated,
        border: `1px solid ${colors.border}`,
        borderRadius: compact ? 999 : 12,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: spacing[1] }}>
        <span
          style={{
            fontSize: compact ? typography.sm : typography.md,
            fontWeight: 600,
            color: colors.text,
          }}
        >
          Suggestions
        </span>
        {!compact && (
          <span style={{ fontSize: typography.sm, color: colors.textSecondary, lineHeight: 1.5 }}>
            Turn live suggestions on or off and adjust how often OpenCassava checks the conversation.
          </span>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: spacing[2], flexWrap: "wrap" }}>
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: spacing[2],
            fontSize: typography.sm,
            color: colors.text,
            fontWeight: 500,
          }}
        >
          <input
            type="checkbox"
            checked={suggestionsEnabled}
            onChange={(e) => onSuggestionsEnabledChange(e.target.checked)}
          />
          Enabled
        </label>

        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: spacing[2],
            fontSize: typography.sm,
            color: suggestionsEnabled ? colors.text : colors.textMuted,
          }}
        >
          <span>Every</span>
          <select
            value={String(suggestionIntervalSeconds)}
            onChange={(e) => onSuggestionIntervalChange(Math.max(30, Number(e.target.value) || 30))}
            disabled={!suggestionsEnabled}
            style={{
              padding: `${spacing[1]}px ${spacing[2]}px`,
              background: colors.background,
              color: suggestionsEnabled ? colors.text : colors.textMuted,
              border: `1px solid ${colors.border}`,
              borderRadius: 6,
              cursor: suggestionsEnabled ? "pointer" : "not-allowed",
            }}
          >
            {CADENCE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

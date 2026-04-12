import { useEffect, useRef, useState } from "react";
import { colors, radius, spacing, typography } from "../theme";

interface Props {
  onSearch: (query: string) => void;
  onClose: () => void;
  resultCount?: number;
  currentIndex?: number;
  onNext?: () => void;
  onPrev?: () => void;
  compact?: boolean;
}

export function TranscriptSearch({
  onSearch,
  onClose,
  resultCount = 0,
  currentIndex = 0,
  onNext,
  onPrev,
  compact = false,
}: Props) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(event.target.value);
    onSearch(event.target.value);
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: spacing[2],
        padding: compact ? `${spacing[2]}px` : `${spacing[2]}px ${spacing[3]}px`,
        background: compact ? colors.background : colors.surface,
        border: compact ? `1px solid ${colors.border}` : "none",
        borderBottom: compact ? undefined : `1px solid ${colors.border}`,
        borderRadius: compact ? 16 : 0,
      }}
    >
      <span
        style={{
          width: 24,
          height: 24,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: radius.full,
          background: colors.surface,
          color: colors.textMuted,
          fontSize: typography.xs,
          fontWeight: 800,
          flexShrink: 0,
        }}
      >
        Q
      </span>

      <input
        ref={inputRef}
        type="text"
        placeholder="Search transcript"
        value={query}
        onChange={handleChange}
        style={{
          flex: 1,
          minWidth: 0,
          padding: `${spacing[1]}px`,
          background: "transparent",
          border: "none",
          fontSize: typography.md,
          color: colors.text,
          outline: "none",
        }}
      />

      {query ? (
        <div style={{ display: "flex", alignItems: "center", gap: spacing[2], flexWrap: "wrap" }}>
          {resultCount > 0 ? (
            <span style={{ fontSize: typography.sm, color: colors.textSecondary }}>
              {currentIndex + 1} / {resultCount}
            </span>
          ) : (
            <span style={{ fontSize: typography.sm, color: colors.textMuted }}>No results</span>
          )}

          {resultCount > 1 ? (
            <div style={{ display: "flex", gap: spacing[1] }}>
              <button onClick={onPrev} disabled={currentIndex === 0} style={navButtonStyle}>
                Up
              </button>
              <button
                onClick={onNext}
                disabled={currentIndex >= resultCount - 1}
                style={navButtonStyle}
              >
                Down
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      <button
        type="button"
        onClick={onClose}
        style={{
          width: 28,
          height: 28,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: radius.full,
          border: `1px solid ${colors.border}`,
          background: colors.surface,
          color: colors.textMuted,
          cursor: "pointer",
          fontSize: typography.sm,
          fontWeight: 700,
          padding: 0,
          flexShrink: 0,
        }}
      >
        x
      </button>
    </div>
  );
}

const navButtonStyle: React.CSSProperties = {
  padding: `3px ${spacing[2]}px`,
  background: colors.surface,
  border: `1px solid ${colors.border}`,
  borderRadius: 8,
  fontSize: typography.sm,
  color: colors.text,
  cursor: "pointer",
};

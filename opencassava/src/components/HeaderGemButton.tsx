import { GemBadge } from "gem-badges";
import { colors, radius, spacing, typography } from "../theme";

interface Props {
  isActive: boolean;
  onClick: () => void;
}

export function HeaderGemButton({ isActive, onClick }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="About OpenCassava"
      aria-label="Open About page"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: spacing[2],
        padding: `${spacing[1]}px ${spacing[3]}px ${spacing[1]}px ${spacing[2]}px`,
        background: isActive
          ? `linear-gradient(135deg, ${colors.surface} 0%, ${colors.accentMuted} 100%)`
          : colors.background,
        border: `1px solid ${isActive ? `${colors.accent}55` : colors.border}`,
        borderRadius: radius.full,
        color: colors.text,
        cursor: "pointer",
        fontSize: typography.md,
        fontWeight: 700,
        boxShadow: isActive ? "0 8px 22px rgba(45, 138, 135, 0.18)" : "none",
      }}
    >
      <GemBadge
        config={{
          material: "diamond",
          cut: "round",
          size: 28,
          rotation: 0,
          glow: true,
          glowIntensity: 0.9,
          renderMode: "auto",
        }}
        aria-hidden="true"
      />
      <span>About</span>
    </button>
  );
}

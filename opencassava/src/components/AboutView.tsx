import { GemBadge } from "gem-badges";
import { colors, radius, shadows, spacing, typography } from "../theme";

interface Props {
  version: string | null;
  releaseLabel: string;
  repositoryUrl: string;
  onBack: () => void;
  onOpenRelease: () => void;
  onOpenRepository: () => void;
}

export function AboutView({
  version,
  releaseLabel,
  repositoryUrl,
  onBack,
  onOpenRelease,
  onOpenRepository,
}: Props) {
  const cardStyle: React.CSSProperties = {
    background: colors.surface,
    border: `1px solid ${colors.border}`,
    borderRadius: radius.xl,
    boxShadow: shadows.md,
    padding: spacing[5],
    display: "flex",
    flexDirection: "column",
    gap: spacing[3],
  };

  const secondaryButtonStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing[2],
    padding: `${spacing[2]}px ${spacing[3]}px`,
    background: colors.surface,
    color: colors.text,
    border: `1px solid ${colors.border}`,
    borderRadius: radius.full,
    cursor: "pointer",
    fontSize: typography.md,
    fontWeight: 700,
  };

  const primaryButtonStyle: React.CSSProperties = {
    ...secondaryButtonStyle,
    background: colors.accent,
    color: colors.textInverse,
    border: `1px solid ${colors.accent}`,
  };

  return (
    <div
      style={{
        flex: 1,
        overflowY: "auto",
        padding: `${spacing[6]}px ${spacing[4]}px ${spacing[8]}px`,
        background: `radial-gradient(circle at top left, ${colors.accentMuted} 0%, ${colors.background} 44%)`,
      }}
    >
      <div
        style={{
          maxWidth: 980,
          margin: "0 auto",
          display: "flex",
          flexDirection: "column",
          gap: spacing[4],
        }}
      >
        <section
          style={{
            ...cardStyle,
            padding: spacing[6],
            background: `linear-gradient(145deg, ${colors.surface} 0%, #fffdf9 100%)`,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: spacing[5], flexWrap: "wrap" }}>
            <div
              style={{
                minWidth: 164,
                minHeight: 164,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 28,
                background: "rgba(255,255,255,0.72)",
                border: `1px solid ${colors.border}`,
                boxShadow: "0 12px 36px rgba(45, 138, 135, 0.12)",
              }}
            >
              <GemBadge
                config={{
                  material: "diamond",
                  cut: "round",
                  size: 120,
                  rotation: 0,
                  glow: true,
                  glowIntensity: 1.35,
                  animate: true,
                  renderMode: "auto",
                }}
                aria-hidden="true"
              />
            </div>

            <div style={{ flex: "1 1 420px", display: "flex", flexDirection: "column", gap: spacing[3] }}>
              <div style={{ display: "flex", flexDirection: "column", gap: spacing[2] }}>
                <span
                  style={{
                    display: "inline-flex",
                    width: "fit-content",
                    padding: `${spacing[1]}px ${spacing[2]}px`,
                    background: `${colors.accent}12`,
                    color: colors.accent,
                    borderRadius: radius.full,
                    fontSize: typography.sm,
                    fontWeight: 800,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                  }}
                >
                  About OpenCassava
                </span>
                <h1 style={{ margin: 0, fontSize: 34, lineHeight: 1.05, color: colors.text }}>
                  Meeting intelligence with a little jewelry.
                </h1>
                <p style={{ margin: 0, fontSize: typography.lg, lineHeight: 1.7, color: colors.textSecondary }}>
                  OpenCassava is a local-first desktop meeting assistant for live transcription,
                  knowledge-base recall, and structured note generation.
                </p>
              </div>

              <div style={{ display: "flex", gap: spacing[2], flexWrap: "wrap" }}>
                <button type="button" onClick={onOpenRepository} style={primaryButtonStyle}>
                  Open Repository
                </button>
                <button type="button" onClick={onOpenRelease} style={secondaryButtonStyle}>
                  Latest Release
                </button>
                <button type="button" onClick={onBack} style={secondaryButtonStyle}>
                  Back to Transcript
                </button>
              </div>
            </div>
          </div>
        </section>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: spacing[4],
          }}
        >
          <section style={cardStyle}>
            <h2 style={{ margin: 0, fontSize: 20, color: colors.text }}>Purpose</h2>
            <p style={{ margin: 0, lineHeight: 1.7, color: colors.textSecondary }}>
              Capture meetings in real time, surface relevant context from your personal knowledge
              base, and turn the conversation into usable notes without leaving the desktop app.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: spacing[2] }}>
              <div
                style={{
                  padding: `${spacing[2]}px ${spacing[3]}px`,
                  background: colors.surfaceElevated,
                  borderRadius: radius.lg,
                  color: colors.text,
                  fontWeight: 600,
                }}
              >
                Live transcription from multiple STT providers
              </div>
              <div
                style={{
                  padding: `${spacing[2]}px ${spacing[3]}px`,
                  background: colors.surfaceElevated,
                  borderRadius: radius.lg,
                  color: colors.text,
                  fontWeight: 600,
                }}
              >
                Local-first retrieval from Obsidian or folder-based knowledge bases
              </div>
              <div
                style={{
                  padding: `${spacing[2]}px ${spacing[3]}px`,
                  background: colors.surfaceElevated,
                  borderRadius: radius.lg,
                  color: colors.text,
                  fontWeight: 600,
                }}
              >
                Structured notes and suggested talking points while the meeting is still happening
              </div>
            </div>
          </section>

          <section style={cardStyle}>
            <h2 style={{ margin: 0, fontSize: 20, color: colors.text }}>Build Info</h2>
            <div style={{ display: "flex", flexDirection: "column", gap: spacing[3] }}>
              <div
                style={{
                  padding: `${spacing[3]}px ${spacing[4]}px`,
                  background: colors.surfaceElevated,
                  borderRadius: radius.lg,
                }}
              >
                <div style={{ fontSize: typography.sm, color: colors.textMuted, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                  Version
                </div>
                <div style={{ marginTop: spacing[1], fontSize: 28, color: colors.text, fontWeight: 800 }}>
                  {version ? `v${version}` : "Checking..."}
                </div>
              </div>

              <div
                style={{
                  padding: `${spacing[3]}px ${spacing[4]}px`,
                  background: colors.surfaceElevated,
                  borderRadius: radius.lg,
                }}
              >
                <div style={{ fontSize: typography.sm, color: colors.textMuted, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                  Release Status
                </div>
                <div style={{ marginTop: spacing[1], fontSize: typography.lg, color: colors.text, fontWeight: 700 }}>
                  {releaseLabel}
                </div>
              </div>

              <div
                style={{
                  padding: `${spacing[3]}px ${spacing[4]}px`,
                  background: colors.surfaceElevated,
                  borderRadius: radius.lg,
                }}
              >
                <div style={{ fontSize: typography.sm, color: colors.textMuted, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                  Repository
                </div>
                <button
                  type="button"
                  onClick={onOpenRepository}
                  style={{
                    marginTop: spacing[1],
                    padding: 0,
                    border: "none",
                    background: "transparent",
                    color: colors.accent,
                    fontSize: typography.lg,
                    fontWeight: 700,
                    cursor: "pointer",
                    textAlign: "left",
                    fontFamily: "SF Mono, Monaco, monospace",
                  }}
                >
                  {repositoryUrl}
                </button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

import type { ReactNode } from "react";
import { GemBadge } from "gem-badges";
import { colors, radius, spacing, typography } from "../theme";

export type DrawerKey = "suggestions" | "notes" | "history" | "settings" | "about";

interface RailItem {
  key: DrawerKey | "transcript";
  label: string;
  shortLabel: string;
  icon?: "diamond";
  badge?: number;
  title?: string;
}

interface RailStatus {
  label: string;
  tone?: "neutral" | "accent" | "success" | "warning" | "danger";
  title?: string;
}

interface CompanionShellProps {
  activeDrawer: DrawerKey | null;
  drawerTitle: string;
  drawerSubtitle?: string;
  railItems: RailItem[];
  railStatuses: RailStatus[];
  onSelectRailItem: (key: RailItem["key"]) => void;
  onCloseDrawer: () => void;
  captureCapsule: ReactNode;
  statusBanner?: ReactNode;
  transcriptUtilities?: ReactNode;
  transcriptContent: ReactNode;
  drawerContent: ReactNode;
  modal?: ReactNode;
}

const RAIL_WIDTH = 92;

function toneStyles(tone: RailStatus["tone"]) {
  switch (tone) {
    case "accent":
      return { background: `${colors.accent}14`, color: colors.accent, border: `${colors.accent}28` };
    case "success":
      return { background: `${colors.success}14`, color: colors.success, border: `${colors.success}28` };
    case "warning":
      return { background: `${colors.warning}16`, color: colors.warning, border: `${colors.warning}30` };
    case "danger":
      return { background: `${colors.error}14`, color: colors.error, border: `${colors.error}28` };
    default:
      return { background: colors.surface, color: colors.textSecondary, border: colors.border };
  }
}

export function CompanionShell({
  activeDrawer,
  drawerTitle,
  drawerSubtitle,
  railItems,
  railStatuses,
  onSelectRailItem,
  onCloseDrawer,
  captureCapsule,
  statusBanner,
  transcriptUtilities,
  transcriptContent,
  drawerContent,
  modal,
}: CompanionShellProps) {
  const drawerOpen = activeDrawer !== null;

  return (
    <div
      style={{
        position: "relative",
        height: "100vh",
        display: "flex",
        overflow: "hidden",
        background:
          `radial-gradient(circle at top left, ${colors.accentMuted} 0%, ${colors.background} 42%), ` +
          `linear-gradient(180deg, #fffdf9 0%, ${colors.background} 100%)`,
        color: colors.text,
        fontFamily:
          "'Segoe UI Variable Display', 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif",
      }}
    >
      <aside
        style={{
          width: RAIL_WIDTH,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          gap: spacing[3],
          padding: `${spacing[3]}px ${spacing[2]}px`,
          background: "rgba(255, 255, 255, 0.76)",
          borderRight: `1px solid ${colors.border}`,
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          zIndex: 2,
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: spacing[2],
            paddingBottom: spacing[2],
          }}
        >
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: 18,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: `linear-gradient(145deg, ${colors.accent} 0%, ${colors.accentLight} 100%)`,
              color: colors.textInverse,
              fontWeight: 800,
              fontSize: typography.lg,
              letterSpacing: "0.08em",
              boxShadow: "0 12px 30px rgba(45, 138, 135, 0.22)",
            }}
          >
            OC
          </div>
          <div
            style={{
              textAlign: "center",
              fontSize: typography.xs,
              color: colors.textMuted,
              lineHeight: 1.4,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
            }}
          >
            Companion
            <br />
            Rail
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: spacing[2], flex: 1 }}>
          {railItems.map((item) => {
            const isActive =
              item.key === "transcript" ? activeDrawer === null : activeDrawer === item.key;

            return (
              <button
                key={item.key}
                type="button"
                onClick={() => onSelectRailItem(item.key)}
                title={item.title || item.label}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: spacing[1],
                  padding: `${spacing[2]}px ${spacing[1]}px`,
                  background: isActive
                    ? `linear-gradient(180deg, ${colors.surface} 0%, rgba(255, 255, 255, 0.72) 100%)`
                    : "transparent",
                  color: isActive ? colors.accent : colors.textSecondary,
                  border: `1px solid ${isActive ? `${colors.accent}2c` : "transparent"}`,
                  borderRadius: radius.xl,
                  cursor: "pointer",
                  boxShadow: isActive ? "0 10px 20px rgba(45, 138, 135, 0.12)" : "none",
                }}
              >
                <span
                  style={{
                    minWidth: 36,
                    height: 36,
                    padding: `0 ${spacing[2]}px`,
                    borderRadius: radius.full,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: isActive ? `${colors.accent}14` : colors.surfaceElevated,
                    color: isActive ? colors.accent : colors.textSecondary,
                    fontSize: typography.sm,
                    fontWeight: 800,
                    letterSpacing: "0.04em",
                    position: "relative",
                  }}
                >
                  {item.icon === "diamond" ? (
                    <GemBadge
                      config={{
                        material: "diamond",
                        cut: "round",
                        size: 24,
                        rotation: 0,
                        glow: isActive,
                        glowIntensity: isActive ? 0.85 : 0.35,
                        renderMode: "auto",
                      }}
                      aria-hidden="true"
                    />
                  ) : (
                    item.shortLabel
                  )}
                  {item.badge !== undefined && item.badge > 0 && (
                    <span
                      style={{
                        position: "absolute",
                        top: -5,
                        right: -5,
                        minWidth: 16,
                        height: 16,
                        padding: "0 4px",
                        borderRadius: radius.full,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        background: colors.accent,
                        color: colors.textInverse,
                        fontSize: 9,
                        fontWeight: 700,
                        boxShadow: "0 4px 12px rgba(45, 138, 135, 0.24)",
                      }}
                    >
                      {item.badge > 9 ? "9+" : item.badge}
                    </span>
                  )}
                </span>
                <span
                  style={{
                    fontSize: typography.xs,
                    lineHeight: 1.2,
                    textAlign: "center",
                    fontWeight: isActive ? 700 : 600,
                  }}
                >
                  {item.label}
                </span>
              </button>
            );
          })}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: spacing[2] }}>
          {railStatuses.map((status) => {
            const tone = toneStyles(status.tone);

            return (
              <div
                key={status.label}
                title={status.title}
                style={{
                  padding: `${spacing[2]}px`,
                  borderRadius: radius.lg,
                  border: `1px solid ${tone.border}`,
                  background: tone.background,
                  color: tone.color,
                  fontSize: typography.xs,
                  fontWeight: 700,
                  lineHeight: 1.2,
                  textAlign: "center",
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                }}
              >
                {status.label}
              </div>
            );
          })}
        </div>
      </aside>

      <main
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          gap: spacing[3],
          padding: `${spacing[3]}px`,
          position: "relative",
          zIndex: 1,
        }}
      >
        {captureCapsule}
        {statusBanner}

        <section
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            borderRadius: 28,
            border: `1px solid ${colors.border}`,
            background: "rgba(255, 255, 255, 0.9)",
            boxShadow: "0 18px 48px rgba(26, 24, 22, 0.08)",
            overflow: "hidden",
            backdropFilter: "blur(18px)",
            WebkitBackdropFilter: "blur(18px)",
          }}
        >
          {transcriptUtilities && (
            <div
              style={{
                padding: `${spacing[3]}px ${spacing[4]}px ${spacing[2]}px`,
                borderBottom: `1px solid ${colors.border}`,
                background:
                  `linear-gradient(180deg, rgba(255, 255, 255, 0.94) 0%, rgba(250, 248, 245, 0.94) 100%)`,
              }}
            >
              {transcriptUtilities}
            </div>
          )}

          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            {transcriptContent}
          </div>
        </section>
      </main>

      <div
        style={{
          position: "absolute",
          inset: 0,
          left: RAIL_WIDTH,
          pointerEvents: drawerOpen ? "auto" : "none",
          zIndex: 3,
        }}
      >
        <div
          onClick={onCloseDrawer}
          style={{
            position: "absolute",
            inset: 0,
            background: drawerOpen ? "rgba(17, 19, 19, 0.14)" : "rgba(17, 19, 19, 0)",
            transition: "background 0.24s ease",
          }}
        />

        <section
          style={{
            position: "absolute",
            top: spacing[3],
            right: spacing[3],
            bottom: spacing[3],
            width: "min(440px, calc(100vw - 24px))",
            maxWidth: "100%",
            display: "flex",
            flexDirection: "column",
            borderRadius: 28,
            border: `1px solid ${colors.border}`,
            background: "rgba(255, 255, 255, 0.96)",
            boxShadow: "0 28px 60px rgba(26, 24, 22, 0.16)",
            overflow: "hidden",
            transform: drawerOpen ? "translateX(0)" : "translateX(calc(100% + 20px))",
            transition: "transform 0.28s ease",
            backdropFilter: "blur(22px)",
            WebkitBackdropFilter: "blur(22px)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: spacing[3],
              padding: `${spacing[3]}px ${spacing[4]}px`,
              borderBottom: `1px solid ${colors.border}`,
              background:
                `linear-gradient(180deg, rgba(255, 255, 255, 0.98) 0%, rgba(245, 243, 240, 0.88) 100%)`,
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: spacing[1] }}>
              <span
                style={{
                  fontSize: typography.xs,
                  color: colors.textMuted,
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                  fontWeight: 700,
                }}
              >
                Workspace
              </span>
              <div style={{ fontSize: typography["2xl"], color: colors.text, fontWeight: 700 }}>
                {drawerTitle}
              </div>
              {drawerSubtitle ? (
                <p style={{ margin: 0, color: colors.textSecondary, fontSize: typography.sm, lineHeight: 1.5 }}>
                  {drawerSubtitle}
                </p>
              ) : null}
            </div>

            <button
              type="button"
              onClick={onCloseDrawer}
              aria-label="Close drawer"
              style={{
                width: 34,
                height: 34,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: radius.full,
                border: `1px solid ${colors.border}`,
                background: colors.surface,
                color: colors.textSecondary,
                cursor: "pointer",
                fontSize: 18,
                flexShrink: 0,
              }}
            >
              x
            </button>
          </div>

          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            {drawerContent}
          </div>
        </section>
      </div>

      {modal}
    </div>
  );
}

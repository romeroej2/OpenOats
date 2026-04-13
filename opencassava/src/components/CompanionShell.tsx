import type { ReactNode } from "react";
import { GemBadge } from "gem-badges";
import { colors, radius, spacing, typography } from "../theme";

export type DrawerKey = "suggestions" | "notes" | "history" | "settings" | "about";
type NavIcon = "transcript" | "ideas" | "notes" | "history" | "settings" | "diamond";

interface NavItem {
  key: DrawerKey | "transcript";
  label: string;
  shortLabel: string;
  icon?: NavIcon;
  badge?: number;
  title?: string;
}

interface CompanionShellProps {
  activeDrawer: DrawerKey | null;
  drawerTitle: string;
  drawerSubtitle?: string;
  navItems: NavItem[];
  onSelectNavItem: (key: NavItem["key"]) => void;
  onCloseDrawer: () => void;
  captureCapsule: ReactNode;
  statusBanner?: ReactNode;
  transcriptUtilities?: ReactNode;
  transcriptContent: ReactNode;
  drawerContent: ReactNode;
  modal?: ReactNode;
}

function renderNavGlyph(icon: NavIcon | undefined, isActive: boolean, fallback: string) {
  const stroke = isActive ? colors.accent : colors.textSecondary;

  switch (icon) {
    case "transcript":
      return (
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="none">
          <rect x="3" y="4" width="12" height="2" rx="1" fill={stroke} />
          <rect x="3" y="8" width="12" height="2" rx="1" fill={stroke} opacity="0.88" />
          <rect x="3" y="12" width="8" height="2" rx="1" fill={stroke} opacity="0.72" />
        </svg>
      );
    case "ideas":
      return (
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="none">
          <path
            d="M9 3.5 10.4 7.1 14 8.5 10.4 9.9 9 13.5 7.6 9.9 4 8.5 7.6 7.1 9 3.5Z"
            fill={stroke}
          />
          <path d="M13.4 3.2v2.1M14.45 4.25h-2.1" stroke={stroke} strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      );
    case "notes":
      return (
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="none">
          <path
            d="M5 3.75h5.9L13.5 6.35V14a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1V4.75a1 1 0 0 1 1-1Z"
            stroke={stroke}
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <path d="M10.75 3.9V6.7h2.8" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M6.5 9h5M6.5 11.5h5" stroke={stroke} strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      );
    case "history":
      return (
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="none">
          <path
            d="M4.2 7.2A5.2 5.2 0 1 1 5 11.9"
            stroke={stroke}
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d="M3.2 4.6v3.2h3.2" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M9 6.2V9l2.05 1.45" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "settings":
      return (
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="none">
          <path d="M4 5.2h10M4 12.8h10" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="7" cy="5.2" r="1.8" fill={stroke} />
          <circle cx="11" cy="12.8" r="1.8" fill={stroke} />
        </svg>
      );
    case "diamond":
      return (
        <GemBadge
          config={{
            material: "diamond",
            cut: "round",
            size: 22,
            rotation: 0,
            glow: isActive,
            glowIntensity: isActive ? 0.85 : 0.35,
            renderMode: "auto",
          }}
          aria-hidden="true"
        />
      );
    default:
      return fallback;
  }
}

export function CompanionShell({
  activeDrawer,
  drawerTitle,
  drawerSubtitle,
  navItems,
  onSelectNavItem,
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
        flexDirection: "column",
        overflow: "hidden",
        background:
          `radial-gradient(circle at top left, ${colors.accentMuted} 0%, ${colors.background} 42%), ` +
          `linear-gradient(180deg, #fffdf9 0%, ${colors.background} 100%)`,
        color: colors.text,
        fontFamily:
          "'Segoe UI Variable Display', 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif",
      }}
    >
      <div
        style={{
          position: "relative",
          display: "flex",
          flex: 1,
          minHeight: 0,
        }}
      >
        <main
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            gap: spacing[3],
            padding: `${spacing[3]}px ${spacing[3]}px ${spacing[2]}px`,
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
          >
          </div>

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
      </div>

      <nav
        aria-label="Workspace"
        style={{
          padding: `0 ${spacing[3]}px ${spacing[3]}px`,
          position: "relative",
          zIndex: 2,
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${navItems.length}, minmax(0, 1fr))`,
            gap: spacing[1],
            padding: `${spacing[1]}px`,
            borderRadius: 28,
            border: `1px solid ${colors.border}`,
            background: "rgba(255, 255, 255, 0.82)",
            boxShadow: "0 18px 42px rgba(26, 24, 22, 0.08)",
            backdropFilter: "blur(22px)",
            WebkitBackdropFilter: "blur(22px)",
          }}
        >
          {navItems.map((item) => {
            const isActive =
              item.key === "transcript" ? activeDrawer === null : activeDrawer === item.key;

            return (
              <button
                key={item.key}
                type="button"
                onClick={() => onSelectNavItem(item.key)}
                title={item.title || item.label}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: spacing[1],
                  minWidth: 0,
                  padding: `${spacing[2]}px ${spacing[1]}px`,
                  background: isActive
                    ? `linear-gradient(180deg, ${colors.surface} 0%, rgba(255, 255, 255, 0.76) 100%)`
                    : "transparent",
                  color: isActive ? colors.accent : colors.textSecondary,
                  border: `1px solid ${isActive ? `${colors.accent}30` : "transparent"}`,
                  borderRadius: 22,
                  cursor: "pointer",
                  boxShadow: isActive ? "0 10px 20px rgba(45, 138, 135, 0.12)" : "none",
                }}
              >
                <span
                  style={{
                    minWidth: 34,
                    height: 34,
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
                  {renderNavGlyph(item.icon, isActive, item.shortLabel)}
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
                    maxWidth: "100%",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontSize: 10,
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
      </nav>

      {modal}
    </div>
  );
}

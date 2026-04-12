import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { SessionRecord } from "../types";
import { colors, radius, spacing, typography } from "../theme";

interface Props {
  currentSessionId?: string;
  onSelectSession: (sessionId: string) => void;
  isActive?: boolean;
}

type RawSessionRecord = SessionRecord & {
  started_at?: string;
  ended_at?: string | null;
  utterance_count?: number;
  has_notes?: boolean;
};

function parseSessionDate(value?: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getStartedAt(session: RawSessionRecord): string | null {
  return session.startedAt ?? session.started_at ?? null;
}

function formatDate(value?: string | null): string {
  const date = parseSessionDate(value);
  if (!date) return "Unknown Date";

  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const isYesterday = new Date(now.getTime() - 86400000).toDateString() === date.toDateString();

  if (isToday) return "Today";
  if (isYesterday) return "Yesterday";

  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatTime(value?: string | null): string {
  const date = parseSessionDate(value);
  if (!date) return "Unknown time";
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function SessionHistoryPanel({
  currentSessionId,
  onSelectSession,
  isActive = false,
}: Props) {
  const [sessions, setSessions] = useState<RawSessionRecord[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  const loadSessions = async () => {
    setIsLoading(true);
    try {
      const data = await invoke<RawSessionRecord[]>("list_sessions");
      setSessions(
        data.sort((a, b) => {
          const aTime = parseSessionDate(getStartedAt(a))?.getTime() ?? 0;
          const bTime = parseSessionDate(getStartedAt(b))?.getTime() ?? 0;
          return bTime - aTime;
        }),
      );
    } catch (error) {
      console.error("Failed to load sessions:", error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadSessions();
  }, []);

  useEffect(() => {
    if (isActive) {
      void loadSessions();
    }
  }, [isActive]);

  useEffect(() => {
    const unlisteners = [listen("notes-ready", () => void loadSessions())];

    return () => {
      unlisteners.forEach((listener) => {
        listener.then((dispose) => dispose());
      });
    };
  }, []);

  const filteredSessions = sessions.filter((session) => {
    const query = searchQuery.toLowerCase();
    const startedAt = getStartedAt(session);

    return (
      (session.title?.toLowerCase() || "").includes(query) ||
      formatDate(startedAt).toLowerCase().includes(query)
    );
  });

  const grouped = filteredSessions.reduce(
    (acc, session) => {
      const date = formatDate(getStartedAt(session));
      if (!acc[date]) acc[date] = [];
      acc[date].push(session);
      return acc;
    },
    {} as Record<string, RawSessionRecord[]>,
  );

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: colors.background,
      }}
    >
      <div
        style={{
          padding: `${spacing[3]}px ${spacing[4]}px`,
          borderBottom: `1px solid ${colors.border}`,
          background: "rgba(255, 255, 255, 0.66)",
        }}
      >
        <input
          type="text"
          placeholder="Search sessions"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          style={{
            width: "100%",
            padding: `${spacing[2]}px ${spacing[3]}px`,
            background: colors.surface,
            border: `1px solid ${colors.border}`,
            borderRadius: radius.lg,
            fontSize: typography.md,
            color: colors.text,
            boxSizing: "border-box",
          }}
        />
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: `${spacing[3]}px ${spacing[3]}px ${spacing[4]}px`,
        }}
      >
        {isLoading ? (
          <div style={{ padding: spacing[4], color: colors.textMuted, textAlign: "center" }}>
            Loading sessions...
          </div>
        ) : Object.keys(grouped).length === 0 ? (
          <div style={{ padding: spacing[4], color: colors.textMuted, textAlign: "center" }}>
            {searchQuery ? "No sessions found" : "No sessions yet"}
          </div>
        ) : (
          Object.entries(grouped).map(([date, dateSessions]) => (
            <div key={date} style={{ marginBottom: spacing[4] }}>
              <div
                style={{
                  padding: `${spacing[1]}px ${spacing[1]}px ${spacing[2]}px`,
                  fontSize: typography.xs,
                  color: colors.textMuted,
                  textTransform: "uppercase",
                  letterSpacing: "0.12em",
                  fontWeight: 700,
                }}
              >
                {date}
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: spacing[2] }}>
                {dateSessions.map((session) => {
                  const startedAt = getStartedAt(session);
                  const timeLabel = formatTime(startedAt);
                  const hasNotes = session.hasNotes ?? session.has_notes ?? false;
                  const utteranceCount = session.utteranceCount ?? session.utterance_count ?? 0;
                  const isCurrent = session.id === currentSessionId;

                  return (
                    <button
                      key={session.id}
                      type="button"
                      onClick={() => onSelectSession(session.id)}
                      style={{
                        width: "100%",
                        textAlign: "left",
                        padding: `${spacing[3]}px`,
                        borderRadius: 18,
                        border: `1px solid ${isCurrent ? `${colors.accent}32` : colors.border}`,
                        background: isCurrent
                          ? `linear-gradient(180deg, ${colors.accentMuted} 0%, rgba(255, 255, 255, 0.95) 100%)`
                          : colors.surface,
                        cursor: "pointer",
                        boxShadow: isCurrent ? "0 12px 26px rgba(45, 138, 135, 0.12)" : "none",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: spacing[2],
                        }}
                      >
                        <span
                          style={{
                            fontSize: typography.md,
                            fontWeight: 700,
                            color: isCurrent ? colors.accent : colors.text,
                          }}
                        >
                          {session.title || `Session ${timeLabel}`}
                        </span>

                        {hasNotes ? (
                          <span
                            style={{
                              padding: `${spacing[1]}px ${spacing[2]}px`,
                              borderRadius: radius.full,
                              background: `${colors.success}14`,
                              color: colors.success,
                              fontSize: typography.xs,
                              fontWeight: 700,
                              textTransform: "uppercase",
                              letterSpacing: "0.08em",
                            }}
                          >
                            Notes
                          </span>
                        ) : null}
                      </div>

                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: spacing[2],
                          flexWrap: "wrap",
                          marginTop: spacing[2],
                          fontSize: typography.sm,
                          color: colors.textSecondary,
                        }}
                      >
                        <span>{timeLabel}</span>
                        <span style={{ color: colors.textMuted }}>.</span>
                        <span>{utteranceCount} messages</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

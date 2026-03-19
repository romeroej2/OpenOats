import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SessionRecord } from "../types";
import { colors, typography, spacing } from "../theme";

interface Props {
  currentSessionId?: string;
  onSelectSession: (sessionId: string) => void;
  isOpen: boolean;
  onClose: () => void;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const isYesterday = new Date(now.getTime() - 86400000).toDateString() === date.toDateString();

  if (isToday) return "Today";
  if (isYesterday) return "Yesterday";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function SessionSidebar({ currentSessionId, onSelectSession, isOpen, onClose }: Props) {
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadSessions();
  }, []);

  const loadSessions = async () => {
    setIsLoading(true);
    try {
      const data = await invoke<SessionRecord[]>("list_sessions");
      setSessions(data.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()));
    } catch (err) {
      console.error("Failed to load sessions:", err);
    } finally {
      setIsLoading(false);
    }
  };

  const filteredSessions = sessions.filter((s) => {
    const query = searchQuery.toLowerCase();
    return (
      (s.title?.toLowerCase() || "").includes(query) ||
      formatDate(s.startedAt).toLowerCase().includes(query)
    );
  });

  // Group by date
  const grouped = filteredSessions.reduce(
    (acc, session) => {
      const date = formatDate(session.startedAt);
      if (!acc[date]) acc[date] = [];
      acc[date].push(session);
      return acc;
    },
    {} as Record<string, SessionRecord[]>
  );

  return (
    <>
      {/* Overlay backdrop */}
      {isOpen && (
        <div
          onClick={onClose}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.2)",
            zIndex: 40,
          }}
        />
      )}

      {/* Sidebar */}
      <div
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          width: 320,
          height: "100vh",
          background: colors.surface,
          borderRight: `1px solid ${colors.border}`,
          transform: isOpen ? "translateX(0)" : "translateX(-100%)",
          transition: "transform 0.3s ease",
          zIndex: 50,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: `${spacing[3]}px ${spacing[4]}px`,
            borderBottom: `1px solid ${colors.border}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <h3
            style={{
              margin: 0,
              fontSize: typography.lg,
              fontWeight: 600,
              color: colors.text,
            }}
          >
            Session History
          </h3>
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              color: colors.textMuted,
              cursor: "pointer",
              fontSize: 20,
              padding: 4,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>

        {/* Search */}
        <div style={{ padding: spacing[3] }}>
          <input
            type="text"
            placeholder="Search sessions..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              width: "100%",
              padding: `${spacing[2]}px ${spacing[3]}px`,
              background: colors.background,
              border: `1px solid ${colors.border}`,
              borderRadius: 6,
              fontSize: typography.md,
              color: colors.text,
              outline: "none",
            }}
          />
        </div>

        {/* Session list */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: `0 ${spacing[3]}px`,
          }}
        >
          {isLoading ? (
            <div style={{ textAlign: "center", padding: spacing[4], color: colors.textMuted }}>
              Loading...
            </div>
          ) : Object.keys(grouped).length === 0 ? (
            <div style={{ textAlign: "center", padding: spacing[4], color: colors.textMuted }}>
              {searchQuery ? "No sessions found" : "No sessions yet"}
            </div>
          ) : (
            Object.entries(grouped).map(([date, dateSessions]) => (
              <div key={date} style={{ marginBottom: spacing[3] }}>
                <div
                  style={{
                    fontSize: typography.xs,
                    color: colors.textMuted,
                    textTransform: "uppercase",
                    letterSpacing: "1px",
                    fontWeight: 600,
                    padding: `${spacing[2]}px 0`,
                  }}
                >
                  {date}
                </div>
                {dateSessions.map((session) => (
                  <button
                    key={session.id}
                    onClick={() => {
                      onSelectSession(session.id);
                      onClose();
                    }}
                    style={{
                      width: "100%",
                      textAlign: "left",
                      padding: `${spacing[2]}px ${spacing[3]}px`,
                      background:
                        session.id === currentSessionId ? `${colors.accent}10` : "transparent",
                      border: "none",
                      borderRadius: 6,
                      cursor: "pointer",
                      marginBottom: spacing[1],
                      transition: "background 0.2s",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                      }}
                    >
                      <span
                        style={{
                          fontSize: typography.md,
                          fontWeight: 500,
                          color: session.id === currentSessionId ? colors.accent : colors.text,
                        }}
                      >
                        {session.title || `Session ${formatTime(session.startedAt)}`}
                      </span>
                      {session.hasNotes && (
                        <span
                          style={{
                            fontSize: typography.xs,
                            color: colors.success,
                          }}
                        >
                          ✓ Notes
                        </span>
                      )}
                    </div>
                    <div
                      style={{
                        fontSize: typography.sm,
                        color: colors.textSecondary,
                        marginTop: 2,
                      }}
                    >
                      {formatTime(session.startedAt)} · {session.utteranceCount} messages
                    </div>
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}

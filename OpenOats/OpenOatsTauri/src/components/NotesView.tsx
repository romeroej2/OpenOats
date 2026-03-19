import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { colors, typography, spacing } from "../theme";

const TEMPLATES = [
  { id: "00000000-0000-0000-0000-000000000000", name: "Generic" },
  { id: "00000000-0000-0000-0000-000000000001", name: "1:1" },
  { id: "00000000-0000-0000-0000-000000000002", name: "Customer Discovery" },
  { id: "00000000-0000-0000-0000-000000000003", name: "Hiring" },
  { id: "00000000-0000-0000-0000-000000000004", name: "Stand-Up" },
  { id: "00000000-0000-0000-0000-000000000005", name: "Weekly Meeting" },
];

interface Props {
  sessionId?: string;
}

export function NotesView({ sessionId }: Props) {
  const [selectedTemplate, setSelectedTemplate] = useState(TEMPLATES[0].id);
  const [markdown, setMarkdown] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showThoughts, setShowThoughts] = useState(false);

  useEffect(() => {
    const unlisten = listen<string>("notes-chunk", (e) => {
      setMarkdown((prev) => prev + e.payload);
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  const handleGenerate = async () => {
    if (!sessionId) return;
    setMarkdown("");
    setIsGenerating(true);
    setError(null);
    setShowThoughts(false);
    try {
      await invoke("generate_notes", { sessionId, templateId: selectedTemplate });
    } catch (e) {
      setError(String(e));
    } finally {
      setIsGenerating(false);
    }
  };

  const parsed = parseGeneratedNotes(markdown);
  const displayedMarkdown = isGenerating ? markdown : parsed.visible;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", padding: spacing[4] }}>
      <div style={{ display: "flex", gap: spacing[2], marginBottom: spacing[3] }}>
        <select
          value={selectedTemplate}
          onChange={(e) => setSelectedTemplate(e.target.value)}
          style={{ 
            flex: 1, 
            padding: `${spacing[2]}px`, 
            background: colors.surface, 
            color: colors.text, 
            border: `1px solid ${colors.border}`, 
            borderRadius: 4,
            fontSize: typography.md,
          }}
        >
          {TEMPLATES.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <button
          onClick={handleGenerate}
          disabled={isGenerating || !sessionId}
          style={{
            padding: `${spacing[2]}px ${spacing[4]}px`,
            background: colors.accent,
            color: colors.textInverse,
            border: "none",
            borderRadius: 4,
            fontSize: typography.md,
            cursor: isGenerating || !sessionId ? "not-allowed" : "pointer",
            opacity: isGenerating || !sessionId ? 0.5 : 1,
            fontWeight: 500,
          }}
        >
          {isGenerating ? "Generating…" : "Generate Notes"}
        </button>
      </div>

      {error && <div style={{ color: colors.error, fontSize: typography.md, marginBottom: spacing[2] }}>{error}</div>}

      {!isGenerating && parsed.thoughts && (
        <div style={{ marginBottom: spacing[2], display: "flex", justifyContent: "flex-end" }}>
          <button
            onClick={() => setShowThoughts((prev) => !prev)}
            style={{
              padding: `${spacing[1]}px ${spacing[2]}px`,
              background: "transparent",
              color: colors.textMuted,
              border: `1px solid ${colors.border}`,
              borderRadius: 4,
              cursor: "pointer",
              fontSize: typography.sm,
            }}
          >
            {showThoughts ? "Hide Thought" : "Show Thought"}
          </button>
        </div>
      )}

      {displayedMarkdown ? (
        <div style={{ flex: 1, overflowY: "auto" }}>
          <pre style={{ fontSize: typography.md, color: colors.text, whiteSpace: "pre-wrap", lineHeight: 1.6, margin: 0 }}>
            {displayedMarkdown}
          </pre>
          {!isGenerating && showThoughts && parsed.thoughts && (
            <div style={{ marginTop: spacing[4], borderTop: `1px solid ${colors.border}`, paddingTop: spacing[3] }}>
              <div style={{ color: colors.textMuted, fontSize: typography.xs, marginBottom: spacing[2], textTransform: "uppercase", letterSpacing: "1px", fontWeight: 600 }}>
                Thought
              </div>
              <pre style={{ fontSize: typography.sm, color: colors.textSecondary, whiteSpace: "pre-wrap", lineHeight: 1.6, margin: 0 }}>
                {parsed.thoughts}
              </pre>
            </div>
          )}
        </div>
      ) : (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: colors.textMuted, fontSize: typography.md }}>
          {sessionId ? "Select a template and click Generate Notes" : "Start a session to generate notes"}
        </div>
      )}
    </div>
  );
}

function parseGeneratedNotes(markdown: string): { visible: string; thoughts: string | null } {
  if (!markdown) {
    return { visible: "", thoughts: null };
  }

  const thoughtMatch = markdown.match(/<think>([\s\S]*?)<\/think>/i);
  const thoughts = thoughtMatch?.[1]?.trim() || null;

  const visible = markdown
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\|begin_of_box\|>/gi, "")
    .replace(/<\|end_of_box\|>/gi, "")
    .trim();

  return { visible, thoughts };
}

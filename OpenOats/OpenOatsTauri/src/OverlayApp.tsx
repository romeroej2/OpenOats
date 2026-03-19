import { useState, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

interface SuggestionPayload {
  id: string;
  text: string;
}

export function OverlayApp() {
  const [suggestion, setSuggestion] = useState<SuggestionPayload | null>(null);

  useEffect(() => {
    const unlisten = listen<SuggestionPayload>("suggestion", (e) => {
      setSuggestion(e.payload);
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  if (!suggestion) {
    return (
      <div style={containerStyle}>
        <span style={{ color: "#555", fontSize: 13 }}>Waiting for suggestions…</span>
      </div>
    );
  }

  const dismiss = () => {
    setSuggestion(null);
    invoke("hide_overlay").catch(() => {});
  };

  return (
    <div style={containerStyle}>
      <div style={cardStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
          <p style={{ margin: 0, fontSize: 13, color: "#eee", lineHeight: 1.5, flex: 1 }}>
            {suggestion.text}
          </p>
          <button onClick={dismiss} style={closeBtn} title="Dismiss">✕</button>
        </div>
      </div>
    </div>
  );
}

const containerStyle: React.CSSProperties = {
  width: "100vw",
  height: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "transparent",
  padding: 8,
  boxSizing: "border-box",
};

const cardStyle: React.CSSProperties = {
  background: "rgba(20, 20, 30, 0.92)",
  border: "1px solid rgba(80, 120, 200, 0.4)",
  borderRadius: 10,
  padding: "12px 14px",
  width: "100%",
  backdropFilter: "blur(12px)",
  boxShadow: "0 4px 20px rgba(0,0,0,0.6)",
};

const closeBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#666",
  cursor: "pointer",
  fontSize: 14,
  lineHeight: 1,
  padding: 0,
  flexShrink: 0,
};

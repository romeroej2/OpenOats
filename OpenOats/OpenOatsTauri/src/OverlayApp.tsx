import type { PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface SuggestionPayload {
  id: string;
  text: string;
}

export function OverlayApp() {
  const [suggestion, setSuggestion] = useState<SuggestionPayload | null>(null);
  const dragStateRef = useRef<{
    pointerId: number;
    startPointerX: number;
    startPointerY: number;
    startWindowX: number;
    startWindowY: number;
  } | null>(null);
  const dragHandleRef = useRef<HTMLDivElement | null>(null);
  const pendingPositionRef = useRef<{ x: number; y: number } | null>(null);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const html = document.documentElement;
    const root = document.getElementById("root");
    const previousHtmlBackground = html.style.background;
    const previousHtmlColorScheme = html.style.colorScheme;
    const previousBodyBackground = document.body.style.background;
    const previousRootBackground = root?.style.background ?? "";
    const previousRootBorder = root?.style.border ?? "";
    const previousRootBoxShadow = root?.style.boxShadow ?? "";
    const previousRootWidth = root?.style.width ?? "";
    const previousRootMaxWidth = root?.style.maxWidth ?? "";
    const previousRootMinHeight = root?.style.minHeight ?? "";
    const previousRootMargin = root?.style.margin ?? "";

    html.style.background = "transparent";
    html.style.colorScheme = "normal";
    document.body.style.background = "transparent";
    if (root) {
      root.style.background = "transparent";
      root.style.border = "none";
      root.style.boxShadow = "none";
      root.style.width = "100%";
      root.style.maxWidth = "100%";
      root.style.minHeight = "100%";
      root.style.margin = "0";
    }

    const unlisten1 = listen<SuggestionPayload>("suggestion", (e) => {
      setSuggestion(e.payload);
    });
    const unlisten2 = listen<SuggestionPayload>("overlay-test-suggestion", (e) => {
      setSuggestion(e.payload);
    });

    return () => {
      unlisten1.then((f) => f());
      unlisten2.then((f) => f());
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
      }
      html.style.background = previousHtmlBackground;
      html.style.colorScheme = previousHtmlColorScheme;
      document.body.style.background = previousBodyBackground;
      if (root) {
        root.style.background = previousRootBackground;
        root.style.border = previousRootBorder;
        root.style.boxShadow = previousRootBoxShadow;
        root.style.width = previousRootWidth;
        root.style.maxWidth = previousRootMaxWidth;
        root.style.minHeight = previousRootMinHeight;
        root.style.margin = previousRootMargin;
      }
    };
  }, []);

  if (!suggestion) {
    return null;
  }

  const lines = suggestion.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const dismiss = () => {
    setSuggestion(null);
    invoke("hide_overlay").catch(() => {});
  };

  const stopDragging = (pointerId?: number) => {
    const dragState = dragStateRef.current;
    dragStateRef.current = null;
    pendingPositionRef.current = null;

    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }

    if (
      dragHandleRef.current &&
      pointerId !== undefined &&
      dragHandleRef.current.hasPointerCapture(pointerId)
    ) {
      dragHandleRef.current.releasePointerCapture(pointerId);
    }
  };

  const flushOverlayPosition = () => {
    frameRef.current = null;
    const position = pendingPositionRef.current;
    if (!position || !dragStateRef.current) {
      return;
    }

    invoke("set_overlay_position", position).catch(() => {});
  };

  const queueOverlayPosition = (x: number, y: number) => {
    pendingPositionRef.current = { x, y };
    if (frameRef.current === null) {
      frameRef.current = requestAnimationFrame(flushOverlayPosition);
    }
  };

  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) {
      return;
    }

    const pointerId = e.pointerId;
    const startPointerX = e.screenX;
    const startPointerY = e.screenY;

    dragHandleRef.current = e.currentTarget;
    e.currentTarget.setPointerCapture(pointerId);

    const win = getCurrentWindow();
    win.setFocus().catch(() => {});

    void win.outerPosition().then((position) => {
      if (
        !dragHandleRef.current?.hasPointerCapture(pointerId) ||
        dragStateRef.current?.pointerId === pointerId
      ) {
        return;
      }

      dragStateRef.current = {
        pointerId,
        startPointerX,
        startPointerY,
        startWindowX: position.x,
        startWindowY: position.y,
      };
    }).catch(() => {
      stopDragging(pointerId);
    });
  };

  const dragOverlay = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.buttons & 1) === 0) {
      stopDragging(e.pointerId);
      return;
    }

    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== e.pointerId) {
      return;
    }

    const nextX = Math.round(dragState.startWindowX + (e.screenX - dragState.startPointerX));
    const nextY = Math.round(dragState.startWindowY + (e.screenY - dragState.startPointerY));

    queueOverlayPosition(nextX, nextY);
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragStateRef.current?.pointerId === e.pointerId) {
      stopDragging(e.pointerId);
    }
  };

  return (
    <div style={containerStyle}>
      <div style={cardStyle}>
        <div
          ref={dragHandleRef}
          style={headerStyle}
          onPointerDown={startDrag}
          onPointerMove={dragOverlay}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <div style={grabberStyle} />
          <span style={headerLabelStyle}>
            Suggestion
          </span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
          <div style={contentStyle}>
            {lines.map((line, index) => (
              <p key={`${suggestion.id}-${index}`} style={lineStyle}>
                {line}
              </p>
            ))}
          </div>
          <button
            onClick={dismiss}
            onMouseDown={(e) => e.stopPropagation()}
            style={closeBtn}
            title="Dismiss"
          >
            x
          </button>
        </div>
      </div>
    </div>
  );
}

const containerStyle: React.CSSProperties = {
  width: "100vw",
  height: "100vh",
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  padding: "20px 24px",
  boxSizing: "border-box",
  overflow: "hidden",
  background: "transparent",
};

const cardStyle: React.CSSProperties = {
  background: "linear-gradient(180deg, rgba(98, 98, 101, 0.84) 0%, rgba(112, 110, 106, 0.8) 100%)",
  border: "none",
  borderRadius: 18,
  padding: "12px 16px 14px",
  width: "min(640px, calc(100vw - 48px))",
  maxHeight: "calc(100vh - 40px)",
  overflow: "hidden",
  boxShadow: "0 12px 28px rgba(0,0,0,0.16)",
  cursor: "grab",
  userSelect: "none",
  backdropFilter: "blur(16px) saturate(1.05)",
  WebkitBackdropFilter: "blur(16px) saturate(1.05)",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginBottom: 12,
  paddingBottom: 10,
  borderBottom: "1px solid rgba(231, 198, 144, 0.16)",
  cursor: "grab",
};

const grabberStyle: React.CSSProperties = {
  width: 28,
  height: 4,
  borderRadius: 999,
  background: "rgba(255,255,255,0.3)",
  flexShrink: 0,
};

const headerLabelStyle: React.CSSProperties = {
  color: "rgba(239, 210, 155, 0.92)",
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
};

const contentStyle: React.CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  minWidth: 0,
  paddingRight: 4,
};

const lineStyle: React.CSSProperties = {
  margin: 0,
  color: "rgba(248,249,252,0.96)",
  fontSize: 15,
  lineHeight: 1.4,
  letterSpacing: "0.01em",
  whiteSpace: "pre-wrap",
  textWrap: "pretty",
  textShadow: "0 1px 1px rgba(0,0,0,0.22)",
};

const closeBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "rgba(255,255,255,0.66)",
  cursor: "pointer",
  fontSize: 16,
  lineHeight: 1,
  padding: "2px 0 0",
  flexShrink: 0,
};

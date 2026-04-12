import { useEffect, useRef } from "react";
import {
  isEditableTarget,
  isShortcutPressed,
  normalizeKeyboardKey,
  parseShortcut,
} from "../hotkeys";

interface ShortcutHandlers {
  onStartStop?: () => void;
  onDismissOverlay?: () => void;
  onFocusSearch?: () => void;
  onExportTranscript?: () => void;
  onToggleSidebar?: () => void;
  pushToTalkEnabled?: boolean;
  pushToTalkShortcut?: string | null;
  onPushToTalkPress?: () => void;
  onPushToTalkRelease?: () => void;
}

const modifierKeys = ["Ctrl", "Alt", "Shift", "Meta"] as const;

export function useKeyboardShortcuts(handlers: ShortcutHandlers) {
  const handlersRef = useRef(handlers);
  const pressedKeysRef = useRef(new Set<string>());
  const pushToTalkActiveRef = useRef(false);

  useEffect(() => {
    handlersRef.current = handlers;
  }, [handlers]);

  useEffect(() => {
    if (handlers.pushToTalkEnabled && parseShortcut(handlers.pushToTalkShortcut)) {
      return;
    }

    pressedKeysRef.current.clear();
    if (pushToTalkActiveRef.current) {
      pushToTalkActiveRef.current = false;
      handlersRef.current.onPushToTalkRelease?.();
    }
  }, [handlers.pushToTalkEnabled, handlers.pushToTalkShortcut]);

  useEffect(() => {
    const syncModifierState = (event: KeyboardEvent) => {
      for (const modifier of modifierKeys) {
        pressedKeysRef.current.delete(modifier);
      }
      if (event.ctrlKey) {
        pressedKeysRef.current.add("Ctrl");
      }
      if (event.altKey) {
        pressedKeysRef.current.add("Alt");
      }
      if (event.shiftKey) {
        pressedKeysRef.current.add("Shift");
      }
      if (event.metaKey) {
        pressedKeysRef.current.add("Meta");
      }
    };

    const syncPushToTalk = (target: EventTarget | null) => {
      const current = handlersRef.current;
      const shortcut =
        current.pushToTalkEnabled && !isEditableTarget(target)
          ? parseShortcut(current.pushToTalkShortcut)
          : null;
      const nextActive = Boolean(
        shortcut && isShortcutPressed(shortcut, pressedKeysRef.current),
      );

      if (nextActive === pushToTalkActiveRef.current) {
        return;
      }

      pushToTalkActiveRef.current = nextActive;
      if (nextActive) {
        current.onPushToTalkPress?.();
      } else {
        current.onPushToTalkRelease?.();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const current = handlersRef.current;
      const isMac = navigator.platform.toUpperCase().includes("MAC");
      const modKey = isMac ? event.metaKey : event.ctrlKey;

      syncModifierState(event);
      const key = normalizeKeyboardKey(event.key);
      if (key) {
        pressedKeysRef.current.add(key);
      }

      if (modKey && event.shiftKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        current.onStartStop?.();
      }

      if (modKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        current.onFocusSearch?.();
      }

      if (modKey && event.key.toLowerCase() === "e") {
        event.preventDefault();
        current.onExportTranscript?.();
      }

      if (modKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        current.onToggleSidebar?.();
      }

      if (event.key === "Escape") {
        current.onDismissOverlay?.();
      }

      syncPushToTalk(event.target);
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      syncModifierState(event);
      const key = normalizeKeyboardKey(event.key);
      if (key && !modifierKeys.includes(key as (typeof modifierKeys)[number])) {
        pressedKeysRef.current.delete(key);
      }
      syncPushToTalk(event.target);
    };

    const handleBlur = () => {
      pressedKeysRef.current.clear();
      if (pushToTalkActiveRef.current) {
        pushToTalkActiveRef.current = false;
        handlersRef.current.onPushToTalkRelease?.();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);

    return () => {
      handleBlur();
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, []);
}

export function useOverlayKeyboardShortcuts(onDismiss: () => void) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onDismiss();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onDismiss]);
}

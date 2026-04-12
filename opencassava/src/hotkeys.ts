const MODIFIER_ORDER = ["Ctrl", "Alt", "Shift", "Meta"] as const;

type ModifierKey = (typeof MODIFIER_ORDER)[number];

export interface ParsedShortcut {
  modifiers: ModifierKey[];
  key: string;
  display: string;
}

const modifierAliases: Record<string, ModifierKey> = {
  alt: "Alt",
  cmd: "Meta",
  command: "Meta",
  control: "Ctrl",
  ctrl: "Ctrl",
  meta: "Meta",
  option: "Alt",
  shift: "Shift",
  super: "Meta",
  win: "Meta",
  windows: "Meta",
};

const specialKeyAliases: Record<string, string> = {
  " ": "Space",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  arrowup: "ArrowUp",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  down: "ArrowDown",
  enter: "Enter",
  esc: "Escape",
  escape: "Escape",
  left: "ArrowLeft",
  minus: "Minus",
  period: "Period",
  plus: "Plus",
  quote: "Quote",
  return: "Enter",
  right: "ArrowRight",
  semicolon: "Semicolon",
  slash: "Slash",
  space: "Space",
  spacebar: "Space",
  tab: "Tab",
  up: "ArrowUp",
};

const singleCharacterAliases: Record<string, string> = {
  "'": "Quote",
  ",": "Comma",
  "-": "Minus",
  ".": "Period",
  "/": "Slash",
  ";": "Semicolon",
  "=": "Plus",
  "[": "BracketLeft",
  "\\": "Backslash",
  "]": "BracketRight",
  "`": "Backquote",
};

function isModifierKey(value: string): value is ModifierKey {
  return MODIFIER_ORDER.includes(value as ModifierKey);
}

export function normalizeKeyboardKey(key: string): string | null {
  const trimmed = key.trim();
  if (!trimmed && key !== " ") {
    return null;
  }

  const lower = key.toLowerCase();
  const modifier = modifierAliases[lower];
  if (modifier) {
    return modifier;
  }

  const special = specialKeyAliases[lower];
  if (special) {
    return special;
  }

  if (key.length === 1) {
    if (/^[a-z]$/i.test(key)) {
      return key.toUpperCase();
    }
    if (/^\d$/.test(key)) {
      return key;
    }
    return singleCharacterAliases[key] ?? null;
  }

  if (/^f\d{1,2}$/i.test(trimmed)) {
    return trimmed.toUpperCase();
  }

  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

export function parseShortcut(input: string | null | undefined): ParsedShortcut | null {
  if (!input) {
    return null;
  }

  const tokens = input
    .split("+")
    .map((token) => normalizeKeyboardKey(token))
    .filter((token): token is string => Boolean(token));

  if (tokens.length === 0) {
    return null;
  }

  const modifiers = new Set<ModifierKey>();
  let key: string | null = null;

  for (const token of tokens) {
    if (isModifierKey(token)) {
      modifiers.add(token);
      continue;
    }

    if (key) {
      return null;
    }
    key = token;
  }

  if (!key) {
    return null;
  }

  const orderedModifiers = MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier));
  return {
    modifiers: orderedModifiers,
    key,
    display: [...orderedModifiers, key].join("+"),
  };
}

export function normalizeShortcut(input: string | null | undefined): string {
  return parseShortcut(input)?.display ?? "";
}

export function shortcutFromKeyboardEvent(
  event: KeyboardEvent,
  options: { allowModifierOnly?: boolean } = {},
): string | null {
  const key = normalizeKeyboardKey(event.key);
  if (!key) {
    return null;
  }

  const modifiers: ModifierKey[] = [];
  if (event.ctrlKey && key !== "Ctrl") {
    modifiers.push("Ctrl");
  }
  if (event.altKey && key !== "Alt") {
    modifiers.push("Alt");
  }
  if (event.shiftKey && key !== "Shift") {
    modifiers.push("Shift");
  }
  if (event.metaKey && key !== "Meta") {
    modifiers.push("Meta");
  }

  if (isModifierKey(key) && !options.allowModifierOnly) {
    return null;
  }

  return [...modifiers, key].join("+");
}

export function isShortcutPressed(parsed: ParsedShortcut, pressedKeys: Set<string>): boolean {
  return parsed.modifiers.every((modifier) => pressedKeys.has(modifier)) && pressedKeys.has(parsed.key);
}

export function isEditableTarget(target: EventTarget | null): boolean {
  const element = target instanceof HTMLElement ? target : null;
  if (!element) {
    return false;
  }

  if (element.isContentEditable) {
    return true;
  }

  const tagName = element.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select";
}

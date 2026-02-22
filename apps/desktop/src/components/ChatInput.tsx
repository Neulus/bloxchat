import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import type { ChatMessage } from "@bloxchat/api";
import { invoke } from "@tauri-apps/api/core";
import { useChat } from "../contexts/ChatContext";
import {
  findEmojiSuggestions,
  type EmojiSuggestion,
  replaceEmojiShortcodes,
} from "../lib/emoji";
import type { ChatInputMode } from "../lib/store";

export type GlobalKeyPayload = {
  code: string;
  text?: string | null;
  phase: "down" | "up";
  ctrl: boolean;
  shift: boolean;
  caps?: boolean;
  alt: boolean;
  meta: boolean;
  repeat: boolean;
  timestamp_ms: number;
};

export type ChatInputKeyAction = "none" | "submit" | "cancel";

export type ChatInputHandle = {
  focusImeInput: () => void;
  handleGlobalKey: (event: GlobalKeyPayload) => Promise<ChatInputKeyAction>;
};

interface ChatInputProps {
  value: string;
  onChange: (val: string) => void;
  messages: ChatMessage[];
  maxLength: number;
  mode: ChatInputMode;
  captureActive?: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  onFocusRequest?: () => void;
}

type Suggestion =
  | { type: "mention"; value: string }
  | { type: "emoji"; value: EmojiSuggestion };

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

const toNormalizedRange = (start: number, end: number) => ({
  start: Math.min(start, end),
  end: Math.max(start, end),
});

const shiftedNumberMap: Record<string, string> = {
  Digit1: "!",
  Digit2: "@",
  Digit3: "#",
  Digit4: "$",
  Digit5: "%",
  Digit6: "^",
  Digit7: "&",
  Digit8: "*",
  Digit9: "(",
  Digit0: ")",
};

const shiftedSymbolMap: Record<string, string> = {
  Backquote: "~",
  Minus: "_",
  Equal: "+",
  BracketLeft: "{",
  BracketRight: "}",
  Backslash: "|",
  Semicolon: ":",
  Quote: "\"",
  Comma: "<",
  Period: ">",
  Slash: "?",
};

const unshiftedSymbolMap: Record<string, string> = {
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
};

const forceCodeMappedCodes = new Set([
  ...Object.keys(shiftedNumberMap),
  ...Object.keys(shiftedSymbolMap),
  ...Object.keys(unshiftedSymbolMap),
  "NumpadAdd",
  "NumpadSubtract",
  "NumpadMultiply",
  "NumpadDivide",
  "NumpadDecimal",
]);

const mapPrintableCharacter = (code: string, shift: boolean) => {
  if (code === "Space") return " ";

  if (/^Key[A-Z]$/.test(code)) {
    const letter = code.slice(3);
    return shift ? letter : letter.toLowerCase();
  }

  if (/^Digit[0-9]$/.test(code)) {
    return shift ? shiftedNumberMap[code] : code.slice(5);
  }

  if (code.startsWith("Numpad") && code.length === "Numpad0".length) {
    const numeric = code.slice("Numpad".length);
    if (/^[0-9]$/.test(numeric)) return numeric;
  }

  if (code === "NumpadAdd") return "+";
  if (code === "NumpadSubtract") return "-";
  if (code === "NumpadMultiply") return "*";
  if (code === "NumpadDivide") return "/";
  if (code === "NumpadDecimal") return ".";

  if (shift && shiftedSymbolMap[code]) return shiftedSymbolMap[code];
  if (!shift && unshiftedSymbolMap[code]) return unshiftedSymbolMap[code];
  return null;
};

const nonTextKeyCodes = new Set([
  "Escape",
  "Enter",
  "NumpadEnter",
  "Tab",
  "Backspace",
  "Delete",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Insert",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "Pause",
  "PrintScreen",
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
]);

const hasControlCharacters = (value: string) => {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
};

const resolveTextFromGlobalEvent = (event: GlobalKeyPayload) => {
  if (event.ctrl || event.meta || event.alt) return null;
  if (nonTextKeyCodes.has(event.code)) return null;
  if (/^F\d{1,2}$/.test(event.code)) return null;

  const mapped = mapPrintableCharacter(event.code, event.shift);
  const raw = event.text;
  const normalized = typeof raw === "string" ? raw.replace(/\r/g, "") : "";
  const hasValidRaw = normalized.length > 0 && !hasControlCharacters(normalized);

  // Preserve non-ASCII text from layout/IME, but force ASCII letter case by Shift state.
  if (/^Key[A-Z]$/.test(event.code)) {
    if (hasValidRaw && !/^[a-zA-Z]$/.test(normalized)) {
      return normalized;
    }
    const letter = event.code.slice(3);
    const caps = event.caps === true;
    const uppercase = event.shift !== caps;
    return uppercase ? letter : letter.toLowerCase();
  }

  if (mapped !== null && forceCodeMappedCodes.has(event.code)) {
    return mapped;
  }

  if (!hasValidRaw) return null;
  return normalized;
};

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(
  (
    {
      value,
      onChange,
      messages,
      maxLength,
      mode,
      captureActive = false,
      onSubmit,
      onCancel,
      onFocusRequest,
    },
    ref,
  ) => {
    const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
    const [showSuggestions, setShowSuggestions] = useState(false);
    const [activeIndex, setActiveIndex] = useState(0);
    const [selectionStart, setSelectionStart] = useState(0);
    const [selectionEnd, setSelectionEnd] = useState(0);
    const [isCaretVisible, setIsCaretVisible] = useState(true);

    const imeInputRef = useRef<HTMLInputElement>(null);
    const focuslessViewportRef = useRef<HTMLDivElement>(null);
    const focuslessAnchorRef = useRef<HTMLSpanElement>(null);
    const { currentJobId } = useChat();

    const usernames = useMemo(
      () => Array.from(new Set(messages.map((m) => m.author.username))),
      [messages],
    );

    useEffect(() => {
      const next = clamp(selectionStart, 0, value.length);
      const nextEnd = clamp(selectionEnd, 0, value.length);
      if (next !== selectionStart) setSelectionStart(next);
      if (nextEnd !== selectionEnd) setSelectionEnd(nextEnd);
    }, [selectionStart, selectionEnd, value.length]);

    useEffect(() => {
      const hasExplicitSelection = selectionStart !== selectionEnd;
      const caret = hasExplicitSelection
        ? Math.max(selectionStart, selectionEnd)
        : selectionEnd;
      const context = value.slice(0, caret);
      const lastWord = context.split(/\s/).pop() || "";

      let nextSuggestions: Suggestion[] = [];
      let shouldShow = false;

      if (lastWord.startsWith("@")) {
        const query = lastWord.slice(1).toLowerCase();
        const matches = usernames.filter((u) =>
          u.toLowerCase().startsWith(query),
        );
        nextSuggestions = matches.map((m) => ({ type: "mention", value: m }));
        shouldShow = matches.length > 0;
      } else if (lastWord.startsWith(":")) {
        const query = lastWord.slice(1).toLowerCase();
        const matches = findEmojiSuggestions(query);
        nextSuggestions = matches.map((m) => ({ type: "emoji", value: m }));
        shouldShow = matches.length > 0;
      }

      setSuggestions(nextSuggestions);
      setShowSuggestions(shouldShow);
      setActiveIndex(0);
    }, [selectionEnd, selectionStart, usernames, value]);

    const updateSelection = (start: number, end: number) => {
      setSelectionStart(clamp(start, 0, value.length));
      setSelectionEnd(clamp(end, 0, value.length));
    };

    const applyValueAndSelection = (
      nextValue: string,
      nextSelectionStart: number,
      nextSelectionEnd: number,
    ) => {
      flushSync(() => {
        onChange(nextValue);
        const clampedStart = clamp(nextSelectionStart, 0, nextValue.length);
        const clampedEnd = clamp(nextSelectionEnd, 0, nextValue.length);
        setSelectionStart(clampedStart);
        setSelectionEnd(clampedEnd);
      });
    };

    const replaceSelectionWith = (insertText: string) => {
      const normalized = toNormalizedRange(selectionStart, selectionEnd);
      const nextValue =
        value.slice(0, normalized.start) + insertText + value.slice(normalized.end);
      const nextCaret = normalized.start + insertText.length;
      applyValueAndSelection(nextValue, nextCaret, nextCaret);
    };

    const insertSuggestion = (suggestion: Suggestion) => {
      const normalized = toNormalizedRange(selectionStart, selectionEnd);
      const before = value.slice(0, normalized.start);
      const after = value.slice(normalized.end);

      const lastWhitespace = Math.max(
        before.lastIndexOf(" "),
        before.lastIndexOf("\t"),
        before.lastIndexOf("\n"),
      );
      const wordStart = lastWhitespace + 1;

      const replacement =
        suggestion.type === "mention"
          ? `@${suggestion.value}`
          : suggestion.value.emoji;

      const nextBefore = `${before.slice(0, wordStart)}${replacement} `;
      const nextValue = `${nextBefore}${after}`;
      const nextCaret = nextBefore.length;

      applyValueAndSelection(nextValue, nextCaret, nextCaret);
      setShowSuggestions(false);
      imeInputRef.current?.focus();
    };

    const moveCaret = (delta: number, extend: boolean) => {
      if (extend) {
        const nextEnd = clamp(selectionEnd + delta, 0, value.length);
        updateSelection(selectionStart, nextEnd);
        return;
      }

      const normalized = toNormalizedRange(selectionStart, selectionEnd);
      if (selectionStart !== selectionEnd) {
        const collapsedTo = delta < 0 ? normalized.start : normalized.end;
        updateSelection(collapsedTo, collapsedTo);
        return;
      }

      const next = clamp(normalized.end + delta, 0, value.length);
      updateSelection(next, next);
    };

    const moveCaretToBoundary = (toEnd: boolean, extend: boolean) => {
      const next = toEnd ? value.length : 0;
      if (extend) {
        updateSelection(selectionStart, next);
      } else {
        updateSelection(next, next);
      }
    };

    const deleteBackward = () => {
      const normalized = toNormalizedRange(selectionStart, selectionEnd);
      if (normalized.start !== normalized.end) {
        replaceSelectionWith("");
        return;
      }

      if (normalized.start === 0) return;
      const nextValue =
        value.slice(0, normalized.start - 1) + value.slice(normalized.start);
      const nextCaret = normalized.start - 1;
      applyValueAndSelection(nextValue, nextCaret, nextCaret);
    };

    const deleteForward = () => {
      const normalized = toNormalizedRange(selectionStart, selectionEnd);
      if (normalized.start !== normalized.end) {
        replaceSelectionWith("");
        return;
      }

      if (normalized.end >= value.length) return;
      const nextValue = value.slice(0, normalized.end) + value.slice(normalized.end + 1);
      applyValueAndSelection(nextValue, normalized.end, normalized.end);
    };

    const handleClipboardShortcut = async (
      event: GlobalKeyPayload,
    ): Promise<boolean> => {
      const isCtrlOrMeta = event.ctrl || event.meta;
      if (!isCtrlOrMeta || event.alt || event.phase !== "down") return false;

      const normalized = toNormalizedRange(selectionStart, selectionEnd);
      const selectedText = value.slice(normalized.start, normalized.end);

      if (event.code === "KeyA") {
        updateSelection(0, value.length);
        return true;
      }

      if (event.code === "KeyC") {
        if (!selectedText) return true;
        try {
          await invoke("write_clipboard_text", { value: selectedText });
        } catch (err) {
          console.error("Failed to copy selected text:", err);
        }
        return true;
      }

      if (event.code === "KeyX") {
        if (!selectedText) return true;
        try {
          await invoke("write_clipboard_text", { value: selectedText });
        } catch (err) {
          console.error("Failed to cut selected text:", err);
        }
        replaceSelectionWith("");
        return true;
      }

      if (event.code === "KeyV") {
        const clipboard = await invoke<string>("read_clipboard_text").catch(
          () => "",
        );
        if (!clipboard) return true;
        replaceSelectionWith(clipboard);
        return true;
      }

      return false;
    };

    const handleFocuslessGlobalKey = async (
      event: GlobalKeyPayload,
    ): Promise<ChatInputKeyAction> => {
      if (event.phase !== "down") return "none";

      if (await handleClipboardShortcut(event)) return "none";

      if (!event.ctrl && !event.meta && !event.alt) {
        if (event.code === "Escape") return "cancel";

        if (event.code === "ArrowDown" && showSuggestions && suggestions.length > 0) {
          setActiveIndex((prev) => (prev + 1) % suggestions.length);
          return "none";
        }

        if (event.code === "ArrowUp" && showSuggestions && suggestions.length > 0) {
          setActiveIndex((prev) =>
            prev === 0 ? suggestions.length - 1 : prev - 1,
          );
          return "none";
        }

        if (event.code === "Tab" && showSuggestions && suggestions.length > 0) {
          insertSuggestion(suggestions[activeIndex]);
          return "none";
        }

        if (event.code === "Enter" || event.code === "NumpadEnter") {
          return "submit";
        }

        if (event.code === "Backspace") {
          deleteBackward();
          return "none";
        }

        if (event.code === "Delete") {
          deleteForward();
          return "none";
        }

        if (event.code === "ArrowLeft") {
          moveCaret(-1, event.shift);
          return "none";
        }

        if (event.code === "ArrowRight") {
          moveCaret(1, event.shift);
          return "none";
        }

        if (event.code === "Home") {
          moveCaretToBoundary(false, event.shift);
          return "none";
        }

        if (event.code === "End") {
          moveCaretToBoundary(true, event.shift);
          return "none";
        }

        const textFromEvent = resolveTextFromGlobalEvent(event);
        if (textFromEvent !== null) {
          replaceSelectionWith(textFromEvent);
          return "none";
        }

        const printable = mapPrintableCharacter(event.code, event.shift);
        if (printable !== null) {
          replaceSelectionWith(printable);
          return "none";
        }
      }

      return "none";
    };

    useImperativeHandle(
      ref,
      (): ChatInputHandle => ({
        focusImeInput: () => {
          imeInputRef.current?.focus();
          const position = imeInputRef.current?.value.length ?? value.length;
          updateSelection(position, position);
        },
        handleGlobalKey: async (event: GlobalKeyPayload) => {
          if (mode !== "focusless") return "none";
          return handleFocuslessGlobalKey(event);
        },
      }),
      [mode, value, selectionStart, selectionEnd, suggestions, showSuggestions, activeIndex],
    );

    const trimmedLength = value.trim().length;
    const remainingChars = maxLength - trimmedLength;
    const isOverLimit = remainingChars < 0;
    const placeholder = `Chatting ${
      currentJobId === "global"
        ? "globally. If you're in a server, try rejoining."
        : `job id ${currentJobId}`
    }`;

    const normalizedSelection = toNormalizedRange(selectionStart, selectionEnd);
    const hasSelection = normalizedSelection.start !== normalizedSelection.end;
    const beforeText = value.slice(0, normalizedSelection.start);
    const selectedText = value.slice(
      normalizedSelection.start,
      normalizedSelection.end,
    );
    const afterText = value.slice(normalizedSelection.end);
    const focuslessSessionActive = mode === "focusless" && captureActive;
    const showFocuslessCaret =
      focuslessSessionActive && !hasSelection && isCaretVisible;
    const focuslessCaretOpacityClass = showFocuslessCaret ? "opacity-100" : "opacity-0";
    const focuslessCaretClass = `inline-block w-px h-[1.08em] bg-primary align-[-0.12em] ${focuslessCaretOpacityClass}`;

    useEffect(() => {
      if (!focuslessSessionActive) {
        setIsCaretVisible(true);
        return;
      }

      const timer = window.setInterval(() => {
        setIsCaretVisible((prev) => !prev);
      }, 530);

      return () => {
        window.clearInterval(timer);
      };
    }, [focuslessSessionActive]);

    useEffect(() => {
      if (mode !== "focusless") return;
      if (!focuslessSessionActive) return;
      focuslessAnchorRef.current?.scrollIntoView({
        block: "nearest",
        inline: "nearest",
      });
    }, [mode, focuslessSessionActive, value, selectionStart, selectionEnd]);

    return (
      <div className="relative w-full min-w-0">
        {mode === "ime" ? (
          <input
            ref={imeInputRef}
            value={value}
            onChange={(e) => {
              onChange(e.target.value);
              const next = e.target.selectionStart ?? e.target.value.length;
              updateSelection(next, e.target.selectionEnd ?? next);
            }}
            onSelect={(event) => {
              const target = event.currentTarget;
              const start = target.selectionStart ?? target.value.length;
              const end = target.selectionEnd ?? start;
              updateSelection(start, end);
            }}
            onClick={(event) => {
              const target = event.currentTarget;
              const start = target.selectionStart ?? target.value.length;
              const end = target.selectionEnd ?? start;
              updateSelection(start, end);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onCancel();
                return;
              }

              if (e.key === "ArrowDown" && showSuggestions && suggestions.length > 0) {
                e.preventDefault();
                setActiveIndex((prev) => (prev + 1) % suggestions.length);
                return;
              }
              if (e.key === "ArrowUp" && showSuggestions && suggestions.length > 0) {
                e.preventDefault();
                setActiveIndex((prev) =>
                  prev === 0 ? suggestions.length - 1 : prev - 1,
                );
                return;
              }
              if (e.key === "Tab" && showSuggestions && suggestions.length > 0) {
                e.preventDefault();
                insertSuggestion(suggestions[activeIndex]);
                return;
              }

              if (e.key === "Enter") {
                e.preventDefault();
                onSubmit();
              }
            }}
            placeholder={placeholder}
            className="h-10 w-full outline-none text-primary text-sm px-2 bg-transparent"
          />
        ) : (
          <div
            ref={focuslessViewportRef}
            role="textbox"
            aria-label="Chat input"
            aria-multiline={false}
            tabIndex={0}
            onMouseDown={(event) => {
              event.preventDefault();
              event.currentTarget.focus();
              updateSelection(value.length, value.length);
              onFocusRequest?.();
            }}
            className="h-10 w-full min-w-0 text-primary text-sm px-2 flex items-center overflow-x-auto overflow-y-hidden select-none outline-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {value.length === 0 ? (
              <span className="inline-block whitespace-pre min-w-full">
                <span
                  aria-hidden
                  className={`${focuslessCaretClass} mr-0.5`}
                />
                <span
                  ref={focuslessAnchorRef}
                  aria-hidden
                  className="inline-block h-4 w-0 align-middle"
                />
                <span className="text-muted-foreground">{placeholder}</span>
              </span>
            ) : hasSelection ? (
              <span className="inline-block whitespace-pre min-w-full">
                {beforeText}
                <span className="bg-brand/30">{selectedText || " "}</span>
                <span
                  ref={focuslessAnchorRef}
                  aria-hidden
                  className="inline-block h-4 w-0 align-middle"
                />
                {afterText}
              </span>
            ) : (
              <span className="inline-block whitespace-pre min-w-full">
                {beforeText}
                <span
                  aria-hidden
                  className={focuslessCaretClass}
                />
                <span
                  ref={focuslessAnchorRef}
                  aria-hidden
                  className="inline-block h-4 w-0 align-middle"
                />
                {afterText}
              </span>
            )}
          </div>
        )}

        <div
          className={`absolute right-2 -top-5 text-[10px] ${
            isOverLimit ? "text-red-400" : "text-muted-foreground"
          }`}
        >
          {remainingChars} chars
        </div>

        {showSuggestions && suggestions.length > 0 && (
          <ul className="absolute bottom-10 left-0 w-full bg-background max-h-40 overflow-y-auto z-10">
            {suggestions.map((suggestion, idx) => (
              <li
                key={
                  suggestion.type === "mention"
                    ? `mention-${suggestion.value}`
                    : `emoji-${suggestion.value.shortcode}`
                }
                className={`px-2 py-1 cursor-pointer ${
                  idx === activeIndex ? "bg-muted/50" : ""
                }`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  insertSuggestion(suggestion);
                }}
              >
                {suggestion.type === "mention" ? (
                  suggestion.value
                ) : (
                  <span className="flex items-center gap-2">
                    <span className="inline-block text-base leading-none">
                      {replaceEmojiShortcodes(suggestion.value.emoji)}
                    </span>
                    <span className="text-muted-foreground">
                      :{suggestion.value.shortcode}:
                    </span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  },
);

ChatInput.displayName = "ChatInput";

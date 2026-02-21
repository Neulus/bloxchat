import { useEffect, useRef } from "react";
import { Window } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { ChatMessage } from "@bloxchat/api";

const TRIGGER_KEY = "Slash";

export function useTauriEvents(
  inputRef: React.RefObject<HTMLInputElement | null>,
  _setCurrentJobId: (id: string) => void,
  _setMessages: (msgs: ChatMessage[]) => void,
) {
  const appWindowRef = useRef<Window | null>(null);

  useEffect(() => {
    (async () => {
      appWindowRef.current = await Window.getByLabel("main");
    })();
  }, []);

  useEffect(() => {
    const unlistenFocus = listen("tauri://focus", () => {
      inputRef.current?.focus();
    });

    const unlistenKeys = listen("key-pressed", (event: { payload: string }) => {
      invoke("should_steal_focus").then((robloxFocused) => {
        if (
          robloxFocused &&
          appWindowRef.current &&
          event.payload === TRIGGER_KEY
        ) {
          appWindowRef.current.setFocus();
          inputRef.current?.focus();
        }
      });
    });

    return () => {
      unlistenFocus.then((f) => f());
      unlistenKeys.then((f) => f());
    };
  }, [inputRef]);

  return { appWindow: appWindowRef.current };
}

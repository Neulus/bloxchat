use anyhow::Result;
use rdev::{grab, listen, Event, EventType, Key};
use serde::Serialize;
use std::collections::HashSet;
use std::mem;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, MAPVK_VK_TO_VSC_EX, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

#[derive(Clone, Copy)]
enum ChatKeyPersistenceMode {
    Full,
    Wasd,
    None,
}

impl ChatKeyPersistenceMode {
    fn parse(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "none" => Self::None,
            "wasd" => Self::Wasd,
            _ => Self::Full,
        }
    }
}

impl Default for ChatKeyPersistenceMode {
    fn default() -> Self {
        Self::Full
    }
}

#[derive(Clone, Copy)]
enum ChatInputMode {
    Focusless,
    Ime,
}

impl ChatInputMode {
    fn parse(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "ime" => Self::Ime,
            _ => Self::Focusless,
        }
    }
}

impl Default for ChatInputMode {
    fn default() -> Self {
        Self::Focusless
    }
}

#[derive(Default)]
struct InputCaptureInner {
    physical_down: HashSet<Key>,
    active: bool,
    mode: ChatKeyPersistenceMode,
    input_mode: ChatInputMode,
    latched_keys: HashSet<Key>,
    capture_started_down: HashSet<Key>,
}

#[derive(Clone, Default)]
pub(crate) struct InputCaptureState {
    inner: Arc<Mutex<InputCaptureInner>>,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum KeyPhase {
    Down,
    Up,
}

#[derive(Clone, Serialize)]
pub(crate) struct GlobalKeyEvent {
    pub(crate) code: String,
    pub(crate) text: Option<String>,
    pub(crate) phase: KeyPhase,
    pub(crate) ctrl: bool,
    pub(crate) shift: bool,
    pub(crate) caps: bool,
    pub(crate) alt: bool,
    pub(crate) meta: bool,
    pub(crate) repeat: bool,
    pub(crate) timestamp_ms: i64,
}

pub(crate) fn start_key_listener(app: AppHandle, state: InputCaptureState) {
    std::thread::spawn(move || {
        let grab_app = app.clone();
        let grab_state = state.clone();
        let grab_callback = move |event: Event| -> Option<Event> {
            let should_suppress = handle_event(&grab_app, &grab_state, &event, true);
            if should_suppress { None } else { Some(event) }
        };

        if let Err(err) = grab(grab_callback) {
            eprintln!(
                "Error in global input grab listener ({err:?}), falling back to passive listening",
            );

            let callback = move |event: Event| {
                let _ = handle_event(&app, &state, &event, false);
            };

            if let Err(err) = listen(callback) {
                eprintln!("Error in global input listener: {:?}", err);
            }
        }
    });
}

pub(crate) fn start_chat_capture(
    state: &InputCaptureState,
    mode: &str,
    input_mode: &str,
) -> Result<()> {
    let mode = ChatKeyPersistenceMode::parse(mode);
    let input_mode = ChatInputMode::parse(input_mode);
    let latched = {
        let mut inner = state
            .inner
            .lock()
            .map_err(|err| anyhow::anyhow!("lock input state: {err}"))?;

        inner.mode = mode;
        inner.input_mode = input_mode;
        inner.capture_started_down = inner.physical_down.clone();
        inner.latched_keys = select_latched_keys(&inner.physical_down, mode);
        inner.latched_keys.iter().copied().collect::<Vec<_>>()
    };

    // Create a synthetic press for persisted keys so stop can reliably end it with a synthetic release.
    for key in latched {
        inject_key_event(key, false);
    }

    let mut inner = state
        .inner
        .lock()
        .map_err(|err| anyhow::anyhow!("lock input state: {err}"))?;
    inner.active = true;

    Ok(())
}

pub(crate) fn stop_chat_capture(state: &InputCaptureState) -> Result<()> {
    let keys_to_release = {
        let mut inner = state
            .inner
            .lock()
            .map_err(|err| anyhow::anyhow!("lock input state: {err}"))?;
        inner.active = false;
        inner.capture_started_down.clear();
        mem::take(&mut inner.latched_keys)
    };

    schedule_latched_key_release(keys_to_release.into_iter().collect());

    Ok(())
}

fn handle_event(
    app: &AppHandle,
    state: &InputCaptureState,
    event: &Event,
    suppression_enabled: bool,
) -> bool {
    let can_suppress = suppression_enabled && should_intercept_for_roblox(app);

    match event.event_type {
        EventType::KeyPress(key) => {
            let (payload, suppress_event, keys_to_release) = {
                let mut inner = match state.inner.lock() {
                    Ok(guard) => guard,
                    Err(err) => {
                        eprintln!("failed to lock input state on key press: {err}");
                        return false;
                    }
                };

                let repeat = !inner.physical_down.insert(key);
                let should_backend_stop = inner.active
                    && matches!(inner.input_mode, ChatInputMode::Focusless)
                    && matches!(key, Key::Return | Key::KpReturn | Key::Escape);
                let suppress_event = if should_backend_stop {
                    can_suppress
                } else {
                    can_suppress
                        && should_suppress_key_event(&inner, key, KeyPhase::Down, false)
                };
                let keys_to_release = if should_backend_stop {
                    inner.active = false;
                    inner.capture_started_down.clear();
                    mem::take(&mut inner.latched_keys).into_iter().collect()
                } else {
                    Vec::new()
                };
                let payload = build_global_key_event(
                    key,
                    KeyPhase::Down,
                    &inner.physical_down,
                    repeat,
                    event.name.as_deref(),
                );
                (payload, suppress_event, keys_to_release)
            };

            schedule_latched_key_release(keys_to_release);

            let _ = app.emit("global-key", payload);
            suppress_event
        }
        EventType::KeyRelease(key) => {
            let (payload, should_reinject, suppress_event) = {
                let mut inner = match state.inner.lock() {
                    Ok(guard) => guard,
                    Err(err) => {
                        eprintln!("failed to lock input state on key release: {err}");
                        return false;
                    }
                };

                let was_down_at_capture = inner.capture_started_down.remove(&key);
                let suppress_event =
                    can_suppress
                        && should_suppress_key_event(
                            &inner,
                            key,
                            KeyPhase::Up,
                            was_down_at_capture,
                        );
                inner.physical_down.remove(&key);
                let should_reinject =
                    inner.active && inner.latched_keys.contains(&key) && !suppress_event;
                let payload =
                    build_global_key_event(key, KeyPhase::Up, &inner.physical_down, false, None);
                (payload, should_reinject, suppress_event)
            };

            if should_reinject {
                inject_key_event(key, false);
            }

            let _ = app.emit("global-key", payload);
            suppress_event
        }
        _ => false,
    }
}

fn should_intercept_for_roblox(app: &AppHandle) -> bool {
    if is_app_window_foreground(app) {
        return false;
    }

    crate::roblox::should_steal_focus(app.clone())
}

fn is_app_window_foreground(app: &AppHandle) -> bool {
    unsafe {
        let foreground = GetForegroundWindow();
        if foreground.0 == std::ptr::null_mut() {
            return false;
        }

        for window in app.webview_windows().values() {
            let Ok(hwnd) = window.hwnd() else {
                continue;
            };

            if hwnd.0 == foreground.0 {
                return true;
            }
        }

        false
    }
}

fn should_suppress_key_event(
    inner: &InputCaptureInner,
    key: Key,
    phase: KeyPhase,
    was_down_at_capture: bool,
) -> bool {
    if !inner.active {
        return matches!(key, Key::Slash);
    }

    if !matches!(inner.input_mode, ChatInputMode::Focusless) {
        return false;
    }

    if should_allow_system_shortcut_during_capture(key, &inner.physical_down) {
        return false;
    }

    if inner.latched_keys.contains(&key) {
        return true;
    }

    if matches!(phase, KeyPhase::Up) && was_down_at_capture {
        return false;
    }

    true
}

fn should_allow_system_shortcut_during_capture(key: Key, down_keys: &HashSet<Key>) -> bool {
    if matches!(key, Key::Alt | Key::AltGr | Key::MetaLeft | Key::MetaRight) {
        return true;
    }

    let alt_down = is_alt_down(down_keys);
    let meta_down = is_meta_down(down_keys);

    if meta_down {
        return true;
    }

    if alt_down && matches!(key, Key::Tab | Key::F4) {
        return true;
    }

    false
}

fn is_alt_down(down_keys: &HashSet<Key>) -> bool {
    down_keys.contains(&Key::Alt) || down_keys.contains(&Key::AltGr)
}

fn is_meta_down(down_keys: &HashSet<Key>) -> bool {
    down_keys.contains(&Key::MetaLeft) || down_keys.contains(&Key::MetaRight)
}

fn build_global_key_event(
    key: Key,
    phase: KeyPhase,
    down_keys: &HashSet<Key>,
    repeat: bool,
    text: Option<&str>,
) -> GlobalKeyEvent {
    let ctrl = down_keys.contains(&Key::ControlLeft) || down_keys.contains(&Key::ControlRight);
    let shift = down_keys.contains(&Key::ShiftLeft) || down_keys.contains(&Key::ShiftRight);
    let caps = is_caps_lock_enabled();
    let alt = down_keys.contains(&Key::Alt) || down_keys.contains(&Key::AltGr);
    let meta = down_keys.contains(&Key::MetaLeft) || down_keys.contains(&Key::MetaRight);

    let timestamp_ms = event_timestamp_ms();

    GlobalKeyEvent {
        code: key_to_code(key),
        text: sanitize_event_text(text),
        phase,
        ctrl,
        shift,
        caps,
        alt,
        meta,
        repeat,
        timestamp_ms,
    }
}

fn is_caps_lock_enabled() -> bool {
    // 0x14 = VK_CAPITAL. The low-order bit of GetKeyState indicates toggle state.
    unsafe { windows::Win32::UI::Input::KeyboardAndMouse::GetKeyState(0x14) & 1 != 0 }
}

fn sanitize_event_text(value: Option<&str>) -> Option<String> {
    let raw = value?;
    if raw.is_empty() {
        return None;
    }

    let normalized = raw.replace('\r', "");
    if normalized.is_empty() {
        return None;
    }

    if normalized.chars().any(char::is_control) {
        return None;
    }

    Some(normalized)
}

fn schedule_latched_key_release(keys: Vec<Key>) {
    if keys.is_empty() {
        return;
    }

    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(8));

        // Retry a few times in case the game drops synthetic transitions on the first frame.
        for attempt in 0..4 {
            if attempt > 0 {
                std::thread::sleep(std::time::Duration::from_millis(14));
            }
            release_latched_keys(keys.clone());
        }
    });
}

fn release_latched_keys(keys: Vec<Key>) {
    for key in keys {
        // Cleanup should only release keys that we explicitly latched.
        inject_key_event(key, true);
    }
}

fn event_timestamp_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};

    let now = match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(value) => value,
        Err(_) => return 0,
    };

    now.as_millis() as i64
}

fn select_latched_keys(physical_down: &HashSet<Key>, mode: ChatKeyPersistenceMode) -> HashSet<Key> {
    match mode {
        ChatKeyPersistenceMode::None => HashSet::new(),
        ChatKeyPersistenceMode::Wasd => physical_down
            .iter()
            .copied()
            .filter(|key| matches!(key, Key::KeyW | Key::KeyA | Key::KeyS | Key::KeyD))
            .collect(),
        ChatKeyPersistenceMode::Full => physical_down
            .iter()
            .copied()
            .filter(|key| is_full_latch_eligible(*key))
            .collect(),
    }
}

fn is_full_latch_eligible(key: Key) -> bool {
    if matches!(key, Key::Slash | Key::Escape | Key::Return) {
        return false;
    }

    key_to_virtual_key(key).is_some()
}

fn key_to_code(key: Key) -> String {
    let code = match key {
        Key::KeyA => "KeyA",
        Key::KeyB => "KeyB",
        Key::KeyC => "KeyC",
        Key::KeyD => "KeyD",
        Key::KeyE => "KeyE",
        Key::KeyF => "KeyF",
        Key::KeyG => "KeyG",
        Key::KeyH => "KeyH",
        Key::KeyI => "KeyI",
        Key::KeyJ => "KeyJ",
        Key::KeyK => "KeyK",
        Key::KeyL => "KeyL",
        Key::KeyM => "KeyM",
        Key::KeyN => "KeyN",
        Key::KeyO => "KeyO",
        Key::KeyP => "KeyP",
        Key::KeyQ => "KeyQ",
        Key::KeyR => "KeyR",
        Key::KeyS => "KeyS",
        Key::KeyT => "KeyT",
        Key::KeyU => "KeyU",
        Key::KeyV => "KeyV",
        Key::KeyW => "KeyW",
        Key::KeyX => "KeyX",
        Key::KeyY => "KeyY",
        Key::KeyZ => "KeyZ",
        Key::Num1 => "Digit1",
        Key::Num2 => "Digit2",
        Key::Num3 => "Digit3",
        Key::Num4 => "Digit4",
        Key::Num5 => "Digit5",
        Key::Num6 => "Digit6",
        Key::Num7 => "Digit7",
        Key::Num8 => "Digit8",
        Key::Num9 => "Digit9",
        Key::Num0 => "Digit0",
        Key::Escape => "Escape",
        Key::F1 => "F1",
        Key::F2 => "F2",
        Key::F3 => "F3",
        Key::F4 => "F4",
        Key::F5 => "F5",
        Key::F6 => "F6",
        Key::F7 => "F7",
        Key::F8 => "F8",
        Key::F9 => "F9",
        Key::F10 => "F10",
        Key::F11 => "F11",
        Key::F12 => "F12",
        Key::BackQuote => "Backquote",
        Key::Minus => "Minus",
        Key::Equal => "Equal",
        Key::Backspace => "Backspace",
        Key::Tab => "Tab",
        Key::LeftBracket => "BracketLeft",
        Key::RightBracket => "BracketRight",
        Key::BackSlash => "Backslash",
        Key::CapsLock => "CapsLock",
        Key::SemiColon => "Semicolon",
        Key::Quote => "Quote",
        Key::Return => "Enter",
        Key::ShiftLeft => "ShiftLeft",
        Key::ShiftRight => "ShiftRight",
        Key::ControlLeft => "ControlLeft",
        Key::ControlRight => "ControlRight",
        Key::Alt => "AltLeft",
        Key::AltGr => "AltRight",
        Key::MetaLeft => "MetaLeft",
        Key::MetaRight => "MetaRight",
        Key::Space => "Space",
        Key::PrintScreen => "PrintScreen",
        Key::ScrollLock => "ScrollLock",
        Key::Pause => "Pause",
        Key::Insert => "Insert",
        Key::Home => "Home",
        Key::PageUp => "PageUp",
        Key::Delete => "Delete",
        Key::End => "End",
        Key::PageDown => "PageDown",
        Key::RightArrow => "ArrowRight",
        Key::LeftArrow => "ArrowLeft",
        Key::DownArrow => "ArrowDown",
        Key::UpArrow => "ArrowUp",
        Key::NumLock => "NumLock",
        Key::Kp0 => "Numpad0",
        Key::Kp1 => "Numpad1",
        Key::Kp2 => "Numpad2",
        Key::Kp3 => "Numpad3",
        Key::Kp4 => "Numpad4",
        Key::Kp5 => "Numpad5",
        Key::Kp6 => "Numpad6",
        Key::Kp7 => "Numpad7",
        Key::Kp8 => "Numpad8",
        Key::Kp9 => "Numpad9",
        Key::KpMultiply => "NumpadMultiply",
        Key::KpPlus => "NumpadAdd",
        Key::KpMinus => "NumpadSubtract",
        Key::KpDelete => "NumpadDecimal",
        Key::KpDivide => "NumpadDivide",
        Key::KpReturn => "NumpadEnter",
        Key::Slash => "Slash",
        Key::Dot => "Period",
        Key::Comma => "Comma",
        _ => return format!("{key:?}"),
    };

    code.to_string()
}

fn key_to_virtual_key(key: Key) -> Option<VIRTUAL_KEY> {
    let vk = match key {
        Key::KeyA => 0x41,
        Key::KeyB => 0x42,
        Key::KeyC => 0x43,
        Key::KeyD => 0x44,
        Key::KeyE => 0x45,
        Key::KeyF => 0x46,
        Key::KeyG => 0x47,
        Key::KeyH => 0x48,
        Key::KeyI => 0x49,
        Key::KeyJ => 0x4A,
        Key::KeyK => 0x4B,
        Key::KeyL => 0x4C,
        Key::KeyM => 0x4D,
        Key::KeyN => 0x4E,
        Key::KeyO => 0x4F,
        Key::KeyP => 0x50,
        Key::KeyQ => 0x51,
        Key::KeyR => 0x52,
        Key::KeyS => 0x53,
        Key::KeyT => 0x54,
        Key::KeyU => 0x55,
        Key::KeyV => 0x56,
        Key::KeyW => 0x57,
        Key::KeyX => 0x58,
        Key::KeyY => 0x59,
        Key::KeyZ => 0x5A,
        Key::Num1 => 0x31,
        Key::Num2 => 0x32,
        Key::Num3 => 0x33,
        Key::Num4 => 0x34,
        Key::Num5 => 0x35,
        Key::Num6 => 0x36,
        Key::Num7 => 0x37,
        Key::Num8 => 0x38,
        Key::Num9 => 0x39,
        Key::Num0 => 0x30,
        Key::Escape => 0x1B,
        Key::BackQuote => 0xC0,
        Key::Minus => 0xBD,
        Key::Equal => 0xBB,
        Key::Backspace => 0x08,
        Key::Tab => 0x09,
        Key::LeftBracket => 0xDB,
        Key::RightBracket => 0xDD,
        Key::BackSlash => 0xDC,
        Key::CapsLock => 0x14,
        Key::SemiColon => 0xBA,
        Key::Quote => 0xDE,
        Key::Return => 0x0D,
        Key::ShiftLeft => 0xA0,
        Key::ShiftRight => 0xA1,
        Key::ControlLeft => 0xA2,
        Key::ControlRight => 0xA3,
        Key::Alt => 0xA4,
        Key::AltGr => 0xA5,
        Key::MetaLeft => 0x5B,
        Key::MetaRight => 0x5C,
        Key::Space => 0x20,
        Key::PrintScreen => 0x2C,
        Key::ScrollLock => 0x91,
        Key::Pause => 0x13,
        Key::Insert => 0x2D,
        Key::Home => 0x24,
        Key::PageUp => 0x21,
        Key::Delete => 0x2E,
        Key::End => 0x23,
        Key::PageDown => 0x22,
        Key::RightArrow => 0x27,
        Key::LeftArrow => 0x25,
        Key::DownArrow => 0x28,
        Key::UpArrow => 0x26,
        Key::NumLock => 0x90,
        Key::Kp0 => 0x60,
        Key::Kp1 => 0x61,
        Key::Kp2 => 0x62,
        Key::Kp3 => 0x63,
        Key::Kp4 => 0x64,
        Key::Kp5 => 0x65,
        Key::Kp6 => 0x66,
        Key::Kp7 => 0x67,
        Key::Kp8 => 0x68,
        Key::Kp9 => 0x69,
        Key::KpMultiply => 0x6A,
        Key::KpPlus => 0x6B,
        Key::KpMinus => 0x6D,
        Key::KpDelete => 0x6E,
        Key::KpDivide => 0x6F,
        Key::KpReturn => 0x0D,
        Key::Slash => 0xBF,
        Key::Dot => 0xBE,
        Key::Comma => 0xBC,
        _ => return None,
    };

    Some(VIRTUAL_KEY(vk))
}

fn inject_key_event(key: Key, key_up: bool) {
    let Some(vk) = key_to_virtual_key(key) else {
        return;
    };

    let mapped = unsafe { MapVirtualKeyW(vk.0 as u32, MAPVK_VK_TO_VSC_EX) };
    if mapped != 0 {
        let scan_code = (mapped & 0xFF) as u16;
        let extended_prefix = mapped & 0xFF00;

        let mut flags = KEYEVENTF_SCANCODE;
        if extended_prefix == 0xE000 || extended_prefix == 0xE100 {
            flags |= KEYEVENTF_EXTENDEDKEY;
        }
        if key_up {
            flags |= KEYEVENTF_KEYUP;
        }

        let input = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(0),
                    wScan: scan_code,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };

        unsafe {
            let _ = SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
        }
    }

    let mut flags = KEYBD_EVENT_FLAGS(0);
    if key_up {
        flags |= KEYEVENTF_KEYUP;
    }

    let fallback = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };

    unsafe {
        let _ = SendInput(&[fallback], std::mem::size_of::<INPUT>() as i32);
    }
}

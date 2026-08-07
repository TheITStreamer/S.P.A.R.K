use std::sync::{Arc, Condvar, Mutex};
use std::sync::atomic::{AtomicU64, AtomicBool, Ordering};
use std::collections::VecDeque;
use serde::{Serialize, Deserialize};
use serde_json::{json, Value};
use tauri::{Manager, State};

pub mod overlay;
pub mod twitch;

// ── Persistent data ───────────────────────────────────────────────────────────

#[derive(Default, Clone, Serialize, Deserialize)]
pub struct AppData {
    #[serde(default)] pub wheel:    Value,
    #[serde(default)] pub giveaway: Value,
    #[serde(default)] pub timers:   Value,
    #[serde(default)] pub tasks:    Value,
    #[serde(default)] pub goals:    Value,
    #[serde(default)] pub checkins: Value,
    #[serde(default)] pub songrequest: Value,
    #[serde(default)] pub chat:     Value,
    #[serde(default)] pub counters: Value,
    #[serde(default)] pub credits:  Value,
    #[serde(default)] pub diy:      Value,
    #[serde(default)] pub commands: Value,
    #[serde(default)] pub settings: Value,
    #[serde(default)] pub twitch_tokens: Value,
    // Optional second account used only for SENDING chat. Never backed up,
    // same as the broadcaster's tokens.
    #[serde(default)] pub bot_tokens: Value,
}

// One pending outbound message. The sender thread owns the pacing; callers
// just drop items here and move on.
#[derive(Clone)]
pub struct QueuedSend {
    pub announce: bool,
    pub message:  String,
    pub color:    String,
}

// ── Shared runtime state ──────────────────────────────────────────────────────

pub struct Shared {
    pub data:      Mutex<AppData>,
    pub data_path: Mutex<std::path::PathBuf>,
    // Overlay event bus (all tools write here; overlay long-polls)
    pub overlay_seq:    AtomicU64,
    pub overlay_events: Mutex<VecDeque<(u64, String)>>,
    // Wakes long-polling overlay connections the instant an event is pushed
    pub overlay_wake_lock: Mutex<()>,
    pub overlay_wake:      Condvar,
    // Follower-status cache shared by every tool: user_id -> (is_follower, checked_at_secs)
    pub follower_cache: Mutex<std::collections::HashMap<String, (bool, u64)>>,
    // Stream title/game/uptime for command variables, with the time it was
    // fetched. Commands can fire in bursts, so this is cached rather than hit
    // per message (Helix rate-limits per token).
    pub stream_info_cache: Mutex<Option<(Value, u64)>>,
    // Outbound chat queue, drained by one background sender thread so nothing
    // in the app can trip Twitch's rate limit. The Condvar pairs with the queue
    // mutex, so a send starts the instant something is pushed.
    pub send_queue: Mutex<VecDeque<QueuedSend>>,
    pub send_wake:  Condvar,
    // Why the bot account's last send was rejected ("" when it's fine).
    pub bot_send_error: Mutex<String>,
    // Held while a token refresh is in flight. Twitch invalidates the old
    // refresh token the moment a new one is issued, so two callers refreshing
    // at once means the loser is left holding a dead token and the app appears
    // to log itself out. ensure_token_for() takes this and then RE-CHECKS
    // expiry, so the second caller simply reuses what the first just fetched.
    // One lock covers both accounts: refreshes are rare and brief, and a shared
    // lock removes any chance of an ordering mistake between the two.
    pub token_refresh: Mutex<()>,
    // Latest full state snapshots for each overlay (served on first connect)
    pub overlay_wheel:    Mutex<String>,
    pub overlay_giveaway: Mutex<String>,
    pub overlay_timers:   Mutex<String>,
    pub overlay_tasks:    Mutex<String>,
    pub overlay_pomodoro: Mutex<String>,
    pub overlay_goals:    Mutex<String>,
    pub overlay_checkins: Mutex<String>,
    pub overlay_srqueue:  Mutex<String>,
    pub overlay_chat:     Mutex<String>,
    pub overlay_counters: Mutex<String>,
    pub overlay_credits:  Mutex<String>,
    // Per-tool master visibility (true = show on master)
    pub tool_visibility: Mutex<std::collections::HashMap<String, bool>>,
    // Master overlay editor accent (border/handles) — settable from Settings
    pub master_border: Mutex<String>,
    // HTTP server port
    pub server_port: AtomicU64,
    // Twitch runtime
    pub twitch_running: AtomicBool,
    pub twitch_stop:    Arc<AtomicBool>,
    // Chat listener stop signal
    pub chat_stop: Arc<AtomicBool>,
    // Thread generation counters. Each (re)connect bumps its counter; a running
    // listener thread exits as soon as it sees a generation newer than its own.
    // A stop-flag handshake alone would race: a thread blocked in socket.read()
    // can miss a brief stop=true window and survive, leaving two threads
    // emitting every event twice.
    pub twitch_gen: Arc<AtomicU64>,
    pub chat_gen:   Arc<AtomicU64>,
}

impl Shared {
    pub fn push_overlay_event(&self, tool: &str, payload: Value) {
        let id = self.overlay_seq.fetch_add(1, Ordering::SeqCst) + 1;
        let mut v = payload;
        v["_tool"] = json!(tool);
        v["_id"]   = json!(id);
        let s = v.to_string();
        {
            let mut q = self.overlay_events.lock().unwrap();
            q.push_back((id, s));
            while q.len() > 500 { q.pop_front(); }
        }
        self.overlay_wake.notify_all();
    }
}

// ── Disk helpers ──────────────────────────────────────────────────────────────

pub fn load_from_disk(path: &std::path::Path) -> AppData {
    if let Ok(b) = std::fs::read(path) {
        if let Ok(d) = serde_json::from_slice::<AppData>(&b) { return d; }
    }
    AppData::default()
}

// Every save goes through one temp file with a FIXED name, then renames it over
// the real file. Twitch commands run concurrently (spawn_blocking) alongside the
// EventSub and chat threads, so two saves could otherwise write that same temp
// file at once and rename a half-written mix into place. This lock serializes
// the write+rename pair so the atomic-rename guarantee still holds.
// Lock ordering is always data -> SAVE_LOCK (SAVE_LOCK is never taken first and
// never held while acquiring anything else), so it cannot deadlock.
static SAVE_LOCK: Mutex<()> = Mutex::new(());

pub fn save_to_disk(path: &std::path::Path, data: &AppData) {
    let _guard = SAVE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(p) = path.parent() { let _ = std::fs::create_dir_all(p); }
    // Compact (not pretty) serialization: this file is rewritten constantly
    // (every counter tick, follower-cache save, etc.) and carries every profile
    // snapshot — pretty formatting roughly doubles the size of every write.
    if let Ok(b) = serde_json::to_vec(data) {
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, &b).is_ok() { let _ = std::fs::rename(&tmp, path); }
    }
}

// Keep the last 3 known-good copies of spark-data.json (backup-1 = newest).
// Called on boot only when the current file PARSES — a corrupt file must never
// rotate good backups off the end — and before a restore overwrites everything.
pub fn rotate_backups(path: &std::path::Path) {
    if !path.exists() { return; }
    let name = |n: u32| path.with_file_name(format!("spark-data.backup-{}.json", n));
    let _ = std::fs::remove_file(name(3));
    for n in [2u32, 1u32] {
        let from = name(n);
        if from.exists() { let _ = std::fs::rename(&from, name(n + 1)); }
    }
    let _ = std::fs::copy(path, name(1));
}

// ── Generic persist helper called by every tool ───────────────────────────────

fn do_save(shared: &Shared) {
    let path = shared.data_path.lock().unwrap().clone();
    let data = shared.data.lock().unwrap().clone();
    save_to_disk(&path, &data);
}

// ── Tauri commands ─────────────────────────────────────────────────────────────

#[tauri::command]
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
fn load_all_data(shared: State<Shared>) -> Value {
    let d = shared.data.lock().unwrap();
    json!({
        "wheel":    d.wheel,
        "giveaway": d.giveaway,
        "timers":   d.timers,
        "tasks":    d.tasks,
        "goals":    d.goals,
        "checkins": d.checkins,
        "songrequest": d.songrequest,
        "chat":     d.chat,
        "counters": d.counters,
        "credits":  d.credits,
        "diy":      d.diy,
        "commands": d.commands,
        "settings": d.settings,
        "twitch_tokens": d.twitch_tokens,
    })
}

// ── Tool visibility (master overlay show/hide per tool) ───────────────────────

#[tauri::command]
fn set_tool_visibility(shared: State<Shared>, tool: String, visible: bool) {
    // Store so the master snapshot includes current visibility on first connect.
    shared.tool_visibility.lock().unwrap().insert(tool.clone(), visible);
    // Also push as an event so already-connected masters update live.
    let id = shared.overlay_seq.fetch_add(1, Ordering::SeqCst) + 1;
    let payload = json!({
        "_tool": "master",
        "_id": id,
        "type": "visibility",
        "tool": tool,
        "visible": visible,
    }).to_string();
    {
        let mut q = shared.overlay_events.lock().unwrap();
        q.push_back((id, payload));
        while q.len() > 500 { q.pop_front(); }
    }
    shared.overlay_wake.notify_all();
}

// Master overlay editor accent colour — stored for the snapshot and pushed
// live so an open master page recolours immediately.
#[tauri::command]
fn set_master_border(shared: State<Shared>, color: String) {
    *shared.master_border.lock().unwrap() = color.clone();
    let id = shared.overlay_seq.fetch_add(1, Ordering::SeqCst) + 1;
    let payload = json!({
        "_tool": "master", "_id": id,
        "type": "master-style", "borderColor": color,
    }).to_string();
    {
        let mut q = shared.overlay_events.lock().unwrap();
        q.push_back((id, payload));
        while q.len() > 500 { q.pop_front(); }
    }
    shared.overlay_wake.notify_all();
}

// ── Wheel commands ────────────────────────────────────────────────────────────

#[tauri::command]
fn save_wheel(shared: State<Shared>, data: Value) {
    shared.data.lock().unwrap().wheel = data;
    do_save(&shared);
}

#[tauri::command]
fn wheel_overlay_update(shared: State<Shared>, wheel: Value) {
    let s = wheel.to_string();
    *shared.overlay_wheel.lock().unwrap() = s;
    shared.push_overlay_event("wheel", json!({"type":"wheel","wheel":wheel}));
}

#[tauri::command]
fn wheel_overlay_spin(shared: State<Shared>, final_angle: f64, winner: String, winner_seconds: f64) {
    shared.push_overlay_event("wheel", json!({
        "type": "spin",
        "final_angle": final_angle,
        "winner": winner,
        "winner_seconds": winner_seconds,
    }));
}

// ── Giveaway commands ─────────────────────────────────────────────────────────

#[tauri::command]
fn save_giveaway(shared: State<Shared>, data: Value) {
    shared.data.lock().unwrap().giveaway = data;
    do_save(&shared);
}

#[tauri::command]
fn giveaway_overlay_update(shared: State<Shared>, state: Value) {
    let s = state.to_string();
    *shared.overlay_giveaway.lock().unwrap() = s;
    shared.push_overlay_event("giveaway", json!({"type":"giveaway_state","state":state}));
}

#[tauri::command]
fn giveaway_overlay_draw(shared: State<Shared>, winner: String, entries: Vec<String>, winner_seconds: Option<f64>) {
    shared.push_overlay_event("giveaway", json!({
        "type": "giveaway_draw",
        "winner": winner,
        "entries": entries,
        "winner_seconds": winner_seconds.unwrap_or(8.0),
    }));
}

// ── Timer commands ────────────────────────────────────────────────────────────

#[tauri::command]
fn save_timers(shared: State<Shared>, data: Value) {
    shared.data.lock().unwrap().timers = data;
    do_save(&shared);
}

#[tauri::command]
fn timers_overlay_update(shared: State<Shared>, timers: Value) {
    let s = timers.to_string();
    *shared.overlay_timers.lock().unwrap() = s;
    shared.push_overlay_event("timers", json!({"type":"timers_state","timers":timers}));
}

// ── Task commands ─────────────────────────────────────────────────────────────

#[tauri::command]
fn save_tasks(shared: State<Shared>, data: Value) {
    shared.data.lock().unwrap().tasks = data;
    do_save(&shared);
}

#[tauri::command]
fn tasks_overlay_update(shared: State<Shared>, state: Value) {
    let s = state.to_string();
    *shared.overlay_tasks.lock().unwrap() = s;
    shared.push_overlay_event("tasks", json!({"type":"tasks_state","state":state}));
}

// ── Pomodoro commands ─────────────────────────────────────────────────────────

#[tauri::command]
fn pomodoro_overlay_update(shared: State<Shared>, state: Value) {
    let s = state.to_string();
    *shared.overlay_pomodoro.lock().unwrap() = s;
    shared.push_overlay_event("pomodoro", json!({"type":"pomodoro_state","state":state}));
}

// ── Goals commands ────────────────────────────────────────────────────────────

#[tauri::command]
fn save_goals(shared: State<Shared>, data: Value) {
    shared.data.lock().unwrap().goals = data;
    do_save(&shared);
}

#[tauri::command]
fn goals_overlay_update(shared: State<Shared>, goals: Value) {
    let s = goals.to_string();
    *shared.overlay_goals.lock().unwrap() = s;
    shared.push_overlay_event("goals", json!({"type":"goals_state","goals":goals}));
}

// ── Chat commands ──────────────────────────────────────────────────────────────

#[tauri::command]
fn save_chat(shared: State<Shared>, data: Value) {
    shared.data.lock().unwrap().chat = data;
    do_save(&shared);
}

// Pushes the current style/settings config. Stored as the snapshot so the
// overlay (and any in-app demo preview iframe) gets it immediately on connect,
// and also broadcast live so an already-open overlay updates in real time.
#[tauri::command]
fn chat_overlay_settings(shared: State<Shared>, cfg: Value) {
    let s = json!({"type":"settings","cfg":cfg}).to_string();
    *shared.overlay_chat.lock().unwrap() = s;
    shared.push_overlay_event("chat", json!({"type":"settings","cfg":cfg}));
}

// One live chat message, already tagged with its role by the frontend.
#[tauri::command]
fn chat_overlay_message(shared: State<Shared>, event: Value) {
    shared.push_overlay_event("chat", event);
}

// Follow / sub alert card.
#[tauri::command]
fn chat_overlay_alert(shared: State<Shared>, event: Value) {
    shared.push_overlay_event("chat", event);
}

// Channel + global emote name→url map, pushed once after fetch (not part of
// the settings snapshot since it can be sizeable and changes far less often).
#[tauri::command]
fn chat_overlay_emotes(shared: State<Shared>, emotes: Value) {
    shared.push_overlay_event("chat", json!({"type":"emotes","emotes":emotes}));
}

// ── Counters commands ──────────────────────────────────────────────────────────

#[tauri::command]
fn save_counters(shared: State<Shared>, data: Value) {
    shared.data.lock().unwrap().counters = data;
    do_save(&shared);
}

#[tauri::command]
fn counters_overlay_update(shared: State<Shared>, counters: Value) {
    let s = counters.to_string();
    *shared.overlay_counters.lock().unwrap() = s;
    shared.push_overlay_event("counters", json!({"type":"counters_state","counters":counters}));
}

// ── Credits commands ───────────────────────────────────────────────────────────

#[tauri::command]
fn save_credits(shared: State<Shared>, data: Value) {
    shared.data.lock().unwrap().credits = data;
    do_save(&shared);
}

// ── Commands / Auto Messages ──────────────────────────────────────────────────
// No overlay for this tool — everything it does lands in Twitch chat or plays a
// sound in the app window, so a plain save is all the backend it needs.

#[tauri::command]
fn save_commands(shared: State<Shared>, data: Value) {
    shared.data.lock().unwrap().commands = data;
    do_save(&shared);
}

// Popup actions. Purely transient — there is no snapshot to restore, so a
// freshly-opened overlay simply shows nothing until the next command fires.
#[tauri::command]
fn commands_overlay_event(shared: State<Shared>, event: Value) {
    shared.push_overlay_event("commands", event);
}

// Generic app-settings save (global ignore list etc.). Careful: `settings`
// also carries ytm_token and similar — callers must pass the FULL settings
// object (store.settings), never a partial one.
#[tauri::command]
fn save_app_settings(shared: State<Shared>, data: Value) {
    shared.data.lock().unwrap().settings = data;
    do_save(&shared);
}

// Pushes the current style/settings config plus the latest resolved roster,
// mirroring chat_overlay_settings — stored as the snapshot so the overlay
// (and live-preview iframe) gets it immediately on connect (enabling
// autoplay-on-load), and also broadcast live for already-open overlays.
#[tauri::command]
fn credits_overlay_settings(shared: State<Shared>, cfg: Value, roster: Value) {
    let s = json!({"type":"settings","cfg":cfg,"roster":roster}).to_string();
    *shared.overlay_credits.lock().unwrap() = s;
    shared.push_overlay_event("credits", json!({"type":"settings","cfg":cfg,"roster":roster}));
}

// Triggers the actual scrolling-credits playback. The roster (already
// resolved into sections/names by the frontend) travels in the event itself —
// this is ephemeral, just like wheel_overlay_spin / giveaway_overlay_draw.
#[tauri::command]
fn credits_overlay_play(shared: State<Shared>, event: Value) {
    shared.push_overlay_event("credits", event);
}

// ── Overlay URL ───────────────────────────────────────────────────────────────

#[tauri::command]
fn overlay_url(shared: State<Shared>) -> Value {
    let port = shared.server_port.load(Ordering::SeqCst);
    json!({
        "master":   format!("http://localhost:{}/", port),
        "wheel":    format!("http://localhost:{}/wheel", port),
        "giveaway": format!("http://localhost:{}/giveaway", port),
        "timers":   format!("http://localhost:{}/timers", port),
        "tasks":    format!("http://localhost:{}/tasks", port),
        "pomodoro": format!("http://localhost:{}/pomodoro", port),
        "goals":    format!("http://localhost:{}/goals", port),
        "checkins":   format!("http://localhost:{}/checkins", port),
        "nowplaying": format!("http://localhost:{}/nowplaying", port),
        "srqueue":    format!("http://localhost:{}/srqueue", port),
        "chat":       format!("http://localhost:{}/chat", port),
        "counters":   format!("http://localhost:{}/counters", port),
        "commands":   format!("http://localhost:{}/commands", port),
        "credits":    format!("http://localhost:{}/credits", port),
    })
}

// ── D.I.Y commands ────────────────────────────────────────────────────────────

// Stores the whole D.I.Y state ({ widgets: [...] }). The overlay server reads
// widgets straight from AppData when serving /diy?id=X, so no separate cache.
#[tauri::command]
fn save_diy(shared: State<Shared>, data: Value) {
    shared.data.lock().unwrap().diy = data;
    do_save(&shared);
}

// Tells a live D.I.Y overlay (in OBS) to reload itself so design changes show
// without a manual browser-source refresh.
#[tauri::command]
fn diy_overlay_refresh(shared: State<Shared>, id: String) {
    shared.push_overlay_event("chat", json!({"type":"diy-refresh","widget":id}));
}

// ── App entry ─────────────────────────────────────────────────────────────────

pub fn run() {
    tauri::Builder::default()
        // Must be the first plugin. A second SPARK would grab port 4748 and
        // every overlay URL would quietly point at the wrong instance — so the
        // second launch is blocked, and the running window pops up a notice.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Emitter;
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            let _ = app.emit("spark-second-instance", ());
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."));
            let data_path = dir.join("spark-data.json");
            // Boot backup: parse first, rotate only on success, then reuse the
            // parsed data (no second read). A corrupt file skips the rotation
            // so the last known-good backups survive for manual recovery.
            let parsed = std::fs::read(&data_path).ok()
                .and_then(|b| serde_json::from_slice::<AppData>(&b).ok());
            if parsed.is_some() { rotate_backups(&data_path); }
            let data = parsed.unwrap_or_default();
            let stop  = Arc::new(AtomicBool::new(false));
            let cstop = Arc::new(AtomicBool::new(false));
            let shared = Shared {
                data:      Mutex::new(data),
                data_path: Mutex::new(data_path),
                overlay_seq:    AtomicU64::new(0),
                overlay_events: Mutex::new(VecDeque::new()),
                overlay_wake_lock: Mutex::new(()),
                overlay_wake:      Condvar::new(),
                follower_cache: Mutex::new(std::collections::HashMap::new()),
                stream_info_cache: Mutex::new(None),
                send_queue:     Mutex::new(VecDeque::new()),
                send_wake:      Condvar::new(),
                bot_send_error: Mutex::new(String::new()),
                token_refresh:  Mutex::new(()),
                overlay_wheel:    Mutex::new("{}".into()),
                overlay_giveaway: Mutex::new("{}".into()),
                overlay_timers:   Mutex::new("[]".into()),
                overlay_tasks:    Mutex::new("{}".into()),
                overlay_pomodoro: Mutex::new("{}".into()),
                overlay_goals:    Mutex::new("[]".into()),
                overlay_checkins: Mutex::new("{}".into()),
                overlay_srqueue:  Mutex::new("{}".into()),
                overlay_chat:     Mutex::new("{}".into()),
                overlay_counters: Mutex::new("[]".into()),
                overlay_credits:  Mutex::new("{}".into()),
                tool_visibility:  Mutex::new(std::collections::HashMap::new()),
                master_border:    Mutex::new("#ffc83d".into()),
                server_port: AtomicU64::new(0),
                twitch_running: AtomicBool::new(false),
                twitch_stop: stop,
                chat_stop: cstop,
                twitch_gen: Arc::new(AtomicU64::new(0)),
                chat_gen:   Arc::new(AtomicU64::new(0)),
            };
            app.manage(shared);
            overlay::start_server(app.handle().clone());
            // Drains the outbound chat queue. Must come after manage() — it
            // reaches for Shared on its first iteration.
            twitch::start_sender(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_all_data,
            get_app_version,
            set_tool_visibility,
            set_master_border,
            save_wheel, wheel_overlay_update, wheel_overlay_spin,
            save_giveaway, giveaway_overlay_update, giveaway_overlay_draw,
            save_timers, timers_overlay_update,
            save_tasks, tasks_overlay_update, pomodoro_overlay_update,
            save_goals, goals_overlay_update,
            save_checkins, checkins_overlay_event,
            save_songrequest,
            srqueue_overlay_event,
            nowplaying_overlay_event,
            save_chat, chat_overlay_settings, chat_overlay_message, chat_overlay_alert, chat_overlay_emotes,
            save_counters, counters_overlay_update,
            save_credits, credits_overlay_settings, credits_overlay_play,
            save_diy, diy_overlay_refresh,
            save_commands, commands_overlay_event,
            save_app_settings,
            backup_data, restore_data,
            overlay_url,
            twitch::twitch_start_device_auth,
            twitch::twitch_poll_device_auth,
            twitch::twitch_load_saved,
            twitch::twitch_get_rewards,
            twitch::twitch_create_reward,
            twitch::twitch_update_reward,
            twitch::twitch_delete_reward,
            twitch::twitch_update_redemption,
            twitch::twitch_connect_eventsub,
            twitch::twitch_connect_chat,
            twitch::twitch_disconnect,
            twitch::twitch_logout,
            twitch::twitch_check_follower,
            twitch::twitch_check_subscriber,
            twitch::twitch_get_follower_count,
            twitch::twitch_get_channel_emotes,
            twitch::twitch_get_global_emotes,
            twitch::twitch_get_user_info,
            twitch::twitch_send_chat_message,
            twitch::twitch_send_announcement,
            twitch::twitch_token_scopes,
            twitch::twitch_get_stream_info,
            twitch::twitch_start_bot_auth,
            twitch::twitch_poll_bot_auth,
            twitch::twitch_bot_logout,
            twitch::twitch_bot_status,
            twitch::twitch_get_user_by_login,
            twitch::twitch_get_followage,
            twitch::twitch_get_sub_count,
            twitch::twitch_get_ad_schedule,
        ])
        .run(tauri::generate_context!())
        .expect("error running SPARK");
}

// ── Check-in commands ─────────────────────────────────────────────────────────

#[tauri::command]
fn save_checkins(shared: State<Shared>, data: Value) {
    shared.data.lock().unwrap().checkins = data;
    do_save(&shared);
}

#[tauri::command]
fn checkins_overlay_event(shared: State<Shared>, event: Value) {
    shared.push_overlay_event("checkins", event);
}


// ── Now Playing overlay event ─────────────────────────────────────────────────

#[tauri::command]
fn nowplaying_overlay_event(shared: State<Shared>, event: Value) {
    shared.push_overlay_event("nowplaying", event);
}

// ── Song Request ──────────────────────────────────────────────────────────────

#[tauri::command]
fn save_songrequest(shared: State<Shared>, data: Value) {
    shared.data.lock().unwrap().songrequest = data;
    do_save(&shared);
}

#[tauri::command]
fn srqueue_overlay_event(shared: State<Shared>, event: Value) {
    *shared.overlay_srqueue.lock().unwrap() = event.to_string();
    shared.push_overlay_event("srqueue", event);
}

// ── Backup / Restore ──────────────────────────────────────────────────────────

#[tauri::command]
fn backup_data(shared: State<Shared>) -> Result<Value, String> {
    let d = shared.data.lock().unwrap();
    // Exclude twitch_tokens from backup
    Ok(json!({
        "wheel":    d.wheel,
        "giveaway": d.giveaway,
        "timers":   d.timers,
        "tasks":    d.tasks,
        "goals":    d.goals,
        "checkins": d.checkins,
        "songrequest": d.songrequest,
        "chat":     d.chat,
        "counters": d.counters,
        "credits":  d.credits,
        "diy":      d.diy,
        "commands": d.commands,
        "settings": d.settings,
        "_spark_backup": true,
        "_version": 1,
    }))
}

#[tauri::command]
fn restore_data(shared: State<Shared>, data: Value) -> Result<(), String> {
    if data.get("_spark_backup").and_then(|v| v.as_bool()) != Some(true) {
        return Err("Not a valid SPARK backup file.".into());
    }
    // Safety net: snapshot the current (known-good, we're running on it) file
    // before the restore overwrites it, so a bad import is one rename away
    // from undone.
    {
        let p = shared.data_path.lock().unwrap().clone();
        rotate_backups(&p);
    }
    let path;
    {
        let mut d = shared.data.lock().unwrap();
        if let Some(v) = data.get("wheel")    { d.wheel    = v.clone(); }
        if let Some(v) = data.get("giveaway") { d.giveaway = v.clone(); }
        if let Some(v) = data.get("timers")   { d.timers   = v.clone(); }
        if let Some(v) = data.get("tasks")    { d.tasks    = v.clone(); }
        if let Some(v) = data.get("goals")    { d.goals    = v.clone(); }
        if let Some(v) = data.get("checkins")    { d.checkins    = v.clone(); }
        if let Some(v) = data.get("songrequest") { d.songrequest = v.clone(); }
        if let Some(v) = data.get("chat")     { d.chat     = v.clone(); }
        if let Some(v) = data.get("counters") { d.counters = v.clone(); }
        if let Some(v) = data.get("credits")  { d.credits  = v.clone(); }
        if let Some(v) = data.get("diy")      { d.diy      = v.clone(); }
        if let Some(v) = data.get("commands") { d.commands = v.clone(); }
        if let Some(v) = data.get("settings") { d.settings = v.clone(); }
        path = shared.data_path.lock().unwrap().clone();
        save_to_disk(&path, &d);
    }
    Ok(())
}

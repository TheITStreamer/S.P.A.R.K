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
    #[serde(default)] pub broadcast: Value,
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
    // Which account should say this. None = the default behaviour: the bot when
    // one is connected, otherwise the broadcaster. Some("broadcaster") forces it
    // to come from the streamer even when a bot exists, which is the whole point
    // of the picker in the Broadcast tab — talking to chat as yourself should
    // not appear under the bot's name.
    pub as_acct:  Option<String>,
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
    // Persisted to its own file (see follower_cache_path). It used to live in
    // settings, which meant every new chatter rewrote the ENTIRE data file,
    // profile snapshots and all, a few seconds later. Its own file makes that
    // write small and keeps it off the busy path.
    pub follower_cache: Mutex<std::collections::HashMap<String, (bool, u64)>>,
    // Set when the cache changes; a background thread flushes on a timer rather
    // than writing once per chatter.
    pub follower_dirty: AtomicBool,
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

// ── Profile snapshots ─────────────────────────────────────────────────────────
// A profile is a full copy of wheel lists, timers, goals, chat styling and the
// rest. Those copies used to sit inside settings, which meant every settings
// save — and there are a lot of them — re-serialised every profile the user
// owns, active or not. Each one now gets its own file and settings keeps only
// the name and id.

pub fn profiles_dir(shared: &Shared) -> std::path::PathBuf {
    let p = shared.data_path.lock().unwrap().clone();
    let dir = p.with_file_name("profiles");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

// Profile ids are generated by the frontend, but they still end up in a path,
// so they get the same treatment as any other untrusted name.
fn safe_id(id: &str) -> String {
    id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect()
}

fn profile_path(shared: &Shared, id: &str) -> Option<std::path::PathBuf> {
    let id = safe_id(id);
    if id.is_empty() { return None; }
    Some(profiles_dir(shared).join(format!("{}.json", id)))
}

#[tauri::command]
fn save_profile_data(shared: State<Shared>, id: String, data: Value) -> Result<(), String> {
    let path = profile_path(&shared, &id).ok_or("Bad profile id.")?;
    let b = serde_json::to_vec(&data).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &b).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

// Missing file returns null rather than an error: a profile created before its
// snapshot was written, or one restored without its file, should load as empty
// (= SPARK defaults) instead of blocking the switch.
#[tauri::command]
fn load_profile_data(shared: State<Shared>, id: String) -> Value {
    let path = match profile_path(&shared, &id) { Some(p) => p, None => return Value::Null };
    std::fs::read(&path).ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .unwrap_or(Value::Null)
}

#[tauri::command]
fn delete_profile_data(shared: State<Shared>, id: String) {
    if let Some(p) = profile_path(&shared, &id) { let _ = std::fs::remove_file(p); }
}

// Every profile's snapshot, keyed by id — used to fold them into a backup so a
// backup still carries the user's full setup now that they live outside the
// main file.
pub fn all_profile_data(shared: &Shared) -> Value {
    let ids: Vec<String> = shared.data.lock().unwrap().settings
        .get("profiles").and_then(|p| p.as_array())
        .map(|arr| arr.iter()
            .filter_map(|p| p.get("id").and_then(|x| x.as_str()).map(|s| s.to_string()))
            .collect())
        .unwrap_or_default();

    let dir = profiles_dir(shared);
    let mut obj = serde_json::Map::new();
    for id in ids {
        let path = dir.join(format!("{}.json", safe_id(&id)));
        if let Some(v) = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) {
            obj.insert(id, v);
        }
    }
    Value::Object(obj)
}

// ── Follower cache ────────────────────────────────────────────────────────────
// One cache, owned by Rust, used by every tool. There used to be two: this one
// (10 minutes, memory only) and a second in the frontend (3 days, saved inside
// settings). They disagreed with each other, and the frontend one was the main
// reason spark-data.json was being rewritten during busy chat.
//
// The TTL is deliberately long. Twitch does not report unfollows at all, so no
// TTL makes those correct; what it CAN get right is new follows, and those
// arrive as EventSub events that update the entry immediately.

pub const FOLLOWER_TTL_SECS: u64 = 3 * 24 * 3600;

pub fn follower_cache_path(shared: &Shared) -> std::path::PathBuf {
    let p = shared.data_path.lock().unwrap().clone();
    p.with_file_name("follower-cache.json")
}

pub fn load_follower_cache(path: &std::path::Path) -> std::collections::HashMap<String, (bool, u64)> {
    let mut out = std::collections::HashMap::new();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs()).unwrap_or(0);
    if let Ok(b) = std::fs::read(path) {
        if let Ok(v) = serde_json::from_slice::<Value>(&b) {
            if let Some(obj) = v.as_object() {
                for (k, e) in obj {
                    // [is_follower, checked_at_secs]
                    let arr = match e.as_array() { Some(a) if a.len() == 2 => a, _ => continue };
                    let is_f = arr[0].as_bool().unwrap_or(false);
                    let at   = arr[1].as_u64().unwrap_or(0);
                    // Drop anything already expired rather than carrying it in
                    // memory until something happens to touch it.
                    if now.saturating_sub(at) < FOLLOWER_TTL_SECS {
                        out.insert(k.clone(), (is_f, at));
                    }
                }
            }
        }
    }
    out
}

pub fn save_follower_cache(path: &std::path::Path, map: &std::collections::HashMap<String, (bool, u64)>) {
    let mut obj = serde_json::Map::new();
    for (k, (is_f, at)) in map {
        obj.insert(k.clone(), json!([is_f, at]));
    }
    if let Ok(b) = serde_json::to_vec(&Value::Object(obj)) {
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, &b).is_ok() { let _ = std::fs::rename(&tmp, path); }
    }
}

// Flushes the cache to disk at most once every 20s, and only when something
// changed. Losing the last few seconds of it on a crash costs nothing — the
// entries are re-fetched on demand.
pub fn start_follower_flusher(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_secs(20));
            let shared = app.state::<Shared>();
            if !shared.follower_dirty.swap(false, Ordering::SeqCst) { continue; }
            let path = follower_cache_path(&shared);
            let map = shared.follower_cache.lock().unwrap().clone();
            save_follower_cache(&path, &map);
        }
    });
}

// The whole cache, for the frontend to mirror in memory at boot. Chat styles a
// message the instant it arrives and cannot wait on a round-trip per chatter,
// so it needs a local copy; this is the one time it is handed over.
#[tauri::command]
fn follower_cache_all(shared: State<Shared>) -> Value {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs()).unwrap_or(0);
    let map = shared.follower_cache.lock().unwrap();
    let mut obj = serde_json::Map::new();
    for (k, (is_f, at)) in map.iter() {
        if now.saturating_sub(*at) < FOLLOWER_TTL_SECS { obj.insert(k.clone(), json!(is_f)); }
    }
    Value::Object(obj)
}

// Record a follower status SPARK learned without asking Helix — currently a
// follow event arriving over EventSub. Keeps the cache correct the moment
// someone follows instead of waiting out the TTL.
#[tauri::command]
fn note_follower(shared: State<Shared>, user_id: String, is_follower: bool) {
    if user_id.is_empty() { return; }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs()).unwrap_or(0);
    shared.follower_cache.lock().unwrap().insert(user_id, (is_follower, now));
    shared.follower_dirty.store(true, Ordering::SeqCst);
}

// ── Custom fonts ──────────────────────────────────────────────────────────────
// Imported font files live in %APPDATA%\com.spark.app\fonts\ and are served to
// overlays by overlay.rs. The stored filename carries a hash of the file's
// CONTENTS, which is what makes OBS caching a non-issue: a given filename can
// only ever mean one exact file, so it is safe to cache forever, and editing a
// font produces a new name rather than a stale cached copy.
//
// The family NAME is whatever the user typed — parsing it out of the font's own
// metadata means a TTF parser for very little gain.

pub fn fonts_dir(app: &tauri::AppHandle) -> std::path::PathBuf {
    let dir = app.path().app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .join("fonts");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

// FNV-1a. Not cryptographic and does not need to be — it only has to make two
// different font files land on two different filenames.
fn content_hash(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{:08x}", (h ^ (h >> 32)) as u32)
}

// Strip anything that could walk out of the fonts directory or upset a URL.
// Applied to BOTH the name we generate and any name handed back to us later.
pub fn safe_font_file(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_' || *c == '.')
        .collect::<String>()
        .trim_matches('.')
        .to_string()
}

const FONT_EXTS: [&str; 4] = ["ttf", "otf", "woff", "woff2"];

#[tauri::command]
fn import_font(app: tauri::AppHandle, path: String, family: String) -> Result<Value, String> {
    let family = family.trim().to_string();
    if family.is_empty() { return Err("Give the font a name first.".into()); }

    let src = std::path::PathBuf::from(&path);
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if !FONT_EXTS.contains(&ext.as_str()) {
        return Err(format!("{} is not a font file. Use a .ttf, .otf, .woff or .woff2 file.", ext));
    }

    let bytes = std::fs::read(&src).map_err(|e| format!("Could not read that file: {}", e))?;
    if bytes.is_empty() { return Err("That file is empty.".into()); }
    // 20 MB is far beyond any real font and keeps a mis-picked video out.
    if bytes.len() > 20 * 1024 * 1024 { return Err("That file is too big to be a font.".into()); }

    let slug: String = family.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect::<String>();
    let slug = slug.trim_matches('-').to_string();
    let slug = if slug.is_empty() { "font".to_string() } else { slug };

    let file = safe_font_file(&format!("{}-{}.{}", slug, content_hash(&bytes), ext));
    let dest = fonts_dir(&app).join(&file);
    // Same contents already imported — the write is redundant, not an error.
    if !dest.exists() {
        std::fs::write(&dest, &bytes).map_err(|e| format!("Could not save the font: {}", e))?;
    }

    Ok(json!({ "family": family, "file": file }))
}

// Filenames actually present on disk. The frontend keeps the family names, so
// this is what tells it which of them have lost their file — after a restore
// onto a different PC, for instance.
#[tauri::command]
fn list_fonts(app: tauri::AppHandle) -> Vec<String> {
    let mut out = vec![];
    if let Ok(rd) = std::fs::read_dir(fonts_dir(&app)) {
        for e in rd.flatten() {
            if let Some(n) = e.file_name().to_str() {
                let ext = n.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
                if FONT_EXTS.contains(&ext.as_str()) { out.push(n.to_string()); }
            }
        }
    }
    out.sort();
    out
}

#[tauri::command]
fn delete_font(app: tauri::AppHandle, file: String) -> Result<(), String> {
    let file = safe_font_file(&file);
    if file.is_empty() { return Err("No font given.".into()); }
    let path = fonts_dir(&app).join(&file);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("Could not remove the font: {}", e))?;
    }
    Ok(())
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
        "broadcast": d.broadcast,
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

// Broadcast tab: title/category/tag presets, poll and prediction templates and
// the pane split. No overlay — nothing here renders to OBS.
#[tauri::command]
fn save_broadcast(shared: State<Shared>, data: Value) {
    shared.data.lock().unwrap().broadcast = data;
    do_save(&shared);
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
            let mut data = parsed.unwrap_or_default();

            // Follower cache: read its own file, then absorb anything left in
            // the old settings.followerCache from a version before the split.
            // The migration is one-way and idempotent — once the key is gone
            // from settings it never comes back.
            let fc_path = data_path.with_file_name("follower-cache.json");
            let mut follower = load_follower_cache(&fc_path);
            let mut migrated_followers = false;
            if let Some(old) = data.settings.get("followerCache").and_then(|v| v.as_object()).cloned() {
                let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs()).unwrap_or(0);
                for (k, e) in old {
                    // Old shape was [isFollower(0|1), cachedAtMs].
                    let arr = match e.as_array() { Some(a) if a.len() == 2 => a.clone(), _ => continue };
                    let is_f = arr[0].as_u64().unwrap_or(0) == 1 || arr[0].as_bool().unwrap_or(false);
                    let at_s = arr[1].as_u64().unwrap_or(0) / 1000;
                    if now.saturating_sub(at_s) >= FOLLOWER_TTL_SECS { continue; }
                    // The file on disk is the newer source; never let the old
                    // settings copy overwrite an entry that is already there.
                    follower.entry(k).or_insert((is_f, at_s));
                }
                if let Some(obj) = data.settings.as_object_mut() { obj.remove("followerCache"); }
                migrated_followers = true;
            }
            // Profile snapshots: write any still sitting inline in settings out
            // to their own files, then null the inline copies. Runs once — after
            // this every profiles[].data is null and there is nothing to move.
            let mut migrated_profiles = false;
            {
                let dir = data_path.with_file_name("profiles");
                let inline: Vec<(String, Value)> = data.settings.get("profiles")
                    .and_then(|p| p.as_array())
                    .map(|arr| arr.iter().filter_map(|p| {
                        let id = p.get("id").and_then(|x| x.as_str())?;
                        let snap = p.get("data")?;
                        if snap.is_null() { return None; }
                        Some((id.to_string(), snap.clone()))
                    }).collect())
                    .unwrap_or_default();

                if !inline.is_empty() {
                    let _ = std::fs::create_dir_all(&dir);
                    let mut all_written = true;
                    for (id, snap) in &inline {
                        let sid: String = id.chars()
                            .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
                        if sid.is_empty() { continue; }
                        match serde_json::to_vec(snap) {
                            Ok(b) => { if std::fs::write(dir.join(format!("{}.json", sid)), &b).is_err() { all_written = false; } }
                            Err(_) => all_written = false,
                        }
                    }
                    // Only drop the inline copies once every file landed. A
                    // half-migrated profile must keep its data in settings, or
                    // a failed write here would lose a whole setup.
                    if all_written {
                        migrated_profiles = strip_inline_profile_data(&mut data.settings);
                    }
                }
            }

            if migrated_followers || migrated_profiles {
                if migrated_followers { save_follower_cache(&fc_path, &follower); }
                save_to_disk(&data_path, &data);
            }

            let stop  = Arc::new(AtomicBool::new(false));
            let cstop = Arc::new(AtomicBool::new(false));
            let shared = Shared {
                data:      Mutex::new(data),
                data_path: Mutex::new(data_path),
                overlay_seq:    AtomicU64::new(0),
                overlay_events: Mutex::new(VecDeque::new()),
                overlay_wake_lock: Mutex::new(()),
                overlay_wake:      Condvar::new(),
                follower_cache: Mutex::new(follower),
                follower_dirty: AtomicBool::new(false),
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
            // Same rule: writes the follower cache on a timer, so it must see a
            // managed Shared.
            start_follower_flusher(app.handle().clone());
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
            save_broadcast,
            save_app_settings,
            follower_cache_all, note_follower,
            save_profile_data, load_profile_data, delete_profile_data,
            import_font, list_fonts, delete_font,
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
            twitch::twitch_send_chat_as,
            twitch::twitch_send_announcement,
            twitch::twitch_token_scopes,
            twitch::twitch_required_scopes,
            twitch::twitch_get_stream_info,
            twitch::twitch_start_bot_auth,
            twitch::twitch_poll_bot_auth,
            twitch::twitch_bot_logout,
            twitch::twitch_bot_status,
            twitch::twitch_get_user_by_login,
            twitch::twitch_get_followage,
            twitch::twitch_get_sub_count,
            twitch::twitch_get_ad_schedule,
            twitch::twitch_update_channel_info,
            twitch::twitch_get_channel_info,
            twitch::twitch_search_categories,
            twitch::twitch_create_stream_marker,
            twitch::twitch_ban_user,
            twitch::twitch_unban_user,
            twitch::twitch_delete_message,
            twitch::twitch_pin_message,
            twitch::twitch_start_raid,
            twitch::twitch_cancel_raid,
            twitch::twitch_send_shoutout,
            twitch::twitch_create_poll,
            twitch::twitch_end_poll,
            twitch::twitch_get_active_poll,
            twitch::twitch_create_prediction,
            twitch::twitch_end_prediction,
            twitch::twitch_get_active_prediction,
            twitch::twitch_set_moderator,
            twitch::twitch_set_vip,
            twitch::twitch_send_whisper,
            twitch::twitch_start_commercial,
            twitch::twitch_snooze_ad,
            twitch::twitch_get_chat_settings,
            twitch::twitch_set_chat_mode,
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
    // Profile snapshots live in their own files now, so they have to be folded
    // back in here — without this a backup would quietly stop carrying the
    // user's other profiles. Read BEFORE taking the data lock: all_profile_data
    // takes it itself.
    let profile_data = all_profile_data(&shared);

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
        // { profileId: snapshot }. Absent in backups taken before the split —
        // those carried the snapshots inside settings.profiles[].data instead,
        // and restore_data still understands that shape.
        "profile_data": profile_data,
        "_spark_backup": true,
        "_version": 2,
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
        if let Some(v) = data.get("broadcast") { d.broadcast = v.clone(); }
        if let Some(v) = data.get("settings") { d.settings = v.clone(); }
        path = shared.data_path.lock().unwrap().clone();
        save_to_disk(&path, &d);
    }

    // Profile snapshots. Two shapes to handle:
    //   v2 backups — a "profile_data" map alongside settings.
    //   v1 backups — the snapshot inline at settings.profiles[].data.
    // Either way they end up as one file per profile, and settings.profiles is
    // left carrying names only.
    {
        let mut snapshots: Vec<(String, Value)> = vec![];

        if let Some(obj) = data.get("profile_data").and_then(|v| v.as_object()) {
            for (id, snap) in obj { snapshots.push((id.clone(), snap.clone())); }
        } else if let Some(arr) = data.get("settings")
            .and_then(|s| s.get("profiles")).and_then(|p| p.as_array()) {
            for p in arr {
                let id = match p.get("id").and_then(|x| x.as_str()) { Some(i) => i.to_string(), None => continue };
                match p.get("data") {
                    Some(v) if !v.is_null() => snapshots.push((id, v.clone())),
                    _ => {}
                }
            }
        }

        // Clear out any profile files belonging to the setup being replaced, so
        // a restore cannot leave a stale snapshot behind under a reused id.
        let dir = profiles_dir(&shared);
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                if e.path().extension().and_then(|x| x.to_str()) == Some("json") {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
        for (id, snap) in snapshots {
            let sid = safe_id(&id);
            if sid.is_empty() { continue; }
            if let Ok(b) = serde_json::to_vec(&snap) {
                let _ = std::fs::write(dir.join(format!("{}.json", sid)), &b);
            }
        }

        // Strip the inline copies so settings never carries snapshots again.
        let mut d = shared.data.lock().unwrap();
        strip_inline_profile_data(&mut d.settings);
        save_to_disk(&path, &d);
    }

    Ok(())
}

// Replaces every profiles[].data with null, leaving ids and names alone.
// Used both by the restore path and by the one-time boot migration.
fn strip_inline_profile_data(settings: &mut Value) -> bool {
    let mut changed = false;
    if let Some(arr) = settings.get_mut("profiles").and_then(|p| p.as_array_mut()) {
        for p in arr.iter_mut() {
            if let Some(obj) = p.as_object_mut() {
                match obj.get("data") {
                    Some(v) if !v.is_null() => { obj.insert("data".into(), Value::Null); changed = true; }
                    _ => {}
                }
            }
        }
    }
    changed
}

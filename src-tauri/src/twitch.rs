use std::sync::atomic::Ordering;
use std::collections::VecDeque;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use serde_json::{json, Value};
use tauri::{Emitter, Manager, State};
use crate::Shared;

// Scopes requested for the broadcaster token. A saved token only carries the
// scopes it was granted, so twitch_token_scopes() lets Settings compare the two
// and prompt for a reconnect when this list has grown.
const SCOPES: &str = "channel:read:redemptions channel:manage:redemptions channel:read:subscriptions moderator:read:followers bits:read chat:read user:write:chat moderator:manage:announcements";

// Scopes for an optional bot account. Deliberately minimal: the bot only ever
// SENDS. Reading chat, EventSub and redeems all stay on the broadcaster token.
// channel:bot is omitted because it would require a matching scope on the
// BROADCASTER's token; making the bot a moderator achieves the same thing.
const BOT_SCOPES: &str = "user:write:chat user:bot";

// Which stored credential set an operation should use.
#[derive(Clone, Copy, PartialEq)]
pub enum Acct { Broadcaster, Bot }

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64
}

fn save_tokens_for(shared: &Shared, acct: Acct, tokens: Value) {
    let path = shared.data_path.lock().unwrap().clone();
    let mut d = shared.data.lock().unwrap();
    match acct {
        Acct::Broadcaster => d.twitch_tokens = tokens,
        Acct::Bot         => d.bot_tokens    = tokens,
    }
    crate::save_to_disk(&path, &d);
}

fn save_tokens(shared: &Shared, tokens: Value) {
    save_tokens_for(shared, Acct::Broadcaster, tokens)
}

// True when a bot account has been authorised. Cheap enough to call per send.
pub fn bot_connected(shared: &Shared) -> bool {
    let d = shared.data.lock().unwrap();
    d.bot_tokens.get("access_token").and_then(|x| x.as_str()).map_or(false, |s| !s.is_empty())
}

// ── Device auth ───────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn twitch_start_device_auth(client_id: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let c = reqwest::blocking::Client::new();
        let r = c.post("https://id.twitch.tv/oauth2/device")
            .form(&[("client_id", client_id.as_str()), ("scopes", SCOPES)])
            .send().map_err(|e| e.to_string())?;
        if !r.status().is_success() {
            return Err(format!("Device request failed ({}). Check your Client ID.", r.status()));
        }
        Ok(r.json().map_err(|e| e.to_string())?)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn twitch_poll_device_auth(app: tauri::AppHandle, client_id: String, device_code: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let shared = app.state::<Shared>();
        let c = reqwest::blocking::Client::new();
        let r = c.post("https://id.twitch.tv/oauth2/token")
            .form(&[
                ("client_id",   client_id.as_str()),
                ("scopes",      SCOPES),
                ("device_code", device_code.as_str()),
                ("grant_type",  "urn:ietf:params:oauth:grant-type:device_code"),
            ]).send().map_err(|e| e.to_string())?;
        let v: Value = r.json().map_err(|e| e.to_string())?;
        if let Some(access) = v.get("access_token").and_then(|x| x.as_str()) {
            let expires_in = v.get("expires_in").and_then(|x| x.as_u64()).unwrap_or(14400);
            let refresh = v.get("refresh_token").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let tokens = json!({
                "access_token":  access,
                "refresh_token": refresh,
                "expires_at":    now_secs() + expires_in,
                "client_id":     client_id,
            });
            save_tokens(&shared, tokens.clone());
            return Ok(json!({"status":"authorized","tokens":tokens}));
        }
        let msg = v.get("message").and_then(|x| x.as_str()).unwrap_or("authorization_pending");
        Ok(json!({"status":"pending","message":msg}))
    }).await.map_err(|e| e.to_string())?
}

// ── Bot account device auth ───────────────────────────────────────────────────
// Same client_id, same device-code dance — the streamer just authorises it a
// second time while signed in as the bot (a private browser window is easiest).

#[tauri::command]
pub async fn twitch_start_bot_auth(client_id: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let c = reqwest::blocking::Client::new();
        let r = c.post("https://id.twitch.tv/oauth2/device")
            .form(&[("client_id", client_id.as_str()), ("scopes", BOT_SCOPES)])
            .send().map_err(|e| e.to_string())?;
        if !r.status().is_success() {
            return Err(format!("Device request failed ({}). Check your Client ID.", r.status()));
        }
        Ok(r.json().map_err(|e| e.to_string())?)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn twitch_poll_bot_auth(app: tauri::AppHandle, client_id: String, device_code: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let shared = app.state::<Shared>();
        let c = reqwest::blocking::Client::new();
        let r = c.post("https://id.twitch.tv/oauth2/token")
            .form(&[
                ("client_id",   client_id.as_str()),
                ("scopes",      BOT_SCOPES),
                ("device_code", device_code.as_str()),
                ("grant_type",  "urn:ietf:params:oauth:grant-type:device_code"),
            ]).send().map_err(|e| e.to_string())?;
        let v: Value = r.json().map_err(|e| e.to_string())?;
        if let Some(access) = v.get("access_token").and_then(|x| x.as_str()) {
            let expires_in = v.get("expires_in").and_then(|x| x.as_u64()).unwrap_or(14400);
            let refresh = v.get("refresh_token").and_then(|x| x.as_str()).unwrap_or("").to_string();
            save_tokens_for(&shared, Acct::Bot, json!({
                "access_token":  access,
                "refresh_token": refresh,
                "expires_at":    now_secs() + expires_in,
                "client_id":     client_id,
            }));
            // Resolve who this actually is straight away, so Settings can show the
            // bot's name and sends never need a validate() round-trip.
            let (uid, login) = validate(access)?;
            store_identity_for(&shared, Acct::Bot, &uid, &login);
            *shared.bot_send_error.lock().unwrap() = String::new();
            return Ok(json!({"status":"authorized","login":login,"user_id":uid}));
        }
        let msg = v.get("message").and_then(|x| x.as_str()).unwrap_or("authorization_pending");
        Ok(json!({"status":"pending","message":msg}))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn twitch_bot_logout(shared: State<Shared>) {
    save_tokens_for(&shared, Acct::Bot, json!({}));
    *shared.bot_send_error.lock().unwrap() = String::new();
}

#[tauri::command]
pub fn twitch_bot_status(shared: State<Shared>) -> Value {
    let (connected, login) = {
        let d = shared.data.lock().unwrap();
        let t = &d.bot_tokens;
        let a = t.get("access_token").and_then(|x| x.as_str()).unwrap_or("");
        (!a.is_empty(), t.get("login").and_then(|x| x.as_str()).unwrap_or("").to_string())
    };
    json!({
        "connected": connected,
        "login":     login,
        "error":     shared.bot_send_error.lock().unwrap().clone(),
    })
}

// ── Token management ──────────────────────────────────────────────────────────

pub fn ensure_token(shared: &Shared) -> Result<(String, String), String> {
    ensure_token_for(shared, Acct::Broadcaster)
}

pub fn ensure_token_for(shared: &Shared, acct: Acct) -> Result<(String, String), String> {
    // Reads the stored credentials for `acct`. Called again after taking the
    // refresh lock, which is the whole point of the double-check below.
    let read = |acct: Acct| {
        let d = shared.data.lock().unwrap();
        let t = match acct { Acct::Broadcaster => &d.twitch_tokens, Acct::Bot => &d.bot_tokens };
        (
            t.get("access_token").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            t.get("refresh_token").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            t.get("expires_at").and_then(|x| x.as_u64()).unwrap_or(0),
            t.get("client_id").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            t.get("user_id").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            t.get("login").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        )
    };

    let (access, _, expires_at, client_id, _, _) = read(acct);
    if access.is_empty() || client_id.is_empty() {
        return Err("Not connected to Twitch".into());
    }
    if now_secs() + 60 < expires_at { return Ok((access, client_id)); }

    // A refresh is due. Twitch kills the old refresh token as soon as it issues
    // a new one, so only one caller may do this at a time — otherwise the loser
    // presents a dead token and the app looks logged out. Whoever gets the lock
    // second re-reads and usually finds the work already done.
    let _refresh_guard = shared.token_refresh.lock().unwrap_or_else(|e| e.into_inner());
    let (access, refresh, expires_at, client_id, uid, login) = read(acct);
    if access.is_empty() || client_id.is_empty() {
        return Err("Not connected to Twitch".into());
    }
    if now_secs() + 60 < expires_at { return Ok((access, client_id)); }

    let c = reqwest::blocking::Client::new();
    let r = c.post("https://id.twitch.tv/oauth2/token")
        .form(&[
            ("client_id",     client_id.as_str()),
            ("grant_type",    "refresh_token"),
            ("refresh_token", refresh.as_str()),
        ]).send().map_err(|e| e.to_string())?;
    let v: Value = r.json().map_err(|e| e.to_string())?;
    let new_access = v.get("access_token").and_then(|x| x.as_str())
        .ok_or("Token refresh failed — please reconnect")?.to_string();
    let new_refresh = v.get("refresh_token").and_then(|x| x.as_str()).unwrap_or(&refresh).to_string();
    let expires_in = v.get("expires_in").and_then(|x| x.as_u64()).unwrap_or(14400);
    save_tokens_for(shared, acct, json!({
        "access_token":  new_access.clone(),
        "refresh_token": new_refresh,
        "expires_at":    now_secs() + expires_in,
        "client_id":     client_id.clone(),
        // preserve cached identity across refreshes
        "user_id":       uid,
        "login":         login,
    }));
    Ok((new_access, client_id))
}

pub fn validate(access: &str) -> Result<(String, String), String> {
    let c = reqwest::blocking::Client::new();
    let r = c.get("https://id.twitch.tv/oauth2/validate")
        .header("Authorization", format!("OAuth {}", access))
        .send().map_err(|e| e.to_string())?;
    if !r.status().is_success() { return Err("Token invalid or expired".into()); }
    let v: Value = r.json().map_err(|e| e.to_string())?;
    Ok((
        v.get("user_id").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        v.get("login").and_then(|x| x.as_str()).unwrap_or("").to_string(),
    ))
}

// Persist the validated user_id/login next to the tokens so routine commands
// don't need a validate() round-trip to id.twitch.tv on every call.
fn store_identity(shared: &Shared, uid: &str, login: &str) {
    store_identity_for(shared, Acct::Broadcaster, uid, login)
}

fn store_identity_for(shared: &Shared, acct: Acct, uid: &str, login: &str) {
    let path = shared.data_path.lock().unwrap().clone();
    let mut d = shared.data.lock().unwrap();
    let t = match acct { Acct::Broadcaster => &mut d.twitch_tokens, Acct::Bot => &mut d.bot_tokens };
    t["user_id"] = json!(uid);
    t["login"]   = json!(login);
    crate::save_to_disk(&path, &d);
}

// Cached (user_id, login). Falls back to validate() once, then caches.
pub fn identity(shared: &Shared, access: &str) -> Result<(String, String), String> {
    identity_for(shared, Acct::Broadcaster, access)
}

pub fn identity_for(shared: &Shared, acct: Acct, access: &str) -> Result<(String, String), String> {
    {
        let d = shared.data.lock().unwrap();
        let t = match acct { Acct::Broadcaster => &d.twitch_tokens, Acct::Bot => &d.bot_tokens };
        let uid   = t.get("user_id").and_then(|x| x.as_str()).unwrap_or("");
        let login = t.get("login").and_then(|x| x.as_str()).unwrap_or("");
        if !uid.is_empty() && !login.is_empty() { return Ok((uid.to_string(), login.to_string())); }
    }
    let (uid, login) = validate(access)?;
    store_identity_for(shared, acct, &uid, &login);
    Ok((uid, login))
}

#[tauri::command]
pub async fn twitch_load_saved(app: tauri::AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let shared = app.state::<Shared>();
        let (access, client_id) = ensure_token(&shared)?;
        // Full validate at boot — this is the one place we always verify the token
        // is live; everything after uses the cached identity.
        let (uid, login) = validate(&access)?;
        store_identity(&shared, &uid, &login);
        Ok(json!({"connected":true,"user_id":uid,"login":login,"client_id":client_id}))
    }).await.map_err(|e| e.to_string())?
}

// ── Rewards listing ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn twitch_get_rewards(app: tauri::AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let shared = app.state::<Shared>();
        let (access, client_id) = ensure_token(&shared)?;
        let (uid, _) = identity(&shared, &access)?;
        let c = reqwest::blocking::Client::new();
        let r = c.get("https://api.twitch.tv/helix/channel_points/custom_rewards")
            .query(&[("broadcaster_id", uid.as_str())])
            .header("Authorization", format!("Bearer {}", access))
            .header("Client-Id", &client_id)
            .send().map_err(|e| e.to_string())?;
        let v: Value = r.json().map_err(|e| e.to_string())?;
        let rewards: Vec<Value> = v.get("data").and_then(|d| d.as_array()).cloned().unwrap_or_default()
            .into_iter().map(|r| json!({
                "id":    r.get("id").cloned().unwrap_or(Value::Null),
                "title": r.get("title").cloned().unwrap_or(Value::Null),
                "cost":  r.get("cost").cloned().unwrap_or(Value::Null),
            })).collect();
        Ok(json!({"rewards":rewards}))
    }).await.map_err(|e| e.to_string())?
}

// ── SPARK-managed rewards ─────────────────────────────────────────────────────
// Twitch only allows an app to update/refund redemptions of rewards that app
// created itself. These commands let SPARK create and own a reward so rejected
// redeems can hand the points back (dashboard-made rewards can never do that).

#[tauri::command]
pub async fn twitch_create_reward(app: tauri::AppHandle, title: String, cost: u64, prompt: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let shared = app.state::<Shared>();
        let (access, client_id) = ensure_token(&shared)?;
        let (uid, _) = identity(&shared, &access)?;
        let c = reqwest::blocking::Client::new();
        let r = c.post("https://api.twitch.tv/helix/channel_points/custom_rewards")
            .query(&[("broadcaster_id", uid.as_str())])
            .header("Authorization", format!("Bearer {}", access))
            .header("Client-Id", &client_id)
            .json(&serde_json::json!({
                "title": title,
                "cost": cost,
                "prompt": prompt,
                "is_user_input_required": true,
            }))
            .send().map_err(|e| e.to_string())?;
        let status = r.status();
        let v: Value = r.json().map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(v.get("message").and_then(|x| x.as_str())
                .unwrap_or("Create reward failed").to_string());
        }
        let rw = v.get("data").and_then(|d| d.as_array()).and_then(|a| a.first()).cloned()
            .unwrap_or(serde_json::json!({}));
        Ok(serde_json::json!({
            "id":    rw.get("id").cloned().unwrap_or(Value::Null),
            "title": rw.get("title").cloned().unwrap_or(Value::Null),
            "cost":  rw.get("cost").cloned().unwrap_or(Value::Null),
        }))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn twitch_update_reward(app: tauri::AppHandle, reward_id: String, title: String, cost: u64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let shared = app.state::<Shared>();
        let (access, client_id) = ensure_token(&shared)?;
        let (uid, _) = identity(&shared, &access)?;
        let c = reqwest::blocking::Client::new();
        let r = c.patch("https://api.twitch.tv/helix/channel_points/custom_rewards")
            .query(&[("broadcaster_id", uid.as_str()), ("id", reward_id.as_str())])
            .header("Authorization", format!("Bearer {}", access))
            .header("Client-Id", &client_id)
            .json(&serde_json::json!({ "title": title, "cost": cost }))
            .send().map_err(|e| e.to_string())?;
        if !r.status().is_success() {
            let v: Value = r.json().unwrap_or(serde_json::json!({}));
            return Err(v.get("message").and_then(|x| x.as_str())
                .unwrap_or("Update reward failed").to_string());
        }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn twitch_delete_reward(app: tauri::AppHandle, reward_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let shared = app.state::<Shared>();
        let (access, client_id) = ensure_token(&shared)?;
        let (uid, _) = identity(&shared, &access)?;
        let c = reqwest::blocking::Client::new();
        let r = c.delete("https://api.twitch.tv/helix/channel_points/custom_rewards")
            .query(&[("broadcaster_id", uid.as_str()), ("id", reward_id.as_str())])
            .header("Authorization", format!("Bearer {}", access))
            .header("Client-Id", &client_id)
            .send().map_err(|e| e.to_string())?;
        if !r.status().is_success() {
            let v: Value = r.json().unwrap_or(serde_json::json!({}));
            return Err(v.get("message").and_then(|x| x.as_str())
                .unwrap_or("Delete reward failed").to_string());
        }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

// status: "CANCELED" refunds the viewer's points, "FULFILLED" clears it from
// the dashboard's pending list. Only works while the redemption is UNFULFILLED.
#[tauri::command]
pub async fn twitch_update_redemption(app: tauri::AppHandle, reward_id: String, redemption_id: String, status: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let shared = app.state::<Shared>();
        let (access, client_id) = ensure_token(&shared)?;
        let (uid, _) = identity(&shared, &access)?;
        let c = reqwest::blocking::Client::new();
        let r = c.patch("https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions")
            .query(&[
                ("broadcaster_id", uid.as_str()),
                ("reward_id", reward_id.as_str()),
                ("id", redemption_id.as_str()),
            ])
            .header("Authorization", format!("Bearer {}", access))
            .header("Client-Id", &client_id)
            .json(&serde_json::json!({ "status": status }))
            .send().map_err(|e| e.to_string())?;
        if !r.status().is_success() {
            let v: Value = r.json().unwrap_or(serde_json::json!({}));
            return Err(v.get("message").and_then(|x| x.as_str())
                .unwrap_or("Redemption update failed").to_string());
        }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

// ── Follower / subscriber checks ──────────────────────────────────────────────

// Follower status barely changes mid-stream; cache it so busy chat doesn't
// hammer Helix with one API call per !command per user.
const FOLLOWER_CACHE_TTL_SECS: u64 = 600;

#[tauri::command]
pub async fn twitch_check_follower(app: tauri::AppHandle, user_id: String, broadcaster_id: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let shared = app.state::<Shared>();
        let now = now_secs();
        {
            let cache = shared.follower_cache.lock().unwrap();
            if let Some((is_follower, at)) = cache.get(&user_id) {
                if now.saturating_sub(*at) < FOLLOWER_CACHE_TTL_SECS { return Ok(*is_follower); }
            }
        }
        let (access, client_id) = ensure_token(&shared)?;
        let c = reqwest::blocking::Client::new();
        let r = c.get("https://api.twitch.tv/helix/channels/followers")
            .query(&[("broadcaster_id", broadcaster_id.as_str()), ("user_id", user_id.as_str())])
            .header("Authorization", format!("Bearer {}", access))
            .header("Client-Id", &client_id)
            .send().map_err(|e| e.to_string())?;
        let v: Value = r.json().map_err(|e| e.to_string())?;
        let is_follower = v.get("total").and_then(|x| x.as_u64()).unwrap_or(0) > 0;
        {
            let mut cache = shared.follower_cache.lock().unwrap();
            // Light pruning so a very long session can't grow unbounded
            if cache.len() > 5000 { cache.retain(|_, (_, at)| now.saturating_sub(*at) < FOLLOWER_CACHE_TTL_SECS); }
            cache.insert(user_id, (is_follower, now));
        }
        Ok(is_follower)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn twitch_check_subscriber(app: tauri::AppHandle, user_id: String, broadcaster_id: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let shared = app.state::<Shared>();
        let (access, client_id) = ensure_token(&shared)?;
        let c = reqwest::blocking::Client::new();
        let r = c.get("https://api.twitch.tv/helix/subscriptions/user")
            .query(&[("broadcaster_id", broadcaster_id.as_str()), ("user_id", user_id.as_str())])
            .header("Authorization", format!("Bearer {}", access))
            .header("Client-Id", &client_id)
            .send().map_err(|e| e.to_string())?;
        Ok(r.status().is_success())
    }).await.map_err(|e| e.to_string())?
}

// ── EventSub (redeems) ────────────────────────────────────────────────────────

#[tauri::command]
pub fn twitch_disconnect(shared: State<Shared>) {
    shared.twitch_stop.store(true, Ordering::SeqCst);
    shared.chat_stop.store(true, Ordering::SeqCst);
    shared.twitch_running.store(false, Ordering::SeqCst);
}

// Full log out: stop the sockets AND forget the saved tokens, so the app
// doesn't silently reconnect as the same account on next launch.
#[tauri::command]
pub fn twitch_logout(shared: State<Shared>) {
    shared.twitch_stop.store(true, Ordering::SeqCst);
    shared.chat_stop.store(true, Ordering::SeqCst);
    shared.twitch_running.store(false, Ordering::SeqCst);
    let path = shared.data_path.lock().unwrap().clone();
    let mut d = shared.data.lock().unwrap();
    d.twitch_tokens = serde_json::json!({});
    crate::save_to_disk(&path, &d);
}

#[tauri::command]
pub async fn twitch_connect_eventsub(app: tauri::AppHandle) -> Result<(), String> {
    // ensure_token() can block on a refresh round-trip, so the whole prologue
    // moves off the main thread like every other Twitch command.
    let setup_app = app.clone();
    let (stop, gen, my_gen) = tauri::async_runtime::spawn_blocking(move || {
        let shared = setup_app.state::<Shared>();
        // Cheap up-front check so the UI gets an immediate error if not connected —
        // the thread fetches its own (fresh) token on every (re)connect.
        ensure_token(&shared)?;
        // Bump the generation: any EventSub thread already running sees a stale
        // generation on its next check and exits. The comparison happens whenever
        // that thread wakes, so exactly one thread survives.
        let my_gen = shared.twitch_gen.fetch_add(1, Ordering::SeqCst) + 1;
        shared.twitch_stop.store(false, Ordering::SeqCst);
        shared.twitch_running.store(true, Ordering::SeqCst);
        Ok::<_, String>((shared.twitch_stop.clone(), shared.twitch_gen.clone(), my_gen))
    }).await.map_err(|e| e.to_string())??;
    // Spawned out here: the listener owns `app` for the life of the connection,
    // and taking it inside the closure above would clash with the State borrow.
    std::thread::spawn(move || { run_eventsub(&app, stop, gen, my_gen); });
    Ok(())
}

fn subscribe(access: &str, client_id: &str, session_id: &str, sub_type: &str, version: &str, condition: Value) -> Result<(), String> {
    let c = reqwest::blocking::Client::new();
    let r = c.post("https://api.twitch.tv/helix/eventsub/subscriptions")
        .header("Authorization", format!("Bearer {}", access))
        .header("Client-Id", client_id)
        .json(&json!({
            "type": sub_type, "version": version,
            "condition": condition,
            "transport": {"method":"websocket","session_id":session_id}
        })).send().map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        let v: Value = r.json().unwrap_or(json!({}));
        return Err(format!("Subscribe {} failed: {}", sub_type, v.get("message").and_then(|x| x.as_str()).unwrap_or("")));
    }
    Ok(())
}

// Twitch sends a keepalive message every ~10s. If the socket goes silent for
// longer than this, it's half-open (PC sleep, network drop) — force a reconnect.
const EVENTSUB_SILENCE_TIMEOUT: Duration = Duration::from_secs(30);

fn run_eventsub(app: &tauri::AppHandle, stop: std::sync::Arc<std::sync::atomic::AtomicBool>, gen: std::sync::Arc<std::sync::atomic::AtomicU64>, my_gen: u64) {
    use tungstenite::Message;
    // True when this thread has been superseded by a newer connect (or disconnected).
    let stale = || stop.load(Ordering::SeqCst) || gen.load(Ordering::SeqCst) != my_gen;
    let mut url = "wss://eventsub.wss.twitch.tv/ws".to_string();
    loop {
        if stale() { return; }

        // Fresh token on every (re)connect — the old one may have expired.
        let creds = {
            let shared = app.state::<Shared>();
            ensure_token(&shared).and_then(|(a, c)| validate(&a).map(|(u, _)| (a, c, u)))
        };
        let (access, client_id, uid) = match creds {
            Ok(x) => x,
            Err(e) => {
                let _ = app.emit("twitch-status", json!({"connected":false,"error":e}));
                for _ in 0..20 { if stale() { return; } std::thread::sleep(Duration::from_millis(500)); }
                continue;
            }
        };
        let access = access.as_str(); let client_id = client_id.as_str(); let uid = uid.as_str();

        let (mut socket, _) = match tungstenite::connect(&url) {
            Ok(s) => s,
            Err(e) => {
                let _ = app.emit("twitch-status", json!({"connected":false,"error":format!("WS connect failed: {}", e)}));
                url = "wss://eventsub.wss.twitch.tv/ws".to_string();
                for _ in 0..6 { if stale() { return; } std::thread::sleep(Duration::from_millis(500)); }
                continue;
            }
        };
        match socket.get_ref() {
            tungstenite::stream::MaybeTlsStream::Plain(s) => { let _ = s.set_read_timeout(Some(Duration::from_millis(500))); }
            tungstenite::stream::MaybeTlsStream::Rustls(s) => { let _ = s.get_ref().set_read_timeout(Some(Duration::from_millis(500))); }
            _ => {}
        }
        let mut reconnect_url: Option<String> = None;
        let mut last_msg = Instant::now();
        loop {
            if stale() { let _ = socket.close(None); return; }
            match socket.read() {
                Ok(Message::Text(txt)) => {
                    last_msg = Instant::now();
                    let v: Value = match serde_json::from_str(&txt) { Ok(x) => x, Err(_) => continue };
                    let mtype = v.get("metadata").and_then(|m| m.get("message_type")).and_then(|x| x.as_str()).unwrap_or("");
                    match mtype {
                        "session_welcome" => {
                            let sid = v["payload"]["session"]["id"].as_str().unwrap_or("").to_string();
                            // Redeems are the critical subscription — surface failure instead of silently showing "connected"
                            match subscribe(access, client_id, &sid, "channel.channel_points_custom_reward_redemption.add", "1", json!({"broadcaster_user_id":uid})) {
                                Ok(_)  => { let _ = app.emit("twitch-status", json!({"connected":true})); }
                                Err(e) => { let _ = app.emit("twitch-status", json!({"connected":false,"error":e})); }
                            }
                            // Goal tracking subscriptions (best-effort)
                            let _ = subscribe(access, client_id, &sid, "channel.follow", "2", json!({"broadcaster_user_id":uid,"moderator_user_id":uid}));
                            let _ = subscribe(access, client_id, &sid, "channel.subscribe", "1", json!({"broadcaster_user_id":uid}));
                            let _ = subscribe(access, client_id, &sid, "channel.subscription.gift", "1", json!({"broadcaster_user_id":uid}));
                            let _ = subscribe(access, client_id, &sid, "channel.subscription.message", "1", json!({"broadcaster_user_id":uid}));
                            let _ = subscribe(access, client_id, &sid, "channel.bits.use", "1", json!({"broadcaster_user_id":uid}));
                            let _ = subscribe(access, client_id, &sid, "channel.raid", "1", json!({"to_broadcaster_user_id":uid}));
                        }
                        "session_reconnect" => {
                            reconnect_url = v["payload"]["session"]["reconnect_url"].as_str().map(|s| s.to_string());
                            break;
                        }
                        "notification" => {
                            let sub_type = v["metadata"]["subscription_type"].as_str().unwrap_or("");
                            let ev = &v["payload"]["event"];
                            // Channel point redeems
                            if sub_type == "channel.channel_points_custom_reward_redemption.add" {
                                let _ = app.emit("twitch-redeem", json!({
                                    "redemption_id": ev["id"],
                                    "reward_id":    ev["reward"]["id"],
                                    "reward_title": ev["reward"]["title"],
                                    "user_id":      ev["user_id"],
                                    "user_name":    ev["user_name"],
                                    "user_login":   ev["user_login"],
                                    "user_input":   ev["user_input"],
                                }));
                            }
                            // Goal: follow
                            if sub_type == "channel.follow" {
                                // Seed the follower cache immediately — the Helix followers
                                // endpoint can lag a real follow by several seconds, and a
                                // stale cached "false" would block follow-then-instantly-enter.
                                if let Some(fuid) = ev["user_id"].as_str() {
                                    let shared = app.state::<Shared>();
                                    shared.follower_cache.lock().unwrap()
                                        .insert(fuid.to_string(), (true, now_secs()));
                                }
                                let _ = app.emit("twitch-goal", json!({
                                    "kind": "follow",
                                    "user_name": ev["user_name"],
                                    "user_id": ev["user_id"],
                                    "amount": 1,
                                }));
                            }
                            // Goal: new sub (not gift)
                            if sub_type == "channel.subscribe" {
                                let is_gift = ev["is_gift"].as_bool().unwrap_or(false);
                                if !is_gift {
                                    let _ = app.emit("twitch-goal", json!({
                                        "kind": "sub",
                                        "user_name": ev["user_name"],
                                        "amount": 1,
                                    }));
                                }
                            }
                            // Goal: resub
                            if sub_type == "channel.subscription.message" {
                                let _ = app.emit("twitch-goal", json!({
                                    "kind": "sub",
                                    "user_name": ev["user_name"],
                                    "amount": 1,
                                }));
                            }
                            // Goal: gift subs (count each individually)
                            if sub_type == "channel.subscription.gift" {
                                let total = ev["total"].as_u64().unwrap_or(1);
                                let _ = app.emit("twitch-goal", json!({
                                    "kind": "sub",
                                    "user_name": ev["user_name"],
                                    "amount": total,
                                }));
                            }
                            // Goal: bits
                            if sub_type == "channel.bits.use" {
                                let bits = ev["bits"].as_u64().unwrap_or(0);
                                let _ = app.emit("twitch-goal", json!({
                                    "kind": "bits",
                                    "user_name": ev["user_name"],
                                    "amount": bits,
                                }));
                            }
                            // Raid (into this channel)
                            if sub_type == "channel.raid" {
                                let viewers = ev["viewers"].as_u64().unwrap_or(0);
                                let _ = app.emit("twitch-goal", json!({
                                    "kind": "raid",
                                    "user_name": ev["from_broadcaster_user_name"],
                                    "amount": viewers,
                                }));
                            }
                        }
                        _ => {}
                    }
                }
                Ok(Message::Close(_)) => break,
                Ok(_) => { last_msg = Instant::now(); }
                Err(tungstenite::Error::Io(ref e)) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {
                    // Keepalive watchdog: Twitch sends a message at least every ~10s.
                    // Prolonged silence = half-open socket; tear down and reconnect.
                    if last_msg.elapsed() > EVENTSUB_SILENCE_TIMEOUT { break; }
                    continue;
                }
                Err(_) => break,
            }
        }
        match reconnect_url.take() {
            Some(u) => { url = u; continue; }
            None => {
                if stale() { return; }
                for _ in 0..6 { if stale() { return; } std::thread::sleep(Duration::from_millis(500)); }
                url = "wss://eventsub.wss.twitch.tv/ws".to_string();
            }
        }
    }
}

// ── Chat listener (IRC via TMI) ───────────────────────────────────────────────
// Uses Twitch IRC WebSocket for reading chat. This is the simplest way to read
// ! commands without requiring a bot account — we read as the broadcaster.

#[tauri::command]
pub async fn twitch_connect_chat(app: tauri::AppHandle, channel: String) -> Result<(), String> {
    // Same shape as twitch_connect_eventsub above — see the note there.
    let setup_app = app.clone();
    let (stop, gen, my_gen) = tauri::async_runtime::spawn_blocking(move || {
        let shared = setup_app.state::<Shared>();
        // Cheap up-front check for immediate UI feedback; the thread refreshes its own token.
        ensure_token(&shared)?;
        // Generation bump — same pattern as EventSub: guarantees a "Reconnect chat"
        // can never leave two IRC threads alive (which would double every ! command).
        let my_gen = shared.chat_gen.fetch_add(1, Ordering::SeqCst) + 1;
        shared.chat_stop.store(false, Ordering::SeqCst);
        Ok::<_, String>((shared.chat_stop.clone(), shared.chat_gen.clone(), my_gen))
    }).await.map_err(|e| e.to_string())??;
    std::thread::spawn(move || { run_chat(&app, &channel, stop, gen, my_gen); });
    Ok(())
}

// Twitch IRC sends a server PING roughly every 5 minutes. We also send our own
// PING every 60s, so 3 minutes of total silence means the socket is dead.
const CHAT_PING_INTERVAL:    Duration = Duration::from_secs(60);
const CHAT_SILENCE_TIMEOUT:  Duration = Duration::from_secs(180);

fn run_chat(app: &tauri::AppHandle, channel: &str, stop: std::sync::Arc<std::sync::atomic::AtomicBool>, gen: std::sync::Arc<std::sync::atomic::AtomicU64>, my_gen: u64) {
    use tungstenite::Message;
    // True when this thread has been superseded by a newer connect (or disconnected).
    let stale = || stop.load(Ordering::SeqCst) || gen.load(Ordering::SeqCst) != my_gen;
    loop {
        if stale() { return; }

        // Fresh token on every (re)connect — IRC PASS with an expired token
        // fails auth forever, so never reuse a captured one.
        let creds = {
            let shared = app.state::<Shared>();
            ensure_token(&shared).and_then(|(a, _)| validate(&a).map(|(_, login)| (a, login)))
        };
        let (access, login) = match creds {
            Ok(x) => x,
            Err(_) => {
                for _ in 0..20 { if stale() { return; } std::thread::sleep(Duration::from_millis(500)); }
                continue;
            }
        };

        let (mut socket, _) = match tungstenite::connect("wss://irc-ws.chat.twitch.tv:443") {
            Ok(s) => s,
            Err(_) => {
                for _ in 0..6 { if stale() { return; } std::thread::sleep(Duration::from_millis(500)); }
                continue;
            }
        };
        match socket.get_ref() {
            tungstenite::stream::MaybeTlsStream::Plain(s) => { let _ = s.set_read_timeout(Some(Duration::from_millis(500))); }
            tungstenite::stream::MaybeTlsStream::Rustls(s) => { let _ = s.get_ref().set_read_timeout(Some(Duration::from_millis(500))); }
            _ => {}
        }
        // authenticate
        let _ = socket.send(Message::Text(format!("PASS oauth:{}", access)));
        let _ = socket.send(Message::Text(format!("NICK {}", login)));
        let _ = socket.send(Message::Text("CAP REQ :twitch.tv/tags twitch.tv/commands".to_string()));
        let chan = if channel.starts_with('#') { channel.to_string() } else { format!("#{}", channel) };
        let _ = socket.send(Message::Text(format!("JOIN {}", chan)));

        let mut last_msg  = Instant::now();
        let mut last_ping = Instant::now();
        loop {
            if stale() { let _ = socket.close(None); return; }
            match socket.read() {
                Ok(Message::Text(txt)) => {
                    last_msg = Instant::now();
                    // One WS frame can carry SEVERAL IRC lines separated by
                    // \r\n (Twitch batches under load) — handle every line, or
                    // messages get silently dropped during fast chat.
                    for line in txt.split("\r\n").filter(|l| !l.is_empty()) {
                        // PING keepalive
                        if line.starts_with("PING") {
                            let _ = socket.send(Message::Text(line.replacen("PING", "PONG", 1)));
                            continue;
                        }
                        // Parse PRIVMSG
                        if let Some(msg) = parse_irc(line) {
                            let _ = app.emit("twitch-chat", msg);
                        }
                    }
                }
                Ok(Message::Close(_)) => break,
                Ok(_) => { last_msg = Instant::now(); }
                Err(tungstenite::Error::Io(ref e)) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {
                    // Half-open detection: ping periodically; break on prolonged silence
                    if last_msg.elapsed() > CHAT_SILENCE_TIMEOUT { break; }
                    if last_ping.elapsed() > CHAT_PING_INTERVAL {
                        last_ping = Instant::now();
                        if socket.send(Message::Text("PING :spark".to_string())).is_err() { break; }
                    }
                    continue;
                }
                Err(_) => break,
            }
        }
        if stale() { return; }
        for _ in 0..6 { if stale() { return; } std::thread::sleep(Duration::from_millis(500)); }
    }
}

fn parse_irc(raw: &str) -> Option<Value> {
    // Parse Twitch IRC tags + PRIVMSG
    // Format: @tags :user!user@user.tmi.twitch.tv PRIVMSG #channel :message
    let mut tags: std::collections::HashMap<&str, &str> = std::collections::HashMap::new();
    let rest = if raw.starts_with('@') {
        let (tag_str, rest) = raw[1..].split_once(' ')?;
        for part in tag_str.split(';') {
            if let Some((k, v)) = part.split_once('=') { tags.insert(k, v); }
        }
        rest
    } else { raw };

    if !rest.contains("PRIVMSG") { return None; }

    let prefix_end = rest.find(' ')?;
    let prefix = &rest[1..prefix_end]; // user!user@...
    let username = prefix.split('!').next().unwrap_or("");
    let after_prefix = &rest[prefix_end+1..];
    // after_prefix: "PRIVMSG #channel :message"
    let msg_start = after_prefix.find(" :")?;
    let message = &after_prefix[msg_start+2..];
    let user_id = tags.get("user-id").copied().unwrap_or("");
    let display = tags.get("display-name").copied().unwrap_or(username);
    let is_mod = tags.get("mod").copied().unwrap_or("0") == "1";
    let is_sub = tags.get("subscriber").copied().unwrap_or("0") == "1";
    let badges = tags.get("badges").copied().unwrap_or("");
    let is_broadcaster = badges.contains("broadcaster");
    let is_vip = badges.contains("vip");
    let color = tags.get("color").copied().unwrap_or("");
    // Per-message emote ranges ("id:start-end,start-end/id:...") — covers
    // emotes from ANY channel, since Twitch identifies them per message.
    let emotes = tags.get("emotes").copied().unwrap_or("");

    Some(json!({
        "username":    username,
        "display":     display,
        "user_id":     user_id,
        "message":     message.trim_end(),
        "is_mod":      is_mod,
        "is_sub":      is_sub,
        "is_vip":      is_vip,
        "is_broadcaster": is_broadcaster,
        "color":       color,
        "emotes":      emotes,
    }))
}

// ── Outbound send queue ───────────────────────────────────────────────────────
// Every tab in the app funnels its chat output through the two commands below.
// They enqueue rather than send, and one background thread does the sending at
// a pace Twitch will accept.
//
// Why this matters: blowing the rate limit gets you IGNORED FOR AN HOUR unless
// the sender is a mod/VIP/broadcaster, and a burst of command replies plus a
// couple of auto messages is enough to do it.
//
// Pacing: 350ms minimum between sends, a rolling 30s window, and announcements
// additionally throttled to one per 3s. A 429 drops the window cap to a
// conservative 18 for the rest of the session and tells the UI.
//
// Twitch also silently DISCARDS a message identical to the previous one within
// 30 seconds. A repeated "!discord" reply would just vanish, so a repeat gets an
// invisible U+E0000 appended — the standard trick, and viewers never see it.

const SEND_MIN_GAP_MS:      u64 = 350;
const SEND_WINDOW_MS:       u64 = 30_000;
const SEND_WINDOW_MAX:      usize = 90;   // mod/broadcaster headroom
const SEND_WINDOW_MAX_SAFE: usize = 18;   // after a 429
const ANNOUNCE_MIN_GAP_MS:  u64 = 3_000;
const SEND_QUEUE_MAX:       usize = 100;
const DUPE_WINDOW_MS:       u64 = 30_000;
const INVISIBLE: &str = "\u{E0000}";

fn enqueue(shared: &Shared, item: crate::QueuedSend) {
    let mut q = shared.send_queue.lock().unwrap();
    // A runaway must not balloon memory. Oldest goes first — it's the most
    // stale and the least worth saying by the time we get to it.
    while q.len() >= SEND_QUEUE_MAX { q.pop_front(); }
    q.push_back(item);
    shared.send_wake.notify_one();
}

#[tauri::command]
pub fn twitch_send_chat_message(shared: State<Shared>, message: String) -> Result<(), String> {
    if message.trim().is_empty() { return Ok(()); }
    enqueue(&shared, crate::QueuedSend { announce: false, message, color: String::new() });
    Ok(())
}

// The actual HTTP call for one chat message, as a given account.
fn post_chat(shared: &Shared, acct: Acct, message: &str) -> Result<(), (u16, String)> {
    let (access, client_id) = ensure_token_for(shared, acct).map_err(|e| (0u16, e))?;
    let (sender_id, _) = identity_for(shared, acct, &access).map_err(|e| (0u16, e))?;
    // The channel is always the broadcaster's, whoever is speaking.
    let broadcaster_id = if acct == Acct::Broadcaster {
        sender_id.clone()
    } else {
        let (b_access, _) = ensure_token(shared).map_err(|e| (0u16, e))?;
        identity(shared, &b_access).map_err(|e| (0u16, e))?.0
    };

    let c = reqwest::blocking::Client::new();
    let r = c.post("https://api.twitch.tv/helix/chat/messages")
        .header("Authorization", format!("Bearer {}", access))
        .header("Client-Id", &client_id)
        .json(&json!({
            "broadcaster_id": broadcaster_id,
            "sender_id":      sender_id,
            "message":        message,
        }))
        .send().map_err(|e| (0u16, e.to_string()))?;
    let status = r.status().as_u16();
    if !r.status().is_success() {
        let v: Value = r.json().unwrap_or(json!({}));
        let msg = v.get("message").and_then(|x| x.as_str()).unwrap_or("Failed to send").to_string();
        return Err((status, msg));
    }
    Ok(())
}

fn post_announcement(shared: &Shared, acct: Acct, message: &str, color: &str) -> Result<(), (u16, String)> {
    let (access, client_id) = ensure_token_for(shared, acct).map_err(|e| (0u16, e))?;
    let (moderator_id, _) = identity_for(shared, acct, &access).map_err(|e| (0u16, e))?;
    let broadcaster_id = if acct == Acct::Broadcaster {
        moderator_id.clone()
    } else {
        let (b_access, _) = ensure_token(shared).map_err(|e| (0u16, e))?;
        identity(shared, &b_access).map_err(|e| (0u16, e))?.0
    };
    let col = match color {
        "blue" | "green" | "orange" | "purple" => color,
        _ => "primary",
    };
    let c = reqwest::blocking::Client::new();
    let r = c.post("https://api.twitch.tv/helix/chat/announcements")
        .query(&[("broadcaster_id", broadcaster_id.as_str()), ("moderator_id", moderator_id.as_str())])
        .header("Authorization", format!("Bearer {}", access))
        .header("Client-Id", &client_id)
        .json(&json!({ "message": message, "color": col }))
        .send().map_err(|e| (0u16, e.to_string()))?;
    let status = r.status().as_u16();
    if !r.status().is_success() {
        let v: Value = r.json().unwrap_or(json!({}));
        let msg = v.get("message").and_then(|x| x.as_str()).unwrap_or("Failed to send announcement").to_string();
        return Err((status, msg));
    }
    Ok(())
}

// The sender thread. Started once, from setup().
pub fn start_sender(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut recent: VecDeque<u64> = VecDeque::new();
        let mut last_send_ms:     u64 = 0;
        let mut last_announce_ms: u64 = 0;
        let mut last_text = String::new();
        let mut last_text_ms: u64 = 0;
        let mut window_max = SEND_WINDOW_MAX;

        loop {
            // Block until there's something to send.
            let item = {
                let shared = app.state::<Shared>();
                let mut q = shared.send_queue.lock().unwrap();
                while q.is_empty() {
                    q = shared.send_wake.wait(q).unwrap();
                }
                q.pop_front().unwrap()
            };

            // ── Pacing, all done outside the queue lock ──
            loop {
                let now = now_ms();
                while recent.front().map_or(false, |t| now.saturating_sub(*t) > SEND_WINDOW_MS) {
                    recent.pop_front();
                }
                let mut wait = 0u64;
                if recent.len() >= window_max {
                    if let Some(oldest) = recent.front() {
                        wait = wait.max(SEND_WINDOW_MS.saturating_sub(now.saturating_sub(*oldest)) + 50);
                    }
                }
                let since = now.saturating_sub(last_send_ms);
                if since < SEND_MIN_GAP_MS { wait = wait.max(SEND_MIN_GAP_MS - since); }
                if item.announce {
                    let a_since = now.saturating_sub(last_announce_ms);
                    if a_since < ANNOUNCE_MIN_GAP_MS { wait = wait.max(ANNOUNCE_MIN_GAP_MS - a_since); }
                }
                if wait == 0 { break; }
                std::thread::sleep(Duration::from_millis(wait.min(5_000)));
            }

            // ── Duplicate-message workaround ──
            let mut text = item.message.clone();
            let now = now_ms();
            if text == last_text && now.saturating_sub(last_text_ms) < DUPE_WINDOW_MS {
                text.push(' ');
                text.push_str(INVISIBLE);
            }

            // ── Send, bot first when one is connected ──
            let shared = app.state::<Shared>();
            let use_bot = bot_connected(&shared);
            let mut result = if use_bot {
                if item.announce { post_announcement(&shared, Acct::Bot, &text, &item.color) }
                else             { post_chat(&shared, Acct::Bot, &text) }
            } else {
                Err((0u16, String::new()))   // no bot: go straight to the fallback below
            };

            // Pulled out as owned values so nothing is still borrowing `result`
            // when it gets reassigned below.
            let bot_failure = if use_bot {
                result.as_ref().err().map(|(s, w)| (*s, w.clone()))
            } else { None };

            if let Some((status, why)) = bot_failure {
                // Bot rejected (not a moderator, revoked, token dead). Record
                // why, then say it as the broadcaster so the viewer still gets
                // an answer rather than silence.
                let reason = if status == 401 || status == 403 {
                    format!("Twitch rejected the bot's last message ({}). Make sure the bot account is a moderator in your channel.", status)
                } else { why };
                *shared.bot_send_error.lock().unwrap() = reason.clone();
                let _ = app.emit("spark-send-error", json!({
                    "kind":   if item.announce { "announce" } else { "chat" },
                    "status": status,
                    "reason": reason,
                    "source": "bot",
                }));
                result = Err((0u16, String::new()));   // force the fallback
            } else if use_bot {
                shared.bot_send_error.lock().unwrap().clear();
            }

            if result.is_err() {
                result = if item.announce { post_announcement(&shared, Acct::Broadcaster, &text, &item.color) }
                         else             { post_chat(&shared, Acct::Broadcaster, &text) };
            }

            match result {
                Ok(()) => {
                    let t = now_ms();
                    recent.push_back(t);
                    last_send_ms = t;
                    if item.announce { last_announce_ms = t; }
                    last_text = item.message.clone();
                    last_text_ms = t;
                }
                Err((status, why)) => {
                    if status == 429 {
                        // Back right off and stay cautious for the session.
                        window_max = SEND_WINDOW_MAX_SAFE;
                        let _ = app.emit("spark-send-error", json!({
                            "kind": "rate", "status": 429,
                            "reason": "Twitch rate-limited SPARK. Messages are now being sent more slowly.",
                        }));
                        std::thread::sleep(Duration::from_secs(5));
                    } else if !why.is_empty() && why != "Not connected to Twitch" {
                        let _ = app.emit("spark-send-error", json!({
                            "kind":   if item.announce { "announce" } else { "chat" },
                            "status": status,
                            "reason": why,
                            "source": "broadcaster",
                        }));
                    }
                }
            }
        }
    });
}

// ── Send announcement ─────────────────────────────────────────────────────────
// Helix only. Unlike a plain chat message this renders as a highlighted block,
// and it is the one thing the Commands tab needs the extra scope for.
// color: blue | green | orange | purple | primary (primary = channel accent).

#[tauri::command]
pub fn twitch_send_announcement(shared: State<Shared>, message: String, color: String) -> Result<(), String> {
    if message.trim().is_empty() { return Ok(()); }
    enqueue(&shared, crate::QueuedSend { announce: true, message, color });
    Ok(())
}

// Scopes actually attached to the saved token, straight from the validate
// endpoint. Settings compares this against what the app now asks for.
#[tauri::command]
pub async fn twitch_token_scopes(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let shared = app.state::<Shared>();
        let (access, _) = ensure_token(&shared)?;
        let c = reqwest::blocking::Client::new();
        let r = c.get("https://id.twitch.tv/oauth2/validate")
            .header("Authorization", format!("OAuth {}", access))
            .send().map_err(|e| e.to_string())?;
        if !r.status().is_success() { return Err("Token invalid or expired".into()); }
        let v: Value = r.json().map_err(|e| e.to_string())?;
        Ok(v.get("scopes").and_then(|s| s.as_array()).cloned().unwrap_or_default()
            .into_iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
    }).await.map_err(|e| e.to_string())?
}

// ── Stream info (for {uptime} / {game} / {title} command variables) ───────────
// Get Streams carries all three while live but returns nothing when offline, so
// we fall back to Get Channel Information for game/title. Neither needs a scope.
// Cached for 30s — commands can fire in bursts and Helix rate-limits per token.

#[tauri::command]
pub async fn twitch_get_stream_info(app: tauri::AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let shared = app.state::<Shared>();
        {
            let cache = shared.stream_info_cache.lock().unwrap();
            if let Some((v, at)) = cache.as_ref() {
                if now_secs().saturating_sub(*at) < 30 { return Ok(v.clone()); }
            }
        }
        let (access, client_id) = ensure_token(&shared)?;
        let (uid, login) = identity(&shared, &access)?;
        let c = reqwest::blocking::Client::new();

        let mut out = json!({ "live": false, "title": "", "game": "", "started_at": "", "viewers": 0, "login": login });

        let r = c.get("https://api.twitch.tv/helix/streams")
            .query(&[("user_id", uid.as_str())])
            .header("Authorization", format!("Bearer {}", access))
            .header("Client-Id", &client_id)
            .send().map_err(|e| e.to_string())?;
        if r.status().is_success() {
            let v: Value = r.json().unwrap_or(json!({}));
            if let Some(s) = v.get("data").and_then(|d| d.as_array()).and_then(|a| a.first()) {
                out["live"]       = json!(true);
                out["title"]      = s.get("title").cloned().unwrap_or(json!(""));
                out["game"]       = s.get("game_name").cloned().unwrap_or(json!(""));
                out["started_at"] = s.get("started_at").cloned().unwrap_or(json!(""));
                out["viewers"]    = s.get("viewer_count").cloned().unwrap_or(json!(0));
            }
        }

        // Offline: still fill in game/title so !game and !title stay useful.
        if out["live"] == json!(false) {
            let r2 = c.get("https://api.twitch.tv/helix/channels")
                .query(&[("broadcaster_id", uid.as_str())])
                .header("Authorization", format!("Bearer {}", access))
                .header("Client-Id", &client_id)
                .send().map_err(|e| e.to_string())?;
            if r2.status().is_success() {
                let v: Value = r2.json().unwrap_or(json!({}));
                if let Some(ch) = v.get("data").and_then(|d| d.as_array()).and_then(|a| a.first()) {
                    out["title"] = ch.get("title").cloned().unwrap_or(json!(""));
                    out["game"]  = ch.get("game_name").cloned().unwrap_or(json!(""));
                }
            }
        }

        *shared.stream_info_cache.lock().unwrap() = Some((out.clone(), now_secs()));
        Ok(out)
    }).await.map_err(|e| e.to_string())?
}

// ── Goals: fetch follower count and channel emotes ────────────────────────────

#[tauri::command]
pub async fn twitch_get_follower_count(app: tauri::AppHandle, broadcaster_id: String) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let shared = app.state::<Shared>();
        let (access, client_id) = ensure_token(&shared)?;
        let c = reqwest::blocking::Client::new();
        let r = c.get("https://api.twitch.tv/helix/channels/followers")
            .query(&[("broadcaster_id", broadcaster_id.as_str())])
            .header("Authorization", format!("Bearer {}", access))
            .header("Client-Id", &client_id)
            .send().map_err(|e| e.to_string())?;
        let v: Value = r.json().map_err(|e| e.to_string())?;
        Ok(v.get("total").and_then(|x| x.as_u64()).unwrap_or(0))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn twitch_get_channel_emotes(app: tauri::AppHandle, broadcaster_id: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let shared = app.state::<Shared>();
        let (access, client_id) = ensure_token(&shared)?;
        let c = reqwest::blocking::Client::new();
        let r = c.get("https://api.twitch.tv/helix/chat/emotes")
            .query(&[("broadcaster_id", broadcaster_id.as_str())])
            .header("Authorization", format!("Bearer {}", access))
            .header("Client-Id", &client_id)
            .send().map_err(|e| e.to_string())?;
        if !r.status().is_success() {
            return Ok(json!({"emotes":[]}));
        }
        let v: Value = r.json().map_err(|e| e.to_string())?;
        let emotes: Vec<Value> = v.get("data").and_then(|d| d.as_array()).cloned().unwrap_or_default()
            .into_iter().map(|e| json!({
                "id":   e.get("id").cloned().unwrap_or(Value::Null),
                "name": e.get("name").cloned().unwrap_or(Value::Null),
                "url":  e.get("images").and_then(|i| i.get("url_1x")).cloned().unwrap_or(Value::Null),
            })).collect();
        Ok(json!({"emotes": emotes}))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn twitch_get_global_emotes(app: tauri::AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let shared = app.state::<Shared>();
        let (access, client_id) = ensure_token(&shared)?;
        let c = reqwest::blocking::Client::new();
        let r = c.get("https://api.twitch.tv/helix/chat/emotes/global")
            .header("Authorization", format!("Bearer {}", access))
            .header("Client-Id", &client_id)
            .send().map_err(|e| e.to_string())?;
        if !r.status().is_success() {
            return Ok(json!({"emotes":[]}));
        }
        let v: Value = r.json().map_err(|e| e.to_string())?;
        let emotes: Vec<Value> = v.get("data").and_then(|d| d.as_array()).cloned().unwrap_or_default()
            .into_iter().map(|e| json!({
                "id":   e.get("id").cloned().unwrap_or(Value::Null),
                "name": e.get("name").cloned().unwrap_or(Value::Null),
                "url":  e.get("images").and_then(|i| i.get("url_1x")).cloned().unwrap_or(Value::Null),
            })).collect();
        Ok(json!({"emotes": emotes}))
    }).await.map_err(|e| e.to_string())?
}

// ── Lookups for command variables ─────────────────────────────────────────────

// Same Helix /users endpoint as twitch_get_user_info, but keyed by login rather
// than id — needed because a chat message gives us "@someone", not a user id.
// Also returns created_at so {accountage} works off the same single call.
#[tauri::command]
pub async fn twitch_get_user_by_login(app: tauri::AppHandle, login: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let shared = app.state::<Shared>();
        let (access, client_id) = ensure_token(&shared)?;
        let clean = login.trim().trim_start_matches('@').to_lowercase();
        if clean.is_empty() { return Err("No username given".into()); }
        let c = reqwest::blocking::Client::new();
        let r = c.get("https://api.twitch.tv/helix/users")
            .query(&[("login", clean.as_str())])
            .header("Authorization", format!("Bearer {}", access))
            .header("Client-Id", &client_id)
            .send().map_err(|e| e.to_string())?;
        let v: Value = r.json().map_err(|e| e.to_string())?;
        let user = v.get("data").and_then(|d| d.as_array()).and_then(|a| a.first()).cloned();
        let user = match user { Some(u) => u, None => return Err("No such user".into()) };
        Ok(json!({
            "id":                user.get("id").cloned().unwrap_or(Value::Null),
            "login":             user.get("login").cloned().unwrap_or(Value::Null),
            "display_name":      user.get("display_name").cloned().unwrap_or(Value::Null),
            "profile_image_url": user.get("profile_image_url").cloned().unwrap_or(Value::Null),
            "created_at":        user.get("created_at").cloned().unwrap_or(Value::Null),
            "description":       user.get("description").cloned().unwrap_or(Value::Null),
        }))
    }).await.map_err(|e| e.to_string())?
}

// When a viewer started following. Returns "" when they don't follow, which the
// frontend renders as "not following" rather than an error.
#[tauri::command]
pub async fn twitch_get_followage(app: tauri::AppHandle, user_id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let shared = app.state::<Shared>();
        let (access, client_id) = ensure_token(&shared)?;
        let (uid, _) = identity(&shared, &access)?;
        let c = reqwest::blocking::Client::new();
        let r = c.get("https://api.twitch.tv/helix/channels/followers")
            .query(&[("broadcaster_id", uid.as_str()), ("user_id", user_id.as_str())])
            .header("Authorization", format!("Bearer {}", access))
            .header("Client-Id", &client_id)
            .send().map_err(|e| e.to_string())?;
        if !r.status().is_success() { return Ok(String::new()); }
        let v: Value = r.json().map_err(|e| e.to_string())?;
        Ok(v.get("data").and_then(|d| d.as_array()).and_then(|a| a.first())
            .and_then(|f| f.get("followed_at")).and_then(|x| x.as_str())
            .unwrap_or("").to_string())
    }).await.map_err(|e| e.to_string())?
}

// Total subscribers. Uses channel:read:subscriptions, which is in SCOPES.
#[tauri::command]
pub async fn twitch_get_sub_count(app: tauri::AppHandle) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let shared = app.state::<Shared>();
        let (access, client_id) = ensure_token(&shared)?;
        let (uid, _) = identity(&shared, &access)?;
        let c = reqwest::blocking::Client::new();
        let r = c.get("https://api.twitch.tv/helix/subscriptions")
            .query(&[("broadcaster_id", uid.as_str()), ("first", "1")])
            .header("Authorization", format!("Bearer {}", access))
            .header("Client-Id", &client_id)
            .send().map_err(|e| e.to_string())?;
        if !r.status().is_success() { return Ok(0); }
        let v: Value = r.json().map_err(|e| e.to_string())?;
        Ok(v.get("total").and_then(|x| x.as_u64()).unwrap_or(0))
    }).await.map_err(|e| e.to_string())?
}

// ── Get user profile picture ──────────────────────────────────────────────────

#[tauri::command]
pub async fn twitch_get_user_info(app: tauri::AppHandle, user_id: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let shared = app.state::<Shared>();
        let (access, client_id) = ensure_token(&shared)?;
        let c = reqwest::blocking::Client::new();
        let r = c.get("https://api.twitch.tv/helix/users")
            .query(&[("id", user_id.as_str())])
            .header("Authorization", format!("Bearer {}", access))
            .header("Client-Id", &client_id)
            .send().map_err(|e| e.to_string())?;
        let v: Value = r.json().map_err(|e| e.to_string())?;
        let user = v.get("data").and_then(|d| d.as_array()).and_then(|a| a.first()).cloned()
            .unwrap_or(json!({}));
        Ok(json!({
            "id":           user.get("id").cloned().unwrap_or(Value::Null),
            "login":        user.get("login").cloned().unwrap_or(Value::Null),
            "display_name": user.get("display_name").cloned().unwrap_or(Value::Null),
            "profile_image_url": user.get("profile_image_url").cloned().unwrap_or(Value::Null),
        }))
    }).await.map_err(|e| e.to_string())?
}

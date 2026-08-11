use std::sync::atomic::Ordering;
use std::collections::VecDeque;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use serde_json::{json, Value};
use tauri::{Emitter, Manager, State};
use crate::Shared;

// Scopes requested for the broadcaster token. A saved token only carries the
// scopes it was granted, so twitch_token_scopes() lets Settings compare the two
// and prompt for a reconnect when this list has grown.
// Twitch's own docs warn that requesting scopes the app does not actually use
// can get an application suspended, so every entry here must map to a call
// SPARK really makes. The Broadcast tab block below is the reason for the
// second half of this list.
const SCOPES: &str = concat!(
    "channel:read:redemptions channel:manage:redemptions channel:read:subscriptions ",
    "moderator:read:followers bits:read chat:read user:write:chat ",
    "moderator:manage:announcements channel:read:ads ",
    // Broadcast tab. Note two of these pull double duty:
    //   channel:manage:broadcast     title/category/tags AND stream markers
    //   moderator:manage:chat_messages  deleting messages AND pinning them
    "channel:manage:broadcast ",
    "moderator:manage:banned_users moderator:manage:chat_messages ",
    "channel:manage:raids moderator:manage:shoutouts ",
    "channel:manage:polls channel:manage:predictions ",
    "channel:manage:moderators channel:manage:vips user:manage:whispers ",
    // Ads and chat modes, also Broadcast tab.
    // channel:read:ads (above) reads the schedule; these two ACT on it.
    "channel:edit:commercial channel:manage:ads ",
    "moderator:read:chat_settings moderator:manage:chat_settings ",
    // Hype train overlay (a D.I.Y widget type).
    "channel:read:hype_train"
);

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
// hammer Helix with one API call per !command per user. The TTL and the cache
// itself now live in lib.rs — this used to be a second, shorter-lived cache
// sitting alongside a persistent one in the frontend, and the two disagreed.
use crate::FOLLOWER_TTL_SECS as FOLLOWER_CACHE_TTL_SECS;

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
        // Flushed to its own file by the background thread, not written here —
        // this runs on the busy path.
        shared.follower_dirty.store(true, Ordering::SeqCst);
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
                            // Ad breaks. Twitch announces the START of a break and
                            // nothing else: there is no "ads are coming" event and no
                            // "ads finished" event, so the frontend derives those two
                            // from the ad schedule and from start + duration.
                            let _ = subscribe(access, client_id, &sid, "channel.ad_break.begin", "1", json!({"broadcaster_user_id":uid}));
                            // Stream start/stop. Neither needs a scope, so these
                            // cost nothing and replace polling Get Streams for
                            // the "only while live" gate. They also give the
                            // frontend a real per-stream boundary to reset
                            // check-ins and the credits roster on, instead of
                            // guessing from when the app happened to launch.
                            let _ = subscribe(access, client_id, &sid, "stream.online",  "1", json!({"broadcaster_user_id":uid}));
                            let _ = subscribe(access, client_id, &sid, "stream.offline", "1", json!({"broadcaster_user_id":uid}));
                            // !! HYPE TRAIN IS VERSION 2. !!
                            // v1 was withdrawn on 15 Jan 2026 and now 410s.
                            // Every other subscription here is "1", so copying
                            // the pattern would silently never fire.
                            let _ = subscribe(access, client_id, &sid, "channel.hype_train.begin",    "2", json!({"broadcaster_user_id":uid}));
                            let _ = subscribe(access, client_id, &sid, "channel.hype_train.progress", "2", json!({"broadcaster_user_id":uid}));
                            let _ = subscribe(access, client_id, &sid, "channel.hype_train.end",      "2", json!({"broadcaster_user_id":uid}));
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
                            // Ad break started. duration_seconds is how long Twitch
                            // says the break runs for, which is what the "ads finish"
                            // trigger counts down from.
                            if sub_type == "channel.ad_break.begin" {
                                let _ = app.emit("twitch-ad", json!({
                                    "kind": "begin",
                                    "duration": ev["duration_seconds"],
                                    "is_automatic": ev["is_automatic"],
                                    "started_at": ev["started_at"],
                                }));
                            }
                            // Hype train. The whole payload is forwarded untouched so
                            // the widget can use any field Twitch sends, including
                            // ones added later, with no Rust change needed.
                            if sub_type.starts_with("channel.hype_train.") {
                                let phase = sub_type.rsplit('.').next().unwrap_or("");
                                let mut payload = ev.clone();
                                payload["_phase"] = json!(phase);   // begin | progress | end
                                let _ = app.emit("twitch-hypetrain", payload.clone());
                                // Straight onto the overlay bus too, so a D.I.Y
                                // widget gets it without a round-trip through the
                                // app window. "chat" is the tool the D.I.Y runtime
                                // long-polls, not a description of the content.
                                {
                                    let shared = app.state::<Shared>();
                                    let mut oe = payload;
                                    oe["type"] = json!("hypetrain");
                                    shared.push_overlay_event("chat", oe);
                                }
                            }
                            // Stream went live / ended. The cached stream info is
                            // cleared as well as forwarded: anything asking "am I
                            // live" a second later must not be answered from a
                            // snapshot taken before this arrived.
                            if sub_type == "stream.online" || sub_type == "stream.offline" {
                                let live = sub_type == "stream.online";
                                {
                                    let shared = app.state::<Shared>();
                                    *shared.stream_info_cache.lock().unwrap() = None;
                                }
                                let _ = app.emit("twitch-stream", json!({
                                    "live": live,
                                    "started_at": ev["started_at"],
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

    // Twitch's per-message id. Deleting a single message needs it, and it is
    // the only handle we ever get — it is not derivable from anything else in
    // the line, so it has to be carried through with the message itself.
    let msg_id = tags.get("id").copied().unwrap_or("");

    Some(json!({
        "username":    username,
        "display":     display,
        "user_id":     user_id,
        "msg_id":      msg_id,
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

// Unchanged signature, unchanged behaviour: the bot says it when one is
// connected, otherwise the broadcaster does. Every tab in SPARK calls this and
// none of them cares who it comes from, so it deliberately takes no account
// argument — see twitch_send_chat_as below for the case that does.
#[tauri::command]
pub fn twitch_send_chat_message(shared: State<Shared>, message: String) -> Result<(), String> {
    if message.trim().is_empty() { return Ok(()); }
    enqueue(&shared, crate::QueuedSend {
        announce: false, message, color: String::new(), as_acct: None,
    });
    Ok(())
}

// Send as a NAMED account: "bot" or "broadcaster". Used by the Broadcast tab's
// chat box, where you are talking to chat yourself and it matters whose name
// appears.
//
// This is a separate command rather than an optional argument on the one above
// on purpose. That one is called from seven other files; widening its signature
// would put every chat message in SPARK behind an assumption about how missing
// arguments deserialise, and that is not a thing to gamble on for the busiest
// path in the app.
#[tauri::command]
pub fn twitch_send_chat_as(shared: State<Shared>, message: String, as_account: String) -> Result<(), String> {
    if message.trim().is_empty() { return Ok(()); }
    let want = match as_account.as_str() {
        "broadcaster" => Some("broadcaster".to_string()),
        "bot"         => Some("bot".to_string()),
        _             => None,
    };
    enqueue(&shared, crate::QueuedSend {
        announce: false, message, color: String::new(), as_acct: want,
    });
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
            // Which account says it. An explicit choice wins; otherwise the
            // old rule applies (bot when there is one).
            //
            // Note the asymmetry, and it is deliberate: asking for the
            // broadcaster NEVER silently becomes the bot, because the point of
            // choosing is that the message appears under your own name. Asking
            // for the bot when none is connected still falls back to you —
            // better a message from the wrong name than no message at all.
            let want = item.as_acct.as_deref().unwrap_or("");
            let use_bot = match want {
                "broadcaster" => false,
                "bot"         => bot_connected(&shared),
                _             => bot_connected(&shared),
            };
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
    enqueue(&shared, crate::QueuedSend {
        announce: true, message, color, as_acct: None,
    });
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

// The scopes THIS build asks for. Exposed so the re-auth check has one source
// of truth: adding a scope to SCOPES above is all a future release has to do —
// the startup check picks it up with no matching frontend edit. Local only,
// no network, so it is safe to call on every boot.
#[tauri::command]
pub fn twitch_required_scopes() -> Vec<String> {
    SCOPES.split_whitespace().map(|s| s.to_string()).collect()
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

// ── Ad schedule ───────────────────────────────────────────────────────────────
// Twitch has no "an ad is coming" event, so the only way to warn ahead of one
// is to ask when the next break is due and watch the clock. next_ad_at comes
// back as an RFC3339 timestamp, or an epoch-zero placeholder when nothing is
// scheduled — the frontend treats anything in the past as "no ad due".
//
// Needs channel:read:ads, which older logins do not carry, so a plain error is
// returned rather than a panic and the Commands tab shows its reconnect banner.
#[tauri::command]
pub async fn twitch_get_ad_schedule(app: tauri::AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let shared = app.state::<Shared>();
        let (access, client_id) = ensure_token(&shared)?;
        let (uid, _) = identity(&shared, &access)?;
        let c = reqwest::blocking::Client::new();
        let r = c.get("https://api.twitch.tv/helix/channels/ads")
            .query(&[("broadcaster_id", uid.as_str())])
            .header("Authorization", format!("Bearer {}", access))
            .header("Client-Id", &client_id)
            .send().map_err(|e| e.to_string())?;
        let status = r.status();
        let v: Value = r.json().unwrap_or(json!({}));
        if !status.is_success() {
            return Err(v.get("message").and_then(|x| x.as_str())
                .unwrap_or("Ad schedule lookup failed").to_string());
        }
        let d = v.get("data").and_then(|d| d.as_array()).and_then(|a| a.first()).cloned()
            .unwrap_or(json!({}));
        Ok(json!({
            "next_ad_at":        d.get("next_ad_at").cloned().unwrap_or(Value::Null),
            "last_ad_at":        d.get("last_ad_at").cloned().unwrap_or(Value::Null),
            "duration":          d.get("duration").cloned().unwrap_or(Value::Null),
            "preroll_free_time": d.get("preroll_free_time").cloned().unwrap_or(Value::Null),
            "snooze_count":      d.get("snooze_count").cloned().unwrap_or(Value::Null),
        }))
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

// ── Broadcast tab ─────────────────────────────────────────────────────────────
// Everything the Broadcast tab calls. Grouped here rather than scattered so the
// scope list at the top of this file has one obvious place to point at.
//
// All of these follow the same shape as the rest of the file: async command,
// spawn_blocking around a blocking reqwest call, so nothing touches the UI
// thread. See the 5 Aug session notes for why that matters.

// Small helper: Helix returns errors as {"message": "..."} and the raw status
// on its own is useless to show a streamer mid-broadcast.
fn helix_err(status: reqwest::StatusCode, body: &Value, fallback: &str) -> String {
    body.get("message").and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("{} ({})", fallback, status.as_u16()))
}

// Modify Channel Information. Every field is optional — sending only the ones
// that changed avoids clobbering a title when the user only picked a category.
// Tags replace the existing set wholesale; that is Twitch's behaviour, not ours.
#[tauri::command]
pub async fn twitch_update_channel_info(
    app: tauri::AppHandle,
    title: Option<String>,
    game_id: Option<String>,
    tags: Option<Vec<String>>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let shared = app.state::<Shared>();
        let (access, client_id) = ensure_token(&shared)?;
        let (uid, _) = identity(&shared, &access)?;

        let mut body = serde_json::Map::new();
        if let Some(t) = title.as_ref() {
            let t = t.trim();
            if t.is_empty() { return Err("A stream title cannot be empty.".into()); }
            if t.chars().count() > 140 { return Err("Titles are limited to 140 characters.".into()); }
            body.insert("title".into(), json!(t));
        }
        if let Some(g) = game_id.as_ref() { body.insert("game_id".into(), json!(g)); }
        if let Some(tg) = tags.as_ref() {
            // Twitch: max 10 tags, 25 characters each, no spaces inside a tag.
            let cleaned: Vec<String> = tg.iter()
                .map(|s| s.trim().replace(' ', ""))
                .filter(|s| !s.is_empty())
                .take(10)
                .collect();
            if cleaned.iter().any(|s| s.chars().count() > 25) {
                return Err("Tags are limited to 25 characters each.".into());
            }
            body.insert("tags".into(), json!(cleaned));
        }
        if body.is_empty() { return Ok(()); }

        let c = reqwest::blocking::Client::new();
        let r = c.patch("https://api.twitch.tv/helix/channels")
            .query(&[("broadcaster_id", uid.as_str())])
            .header("Authorization", format!("Bearer {}", access))
            .header("Client-Id", &client_id)
            .json(&Value::Object(body))
            .send().map_err(|e| e.to_string())?;
        let status = r.status();
        if !status.is_success() {
            let v: Value = r.json().unwrap_or(json!({}));
            return Err(helix_err(status, &v, "Could not update your channel"));
        }
        // The cached copy is now wrong by definition.
        *shared.stream_info_cache.lock().unwrap() = None;
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

// Current title, category (id AND name) and tags. Get Streams does not return
// tags or a game id reliably, so the Broadcast tab reads the channel directly
// rather than reusing the cached twitch_get_stream_info.
#[tauri::command]
pub async fn twitch_get_channel_info(app: tauri::AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let shared = app.state::<Shared>();
        let (access, client_id) = ensure_token(&shared)?;
        let (uid, _) = identity(&shared, &access)?;
        let c = reqwest::blocking::Client::new();
        let r = c.get("https://api.twitch.tv/helix/channels")
            .query(&[("broadcaster_id", uid.as_str())])
            .header("Authorization", format!("Bearer {}", access))
            .header("Client-Id", &client_id)
            .send().map_err(|e| e.to_string())?;
        let status = r.status();
        let v: Value = r.json().unwrap_or(json!({}));
        if !status.is_success() { return Err(helix_err(status, &v, "Could not read your channel")); }
        let ch = v.get("data").and_then(|d| d.as_array()).and_then(|a| a.first()).cloned()
            .unwrap_or(json!({}));
        Ok(json!({
            "title":     ch.get("title").cloned().unwrap_or(json!("")),
            "game_id":   ch.get("game_id").cloned().unwrap_or(json!("")),
            "game_name": ch.get("game_name").cloned().unwrap_or(json!("")),
            "tags":      ch.get("tags").cloned().unwrap_or(json!([])),
            "language":  ch.get("broadcaster_language").cloned().unwrap_or(json!("")),
        }))
    }).await.map_err(|e| e.to_string())?
}

// Category search for the picker. Needs no scope, so it stays available even if
// the user has not reconnected for the Broadcast scopes yet.
#[tauri::command]
pub async fn twitch_search_categories(app: tauri::AppHandle, query: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let q = query.trim().to_string();
        if q.is_empty() { return Ok(json!([])); }
        let shared = app.state::<Shared>();
        let (access, client_id) = ensure_token(&shared)?;
        let c = reqwest::blocking::Client::new();
        let r = c.get("https://api.twitch.tv/helix/search/categories")
            .query(&[("query", q.as_str()), ("first", "12")])
            .header("Authorization", format!("Bearer {}", access))
            .header("Client-Id", &client_id)
            .send().map_err(|e| e.to_string())?;
        let status = r.status();
        let v: Value = r.json().unwrap_or(json!({}));
        if !status.is_success() { return Err(helix_err(status, &v, "Category search failed")); }
        let list: Vec<Value> = v.get("data").and_then(|d| d.as_array()).cloned().unwrap_or_default()
            .into_iter().map(|g| json!({
                "id":       g.get("id").cloned().unwrap_or(Value::Null),
                "name":     g.get("name").cloned().unwrap_or(Value::Null),
                // box_art_url carries {width}x{height} placeholders.
                "box_art":  g.get("box_art_url").and_then(|x| x.as_str())
                             .map(|s| s.replace("{width}", "52").replace("{height}", "72"))
                             .map(Value::from).unwrap_or(Value::Null),
            })).collect();
        Ok(Value::Array(list))
    }).await.map_err(|e| e.to_string())?
}

// Stream marker. Free with channel:manage:broadcast — same scope as the title
// edit above, which is why it lives in this tab rather than costing its own.
// Twitch rejects markers when the channel is not live; say so plainly.
#[tauri::command]
pub async fn twitch_create_stream_marker(app: tauri::AppHandle, description: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let shared = app.state::<Shared>();
        let (access, client_id) = ensure_token(&shared)?;
        let (uid, _) = identity(&shared, &access)?;
        let mut body = json!({ "user_id": uid });
        let d = description.trim();
        if !d.is_empty() { body["description"] = json!(d.chars().take(140).collect::<String>()); }

        let c = reqwest::blocking::Client::new();
        let r = c.post("https://api.twitch.tv/helix/streams/markers")
            .header("Authorization", format!("Bearer {}", access))
            .header("Client-Id", &client_id)
            .json(&body)
            .send().map_err(|e| e.to_string())?;
        let status = r.status();
        let v: Value = r.json().unwrap_or(json!({}));
        if status == reqwest::StatusCode::NOT_FOUND {
            return Err("Markers only work while you are live.".into());
        }
        if !status.is_success() { return Err(helix_err(status, &v, "Could not create a marker")); }
        let m = v.get("data").and_then(|d| d.as_array()).and_then(|a| a.first()).cloned()
            .unwrap_or(json!({}));
        Ok(json!({
            "id":       m.get("id").cloned().unwrap_or(Value::Null),
            "position": m.get("position_seconds").cloned().unwrap_or(Value::Null),
        }))
    }).await.map_err(|e| e.to_string())?
}

// ── Moderation ────────────────────────────────────────────────────────────────
// SPARK is always acting AS the broadcaster, so moderator_id is always our own
// user id. Twitch still wants both parameters spelled out.

// Timeout when duration is Some, permanent ban when None. One endpoint covers
// both, and collapsing them here keeps the two buttons in the UI honest about
// being the same underlying action.
#[tauri::command]
pub async fn twitch_ban_user(
    app: tauri::AppHandle,
    user_id: String,
    duration: Option<u32>,
    reason: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if user_id.trim().is_empty() { return Err("No user to act on.".into()); }
        let shared = app.state::<Shared>();
        let (access, client_id) = ensure_token(&shared)?;
        let (uid, _) = identity(&shared, &access)?;

        let mut d = serde_json::Map::new();
        d.insert("user_id".into(), json!(user_id));
        if let Some(secs) = duration {
            // Twitch caps a timeout at 1209600 seconds (14 days).
            d.insert("duration".into(), json!(secs.clamp(1, 1_209_600)));
        }
        if let Some(r) = reason.as_ref() {
            let r = r.trim();
            if !r.is_empty() { d.insert("reason".into(), json!(r.chars().take(500).collect::<String>())); }
        }

        let c = reqwest::blocking::Client::new();
        let r = c.post("https://api.twitch.tv/helix/moderation/bans")
            .query(&[("broadcaster_id", uid.as_str()), ("moderator_id", uid.as_str())])
            .header("Authorization", format!("Bearer {}", access))
            .header("Client-Id", &client_id)
            .json(&json!({ "data": Value::Object(d) }))
            .send().map_err(|e| e.to_string())?;
        let status = r.status();
        if !status.is_success() {
            let v: Value = r.json().unwrap_or(json!({}));
            // The most common failure by far: you cannot time out a mod, and
            // the raw message does not say so clearly.
            if status == reqwest::StatusCode::BAD_REQUEST {
                let m = v.get("message").and_then(|x| x.as_str()).unwrap_or("");
                if m.to_lowercase().contains("moderator") {
                    return Err("You cannot time out or ban a moderator. Remove their mod status first.".into());
                }
            }
            return Err(helix_err(status, &v, "That moderation action failed"));
        }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn twitch_unban_user(app: tauri::AppHandle, user_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if user_id.trim().is_empty() { return Err("No user to act on.".into()); }
        let shared = app.state::<Shared>();
        let (access, client_id) = ensure_token(&shared)?;
        let (uid, _) = identity(&shared, &access)?;
        let c = reqwest::blocking::Client::new();
        let r = c.delete("https://api.twitch.tv/helix/moderation/bans")
            .query(&[("broadcaster_id", uid.as_str()), ("moderator_id", uid.as_str()),
                     ("user_id", user_id.as_str())])
            .header("Authorization", format!("Bearer {}", access))
            .header("Client-Id", &client_id)
            .send().map_err(|e| e.to_string())?;
        let status = r.status();
        if !status.is_success() {
            let v: Value = r.json().unwrap_or(json!({}));
            return Err(helix_err(status, &v, "Could not undo that"));
        }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

// Delete one message, or clear the whole chat when message_id is empty.
// message_id comes from the IRC "id" tag (see parse_irc) and is the only handle
// Twitch gives us for a specific message.
#[tauri::command]
pub async fn twitch_delete_message(app: tauri::AppHandle, message_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let shared = app.state::<Shared>();
        let (access, client_id) = ensure_token(&shared)?;
        let (uid, _) = identity(&shared, &access)?;
        let c = reqwest::blocking::Client::new();

        let mut q = vec![("broadcaster_id", uid.clone()), ("moderator_id", uid.clone())];
        if !message_id.trim().is_empty() { q.push(("message_id", message_id.clone())); }

        let r = c.delete("https://api.twitch.tv/helix/moderation/chat")
            .query(&q)
            .header("Authorization", format!("Bearer {}", access))
            .header("Client-Id", &client_id)
            .send().map_err(|e| e.to_string())?;
        let status = r.status();
        if !status.is_success() {
            let v: Value = r.json().unwrap_or(json!({}));
            // Twitch refuses to delete anything older than 6 hours, and refuses
            // outright to delete a broadcaster's or moderator's message.
            if status == reqwest::StatusCode::NOT_FOUND {
                return Err("That message is too old to delete, or has already gone.".into());
            }
            if status == reqwest::StatusCode::FORBIDDEN {
                return Err("Twitch does not allow deleting a moderator's or the broadcaster's messages.".into());
            }
            return Err(helix_err(status, &v, "Could not delete that message"));
        }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

// Pin / unpin. Free with moderator:manage:chat_messages — the same scope the
// delete above already needs.
#[tauri::command]
pub async fn twitch_pin_message(app: tauri::AppHandle, message_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if message_id.trim().is_empty() { return Err("No message to pin.".into()); }
        let shared = app.state::<Shared>();
        let (access, client_id) = ensure_token(&shared)?;
        let (uid, _) = identity(&shared, &access)?;
        let c = reqwest::blocking::Client::new();
        let r = c.post("https://api.twitch.tv/helix/chat/pins")
            .header("Authorization", format!("Bearer {}", access))
            .header("Client-Id", &client_id)
            .json(&json!({
                "broadcaster_id": uid,
                "sender_id":      uid,
                "message_id":     message_id,
            }))
            .send().map_err(|e| e.to_string())?;
        let status = r.status();
        if !status.is_success() {
            let v: Value = r.json().unwrap_or(json!({}));
            return Err(helix_err(status, &v, "Could not pin that message"));
        }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

// ── Quick actions ─────────────────────────────────────────────────────────────

// Raid. Twitch does NOT start the raid immediately — it opens the 90-second
// warning on stream and the raid fires when that elapses (or when you click
// through on Twitch). Say so, or it looks broken.
#[tauri::command]
pub async fn twitch_start_raid(app: tauri::AppHandle, target_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if target_id.trim().is_empty() { return Err("Pick a channel to raid first.".into()); }
        let shared = app.state::<Shared>();
        let (access, client_id) = ensure_token(&shared)?;
        let (uid, _) = identity(&shared, &access)?;
        if target_id == uid { return Err("You cannot raid your own channel.".into()); }
        let c = reqwest::blocking::Client::new();
        let r = c.post("https://api.twitch.tv/helix/raids")
            .query(&[("from_broadcaster_id", uid.as_str()), ("to_broadcaster_id", target_id.as_str())])
            .header("Authorization", format!("Bearer {}", access))
            .header("Client-Id", &client_id)
            .send().map_err(|e| e.to_string())?;
        let status = r.status();
        if !status.is_success() {
            let v: Value = r.json().unwrap_or(json!({}));
            if status == reqwest::StatusCode::BAD_REQUEST {
                return Err("Twitch refused that raid. The channel may not exist, or you may already have a raid pending.".into());
            }
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                return Err("You are raiding too often — Twitch is rate-limiting it.".into());
            }
            return Err(helix_err(status, &v, "Could not start that raid"));
        }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn twitch_cancel_raid(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let shared = app.state::<Shared>();
        let (access, client_id) = ensure_token(&shared)?;
        let (uid, _) = identity(&shared, &access)?;
        let c = reqwest::blocking::Client::new();
        let r = c.delete("https://api.twitch.tv/helix/raids")
            .query(&[("broadcaster_id", uid.as_str())])
            .header("Authorization", format!("Bearer {}", access))
            .header("Client-Id", &client_id)
            .send().map_err(|e| e.to_string())?;
        let status = r.status();
        if status == reqwest::StatusCode::NOT_FOUND { return Err("There is no raid to cancel.".into()); }
        if !status.is_success() {
            let v: Value = r.json().unwrap_or(json!({}));
            return Err(helix_err(status, &v, "Could not cancel the raid"));
        }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

// Shoutout. Twitch enforces two cooldowns of its own (2 minutes between any two
// shoutouts, 60 minutes per target) and requires the channel to be live.
#[tauri::command]
pub async fn twitch_send_shoutout(app: tauri::AppHandle, target_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if target_id.trim().is_empty() { return Err("Pick someone to shout out first.".into()); }
        let shared = app.state::<Shared>();
        let (access, client_id) = ensure_token(&shared)?;
        let (uid, _) = identity(&shared, &access)?;
        if target_id == uid { return Err("You cannot shout out your own channel.".into()); }
        let c = reqwest::blocking::Client::new();
        let r = c.post("https://api.twitch.tv/helix/chat/shoutouts")
            .query(&[("from_broadcaster_id", uid.as_str()),
                     ("to_broadcaster_id", target_id.as_str()),
                     ("moderator_id", uid.as_str())])
            .header("Authorization", format!("Bearer {}", access))
            .header("Client-Id", &client_id)
            .send().map_err(|e| e.to_string())?;
        let status = r.status();
        if !status.is_success() {
            let v: Value = r.json().unwrap_or(json!({}));
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                return Err("Twitch is still cooling down from the last shoutout. It allows one every 2 minutes, and one per channel per hour.".into());
            }
            if status == reqwest::StatusCode::BAD_REQUEST {
                return Err("Shoutouts only work while you are live.".into());
            }
            return Err(helix_err(status, &v, "Could not send that shoutout"));
        }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

// ── Polls and predictions ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn twitch_create_poll(
    app: tauri::AppHandle,
    title: String,
    choices: Vec<String>,
    duration: u32,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let title = title.trim().to_string();
        if title.is_empty() { return Err("Give the poll a question.".into()); }
        if title.chars().count() > 60 { return Err("Poll questions are limited to 60 characters.".into()); }
        let opts: Vec<String> = choices.iter().map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()).collect();
        if opts.len() < 2 { return Err("A poll needs at least two answers.".into()); }
        if opts.len() > 5 { return Err("Twitch allows five answers at most.".into()); }
        if opts.iter().any(|o| o.chars().count() > 25) {
            return Err("Poll answers are limited to 25 characters each.".into());
        }

        let shared = app.state::<Shared>();
        let (access, client_id) = ensure_token(&shared)?;
        let (uid, _) = identity(&shared, &access)?;
        let c = reqwest::blocking::Client::new();
        let r = c.post("https://api.twitch.tv/helix/polls")
            .header("Authorization", format!("Bearer {}", access))
            .header("Client-Id", &client_id)
            .json(&json!({
                "broadcaster_id": uid,
                "title": title,
                "choices": opts.iter().map(|t| json!({"title": t})).collect::<Vec<Value>>(),
                // Twitch accepts 15..1800 seconds.
                "duration": duration.clamp(15, 1800),
            }))
            .send().map_err(|e| e.to_string())?;
        let status = r.status();
        let v: Value = r.json().unwrap_or(json!({}));
        if !status.is_success() {
            if status == reqwest::StatusCode::BAD_REQUEST {
                return Err("Twitch refused that poll. You may already have one running — only one poll can be active at a time.".into());
            }
            return Err(helix_err(status, &v, "Could not create that poll"));
        }
        let p = v.get("data").and_then(|d| d.as_array()).and_then(|a| a.first()).cloned()
            .unwrap_or(json!({}));
        Ok(json!({ "id": p.get("id").cloned().unwrap_or(Value::Null) }))
    }).await.map_err(|e| e.to_string())?
}

// status: "TERMINATED" ends it and shows the result, "ARCHIVED" hides it.
#[tauri::command]
pub async fn twitch_end_poll(app: tauri::AppHandle, poll_id: String, status: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if poll_id.trim().is_empty() { return Err("No poll to end.".into()); }
        let st = if status == "ARCHIVED" { "ARCHIVED" } else { "TERMINATED" };
        let shared = app.state::<Shared>();
        let (access, client_id) = ensure_token(&shared)?;
        let (uid, _) = identity(&shared, &access)?;
        let c = reqwest::blocking::Client::new();
        let r = c.patch("https://api.twitch.tv/helix/polls")
            .header("Authorization", format!("Bearer {}", access))
            .header("Client-Id", &client_id)
            .json(&json!({ "broadcaster_id": uid, "id": poll_id, "status": st }))
            .send().map_err(|e| e.to_string())?;
        let s = r.status();
        if !s.is_success() {
            let v: Value = r.json().unwrap_or(json!({}));
            return Err(helix_err(s, &v, "Could not end that poll"));
        }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

// The one currently-running poll, or null. Used to show live results and to
// keep the End button honest across an app restart.
#[tauri::command]
pub async fn twitch_get_active_poll(app: tauri::AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let shared = app.state::<Shared>();
        let (access, client_id) = ensure_token(&shared)?;
        let (uid, _) = identity(&shared, &access)?;
        let c = reqwest::blocking::Client::new();
        let r = c.get("https://api.twitch.tv/helix/polls")
            .query(&[("broadcaster_id", uid.as_str()), ("first", "1")])
            .header("Authorization", format!("Bearer {}", access))
            .header("Client-Id", &client_id)
            .send().map_err(|e| e.to_string())?;
        if !r.status().is_success() { return Ok(Value::Null); }
        let v: Value = r.json().unwrap_or(json!({}));
        let p = match v.get("data").and_then(|d| d.as_array()).and_then(|a| a.first()) {
            Some(p) => p.clone(), None => return Ok(Value::Null),
        };
        if p.get("status").and_then(|x| x.as_str()) != Some("ACTIVE") { return Ok(Value::Null); }
        Ok(json!({
            "id":      p.get("id").cloned().unwrap_or(Value::Null),
            "title":   p.get("title").cloned().unwrap_or(Value::Null),
            "ends_at": p.get("ends_at").cloned().unwrap_or(Value::Null),
            "choices": p.get("choices").and_then(|c| c.as_array()).map(|arr| arr.iter().map(|ch| json!({
                "title": ch.get("title").cloned().unwrap_or(Value::Null),
                "votes": ch.get("votes").cloned().unwrap_or(json!(0)),
            })).collect::<Vec<Value>>()).unwrap_or_default(),
        }))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn twitch_create_prediction(
    app: tauri::AppHandle,
    title: String,
    outcomes: Vec<String>,
    window: u32,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let title = title.trim().to_string();
        if title.is_empty() { return Err("Give the prediction a question.".into()); }
        if title.chars().count() > 45 { return Err("Prediction questions are limited to 45 characters.".into()); }
        let outs: Vec<String> = outcomes.iter().map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()).collect();
        // Twitch takes 2 to 10 outcomes.
        if outs.len() < 2 { return Err("A prediction needs at least two outcomes.".into()); }
        if outs.len() > 10 { return Err("Twitch allows ten outcomes at most.".into()); }
        if outs.iter().any(|o| o.chars().count() > 25) {
            return Err("Prediction outcomes are limited to 25 characters each.".into());
        }

        let shared = app.state::<Shared>();
        let (access, client_id) = ensure_token(&shared)?;
        let (uid, _) = identity(&shared, &access)?;
        let c = reqwest::blocking::Client::new();
        let r = c.post("https://api.twitch.tv/helix/predictions")
            .header("Authorization", format!("Bearer {}", access))
            .header("Client-Id", &client_id)
            .json(&json!({
                "broadcaster_id": uid,
                "title": title,
                "outcomes": outs.iter().map(|t| json!({"title": t})).collect::<Vec<Value>>(),
                "prediction_window": window.clamp(30, 1800),
            }))
            .send().map_err(|e| e.to_string())?;
        let status = r.status();
        let v: Value = r.json().unwrap_or(json!({}));
        if !status.is_success() {
            if status == reqwest::StatusCode::BAD_REQUEST {
                return Err("Twitch refused that prediction. You may already have one running — only one can be active at a time.".into());
            }
            return Err(helix_err(status, &v, "Could not create that prediction"));
        }
        Ok(json!({ "id": v.get("data").and_then(|d| d.as_array()).and_then(|a| a.first())
                     .and_then(|p| p.get("id")).cloned().unwrap_or(Value::Null) }))
    }).await.map_err(|e| e.to_string())?
}

// status: RESOLVED (needs winning_outcome_id) | CANCELED | LOCKED
#[tauri::command]
pub async fn twitch_end_prediction(
    app: tauri::AppHandle,
    prediction_id: String,
    status: String,
    winning_outcome_id: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if prediction_id.trim().is_empty() { return Err("No prediction to end.".into()); }
        let st = match status.as_str() {
            "RESOLVED" | "CANCELED" | "LOCKED" => status.as_str(),
            _ => "CANCELED",
        };
        if st == "RESOLVED" && winning_outcome_id.as_deref().unwrap_or("").is_empty() {
            return Err("Pick the winning outcome first.".into());
        }
        let shared = app.state::<Shared>();
        let (access, client_id) = ensure_token(&shared)?;
        let (uid, _) = identity(&shared, &access)?;
        let mut body = json!({ "broadcaster_id": uid, "id": prediction_id, "status": st });
        if st == "RESOLVED" {
            body["winning_outcome_id"] = json!(winning_outcome_id.unwrap_or_default());
        }
        let c = reqwest::blocking::Client::new();
        let r = c.patch("https://api.twitch.tv/helix/predictions")
            .header("Authorization", format!("Bearer {}", access))
            .header("Client-Id", &client_id)
            .json(&body)
            .send().map_err(|e| e.to_string())?;
        let s = r.status();
        if !s.is_success() {
            let v: Value = r.json().unwrap_or(json!({}));
            return Err(helix_err(s, &v, "Could not end that prediction"));
        }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

// Active or locked prediction, or null. A LOCKED one still needs resolving, so
// unlike polls this deliberately does not filter it out.
#[tauri::command]
pub async fn twitch_get_active_prediction(app: tauri::AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let shared = app.state::<Shared>();
        let (access, client_id) = ensure_token(&shared)?;
        let (uid, _) = identity(&shared, &access)?;
        let c = reqwest::blocking::Client::new();
        let r = c.get("https://api.twitch.tv/helix/predictions")
            .query(&[("broadcaster_id", uid.as_str()), ("first", "1")])
            .header("Authorization", format!("Bearer {}", access))
            .header("Client-Id", &client_id)
            .send().map_err(|e| e.to_string())?;
        if !r.status().is_success() { return Ok(Value::Null); }
        let v: Value = r.json().unwrap_or(json!({}));
        let p = match v.get("data").and_then(|d| d.as_array()).and_then(|a| a.first()) {
            Some(p) => p.clone(), None => return Ok(Value::Null),
        };
        let st = p.get("status").and_then(|x| x.as_str()).unwrap_or("");
        if st != "ACTIVE" && st != "LOCKED" { return Ok(Value::Null); }
        Ok(json!({
            "id":     p.get("id").cloned().unwrap_or(Value::Null),
            "title":  p.get("title").cloned().unwrap_or(Value::Null),
            "status": st,
            "locks_at": p.get("locks_at").cloned().unwrap_or(Value::Null),
            "outcomes": p.get("outcomes").and_then(|c| c.as_array()).map(|arr| arr.iter().map(|o| json!({
                "id":     o.get("id").cloned().unwrap_or(Value::Null),
                "title":  o.get("title").cloned().unwrap_or(Value::Null),
                "points": o.get("channel_points").cloned().unwrap_or(json!(0)),
                "users":  o.get("users").cloned().unwrap_or(json!(0)),
            })).collect::<Vec<Value>>()).unwrap_or_default(),
        }))
    }).await.map_err(|e| e.to_string())?
}

// ── Chatter actions ───────────────────────────────────────────────────────────

// add=true grants the role, false removes it. Twitch uses POST/DELETE on the
// same endpoint, so one command covers both and the UI can toggle.
#[tauri::command]
pub async fn twitch_set_moderator(app: tauri::AppHandle, user_id: String, add: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if user_id.trim().is_empty() { return Err("No user to act on.".into()); }
        let shared = app.state::<Shared>();
        let (access, client_id) = ensure_token(&shared)?;
        let (uid, _) = identity(&shared, &access)?;
        let c = reqwest::blocking::Client::new();
        let url = "https://api.twitch.tv/helix/moderation/moderators";
        let req = if add { c.post(url) } else { c.delete(url) };
        let r = req
            .query(&[("broadcaster_id", uid.as_str()), ("user_id", user_id.as_str())])
            .header("Authorization", format!("Bearer {}", access))
            .header("Client-Id", &client_id)
            .send().map_err(|e| e.to_string())?;
        let status = r.status();
        if !status.is_success() {
            let v: Value = r.json().unwrap_or(json!({}));
            if status == reqwest::StatusCode::UNPROCESSABLE_ENTITY {
                return Err("Twitch will not do that — a VIP cannot be made a mod directly. Remove their VIP status first.".into());
            }
            return Err(helix_err(status, &v, "Could not change that mod status"));
        }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn twitch_set_vip(app: tauri::AppHandle, user_id: String, add: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if user_id.trim().is_empty() { return Err("No user to act on.".into()); }
        let shared = app.state::<Shared>();
        let (access, client_id) = ensure_token(&shared)?;
        let (uid, _) = identity(&shared, &access)?;
        let c = reqwest::blocking::Client::new();
        let url = "https://api.twitch.tv/helix/channels/vips";
        let req = if add { c.post(url) } else { c.delete(url) };
        let r = req
            .query(&[("broadcaster_id", uid.as_str()), ("user_id", user_id.as_str())])
            .header("Authorization", format!("Bearer {}", access))
            .header("Client-Id", &client_id)
            .send().map_err(|e| e.to_string())?;
        let status = r.status();
        if !status.is_success() {
            let v: Value = r.json().unwrap_or(json!({}));
            if status == reqwest::StatusCode::UNPROCESSABLE_ENTITY {
                return Err("Twitch will not do that — a moderator cannot be made a VIP directly, and you may be out of VIP slots.".into());
            }
            if status == reqwest::StatusCode::CONFLICT {
                return Err("You have no VIP slots left. Twitch grants more as the channel grows.".into());
            }
            return Err(helix_err(status, &v, "Could not change that VIP status"));
        }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

// Whispers. Twitch silently drops whispers from accounts without a verified
// phone number, and returns 401 for accounts it does not trust yet.
#[tauri::command]
pub async fn twitch_send_whisper(app: tauri::AppHandle, user_id: String, message: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let msg = message.trim().to_string();
        if user_id.trim().is_empty() { return Err("No one to whisper.".into()); }
        if msg.is_empty() { return Err("The whisper is empty.".into()); }
        let shared = app.state::<Shared>();
        let (access, client_id) = ensure_token(&shared)?;
        let (uid, _) = identity(&shared, &access)?;
        if user_id == uid { return Err("You cannot whisper yourself.".into()); }
        let c = reqwest::blocking::Client::new();
        let r = c.post("https://api.twitch.tv/helix/whispers")
            .query(&[("from_user_id", uid.as_str()), ("to_user_id", user_id.as_str())])
            .header("Authorization", format!("Bearer {}", access))
            .header("Client-Id", &client_id)
            .json(&json!({ "message": msg.chars().take(500).collect::<String>() }))
            .send().map_err(|e| e.to_string())?;
        let status = r.status();
        if !status.is_success() {
            let v: Value = r.json().unwrap_or(json!({}));
            if status == reqwest::StatusCode::UNAUTHORIZED {
                return Err("Twitch only allows whispers from accounts with a verified phone number.".into());
            }
            if status == reqwest::StatusCode::FORBIDDEN {
                return Err("That user does not accept whispers from people they do not follow.".into());
            }
            return Err(helix_err(status, &v, "Could not send that whisper"));
        }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

// ── Ads ───────────────────────────────────────────────────────────────────────
// Reading the ad schedule lives further up (twitch_get_ad_schedule) and needs
// only channel:read:ads. These two ACT on ads and each cost their own scope.

// Start a commercial. Twitch takes a length in seconds and serves roughly that.
// Affiliates and partners only, live only, and there is a cooldown between
// commercials — all three come back as a 400, so they are spelled out.
#[tauri::command]
pub async fn twitch_start_commercial(app: tauri::AppHandle, length: u32) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let shared = app.state::<Shared>();
        let (access, client_id) = ensure_token(&shared)?;
        let (uid, _) = identity(&shared, &access)?;
        let c = reqwest::blocking::Client::new();
        let r = c.post("https://api.twitch.tv/helix/channels/commercial")
            .header("Authorization", format!("Bearer {}", access))
            .header("Client-Id", &client_id)
            .json(&json!({ "broadcaster_id": uid, "length": length.clamp(1, 180) }))
            .send().map_err(|e| e.to_string())?;
        let status = r.status();
        let v: Value = r.json().unwrap_or(json!({}));
        if !status.is_success() {
            let msg = v.get("message").and_then(|x| x.as_str()).unwrap_or("");
            if status == reqwest::StatusCode::BAD_REQUEST {
                let low = msg.to_lowercase();
                if low.contains("live")     { return Err("Ads only run while you are live.".into()); }
                if low.contains("cooldown") { return Err("Twitch is still cooling down from your last ad break.".into()); }
                return Err(if msg.is_empty() {
                    "Twitch refused that ad break. Only affiliates and partners can run ads.".to_string()
                } else { msg.to_string() });
            }
            return Err(helix_err(status, &v, "Could not start that ad break"));
        }
        let d = v.get("data").and_then(|d| d.as_array()).and_then(|a| a.first()).cloned()
            .unwrap_or(json!({}));
        Ok(json!({
            "length":      d.get("length").cloned().unwrap_or(Value::Null),
            // Seconds until another commercial is allowed. Worth surfacing:
            // the button is otherwise dead for several minutes with no reason.
            "retry_after": d.get("retry_after").cloned().unwrap_or(Value::Null),
            "message":     d.get("message").cloned().unwrap_or(Value::Null),
        }))
    }).await.map_err(|e| e.to_string())?
}

// Pushes the next automatic mid-roll back by 5 minutes. A channel gets a
// limited number of these per stream; running out is a 429.
#[tauri::command]
pub async fn twitch_snooze_ad(app: tauri::AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let shared = app.state::<Shared>();
        let (access, client_id) = ensure_token(&shared)?;
        let (uid, _) = identity(&shared, &access)?;
        let c = reqwest::blocking::Client::new();
        let r = c.post("https://api.twitch.tv/helix/channels/ads/schedule/snooze")
            .query(&[("broadcaster_id", uid.as_str())])
            .header("Authorization", format!("Bearer {}", access))
            .header("Client-Id", &client_id)
            .send().map_err(|e| e.to_string())?;
        let status = r.status();
        let v: Value = r.json().unwrap_or(json!({}));
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Err("You have no snoozes left this stream.".into());
        }
        if status == reqwest::StatusCode::BAD_REQUEST {
            return Err("Nothing to snooze — you are either offline or have no ad break scheduled.".into());
        }
        if !status.is_success() { return Err(helix_err(status, &v, "Could not snooze the next ad")); }
        let d = v.get("data").and_then(|d| d.as_array()).and_then(|a| a.first()).cloned()
            .unwrap_or(json!({}));
        Ok(json!({
            "snooze_count":     d.get("snooze_count").cloned().unwrap_or(Value::Null),
            "snooze_refresh_at":d.get("snooze_refresh_at").cloned().unwrap_or(Value::Null),
            "next_ad_at":       d.get("next_ad_at").cloned().unwrap_or(Value::Null),
        }))
    }).await.map_err(|e| e.to_string())?
}

// ── Chat modes ────────────────────────────────────────────────────────────────
// Emote-only, subscriber-only, follower-only and friends.
//
// !! FIELD NAMES NOT VERIFIED AGAINST LIVE DOCS !!
// The scopes and endpoint below ARE verified (dev.twitch.tv scope table,
// 2026-07-31), but the reference page truncated before the chat-settings
// section, so the body field names come from prior knowledge. If a toggle comes
// back with "Invalid parameter", that is what to check first. The failure mode
// is a visible error, not silent data loss.

#[tauri::command]
pub async fn twitch_get_chat_settings(app: tauri::AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let shared = app.state::<Shared>();
        let (access, client_id) = ensure_token(&shared)?;
        let (uid, _) = identity(&shared, &access)?;
        let c = reqwest::blocking::Client::new();
        let r = c.get("https://api.twitch.tv/helix/chat/settings")
            .query(&[("broadcaster_id", uid.as_str()), ("moderator_id", uid.as_str())])
            .header("Authorization", format!("Bearer {}", access))
            .header("Client-Id", &client_id)
            .send().map_err(|e| e.to_string())?;
        let status = r.status();
        let v: Value = r.json().unwrap_or(json!({}));
        if !status.is_success() { return Err(helix_err(status, &v, "Could not read your chat settings")); }
        let d = v.get("data").and_then(|d| d.as_array()).and_then(|a| a.first()).cloned()
            .unwrap_or(json!({}));
        Ok(json!({
            "emote_mode":             d.get("emote_mode").cloned().unwrap_or(json!(false)),
            "subscriber_mode":        d.get("subscriber_mode").cloned().unwrap_or(json!(false)),
            "follower_mode":          d.get("follower_mode").cloned().unwrap_or(json!(false)),
            "follower_mode_duration": d.get("follower_mode_duration").cloned().unwrap_or(json!(0)),
            "slow_mode":              d.get("slow_mode").cloned().unwrap_or(json!(false)),
            "slow_mode_wait_time":    d.get("slow_mode_wait_time").cloned().unwrap_or(json!(0)),
            "unique_chat_mode":       d.get("unique_chat_mode").cloned().unwrap_or(json!(false)),
        }))
    }).await.map_err(|e| e.to_string())?
}

// Sets ONE mode. Twitch's PATCH only touches fields present in the body, so
// sending a single field cannot disturb the others — which is why this takes a
// mode name rather than a whole settings object.
//
// mode: "emote" | "subscriber" | "follower" | "slow" | "unique"
// minutes is only read for "follower" (0 = anyone who follows at all).
#[tauri::command]
pub async fn twitch_set_chat_mode(
    app: tauri::AppHandle,
    mode: String,
    enabled: bool,
    minutes: Option<u32>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut body = serde_json::Map::new();
        match mode.as_str() {
            "emote"      => { body.insert("emote_mode".into(), json!(enabled)); }
            "subscriber" => { body.insert("subscriber_mode".into(), json!(enabled)); }
            "unique"     => { body.insert("unique_chat_mode".into(), json!(enabled)); }
            "follower"   => {
                body.insert("follower_mode".into(), json!(enabled));
                if enabled {
                    // Twitch takes 0..129600 minutes (90 days).
                    body.insert("follower_mode_duration".into(), json!(minutes.unwrap_or(0).min(129_600)));
                }
            }
            "slow"       => {
                body.insert("slow_mode".into(), json!(enabled));
                if enabled {
                    // Seconds here, not minutes: 3..120.
                    body.insert("slow_mode_wait_time".into(), json!(minutes.unwrap_or(30).clamp(3, 120)));
                }
            }
            _ => return Err(format!("Unknown chat mode \"{}\".", mode)),
        }

        let shared = app.state::<Shared>();
        let (access, client_id) = ensure_token(&shared)?;
        let (uid, _) = identity(&shared, &access)?;
        let c = reqwest::blocking::Client::new();
        let r = c.patch("https://api.twitch.tv/helix/chat/settings")
            .query(&[("broadcaster_id", uid.as_str()), ("moderator_id", uid.as_str())])
            .header("Authorization", format!("Bearer {}", access))
            .header("Client-Id", &client_id)
            .json(&Value::Object(body))
            .send().map_err(|e| e.to_string())?;
        let status = r.status();
        if !status.is_success() {
            let v: Value = r.json().unwrap_or(json!({}));
            return Err(helix_err(status, &v, "Could not change that chat setting"));
        }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

// ── Hype train ────────────────────────────────────────────────────────────────
// Live updates arrive as EventSub v2 (see the subscribe block above). This is
// the catch-up call: open SPARK part way through a train and the overlay would
// otherwise show nothing until the next one, which — given how rare they are —
// could be weeks.
//
// Replaces the old Get Hype Train EVENTS endpoint, which was withdrawn in
// January 2026 and now returns 410. This is Get Hype Train STATUS.
#[tauri::command]
pub async fn twitch_get_hype_train(app: tauri::AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let shared = app.state::<Shared>();
        let (access, client_id) = ensure_token(&shared)?;
        let (uid, _) = identity(&shared, &access)?;
        let c = reqwest::blocking::Client::new();
        let r = c.get("https://api.twitch.tv/helix/hypetrain/status")
            .query(&[("broadcaster_id", uid.as_str())])
            .header("Authorization", format!("Bearer {}", access))
            .header("Client-Id", &client_id)
            .send().map_err(|e| e.to_string())?;
        let status = r.status();
        // No scope yet (not reconnected), or no train — either way there is
        // nothing to show and it is not worth an error on screen.
        if !status.is_success() { return Ok(Value::Null); }
        let v: Value = r.json().unwrap_or(json!({}));
        Ok(v.get("data").and_then(|d| d.as_array()).and_then(|a| a.first()).cloned()
            .unwrap_or(Value::Null))
    }).await.map_err(|e| e.to_string())?
}

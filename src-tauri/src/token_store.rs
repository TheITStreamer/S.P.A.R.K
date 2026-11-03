// ── Twitch token storage (OS keychain) ───────────────────────────────────────
// Broadcaster and bot access/refresh tokens used to live inside
// spark-data.json next to everything else — a live Twitch credential, in
// plain text, readable by anything with access to the user's profile
// (malware, another local account, a stolen backup). They now live in the
// OS's own secure credential store instead: Windows Credential Manager on
// Windows, Keychain Services on macOS, Secret Service on *nix.
//
// Unlike the rest of AppData, tokens are written here directly by the few
// call sites that actually change them (twitch.rs: login, refresh, logout),
// not as part of the routine save_to_disk() that runs on every unrelated
// change — a login happens once, a refresh every few hours, there is no
// reason to touch the OS credential store on a counter tick.

use serde_json::{json, Value};

const SERVICE: &str = "SPARK Streaming Panel";

// None means no usable credential store on this platform/session (e.g. a
// locked-down CI box). Tokens simply won't survive a restart rather than
// crashing the app — the existing "Not connected to Twitch" path covers that.
fn entry(which: &str) -> Option<keyring::Entry> {
    keyring::Entry::new(SERVICE, which).ok()
}

/// Load a token blob (keyed "twitch_tokens" or "bot_tokens") from the OS
/// keychain. Returns an empty object — same shape as a logged-out account —
/// when nothing is stored or the store can't be read.
pub fn load(which: &str) -> Value {
    entry(which)
        .and_then(|e| e.get_password().ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}))
}

/// Save (or clear, if `value` has no access_token) a token blob to the OS
/// keychain.
pub fn save(which: &str, value: &Value) {
    let Some(e) = entry(which) else { return };
    let has_token = value.get("access_token")
        .and_then(|x| x.as_str())
        .map_or(false, |s| !s.is_empty());
    if has_token {
        if let Ok(s) = serde_json::to_string(value) {
            let _ = e.set_password(&s);
        }
    } else {
        // Logged out / never connected — remove the credential entirely
        // rather than storing "{}", so nothing lingers in the OS store either.
        let _ = e.delete_credential();
    }
}

/// One-time migration, run once at startup right after AppData loads. Older
/// versions of SPARK wrote twitch_tokens/bot_tokens straight into
/// spark-data.json; this lifts anything still sitting there into the
/// keychain, then scrubs the plaintext copy from the live file and from any
/// rotated backups. Idempotent: once the fields are gone from disk this is
/// just two keychain reads on every later launch.
pub fn migrate(path: &std::path::Path, data: &mut crate::AppData) {
    let legacy = std::fs::read(path).ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok());

    let mut migrated_any = false;
    if let Some(raw) = &legacy {
        for which in ["twitch_tokens", "bot_tokens"] {
            if let Some(v) = raw.get(which) {
                let has_token = v.get("access_token")
                    .and_then(|x| x.as_str())
                    .map_or(false, |s| !s.is_empty());
                if has_token {
                    save(which, v);
                    migrated_any = true;
                }
            }
        }
    }

    data.twitch_tokens = load("twitch_tokens");
    data.bot_tokens    = load("bot_tokens");

    if !migrated_any { return; }

    // Rewrite the main file now (it no longer serializes these fields at
    // all) instead of waiting for some unrelated save to scrub it.
    crate::save_to_disk(path, data);

    // Backups are raw copies taken by rotate_backups() before this fix
    // existed, so they can still carry the old plaintext fields even after
    // the line above. Strip just those two keys from each if present; leave
    // everything else in the backup untouched.
    for n in 1..=3u32 {
        let bpath = path.with_file_name(format!("spark-data.backup-{}.json", n));
        let Ok(b) = std::fs::read(&bpath) else { continue };
        let Ok(mut v) = serde_json::from_slice::<Value>(&b) else { continue };
        let Some(obj) = v.as_object_mut() else { continue };
        let had_tokens = obj.remove("twitch_tokens").is_some();
        let had_bot    = obj.remove("bot_tokens").is_some();
        if had_tokens || had_bot {
            if let Ok(nb) = serde_json::to_vec(&v) { let _ = std::fs::write(&bpath, nb); }
        }
    }
}

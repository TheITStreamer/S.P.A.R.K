use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
use tauri::Manager;
use tiny_http::{Server, Response, Header};
use crate::Shared;

// Overlay pages compiled in at build time
const MASTER_HTML:   &str = include_str!("../../dist/overlays/master.html");
const WHEEL_HTML:    &str = include_str!("../../dist/overlays/wheel.html");
const GIVEAWAY_HTML: &str = include_str!("../../dist/overlays/giveaway.html");
const TIMERS_HTML:   &str = include_str!("../../dist/overlays/timers.html");
const TASKS_HTML:    &str = include_str!("../../dist/overlays/tasks.html");
const POMODORO_HTML: &str = include_str!("../../dist/overlays/pomodoro.html");
const GOALS_HTML:    &str = include_str!("../../dist/overlays/goals.html");
const CHECKINS_HTML:   &str = include_str!("../../dist/overlays/checkins.html");
const NOWPLAYING_HTML: &str = include_str!("../../dist/overlays/nowplaying.html");
const SRQUEUE_HTML:    &str = include_str!("../../dist/overlays/srqueue.html");
const CHAT_HTML:       &str = include_str!("../../dist/overlays/chat.html");
const COUNTERS_HTML:   &str = include_str!("../../dist/overlays/counters.html");
const CREDITS_HTML:    &str = include_str!("../../dist/overlays/credits.html");
const COMMANDS_HTML:   &str = include_str!("../../dist/overlays/commands.html");
const WHEEL_JS:      &str = include_str!("../../dist/js/wheel.js");
const OVERLAY_JS:    &str = include_str!("../../dist/js/overlay-common.js");
const BAR_RENDERER:  &str = include_str!("../../dist/js/bar-renderer.js");
const CHAT_DEFAULTS: &str = include_str!("../../dist/js/chat-defaults.js");
const CREDITS_DEFAULTS: &str = include_str!("../../dist/js/credits-defaults.js");
const DIY_RUNTIME:   &str = include_str!("../../dist/js/diy-runtime.js");

pub fn start_server(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut server: Option<Server> = None;
        let mut chosen = 0u16;
        for port in 4747..4797u16 {
            match Server::http(("127.0.0.1", port)) {
                Ok(s) => { server = Some(s); chosen = port; break; }
                Err(_) => continue,
            }
        }
        let server = match server { Some(s) => s, None => return };
        app.state::<Shared>().server_port.store(chosen as u64, Ordering::SeqCst);
        let server = std::sync::Arc::new(server);
        // 16 workers: each long-poll (/events) can hold a worker for up to 25s,
        // and master + per-tool overlays + several D.I.Y widgets easily exceed a
        // dozen concurrent browser sources. Too few workers stalls page, sound
        // and icon requests behind the held long-polls.
        let mut workers = Vec::new();
        for _ in 0..16 {
            let server = server.clone();
            let app = app.clone();
            workers.push(std::thread::spawn(move || {
                loop {
                    match server.recv() {
                        Ok(r) => handle(&app, r),
                        Err(_) => break,
                    }
                }
            }));
        }
        for w in workers { let _ = w.join(); }
    });
}

// Overlay pages. OBS loads these as a browser source by navigating to them,
// which is not a cross-origin fetch, so no CORS header is needed — and without
// it another site cannot read your overlay configuration.
fn html(req: tiny_http::Request, body: &str) {
    let mut r = Response::from_string(body);
    r.add_header(Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]).unwrap());
    let _ = req.respond(r);
}
fn js(req: tiny_http::Request, body: &str) {
    let h = Header::from_bytes(&b"Content-Type"[..], &b"text/javascript; charset=utf-8"[..]).unwrap();
    let _ = req.respond(Response::from_string(body).with_header(h));
}
// NO Access-Control-Allow-Origin here, deliberately.
//
// This is /events — the live feed of chat messages, viewer names and every
// tool's state. It used to send "*", which meant ANY WEBSITE open in ANY
// browser could fetch http://localhost:4747/events and read the response.
// Browse to a hostile page while SPARK is running and it could quietly siphon
// your entire chat.
//
// The overlays do not need the header: they are SERVED BY THIS SERVER, so
// their fetch('/events') is same-origin and CORS never applies. Removing it
// costs nothing and closes the hole.
fn json_resp(req: tiny_http::Request, body: String) {
    let mut r = Response::from_string(body);
    r.add_header(Header::from_bytes(&b"Content-Type"[..],    &b"application/json"[..]).unwrap());
    r.add_header(Header::from_bytes(&b"Cache-Control"[..],   &b"no-store"[..]).unwrap());
    let _ = req.respond(r);
}

fn handle(app: &tauri::AppHandle, request: tiny_http::Request) {
    let url = request.url().to_string();
    let path = url.split('?').next().unwrap_or("/");

    // CORS preflight.
    //
    // The wildcard was removed from /events and from the overlay PAGES — those
    // are the sensitive ones and neither needs it, because overlays are served
    // by this same server and are therefore same-origin.
    //
    // It remains on:
    //   /fonts.css and /fonts/<file>  the app window links these from a
    //                                 different origin, so they genuinely need it
    //   /diy/sound, /diy/icon,        media the streamer chose; same-origin for
    //   /commands/image               overlays, and harmless to leave open
    //
    // There are no write routes at all, so nothing here can be made to CHANGE
    // anything — worth keeping that way.
    if request.method() == &tiny_http::Method::Options {
        let mut r = Response::from_string("").with_status_code(204);
        r.add_header(Header::from_bytes("Access-Control-Allow-Origin","*").unwrap());
        r.add_header(Header::from_bytes("Access-Control-Allow-Methods","GET,POST,OPTIONS").unwrap());
        r.add_header(Header::from_bytes("Access-Control-Allow-Headers","Content-Type,Authorization").unwrap());
        let _ = request.respond(r);
        return;
    }
    let shared = app.state::<Shared>();

    match path {
        "/"         | "/master"   => { html(request, MASTER_HTML);   return; }
        "/wheel"                  => { html(request, WHEEL_HTML);     return; }
        "/giveaway"               => { html(request, GIVEAWAY_HTML);  return; }
        "/timers"                 => { html(request, TIMERS_HTML);    return; }
        "/tasks"                  => { html(request, TASKS_HTML);     return; }
        "/pomodoro"               => { html(request, POMODORO_HTML);  return; }
        "/goals"                  => { html(request, GOALS_HTML);     return; }
        "/checkins"               => { html(request, CHECKINS_HTML);  return; }
        "/nowplaying"             => { html(request, NOWPLAYING_HTML); return; }
        "/srqueue"                => { html(request, SRQUEUE_HTML);    return; }
        "/chat"                   => { html(request, CHAT_HTML);      return; }
        "/counters"               => { html(request, COUNTERS_HTML);  return; }
        "/credits"                => { html(request, CREDITS_HTML);  return; }
        "/commands"               => { html(request, COMMANDS_HTML); return; }
        "/commands/image"         => { serve_command_image(app, request, &url); return; }
        "/diy"                    => { serve_diy(app, request, &url); return; }
        "/diy/sound"              => { serve_diy_sound(app, request, &url); return; }
        "/diy/icon"               => { serve_diy_icon(app, request, &url); return; }
        "/js/wheel.js"            => { js(request, WHEEL_JS);         return; }
        "/js/overlay-common.js"   => { js(request, OVERLAY_JS);       return; }
        "/js/bar-renderer.js"     => { js(request, BAR_RENDERER);     return; }
        "/js/chat-defaults.js"    => { js(request, CHAT_DEFAULTS);    return; }
        "/js/credits-defaults.js" => { js(request, CREDITS_DEFAULTS); return; }
        "/js/diy-runtime.js"      => { js(request, DIY_RUNTIME);      return; }
        "/fonts.css"              => { serve_fonts_css(app, request);  return; }
        _ => {}
    }

    // Imported font files: /fonts/<file>
    if let Some(file) = path.strip_prefix("/fonts/") {
        serve_font_file(app, request, file);
        return;
    }

    if path == "/events" {
        // ?since=N&tool=wheel (tool filter optional)
        let qs = url.split('?').nth(1).unwrap_or("");
        let since: u64 = qs.split('&').find(|s| s.starts_with("since="))
            .and_then(|s| s[6..].parse().ok()).unwrap_or(0);
        let tool_filter: Option<String> = qs.split('&').find(|s| s.starts_with("tool="))
            .map(|s| s[5..].to_string());

        let deadline = Instant::now() + Duration::from_secs(25);
        let body;
        loop {
            let (events, snapshot, latest) = {
                let q = shared.overlay_events.lock().unwrap();
                let latest = shared.overlay_seq.load(Ordering::SeqCst);
                let evs: Vec<serde_json::Value> = q.iter()
                    .filter(|(id, _)| *id > since)
                    .filter(|(_, payload)| {
                        if let Some(ref tf) = tool_filter {
                            if let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) {
                                return v.get("_tool").and_then(|x| x.as_str()).unwrap_or("") == tf;
                            }
                        }
                        true
                    })
                    .map(|(_, payload)| serde_json::from_str(payload).unwrap_or(serde_json::json!({})))
                    .collect();

                // build snapshot for first connect
                let snap = if since == 0 {
                    let tool = tool_filter.as_deref().unwrap_or("master");
                    match tool {
                        "wheel"    => shared.overlay_wheel.lock().unwrap().clone(),
                        "giveaway" => shared.overlay_giveaway.lock().unwrap().clone(),
                        "timers"   => shared.overlay_timers.lock().unwrap().clone(),
                        "tasks"    => shared.overlay_tasks.lock().unwrap().clone(),
                        "pomodoro" => shared.overlay_pomodoro.lock().unwrap().clone(),
                        "goals"    => shared.overlay_goals.lock().unwrap().clone(),
                        "checkins" => shared.overlay_checkins.lock().unwrap().clone(),
                        "srqueue"  => shared.overlay_srqueue.lock().unwrap().clone(),
                        "chat"     => shared.overlay_chat.lock().unwrap().clone(),
                        "counters" => shared.overlay_counters.lock().unwrap().clone(),
                        "credits"  => shared.overlay_credits.lock().unwrap().clone(),
                        _ => {
                            let vis = shared.tool_visibility.lock().unwrap().clone();
                            let border = shared.master_border.lock().unwrap().clone();
                            serde_json::json!({ "visibility": vis, "borderColor": border }).to_string()
                        }
                    }
                } else { String::new() };
                (evs, snap, latest)
            };

            let now = Instant::now();
            if !events.is_empty() || since == 0 || now >= deadline {
                let snap_val: serde_json::Value = if !snapshot.is_empty() {
                    serde_json::from_str(&snapshot).unwrap_or(serde_json::Value::Null)
                } else { serde_json::Value::Null };
                body = serde_json::json!({
                    "latest": latest,
                    "events": events,
                    "snapshot": snap_val,
                }).to_string();
                break;
            }
            // Block until a new event is pushed (condvar notify) or the deadline
            // passes. Spurious wakeups just re-check.
            let wait = (deadline - now).min(Duration::from_secs(5));
            let guard = shared.overlay_wake_lock.lock().unwrap();
            let _ = shared.overlay_wake.wait_timeout(guard, wait).unwrap();
        }
        json_resp(request, body);
        return;
    }

    let _ = request.respond(Response::from_string("not found").with_status_code(404));
}

// ── D.I.Y native widget renderer ──────────────────────────────────────────────

// Host page for a SPARK-native D.I.Y widget. The widget's HTML skeleton and JS
// behaviour are fixed by SPARK per type (chat / alert); the streamer supplies
// only the CSS and a Google Font. diy-runtime.js feeds it SPARK's own live
// events; no external services or frameworks are involved.
const DIY_HOST_TEMPLATE: &str = r#"<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SPARK widget</title>
%%FONT_LINK%%
<style>html,body{margin:0;padding:0;width:100%;height:100%;background:transparent;overflow:hidden}
.emote{height:1.35em;vertical-align:middle}
.badge-icon{height:1.2em;vertical-align:-0.15em;margin-right:4px}
.msg-inner{display:inline-block}
.msg{flex-shrink:0}
/* compositor-layer hints — OBS's CEF renderer benefits noticeably */
.msg,.msg-inner,.alert{will-change:transform,opacity}
/* stack grow/collapse: the runtime sets --spk-h/--spk-w to the row's measured
   size, the designer CSS sets --spk-gap. Animating the row's margin makes
   neighbouring messages slide smoothly instead of jumping. */
@keyframes spk-grow{from{margin-bottom:calc(-1*var(--spk-h,0px) - var(--spk-gap,0px))}}
@keyframes spk-grow-x{from{margin-right:calc(-1*var(--spk-w,0px) - var(--spk-gap,0px))}}
@keyframes spk-collapse{to{opacity:0;margin-bottom:calc(-1*var(--spk-h,0px) - var(--spk-gap,0px))}}
@keyframes spk-collapse-x{to{opacity:0;margin-right:calc(-1*var(--spk-w,0px) - var(--spk-gap,0px))}}
/* entrance animations */
@keyframes spk-in-fade{from{opacity:0}}
@keyframes spk-in-slide-left{from{opacity:0;transform:translateX(-40px)}}
@keyframes spk-in-slide-right{from{opacity:0;transform:translateX(40px)}}
@keyframes spk-in-slide-up{from{opacity:0;transform:translateY(30px)}}
@keyframes spk-in-slide-down{from{opacity:0;transform:translateY(-30px)}}
@keyframes spk-in-pop{from{opacity:0;transform:scale(.7)}}
@keyframes spk-in-stomp{0%{opacity:0;transform:scale(2.3)}55%{opacity:1;transform:scale(.88)}75%{transform:scale(1.06)}100%{transform:scale(1)}}
@keyframes spk-in-bounce{0%{opacity:0;transform:translateY(-45px)}60%{opacity:1;transform:translateY(8px)}80%{transform:translateY(-4px)}100%{transform:translateY(0)}}
@keyframes spk-in-drop{0%{opacity:0;transform:translateY(-70px)}70%{opacity:1;transform:translateY(6px)}100%{transform:translateY(0)}}
@keyframes spk-in-flip{from{opacity:0;transform:perspective(500px) rotateX(90deg)}}
@keyframes spk-in-zoom{from{opacity:0;transform:scale(0)}}
/* exit animations */
@keyframes spk-out-fade{to{opacity:0}}
@keyframes spk-out-slide-left{to{opacity:0;transform:translateX(-40px)}}
@keyframes spk-out-slide-right{to{opacity:0;transform:translateX(40px)}}
@keyframes spk-out-slide-up{to{opacity:0;transform:translateY(-30px)}}
@keyframes spk-out-slide-down{to{opacity:0;transform:translateY(30px)}}
@keyframes spk-out-shrink{to{opacity:0;transform:scale(.6)}}
@keyframes spk-out-fall{to{opacity:0;transform:translateY(40px)}}
@keyframes spk-out-zoom{to{opacity:0;transform:scale(0)}}
/* hard slide — physically off-screen, no fade */
@keyframes spk-in-hslide-left{from{transform:translateX(-110vw)}}
@keyframes spk-in-hslide-right{from{transform:translateX(110vw)}}
@keyframes spk-in-hslide-up{from{transform:translateY(110vh)}}
@keyframes spk-in-hslide-down{from{transform:translateY(-110vh)}}
@keyframes spk-out-hslide-left{to{transform:translateX(-110vw)}}
@keyframes spk-out-hslide-right{to{transform:translateX(110vw)}}
@keyframes spk-out-hslide-up{to{transform:translateY(-110vh)}}
@keyframes spk-out-hslide-down{to{transform:translateY(110vh)}}
%%FONT_CSS%%
/* ── active styling (designer or custom CSS) ── */
%%USER_CSS%%</style>
</head><body>
%%SKELETON%%
%%AUDIO%%
<script>window.SPARK_WIDGET_ID='%%ID%%';window.SPARK_WIDGET_TYPE='%%TYPE%%';window.SPARK_WIDGET_EVENTS=%%EVENTS%%;window.SPARK_WIDGET_OUTMS=%%OUTMS%%;window.SPARK_WIDGET_SCROLL='%%SCROLL%%';window.SPARK_WIDGET_ICONS=%%ICONS%%;window.SPARK_WIDGET_ALERTTEXT=%%ALERTTEXT%%;window.SPARK_WIDGET_ROLESTYLE=%%ROLESTYLE%%;window.SPARK_WIDGET_IGNORE=%%IGNORE%%;window.SPARK_WIDGET_SHOWEVENTS=%%SHOWEVENTS%%;window.SPARK_WIDGET_SHOWTOP=%%SHOWTOP%%;window.SPARK_WIDGET_CHATEVENTTEXT=%%CHATEVENTTEXT%%;window.SPARK_WIDGET_MAXMSG=%%MAXMSG%%;window.SPARK_WIDGET_HIDEMS=%%HIDEMS%%;window.SPARK_WIDGET_DURMS=%%DURMS%%;</script>
<script src="/js/diy-runtime.js"></script>
</body></html>"#;

fn serve_diy(app: &tauri::AppHandle, request: tiny_http::Request, url: &str) {
    let qs = url.split('?').nth(1).unwrap_or("");
    let id = qs.split('&').find(|s| s.starts_with("id="))
        .map(|s| s[3..].to_string());
    let id = match id {
        Some(i) if !i.is_empty() => i,
        _ => {
            let _ = request.respond(Response::from_string(
                "Add a widget in SPARK's D.I.Y tab, then use its overlay URL.").with_status_code(404));
            return;
        }
    };

    let shared = app.state::<Shared>();
    let (widget, ignore_json, imported_families) = {
        let d = shared.data.lock().unwrap();
        let w = d.diy.get("widgets").and_then(|w| w.as_array()).and_then(|arr| {
            arr.iter().find(|w| w.get("id").and_then(|x| x.as_str()) == Some(id.as_str())).cloned()
        });
        // Global ignore/bot list from Settings, lowercased for matching.
        let ig = d.settings.get("ignoreList").and_then(|x| x.as_array()).map(|a| {
            let v: Vec<serde_json::Value> = a.iter()
                .filter_map(|u| u.as_str()).map(|u| serde_json::json!(u.to_ascii_lowercase())).collect();
            serde_json::Value::Array(v)
        }).unwrap_or_else(|| serde_json::json!([]));
        // Families the user imported — /fonts.css already serves these, so the
        // page must NOT also ask Google for them.
        let fams: Vec<String> = d.settings.get("fonts").and_then(|f| f.as_array())
            .map(|arr| arr.iter()
                .filter_map(|f| f.get("family").and_then(|x| x.as_str()).map(|s| s.to_string()))
                .collect())
            .unwrap_or_default();
        (w, ig.to_string(), fams)
    };

    match widget {
        Some(w) => { let page = build_diy_page(&w, &ignore_json, &imported_families); html(request, &page); }
        None => {
            let _ = request.respond(Response::from_string("D.I.Y widget not found").with_status_code(404));
        }
    }
}

// JSON injected into an inline <script> must never contain "</" — a literal
// "</script>" inside a string value would end the script block early (HTML
// parses that before JS does). "\/" is a valid JSON string escape, so this is
// loss-free.
fn script_safe(s: String) -> String { s.replace("</", "<\\/") }

fn build_diy_page(w: &serde_json::Value, ignore_json: &str, imported_families: &[String]) -> String {
    let id   = w.get("id").and_then(|x| x.as_str()).unwrap_or("");
    let typ  = w.get("type").and_then(|x| x.as_str()).unwrap_or("chat");
    let css  = w.get("css").and_then(|x| x.as_str()).unwrap_or("");
    let font = w.get("font").and_then(|x| x.as_str()).unwrap_or("");

    // Designer mode uses the generated styleCss; Custom CSS mode uses the box.
    let mode = w.get("mode").and_then(|x| x.as_str()).unwrap_or("css");
    let style_css = w.get("styleCss").and_then(|x| x.as_str()).unwrap_or("");
    // "</style" in the CSS would end the style block; "\2f " is the CSS escape
    // for "/" so string values keep their meaning and the HTML parser is safe.
    let active_css = (if mode == "designer" { style_css } else { css }).replace("</", "<\\2f ");

    // Exit-animation duration the runtime waits before removing (0 = instant).
    let style = w.get("style");
    let out_ms: u64 = if mode == "designer" {
        let anim_out = style.and_then(|s| s.get("animOut")).and_then(|x| x.as_str()).unwrap_or("none");
        if anim_out.is_empty() || anim_out == "none" { 0 } else {
            // Keep in sync with speedDur() in dist/js/diy-tab.js.
            match style.and_then(|s| s.get("speed")).and_then(|x| x.as_str()).unwrap_or("normal") {
                "slow" => 800, "fast" => 300, _ => 500,
            }
        }
    } else {
        // Custom CSS mode: user-set duration for their own .spk-out rules.
        w.get("cssOutMs").and_then(|x| x.as_u64()).unwrap_or(0)
    };

    // Chat scroll direction, role icons, and alert text templates.
    let scroll = style.and_then(|s| s.get("scroll")).and_then(|x| x.as_str()).unwrap_or("up");
    let icons_json = script_safe(icons_global(w.get("icons").unwrap_or(&serde_json::Value::Null)));
    let alerttext_json = script_safe(w.get("alertText").cloned().unwrap_or_else(default_alerttext).to_string());

    // Per-role name colour/glow, in-chat event toggle + text templates.
    let rolestyle_json = script_safe(w.get("roleStyle").cloned().unwrap_or_else(|| serde_json::json!({})).to_string());
    let show_events = w.get("showEvents").and_then(|x| x.as_bool()).unwrap_or(false);
    // Hype train: name the top contributor, or don't. Off by default — not
    // everyone wants their name on stream.
    let show_top = w.get("showTop").and_then(|x| x.as_bool()).unwrap_or(false);
    let chatevent_json = script_safe(w.get("chatEventText").cloned().unwrap_or_else(default_chatevent_text).to_string());

    // Chat message limit + timed hide; alert on-screen duration (seconds -> ms).
    let max_msg = style.and_then(|s| s.get("maxMsg")).and_then(|x| x.as_u64()).unwrap_or(20);
    let hide_ms = style.and_then(|s| s.get("hideAfter")).and_then(|x| x.as_f64()).map(|v| (v * 1000.0) as u64).unwrap_or(0);
    let dur_ms  = style.and_then(|s| s.get("duration")).and_then(|x| x.as_f64()).map(|v| (v * 1000.0) as u64).unwrap_or(5000);

    // Which alert kinds this widget shows (default: all). Chat ignores it.
    let events = w.get("events").cloned().unwrap_or_else(||
        serde_json::json!({"follow":true,"sub":true,"cheer":true,"raid":true}));
    let events_json = script_safe(events.to_string());

    // Optional sound: served from disk by /diy/sound so there's no size limit.
    let sound = w.get("sound").and_then(|x| x.as_str()).unwrap_or("");
    let audio = if sound.is_empty() {
        String::new()
    } else {
        format!("<audio id=\"spark-sfx\" preload=\"auto\" src=\"/diy/sound?id={}\"></audio>", id)
    };

    // Fixed, SPARK-defined skeleton per widget type.
    let (skeleton, typ_safe) = match typ {
        "alert"     => ("<div id=\"spark-alert\" class=\"alert\"></div>", "alert"),
        "hypetrain" => ("<div id=\"spark-hypetrain\" class=\"hypetrain\"></div>", "hypetrain"),
        _           => ("<main id=\"spark-chat\"></main>", "chat"),
    };

    // Google Font (or a plain system stack).
    // 'system-ui' style stack + emoji fonts so plain unicode emoji always render.
    let emoji = "'Segoe UI Emoji','Apple Color Emoji','Noto Color Emoji'";
    // DIY builds its page in Rust rather than importing overlay-common.js, so
    // the imported-font stylesheet has to be attached here too. Always linked:
    // the streamer's own CSS can name a custom family even when the widget's
    // font dropdown is left on the default.
    let custom_css = "<link href=\"/fonts.css\" rel=\"stylesheet\">";

    // An imported font is served by /fonts.css — asking Google for it would
    // just 404. Only families we did NOT import get a Google stylesheet.
    let imported = imported_families.iter().any(|f| f.as_str() == font);

    let (font_link, font_css) = if font.is_empty() || font == "System default" {
        (custom_css.to_string(), format!("body{{font-family:system-ui,'Segoe UI',Roboto,{},sans-serif}}", emoji))
    } else {
        let google = if imported { String::new() } else {
            format!("<link href=\"https://fonts.googleapis.com/css2?family={}&display=swap\" rel=\"stylesheet\">",
                    font.replace(' ', "+"))
        };
        (
            format!("{}{}", custom_css, google),
            format!("body{{font-family:'{}',system-ui,{},sans-serif}}", font, emoji),
        )
    };

    // Inject fixed pieces first; the streamer's CSS goes in last.
    DIY_HOST_TEMPLATE
        .replace("%%FONT_LINK%%", &font_link)
        .replace("%%FONT_CSS%%",  &font_css)
        .replace("%%SKELETON%%",  skeleton)
        .replace("%%AUDIO%%",     &audio)
        .replace("%%EVENTS%%",    &events_json)
        .replace("%%OUTMS%%",     &out_ms.to_string())
        .replace("%%ID%%",        id)
        .replace("%%SCROLL%%",    scroll)
        .replace("%%ICONS%%",     &icons_json)
        .replace("%%ALERTTEXT%%", &alerttext_json)
        .replace("%%ROLESTYLE%%", &rolestyle_json)
        .replace("%%IGNORE%%",    &script_safe(ignore_json.to_string()))
        .replace("%%SHOWEVENTS%%", if show_events { "true" } else { "false" })
        .replace("%%SHOWTOP%%", if show_top { "true" } else { "false" })
        .replace("%%CHATEVENTTEXT%%", &chatevent_json)
        .replace("%%MAXMSG%%",    &max_msg.to_string())
        .replace("%%HIDEMS%%",    &hide_ms.to_string())
        .replace("%%DURMS%%",     &dur_ms.to_string())
        .replace("%%TYPE%%",      typ_safe)
        .replace("%%USER_CSS%%",  &active_css)
}

fn default_chatevent_text() -> serde_json::Value {
    serde_json::json!({
        "follow": "\u{2b50} {name} just followed!",
        "sub":    "\u{1f49c} {name} subscribed!",
        "cheer":  "\u{2728} {name} cheered {amount}!",
        "raid":   "\u{1f680} {name} raided with {amount}!"
    })
}

// Build the per-role icon config the runtime reads: {role:{t:'emoji'|'img', v}}.
fn icons_global(icons: &serde_json::Value) -> String {
    let mut m = serde_json::Map::new();
    if let Some(obj) = icons.as_object() {
        for (role, v) in obj {
            let val = v.as_str().unwrap_or("");
            if val.is_empty() { continue; }
            let lower = val.to_ascii_lowercase();
            let is_img = val.contains('/') || val.contains('\\')
                || lower.ends_with(".png") || lower.ends_with(".jpg") || lower.ends_with(".jpeg")
                || lower.ends_with(".gif") || lower.ends_with(".webp") || lower.ends_with(".svg");
            if is_img { m.insert(role.clone(), serde_json::json!({"t":"img"})); }
            else { m.insert(role.clone(), serde_json::json!({"t":"emoji","v":val})); }
        }
    }
    serde_json::Value::Object(m).to_string()
}

fn default_alerttext() -> serde_json::Value {
    serde_json::json!({
        "follow": {"title":"NEW FOLLOWER",  "message":"{name}"},
        "sub":    {"title":"NEW SUBSCRIBER","message":"{name}"},
        "cheer":  {"title":"{amount} BITS", "message":"{name}"},
        "raid":   {"title":"RAID x{amount}","message":"{name}"}
    })
}

// Serve a role's icon image file from disk (like sounds).
fn serve_diy_icon(app: &tauri::AppHandle, request: tiny_http::Request, url: &str) {
    let qs = url.split('?').nth(1).unwrap_or("");
    let get = |k: &str| qs.split('&').find(|s| s.starts_with(k)).map(|s| s[k.len()..].to_string());
    let id = get("id=").unwrap_or_default();
    let role = get("role=").unwrap_or_default();
    if id.is_empty() || role.is_empty() {
        let _ = request.respond(Response::from_string("").with_status_code(404)); return;
    }
    let shared = app.state::<Shared>();
    let path = {
        let d = shared.data.lock().unwrap();
        d.diy.get("widgets").and_then(|w| w.as_array()).and_then(|arr| {
            arr.iter().find(|w| w.get("id").and_then(|x| x.as_str()) == Some(id.as_str()))
                .and_then(|w| w.get("icons")).and_then(|ic| ic.get(&role))
                .and_then(|x| x.as_str()).map(|s| s.to_string())
        })
    };
    let path = match path { Some(p) if !p.is_empty() => p, _ => {
        let _ = request.respond(Response::from_string("").with_status_code(404)); return; } };
    match std::fs::read(&path) {
        Ok(bytes) => {
            let ct = match path.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
                "png" => "image/png", "jpg" | "jpeg" => "image/jpeg", "gif" => "image/gif",
                "webp" => "image/webp", "svg" => "image/svg+xml", _ => "application/octet-stream",
            };
            let mut r = Response::from_data(bytes);
            r.add_header(Header::from_bytes(&b"Content-Type"[..], ct.as_bytes()).unwrap());
            r.add_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap());
            let _ = request.respond(r);
        }
        Err(_) => { let _ = request.respond(Response::from_string("").with_status_code(404)); }
    }
}

// Serve a popup action's image. Looked up by command id + action index rather
// than taking a path from the query string — deliberately the same approach as
// the D.I.Y icon route, so this local server can never be used to read an
// arbitrary file off the machine.
fn serve_command_image(app: &tauri::AppHandle, request: tiny_http::Request, url: &str) {
    let qs = url.split('?').nth(1).unwrap_or("");
    let id = qs.split('&').find(|s| s.starts_with("id=")).map(|s| s[3..].to_string()).unwrap_or_default();
    let idx: usize = qs.split('&').find(|s| s.starts_with("i="))
        .and_then(|s| s[2..].parse().ok()).unwrap_or(usize::MAX);
    if id.is_empty() || idx == usize::MAX {
        let _ = request.respond(Response::from_string("").with_status_code(404));
        return;
    }

    let shared = app.state::<Shared>();
    let path = {
        let d = shared.data.lock().unwrap();
        d.commands.get("commands").and_then(|c| c.as_array()).and_then(|arr| {
            arr.iter().find(|c| c.get("id").and_then(|x| x.as_str()) == Some(id.as_str()))
                .and_then(|c| c.get("actions")).and_then(|a| a.as_array())
                .and_then(|acts| acts.get(idx))
                .and_then(|a| a.get("image")).and_then(|x| x.as_str())
                .map(|s| s.to_string())
        })
    };
    let path = match path { Some(p) if !p.is_empty() => p, _ => {
        let _ = request.respond(Response::from_string("").with_status_code(404)); return; } };

    match std::fs::read(&path) {
        Ok(bytes) => {
            let ct = match path.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
                "png" => "image/png", "jpg" | "jpeg" => "image/jpeg", "gif" => "image/gif",
                "webp" => "image/webp", "svg" => "image/svg+xml", _ => "application/octet-stream",
            };
            let mut r = Response::from_data(bytes);
            r.add_header(Header::from_bytes(&b"Content-Type"[..], ct.as_bytes()).unwrap());
            // Belt and braces alongside the ?v= stamp the frontend adds: the URL
            // is otherwise identical after swapping the file, and a cached copy
            // means the overlay keeps showing the old picture.
            r.add_header(Header::from_bytes(&b"Cache-Control"[..], &b"no-store"[..]).unwrap());
            r.add_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap());
            let _ = request.respond(r);
        }
        Err(_) => { let _ = request.respond(Response::from_string("").with_status_code(404)); }
    }
}

// Serve a widget's chosen sound file straight from disk (any size, no embedding).
// ── Imported fonts ────────────────────────────────────────────────────────────
// Two routes work together:
//   /fonts.css   — one @font-face block per imported font, regenerated on every
//                  request and marked no-store, so an overlay picks up a newly
//                  imported font on refresh.
//   /fonts/<file>— the font file itself. The filename contains a hash of the
//                  contents (see import_font), so it is immutable and can be
//                  cached hard. That is what stops OBS serving a stale font.
// Overlays just <link> /fonts.css and then use the family name normally.

fn serve_fonts_css(app: &tauri::AppHandle, request: tiny_http::Request) {
    let shared = app.state::<Shared>();
    let fonts = {
        let d = shared.data.lock().unwrap();
        d.settings.get("fonts").and_then(|f| f.as_array()).cloned().unwrap_or_default()
    };

    let mut css = String::from("/* SPARK imported fonts */\n");
    for f in fonts {
        let family = f.get("family").and_then(|x| x.as_str()).unwrap_or("");
        let file   = f.get("file").and_then(|x| x.as_str()).unwrap_or("");
        if family.is_empty() || file.is_empty() { continue; }
        let file = crate::safe_font_file(file);
        // A family name with a quote in it would break out of the CSS string.
        let family = family.replace('\'', "").replace('"', "").replace('\\', "");
        let fmt = match file.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
            "ttf"   => "truetype",
            "otf"   => "opentype",
            "woff"  => "woff",
            "woff2" => "woff2",
            _       => continue,
        };
        css.push_str(&format!(
            "@font-face{{font-family:'{}';src:url('/fonts/{}') format('{}');font-display:swap}}\n",
            family, file, fmt));
    }

    let mut r = Response::from_string(css);
    r.add_header(Header::from_bytes(&b"Content-Type"[..], &b"text/css; charset=utf-8"[..]).unwrap());
    r.add_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap());
    // The list changes whenever a font is imported or removed, and it is tiny.
    r.add_header(Header::from_bytes(&b"Cache-Control"[..], &b"no-store"[..]).unwrap());
    let _ = request.respond(r);
}

fn serve_font_file(app: &tauri::AppHandle, request: tiny_http::Request, file: &str) {
    let file = crate::safe_font_file(file.split('?').next().unwrap_or(""));
    if file.is_empty() {
        let _ = request.respond(Response::from_string("").with_status_code(404));
        return;
    }
    let path = crate::fonts_dir(app).join(&file);
    match std::fs::read(&path) {
        Ok(bytes) => {
            let ct = match file.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
                "ttf"   => "font/ttf",
                "otf"   => "font/otf",
                "woff"  => "font/woff",
                "woff2" => "font/woff2",
                _       => "application/octet-stream",
            };
            let mut r = Response::from_data(bytes);
            r.add_header(Header::from_bytes(&b"Content-Type"[..], ct.as_bytes()).unwrap());
            // OBS's browser source is a plain Chromium; a font loaded from a
            // stylesheet still needs CORS to be allowed explicitly.
            r.add_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap());
            r.add_header(Header::from_bytes(&b"Cache-Control"[..], &b"public, max-age=31536000, immutable"[..]).unwrap());
            let _ = request.respond(r);
        }
        Err(_) => { let _ = request.respond(Response::from_string("font not found").with_status_code(404)); }
    }
}

fn serve_diy_sound(app: &tauri::AppHandle, request: tiny_http::Request, url: &str) {
    let qs = url.split('?').nth(1).unwrap_or("");
    let id = qs.split('&').find(|s| s.starts_with("id=")).map(|s| s[3..].to_string());
    let id = match id { Some(i) if !i.is_empty() => i, _ => {
        let _ = request.respond(Response::from_string("").with_status_code(404)); return; } };

    let shared = app.state::<Shared>();
    let path = {
        let d = shared.data.lock().unwrap();
        d.diy.get("widgets").and_then(|w| w.as_array()).and_then(|arr| {
            arr.iter().find(|w| w.get("id").and_then(|x| x.as_str()) == Some(id.as_str()))
                .and_then(|w| w.get("sound").and_then(|x| x.as_str()).map(|s| s.to_string()))
        })
    };
    let path = match path { Some(p) if !p.is_empty() => p, _ => {
        let _ = request.respond(Response::from_string("").with_status_code(404)); return; } };

    match std::fs::read(&path) {
        Ok(bytes) => {
            let ct = match path.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
                "mp3"        => "audio/mpeg",
                "ogg"        => "audio/ogg",
                "wav"        => "audio/wav",
                "m4a" | "aac"=> "audio/aac",
                "flac"       => "audio/flac",
                "webm"       => "audio/webm",
                _            => "application/octet-stream",
            };
            let mut r = Response::from_data(bytes);
            r.add_header(Header::from_bytes(&b"Content-Type"[..], ct.as_bytes()).unwrap());
            r.add_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap());
            let _ = request.respond(r);
        }
        Err(_) => { let _ = request.respond(Response::from_string("sound not found").with_status_code(404)); }
    }
}

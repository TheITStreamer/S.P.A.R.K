// ── Native sound player ───────────────────────────────────────────────────────
// Every sound in SPARK plays from here, not from the webview.
//
// Why: a webview's <audio> comes out of a separate msedgewebview2.exe process,
// so OBS's "Application Audio Capture" pointed at SPARK hears nothing. Sound
// played from Rust comes out of spark.exe itself, which OBS, Meld and the
// Windows volume mixer all see as SPARK.
//
// Output goes to the Windows default playback device. The device is opened on
// the first sound, not at boot, so a missing or broken device can never hold
// up startup — it just makes that sound report an error.
//
// rodio's OutputStream can't move between threads, so one dedicated thread
// owns it and every command talks to that thread over a channel.

use std::collections::HashMap;
use std::fs::File;
use std::io::BufReader;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use rodio::source::SineWave;
use rodio::{Decoder, OutputStream, OutputStreamHandle, Sink, Source};

enum Cmd {
    Play {
        path: String,
        volume: f32,
        looped: bool,
        force: bool,
        max: usize,
        reply: Sender<Result<Option<u64>, String>>,
    },
    Beep { reply: Sender<Result<(), String>> },
    Stop(u64),
    StopAll,
}

struct Playing {
    sink: Sink,
    // Looping clips run until stopped, so they don't count against the cap —
    // otherwise one long loop would block every alert in the app.
    looped: bool,
}

static TX: OnceLock<Mutex<Sender<Cmd>>> = OnceLock::new();

fn send(cmd: Cmd) -> Result<(), String> {
    let tx = TX.get_or_init(|| {
        let (tx, rx) = channel::<Cmd>();
        let _ = std::thread::Builder::new()
            .name("spark-audio".into())
            .spawn(move || audio_thread(rx));
        Mutex::new(tx)
    });
    tx.lock()
        .map_err(|_| "Audio player is unavailable (lock poisoned)".to_string())?
        .send(cmd)
        .map_err(|_| "Audio player thread has stopped. Restart SPARK.".to_string())
}

fn audio_thread(rx: Receiver<Cmd>) {
    let mut out: Option<(OutputStream, OutputStreamHandle)> = None;
    let mut playing: HashMap<u64, Playing> = HashMap::new();
    let mut next_id: u64 = 1;

    for cmd in rx {
        // Forget clips that have finished on their own.
        playing.retain(|_, p| !p.sink.empty());

        match cmd {
            Cmd::Play { path, volume, looped, force, max, reply } => {
                let r = play(&mut out, &mut playing, &mut next_id, &path, volume, looped, force, max);
                let _ = reply.send(r);
            }
            Cmd::Beep { reply } => {
                let _ = reply.send(beep(&mut out));
            }
            Cmd::Stop(id) => {
                if let Some(p) = playing.remove(&id) {
                    p.sink.stop();
                }
            }
            Cmd::StopAll => {
                for (_, p) in playing.drain() {
                    p.sink.stop();
                }
            }
        }
    }
}

// Opens the default output device on first use. If that fails, the next sound
// tries again — so plugging in a headset after a failed attempt recovers.
fn handle(out: &mut Option<(OutputStream, OutputStreamHandle)>) -> Result<OutputStreamHandle, String> {
    if out.is_none() {
        let s = OutputStream::try_default()
            .map_err(|e| format!("No audio output device available: {e}"))?;
        *out = Some(s);
    }
    Ok(out.as_ref().unwrap().1.clone())
}

#[allow(clippy::too_many_arguments)]
fn play(
    out: &mut Option<(OutputStream, OutputStreamHandle)>,
    playing: &mut HashMap<u64, Playing>,
    next_id: &mut u64,
    path: &str,
    volume: f32,
    looped: bool,
    force: bool,
    max: usize,
) -> Result<Option<u64>, String> {
    // Over the cap: drop the sound rather than queue it. A chat sound ten
    // seconds late is worse than one that never played.
    if !looped && !force {
        let active = playing.values().filter(|p| !p.looped).count();
        if active >= max.max(1) {
            return Ok(None);
        }
    }

    let file = File::open(path).map_err(|e| format!("Can't open sound file \"{path}\": {e}"))?;
    let decoder = Decoder::new(BufReader::new(file))
        .map_err(|e| format!("Can't play \"{path}\" — unsupported or damaged file ({e}). Use MP3, WAV, OGG, FLAC or M4A."))?;

    let h = handle(out)?;
    let sink = Sink::try_new(&h).map_err(|e| {
        // The device may have gone away (unplugged, driver reset). Drop it so
        // the next sound reopens the current default device.
        *out = None;
        format!("Audio output error: {e}")
    })?;
    sink.set_volume(volume.clamp(0.0, 1.0));
    if looped {
        sink.append(decoder.buffered().repeat_infinite());
    } else {
        sink.append(decoder);
    }

    let id = *next_id;
    *next_id += 1;
    playing.insert(id, Playing { sink, looped });
    Ok(Some(id))
}

// Three-note chime, used by Pomodoro when no sound file is set.
fn beep(out: &mut Option<(OutputStream, OutputStreamHandle)>) -> Result<(), String> {
    let h = handle(out)?;
    for (freq, at) in [(880.0_f32, 0.0_f32), (1108.7, 0.18), (1318.5, 0.36)] {
        let sink = Sink::try_new(&h).map_err(|e| {
            *out = None;
            format!("Audio output error: {e}")
        })?;
        sink.append(
            SineWave::new(freq)
                .take_duration(Duration::from_millis(400))
                .fade_out(Duration::from_millis(400))
                .amplify(0.25)
                .delay(Duration::from_secs_f32(at)),
        );
        sink.detach(); // keeps playing on the stream after the handle is dropped
    }
    Ok(())
}

// ── Public API (called by the Tauri commands) ────────────────────────────────

pub fn play_blocking(path: String, volume: f32, looped: bool, force: bool, max: usize) -> Result<Option<u64>, String> {
    let (reply, rx) = channel();
    send(Cmd::Play { path, volume, looped, force, max, reply })?;
    rx.recv_timeout(Duration::from_secs(10))
        .map_err(|_| "Audio player did not respond".to_string())?
}

pub fn beep_blocking() -> Result<(), String> {
    let (reply, rx) = channel();
    send(Cmd::Beep { reply })?;
    rx.recv_timeout(Duration::from_secs(10))
        .map_err(|_| "Audio player did not respond".to_string())?
}

pub fn stop(id: u64) -> Result<(), String> { send(Cmd::Stop(id)) }
pub fn stop_all() -> Result<(), String> { send(Cmd::StopAll) }

// ── Tauri commands ───────────────────────────────────────────────────────────
// Async + spawn_blocking so opening a file or the audio device never stalls
// the UI thread.

// volume 0.0-1.0. looped: repeat until audio_stop. force: ignore the cap.
// max: concurrent one-shot cap. Returns an id for audio_stop, or null when the
// sound was dropped because the cap was full.
#[tauri::command]
pub async fn audio_play(
    path: String,
    volume: Option<f64>,
    looped: Option<bool>,
    force: Option<bool>,
    max: Option<u32>,
) -> Result<Option<u64>, String> {
    let volume = volume.unwrap_or(1.0) as f32;
    let looped = looped.unwrap_or(false);
    let force = force.unwrap_or(false);
    let max = max.unwrap_or(3) as usize;
    tauri::async_runtime::spawn_blocking(move || play_blocking(path, volume, looped, force, max))
        .await
        .map_err(|e| format!("Audio task failed: {e}"))?
}

#[tauri::command]
pub async fn audio_beep() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(beep_blocking)
        .await
        .map_err(|e| format!("Audio task failed: {e}"))?
}

#[tauri::command]
pub fn audio_stop(id: u64) -> Result<(), String> { stop(id) }

#[tauri::command]
pub fn audio_stop_all() -> Result<(), String> { stop_all() }

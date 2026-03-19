use openoats_core::{
    audio::{cpal_mic::CpalMicCapture, MicCaptureService},
    download,
    settings::AppSettings,
    storage::{session_store::SessionStore, transcript_logger::TranscriptLogger},
    transcription::streaming_transcriber::StreamingTranscriber,
};
use serde::Serialize;
use std::sync::{Arc, Mutex};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Serialize)]
pub struct TranscriptPayload {
    pub text: String,
    pub speaker: String,
}

pub struct AppState {
    pub settings: Mutex<AppSettings>,
    pub session_store: Mutex<SessionStore>,
    pub transcript_logger: Mutex<TranscriptLogger>,
    pub audio_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    pub is_running: Mutex<bool>,
}

impl AppState {
    pub fn new() -> Self {
        let settings = AppSettings::load();
        let session_store = SessionStore::with_default_path();
        let transcript_logger = TranscriptLogger::with_default_path();
        Self {
            settings: Mutex::new(settings),
            session_store: Mutex::new(session_store),
            transcript_logger: Mutex::new(transcript_logger),
            audio_task: Mutex::new(None),
            is_running: Mutex::new(false),
        }
    }

    pub fn model_path(app: &AppHandle) -> Result<PathBuf, String> {
        app.path()
            .app_data_dir()
            .map(|p| p.join("ggml-base.en.bin"))
            .map_err(|e| e.to_string())
    }
}

// ── Tauri commands ─────────────────────────────────────────────────────────────

#[tauri::command]
pub fn check_model(app: AppHandle) -> Result<bool, String> {
    let path = AppState::model_path(&app)?;
    Ok(download::model_exists(&path))
}

#[tauri::command]
pub fn get_model_path(app: AppHandle) -> Result<String, String> {
    AppState::model_path(&app).map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn get_settings(state: tauri::State<'_, Arc<AppState>>) -> AppSettings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
pub fn save_settings(
    new_settings: AppSettings,
    state: tauri::State<'_, Arc<AppState>>,
) {
    let mut s = state.settings.lock().unwrap();
    *s = new_settings;
    s.save();
}

#[tauri::command]
pub fn list_mic_devices() -> Vec<String> {
    CpalMicCapture::available_device_names()
}

#[tauri::command]
pub fn start_transcription(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let model_path = AppState::model_path(&app)?;
    if !download::model_exists(&model_path) {
        return Err("Whisper model not found. Download it first.".into());
    }

    let mut running = state.is_running.lock().unwrap();
    if *running { return Ok(()); }
    *running = true;
    drop(running);

    state.session_store.lock().unwrap().start_session();
    state.transcript_logger.lock().unwrap().start_session();

    let model_str = model_path.to_string_lossy().into_owned();
    let app_clone = app.clone();
    let state_clone = Arc::clone(&state);

    let settings = state.settings.lock().unwrap().clone();
    let device_name = settings.input_device_name.clone();
    let language = settings.transcription_locale
        .split('-').next().unwrap_or("en").to_string();

    let handle = tokio::spawn(async move {
        let mic = CpalMicCapture::new();
        let stream = mic.buffer_stream_for_device(device_name.as_deref());

        let app_for_final = app_clone.clone();
        let state_for_final = Arc::clone(&state_clone);

        let on_final = move |text: String| {
            let payload = TranscriptPayload { text: text.clone(), speaker: "you".into() };
            app_for_final.emit("transcript", &payload).ok();

            let record = openoats_core::models::SessionRecord {
                speaker: openoats_core::models::Speaker::You,
                text: text.clone(),
                timestamp: chrono::Utc::now(),
                suggestions: None,
                kb_hits: None,
                suggestion_decision: None,
                surfaced_suggestion_text: None,
                conversation_state_summary: None,
            };
            state_for_final.session_store.lock().unwrap().append_record(&record).ok();
            state_for_final.transcript_logger.lock().unwrap()
                .append("You", &text, chrono::Utc::now());
        };

        app_clone.emit("whisper-ready", ()).ok();

        let transcriber = StreamingTranscriber::new(model_str, language, Box::new(on_final));
        transcriber.run(stream).await;
    });

    *state.audio_task.lock().unwrap() = Some(handle);
    Ok(())
}

#[tauri::command]
pub fn stop_transcription(state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    if let Some(handle) = state.audio_task.lock().unwrap().take() {
        handle.abort();
    }
    state.session_store.lock().unwrap().end_session();
    state.transcript_logger.lock().unwrap().end_session();
    *state.is_running.lock().unwrap() = false;
    Ok(())
}

#[tauri::command]
pub async fn download_model(app: AppHandle) -> Result<(), String> {
    use tauri::Emitter;
    let model_path = AppState::model_path(&app)?;
    let app_clone = app.clone();
    download::download_model(model_path, move |pct| {
        app_clone.emit("model-download-progress", pct).ok();
    }).await?;
    app.emit("model-download-done", ()).ok();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_state_initializes_without_panic() {
        let state = AppState::new();
        assert!(!*state.is_running.lock().unwrap());
    }
}

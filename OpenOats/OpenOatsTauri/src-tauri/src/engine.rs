// Replaced in Task 15 — stubbed to allow workspace compile
use std::sync::Arc;
use tauri::{AppHandle, Manager};

pub struct AppState;

impl AppState {
    pub fn new() -> Self { Self }
    pub fn model_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
        app.path().app_data_dir()
            .map(|p| p.join("ggml-base.en.bin"))
            .map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn check_model(app: AppHandle) -> Result<bool, String> {
    Ok(AppState::model_path(&app)?.exists())
}

#[tauri::command]
pub fn get_model_path(app: AppHandle) -> Result<String, String> {
    AppState::model_path(&app).map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn start_transcription(_app: AppHandle, _state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    Err("Not yet implemented — see Task 15".into())
}

#[tauri::command]
pub fn stop_transcription(_state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn download_model(_app: AppHandle) -> Result<(), String> {
    Err("Not yet implemented — see Task 15".into())
}

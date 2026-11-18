use std::fs;
use std::fs::OpenOptions;
use std::process::{Command, Stdio};
use tauri::Manager;

fn normalize_windows_path(path: std::path::PathBuf) -> std::path::PathBuf {
  let value = path.to_string_lossy();
  if let Some(stripped) = value.strip_prefix(r"\\?\") {
    std::path::PathBuf::from(stripped)
  } else if let Some(stripped) = value.strip_prefix(r"\??\") {
    std::path::PathBuf::from(stripped)
  } else {
    path
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      #[cfg(not(debug_assertions))]
      {
        let resource_dir = normalize_windows_path(app.path().resource_dir()?);
        let resource_dir = if resource_dir.join("runtime").exists() {
          normalize_windows_path(resource_dir)
        } else {
          let nested_resource_dir = normalize_windows_path(resource_dir.join("_up_"));
          if nested_resource_dir.join("runtime").exists() {
            nested_resource_dir
          } else {
            resource_dir
          }
        };
        let app_data_dir = normalize_windows_path(app.path().app_data_dir()?);
        fs::create_dir_all(&app_data_dir)?;
        let downloads_dir = app_data_dir.join("downloads");
        fs::create_dir_all(&downloads_dir)?;
        let service_log = OpenOptions::new()
          .create(true)
          .append(true)
          .open(app_data_dir.join("service.log"))?;

        let node = resource_dir.join("runtime").join("node.exe");
        let tools = resource_dir.join("tools");
        let python = resource_dir.join("runtime").join("python").join("python.exe");
        let ffmpeg = resource_dir.join("runtime").join("ffmpeg.exe");
        let yt_dlp = resource_dir.join("runtime").join("yt-dlp.exe");
        let whisper_cache = resource_dir.join("runtime").join("models");

        Command::new(node)
          .arg("server/index.ts")
          .current_dir(&resource_dir)
          .env("CLIPFORGE_APP_ROOT", &resource_dir)
          .env("CLIPFORGE_TOOLS_DIR", tools)
          .env("CLIPFORGE_DOWNLOADS_DIR", downloads_dir)
          .env("CLIPFORGE_PYTHON", python)
          .env("CLIPFORGE_FFMPEG", ffmpeg)
          .env("CLIPFORGE_YTDLP", yt_dlp)
          .env("HF_HOME", whisper_cache)
          .stdout(Stdio::from(service_log.try_clone()?))
          .stderr(Stdio::from(service_log))
          .spawn()?;
      }

      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}

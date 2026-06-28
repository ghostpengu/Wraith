use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

struct PtyInstance {
    writer: Box<dyn std::io::Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    kill_flag: Arc<AtomicBool>,
}

#[derive(Default)]
struct AppState {
    pty: Mutex<HashMap<String, PtyInstance>>,
    agent_hook_url: Mutex<Option<String>>,
}

#[derive(Serialize, Clone)]
struct PtyOutput {
    id: String,
    data: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AgentHookFinished {
    run_id: String,
    agent: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentChatCompletionResponse {
    status: u16,
    body: String,
}

fn kill_instance(id: &str, state: &AppState) {
    let removed = state.pty.lock().ok().and_then(|mut map| map.remove(id));
    if let Some(mut instance) = removed {
        instance.kill_flag.store(true, Ordering::SeqCst);
        let _ = instance.child.kill();
    }
}

fn kill_all(state: &AppState) {
    let instances: Vec<PtyInstance> = if let Ok(mut map) = state.pty.lock() {
        map.drain().map(|(_, instance)| instance).collect()
    } else {
        return;
    };

    for mut instance in instances {
        instance.kill_flag.store(true, Ordering::SeqCst);
        thread::spawn(move || {
            let _ = instance.child.kill();
        });
    }
}

fn new_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("pty-{:x}", nanos)
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut i = 0;

    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                output.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hex = &input[i + 1..i + 3];
                if let Ok(value) = u8::from_str_radix(hex, 16) {
                    output.push(value);
                    i += 3;
                } else {
                    output.push(bytes[i]);
                    i += 1;
                }
            }
            value => {
                output.push(value);
                i += 1;
            }
        }
    }

    String::from_utf8_lossy(&output).into_owned()
}

fn query_value(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|part| {
        let (name, value) = part.split_once('=')?;
        if percent_decode(name) == key {
            Some(percent_decode(value))
        } else {
            None
        }
    })
}

fn handle_agent_hook_request(mut stream: TcpStream, app: &AppHandle) {
    let mut buffer = [0u8; 8192];
    let read = stream.read(&mut buffer).unwrap_or(0);
    let request = String::from_utf8_lossy(&buffer[..read]);
    let mut accepted = false;

    if let Some(request_line) = request.lines().next() {
        let mut parts = request_line.split_whitespace();
        let method = parts.next().unwrap_or_default();
        let target = parts.next().unwrap_or_default();
        let (path, query) = target.split_once('?').unwrap_or((target, ""));

        if method == "POST" && path == "/agent-finished" {
            if let Some(run_id) = query_value(query, "runId").filter(|value| !value.is_empty()) {
                let payload = AgentHookFinished {
                    run_id,
                    agent: query_value(query, "agent").filter(|value| !value.is_empty()),
                };
                accepted = app.emit("agent-finished", payload).is_ok();
            }
        }
    }

    let (status, body) = if accepted {
        ("200 OK", "{}")
    } else {
        ("400 Bad Request", r#"{"error":"bad request"}"#)
    };
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn start_agent_hook_server(app: AppHandle) -> Result<String, String> {
    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|e| format!("hook bind failed: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("hook local addr failed: {e}"))?
        .port();
    let url = format!("http://127.0.0.1:{port}/agent-finished");

    thread::spawn(move || {
        for stream in listener.incoming() {
            if let Ok(stream) = stream {
                handle_agent_hook_request(stream, &app);
            }
        }
    });

    Ok(url)
}

fn user_home() -> Result<PathBuf, String> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .ok_or_else(|| "user home directory not found".to_string())
}

fn agent_settings_path(home: &Path) -> PathBuf {
    home.join(".wraith").join("agent.json")
}

fn default_agent_settings() -> Value {
    json!({
        "provider": "openrouter",
        "model": "anthropic/claude-3.5-sonnet",
        "baseUrl": "https://openrouter.ai/api/v1",
        "apiKey": ""
    })
}

fn write_json_pretty(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create {} failed: {e}", parent.display()))?;
    }
    let json =
        serde_json::to_string_pretty(value).map_err(|e| format!("serialize JSON failed: {e}"))?;
    std::fs::write(path, format!("{json}\n"))
        .map_err(|e| format!("write {} failed: {e}", path.display()))
}

fn load_json_object(path: &Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(json!({}));
    }

    let contents = std::fs::read_to_string(path)
        .map_err(|e| format!("read {} failed: {e}", path.display()))?;
    let value: Value = serde_json::from_str(&contents)
        .map_err(|e| format!("parse {} failed: {e}", path.display()))?;
    if value.is_object() {
        Ok(value)
    } else {
        Err(format!("{} must contain a JSON object", path.display()))
    }
}

fn ensure_agent_hook_script(home: &Path) -> Result<String, String> {
    let script_dir = home.join(".wraith");
    std::fs::create_dir_all(&script_dir)
        .map_err(|e| format!("create {} failed: {e}", script_dir.display()))?;

    let script_path = script_dir.join("wraith-agent-finished.ps1");
    let script = r#"$hookUrl = [Environment]::GetEnvironmentVariable('WRAITH_AGENT_HOOK_URL')
$runId = [Environment]::GetEnvironmentVariable('WRAITH_AGENT_RUN_ID')

if ([string]::IsNullOrWhiteSpace($hookUrl) -or [string]::IsNullOrWhiteSpace($runId)) {
  exit 0
}

try {
  $uriBuilder = [System.UriBuilder]::new($hookUrl)
  $query = 'runId=' + [System.Uri]::EscapeDataString($runId)
  $label = [Environment]::GetEnvironmentVariable('WRAITH_AGENT_LABEL')
  if (-not [string]::IsNullOrWhiteSpace($label)) {
    $query += '&agent=' + [System.Uri]::EscapeDataString($label)
  }
  $uriBuilder.Query = $query
  Invoke-WebRequest -UseBasicParsing -Method Post -Uri $uriBuilder.Uri.AbsoluteUri -TimeoutSec 2 | Out-Null
} catch {
}
"#;
    std::fs::write(&script_path, script)
        .map_err(|e| format!("write {} failed: {e}", script_path.display()))?;

    let escaped_path = script_path.display().to_string().replace('"', "\\\"");
    Ok(format!(
        "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{escaped_path}\""
    ))
}

fn ensure_stop_hook_json(path: &Path, command: &str) -> Result<(), String> {
    let mut root = load_json_object(path)?;
    let root_obj = root
        .as_object_mut()
        .ok_or_else(|| format!("{} must contain a JSON object", path.display()))?;
    let hooks = root_obj.entry("hooks").or_insert_with(|| json!({}));
    if !hooks.is_object() {
        *hooks = json!({});
    }

    let hooks_obj = hooks
        .as_object_mut()
        .ok_or_else(|| "hooks must be a JSON object".to_string())?;
    let stop = hooks_obj.entry("Stop").or_insert_with(|| json!([]));
    if !stop.is_array() {
        *stop = json!([]);
    }

    let stop_array = stop
        .as_array_mut()
        .ok_or_else(|| "Stop hooks must be a JSON array".to_string())?;
    stop_array.retain(|entry| {
        let entry = entry.to_string().to_ascii_lowercase();
        !entry.contains("wraith_agent_hook_url")
            && !entry.contains("wraith-agent-finished.ps1")
            && !entry.contains("wraith agent completion notification")
    });
    stop_array.push(json!({
        "hooks": [
            {
                "type": "command",
                "command": command,
                "timeout": 5
            }
        ]
    }));

    write_json_pretty(path, &root)
}

fn ensure_grok_hook(home: &Path, command: &str) -> Result<(), String> {
    let path = home
        .join(".grok")
        .join("hooks")
        .join("wraith-finished.json");
    let value = json!({
        "description": "Wraith agent completion notification",
        "hooks": {
            "Stop": [
                {
                    "hooks": [
                        {
                            "type": "command",
                            "command": command,
                            "timeout": 5
                        }
                    ]
                }
            ]
        }
    });
    write_json_pretty(&path, &value)
}

fn ensure_opencode_plugin(home: &Path) -> Result<(), String> {
    let plugin_dir = home.join(".config").join("opencode").join("plugins");
    std::fs::create_dir_all(&plugin_dir)
        .map_err(|e| format!("create {} failed: {e}", plugin_dir.display()))?;

    let path = plugin_dir.join("wraith-notify.js");
    let source = r#"export const WraithNotifyPlugin = async () => {
  let lastRunId = "";
  let lastAt = 0;

  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle") return;

      const url = process.env.WRAITH_AGENT_HOOK_URL;
      const runId = process.env.WRAITH_AGENT_RUN_ID;
      const agent = process.env.WRAITH_AGENT_LABEL || "opencode";
      if (!url || !runId) return;

      const now = Date.now();
      if (runId === lastRunId && now - lastAt < 1000) return;
      lastRunId = runId;
      lastAt = now;

      const target = new URL(url);
      target.searchParams.set("runId", runId);
      target.searchParams.set("agent", agent);
      await fetch(target, { method: "POST" }).catch(() => undefined);
    },
  };
};
"#;

    std::fs::write(&path, source).map_err(|e| format!("write {} failed: {e}", path.display()))
}

#[tauri::command]
fn agent_hook_url(state: State<'_, AppState>) -> Result<String, String> {
    state
        .agent_hook_url
        .lock()
        .map_err(|e| format!("lock poisoned: {e}"))?
        .clone()
        .ok_or_else(|| "agent hook server not ready".to_string())
}

#[tauri::command]
fn load_agent_settings() -> Result<Value, String> {
    let home = user_home()?;
    let path = agent_settings_path(&home);
    if !path.exists() {
        return Ok(default_agent_settings());
    }
    let value = load_json_object(&path)?;
    // Merge with defaults so missing keys are filled in.
    let mut defaults = default_agent_settings();
    if let (Some(defaults_obj), Some(value_obj)) = (defaults.as_object_mut(), value.as_object()) {
        for (key, val) in value_obj {
            defaults_obj.insert(key.clone(), val.clone());
        }
    }
    Ok(defaults)
}

#[tauri::command]
fn save_agent_settings(state: Value) -> Result<(), String> {
    let home = user_home()?;
    let path = agent_settings_path(&home);
    write_json_pretty(&path, &state)
}

#[tauri::command]
async fn agent_chat_completion(
    url: String,
    headers: HashMap<String, String>,
    body: Value,
) -> Result<AgentChatCompletionResponse, String> {
    use reqwest::header::{HeaderMap, HeaderName, HeaderValue};

    let target = reqwest::Url::parse(&url).map_err(|e| format!("invalid URL: {e}"))?;
    if target.scheme() != "https" && target.scheme() != "http" {
        return Err("agent URL must use http or https".to_string());
    }

    let mut header_map = HeaderMap::new();
    for (name, value) in headers {
        if name.eq_ignore_ascii_case("host") || name.eq_ignore_ascii_case("content-length") {
            continue;
        }
        let header_name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|e| format!("invalid header {name}: {e}"))?;
        let header_value = HeaderValue::from_str(&value)
            .map_err(|e| format!("invalid header value for {name}: {e}"))?;
        header_map.insert(header_name, header_value);
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| format!("HTTP client failed: {e}"))?;
    let response = client
        .post(target)
        .headers(header_map)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let status = response.status().as_u16();
    let body = response
        .text()
        .await
        .map_err(|e| format!("read response failed: {e}"))?;

    Ok(AgentChatCompletionResponse { status, body })
}

#[tauri::command]
fn ensure_agent_hooks() -> Result<(), String> {
    let home = user_home()?;
    let command = ensure_agent_hook_script(&home)?;

    ensure_stop_hook_json(&home.join(".codex").join("hooks.json"), &command)?;
    ensure_stop_hook_json(&home.join(".claude").join("settings.json"), &command)?;
    ensure_grok_hook(&home, &command)?;
    ensure_opencode_plugin(&home)?;

    Ok(())
}

#[tauri::command]
fn spawn_powershell(
    app: AppHandle,
    state: State<'_, AppState>,
    cwd: Option<String>,
) -> Result<String, String> {
    let pty_system = native_pty_system();
    let pty_pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    let mut cmd = CommandBuilder::new("powershell.exe");
    cmd.arg("-NoLogo");
    if let Some(path) = cwd.as_deref() {
        if !path.trim().is_empty() {
            cmd.cwd(path);
        }
    }

    let child = pty_pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn failed: {e}"))?;

    let reader = pty_pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader failed: {e}"))?;

    let writer = pty_pair
        .master
        .take_writer()
        .map_err(|e| format!("take writer failed: {e}"))?;

    let id = new_id();
    let kill_flag = Arc::new(AtomicBool::new(false));
    let kill_flag_reader = kill_flag.clone();
    let app_handle = app.clone();
    let id_for_thread = id.clone();

    thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 4096];
        loop {
            if kill_flag_reader.load(Ordering::SeqCst) {
                break;
            }
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let payload = PtyOutput {
                        id: id_for_thread.clone(),
                        data,
                    };
                    if app_handle.emit("pty-output", payload).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = app_handle.emit("pty-exit", id_for_thread);
    });

    let instance = PtyInstance {
        writer,
        master: pty_pair.master,
        child,
        kill_flag,
    };

    state
        .pty
        .lock()
        .map_err(|e| format!("lock poisoned: {e}"))?
        .insert(id.clone(), instance);

    Ok(id)
}

#[tauri::command]
fn write_powershell(id: String, input: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut slot = state
        .pty
        .lock()
        .map_err(|e| format!("lock poisoned: {e}"))?;
    let instance = slot.get_mut(&id).ok_or("no such pty")?;
    instance
        .writer
        .write_all(input.as_bytes())
        .map_err(|e| format!("write failed: {e}"))?;
    instance
        .writer
        .flush()
        .map_err(|e| format!("flush failed: {e}"))?;
    Ok(())
}

#[tauri::command]
fn resize_powershell(
    id: String,
    cols: u16,
    rows: u16,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let slot = state
        .pty
        .lock()
        .map_err(|e| format!("lock poisoned: {e}"))?;
    let instance = slot.get(&id).ok_or("no such pty")?;
    instance
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize failed: {e}"))?;
    Ok(())
}

#[tauri::command]
fn kill_powershell(id: String, state: State<'_, AppState>) -> Result<(), String> {
    kill_instance(&id, &state);
    Ok(())
}

#[tauri::command]
fn list_powershell(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let slot = state
        .pty
        .lock()
        .map_err(|e| format!("lock poisoned: {e}"))?;
    Ok(slot.keys().cloned().collect())
}

fn sessions_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map_err(|e| format!("app data dir failed: {e}"))
        .map(|dir| dir.join("sessions.json"))
}

#[tauri::command]
fn load_sessions(app: AppHandle) -> Result<Option<Value>, String> {
    let path = sessions_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let contents =
        std::fs::read_to_string(&path).map_err(|e| format!("read sessions failed: {e}"))?;
    let value: Value =
        serde_json::from_str(&contents).map_err(|e| format!("parse sessions failed: {e}"))?;
    Ok(Some(value))
}

#[tauri::command]
fn save_sessions(app: AppHandle, state: Value) -> Result<(), String> {
    let path = sessions_path(&app)?;
    let dir = path
        .parent()
        .ok_or_else(|| "sessions path has no parent".to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("create sessions dir failed: {e}"))?;

    let json = serde_json::to_string_pretty(&state)
        .map_err(|e| format!("serialize sessions failed: {e}"))?;
    let tmp_path = dir.join("sessions.json.tmp");
    std::fs::write(&tmp_path, json).map_err(|e| format!("write sessions failed: {e}"))?;
    std::fs::rename(&tmp_path, &path).map_err(|e| format!("commit sessions failed: {e}"))?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .setup(|app| {
            let url = start_agent_hook_server(app.handle().clone())
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
            let state = app.state::<AppState>();
            if let Ok(mut slot) = state.agent_hook_url.lock() {
                *slot = Some(url);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            spawn_powershell,
            write_powershell,
            resize_powershell,
            kill_powershell,
            list_powershell,
            load_sessions,
            save_sessions,
            agent_hook_url,
            ensure_agent_hooks,
            load_agent_settings,
            save_agent_settings,
            agent_chat_completion
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let Some(state) = window.app_handle().try_state::<AppState>() {
                    kill_all(&state);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
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
}

#[derive(Serialize, Clone)]
struct PtyOutput {
    id: String,
    data: String,
}

fn kill_instance(id: &str, state: &AppState) {
    let removed = state
        .pty
        .lock()
        .ok()
        .and_then(|mut map| map.remove(id));
    if let Some(mut instance) = removed {
        instance.kill_flag.store(true, Ordering::SeqCst);
        let _ = instance.child.kill();
    }
}

fn kill_all(state: &AppState) {
    if let Some(mut map) = state.pty.lock().ok() {
        for (_id, mut instance) in map.drain() {
            instance.kill_flag.store(true, Ordering::SeqCst);
            let _ = instance.child.kill();
        }
    }
}

fn new_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    format!("pty-{:x}", nanos)
}

#[tauri::command]
fn spawn_powershell(app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            spawn_powershell,
            write_powershell,
            resize_powershell,
            kill_powershell,
            list_powershell
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
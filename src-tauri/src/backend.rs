use serde_json::{json, Value};
use std::{collections::HashMap, io::{BufRead, BufReader, Write}, process::{Child, ChildStdin, Command, Stdio}, sync::{Arc, Mutex, atomic::{AtomicU64, Ordering}}, path::Path};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

pub struct Backend {
    input: Mutex<ChildStdin>, child: Mutex<Child>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    sequence: AtomicU64,
    #[cfg(windows)]
    _job: crate::job::ProcessJob,
}
impl Backend {
    pub fn start(app: AppHandle, resources: &Path, data: &Path) -> Result<Arc<Self>, Box<dyn std::error::Error>> {
        let config: Value = std::fs::read(data.join("migration-config.json")).ok().and_then(|v| serde_json::from_slice(&v).ok()).unwrap_or(json!({}));
        let mut command = Command::new(resources.join("node/node.exe"));
        command.current_dir(resources.join("backend")).arg("--preserve-symlinks-main").arg("--preserve-symlinks").arg("desktop/main.cjs")
            .env("ATLAS_DATA_DIR", data).env("ATLAS_LEGACY_MODELS", config["legacyModels"].as_str().unwrap_or(""))
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
        let mut child = command.spawn()?;
        #[cfg(windows)]
        let job = match crate::job::ProcessJob::attach(&child) { Ok(job) => job, Err(error) => { let _ = child.kill(); return Err(error.into()); } };
        let output = child.stdout.take().unwrap(); let errors = child.stderr.take().unwrap();
        let backend = Arc::new(Self { input: Mutex::new(child.stdin.take().unwrap()), child: Mutex::new(child), pending: Mutex::new(HashMap::new()), sequence: AtomicU64::new(0), #[cfg(windows)] _job: job });
        let weak = Arc::downgrade(&backend);
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Some(backend) = weak.upgrade() else { break; };
                let Ok(line) = line else { break; };
                if line.len() > 100 * 1024 * 1024 { break; }
                let Ok(value) = serde_json::from_str::<Value>(&line) else { continue; };
                match value["type"].as_str() {
                    Some("result") => { if let Some(id) = value["id"].as_u64() { if let Some(sender) = backend.pending.lock().unwrap().remove(&id) {
                        let result = if let Some(error) = value["error"].as_str() { Err(error.to_string()) } else { Ok(value["value"].clone()) }; let _ = sender.send(result);
                    } } }
                    Some("inference") => { let _ = app.emit_to("main", "atlas-inference", &value["value"]); }
                    Some("native") => {
                        let handle = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let result = crate::native::dispatch(&handle, &backend, &value).await;
                            let reply = match result { Ok(result) => json!({"type":"nativeResult","id":value["id"],"value":result}), Err(error) => json!({"type":"nativeResult","id":value["id"],"error":error}) };
                            let _ = backend.send(&reply);
                        });
                    }
                    _ => {}
                }
            }
            if let Some(backend) = weak.upgrade() {
                for (_, sender) in backend.pending.lock().unwrap().drain() { let _ = sender.send(Err("Atlas native service stopped. Restart the application.".into())); }
                let _ = app.emit_to("main", "atlas-inference", json!({"type":"runtime-reset","detail":"Atlas native service stopped. Restart Atlas."}));
            }
        });
        let log = data.join("native-service.log");
        std::thread::spawn(move || {
            if let Ok(mut file) = std::fs::File::create(log) { for line in BufReader::new(errors).lines().take(500) { if let Ok(line) = line { let _ = writeln!(file,"{}",line); } } }
        });
        Ok(backend)
    }
    pub fn send(&self, value: &Value) -> Result<(), String> {
        let mut input = self.input.lock().map_err(|_| "Native service lock failed")?;
        let line = serde_json::to_vec(value).map_err(|e| e.to_string())?;
        input.write_all(&line).and_then(|_| input.write_all(b"\n")).and_then(|_| input.flush()).map_err(|e| e.to_string())
    }
    pub async fn call(&self, name: &str, value: Value) -> Result<Value, String> {
        let id = self.sequence.fetch_add(1, Ordering::Relaxed) + 1;
        let (sender, receiver) = oneshot::channel(); self.pending.lock().unwrap().insert(id, sender);
        if let Err(error) = self.send(&json!({"id":id,"name":name,"value":value})) { self.pending.lock().unwrap().remove(&id); return Err(error); }
        let result = tokio::time::timeout(std::time::Duration::from_secs(2800), receiver).await;
        self.pending.lock().unwrap().remove(&id);
        result.map_err(|_| "Native request time limit reached".to_string())?.map_err(|_| "Native request interrupted".to_string())?
    }
    pub fn shutdown(&self) {
        let _ = self.send(&json!({"name":"_shutdown"}));
        let started = std::time::Instant::now();
        let mut child = self.child.lock().unwrap();
        while started.elapsed().as_secs() < 4 { if child.try_wait().ok().flatten().is_some() { return; } std::thread::sleep(std::time::Duration::from_millis(50)); }
        let _ = child.kill(); let _ = child.wait();
    }
}

//! Supervises the Node.js sidecar that hosts the Claude Agent SDK.
//!
//! Protocol: newline-delimited JSON over the child's stdin/stdout. Responses are matched to
//! requests by id; lines with an `event` field are forwarded to the webview.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::policy;

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, Value>>>>>;

pub struct Sidecar {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    pending: Pending,
    next_id: AtomicU64,
}

#[derive(Debug, Clone)]
pub struct Launch {
    pub node: PathBuf,
    pub entry: PathBuf,
}

/// Locate the Node binary and the sidecar entry point.
///
/// Order: explicit env overrides, the source tree (debug builds), then the installed layout
/// `<prefix>/lib/void-workshop/sidecar` next to `<prefix>/bin/void-workshop`.
pub fn locate() -> Result<Launch, String> {
    let node = std::env::var_os("VOID_WORKSHOP_NODE")
        .map(PathBuf::from)
        .or_else(|| find_in_path("node"))
        .ok_or_else(|| "Node.js was not found. Install it (pacman -S nodejs) or set VOID_WORKSHOP_NODE.".to_string())?;

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = std::env::var_os("VOID_WORKSHOP_SIDECAR_DIR") {
        candidates.push(PathBuf::from(dir));
    }
    if cfg!(debug_assertions) {
        candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("sidecar"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(bin_dir) = exe.parent() {
            candidates.push(bin_dir.join("..").join("lib").join("void-workshop").join("sidecar"));
            candidates.push(bin_dir.join("sidecar"));
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        candidates.push(PathBuf::from(home).join(".local/lib/void-workshop/sidecar"));
    }
    for dir in candidates {
        let entry = dir.join("dist").join("main.js");
        if entry.is_file() {
            let entry = entry.canonicalize().map_err(|e| e.to_string())?;
            return Ok(Launch { node, entry });
        }
    }
    Err("The VOID Workshop sidecar was not found. Run ./scripts/build.sh (or set VOID_WORKSHOP_SIDECAR_DIR).".into())
}

fn find_in_path(bin: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|d| d.join(bin))
        .find(|p| p.is_file())
}

impl Sidecar {
    /// Spawn the sidecar. `on_event` receives `(event, payload)`; `on_exit` fires when stdout closes.
    pub fn spawn<E, X>(launch: &Launch, on_event: E, on_exit: X) -> Result<Arc<Sidecar>, String>
    where
        E: Fn(String, Value) + Send + 'static,
        X: FnOnce(Option<i32>) + Send + 'static,
    {
        let mut cmd = Command::new(&launch.node);
        cmd.arg("--disable-warning=ExperimentalWarning")
            .arg("--max-old-space-size=2048")
            .arg(&launch.entry)
            .env_clear()
            .envs(policy::filtered_env(std::env::vars()))
            // This shell handles `app.restart` (admin dev sessions install a new build and start again).
            .env("VOID_WORKSHOP_SHELL_RESTART", "1")
            .current_dir(launch.entry.parent().unwrap_or(Path::new("/")))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        let mut child = cmd.spawn().map_err(|e| format!("Could not start the sidecar: {e}"))?;
        let stdout = child.stdout.take().ok_or("sidecar stdout unavailable")?;
        let stdin = child.stdin.take().ok_or("sidecar stdin unavailable")?;

        let sidecar = Arc::new(Sidecar {
            child: Mutex::new(Some(child)),
            stdin: Mutex::new(Some(stdin)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(1),
        });

        let pending = sidecar.pending.clone();
        let reader_owner = sidecar.clone();
        std::thread::Builder::new()
            .name("sidecar-reader".into())
            .spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines() {
                    let Ok(line) = line else { break };
                    if line.trim().is_empty() {
                        continue;
                    }
                    let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                        eprintln!("void-workshop: ignoring malformed sidecar line");
                        continue;
                    };
                    route_message(&pending, &on_event, msg);
                }
                // stdout closed: fail every outstanding request.
                let waiting: Vec<_> = pending.lock().map(|mut p| p.drain().collect()).unwrap_or_default();
                for (_, tx) in waiting {
                    let _ = tx.send(Err(json!({"code": "sidecar-exit", "message": "The agent backend stopped."})));
                }
                let code = reader_owner
                    .child
                    .lock()
                    .ok()
                    .and_then(|mut c| c.as_mut().and_then(|c| c.wait().ok()))
                    .and_then(|s| s.code());
                on_exit(code);
            })
            .map_err(|e| e.to_string())?;
        Ok(sidecar)
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value, Value> {
        if let Err(rejection) = policy::check_call(method, &params) {
            return Err(json!({"code": "rejected", "message": format!("Request rejected: {rejection}")}));
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().map_err(|_| internal("lock"))?.insert(id, tx);
        let line = serde_json::to_string(&json!({"id": id, "method": method, "params": params})).map_err(|_| internal("encode"))?;
        {
            let mut guard = self.stdin.lock().map_err(|_| internal("lock"))?;
            let Some(stdin) = guard.as_mut() else {
                self.pending.lock().ok().map(|mut p| p.remove(&id));
                return Err(json!({"code": "sidecar-exit", "message": "The agent backend is not running."}));
            };
            if stdin.write_all(line.as_bytes()).and_then(|_| stdin.write_all(b"\n")).and_then(|_| stdin.flush()).is_err() {
                self.pending.lock().ok().map(|mut p| p.remove(&id));
                return Err(json!({"code": "sidecar-exit", "message": "The agent backend is not running."}));
            }
        }
        match tokio::time::timeout(policy::timeout_for(method), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(json!({"code": "sidecar-exit", "message": "The agent backend stopped."})),
            Err(_) => {
                self.pending.lock().ok().map(|mut p| p.remove(&id));
                Err(json!({"code": "timeout", "message": format!("{method} timed out")}))
            }
        }
    }

    /// Graceful stop: closing stdin lets the sidecar cancel tasks and stop child processes,
    /// then it is killed if it has not exited after a grace period.
    pub fn shutdown(&self) {
        if let Ok(mut s) = self.stdin.lock() {
            s.take();
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let done = self
                .child
                .lock()
                .ok()
                .map(|mut c| match c.as_mut() {
                    Some(child) => matches!(child.try_wait(), Ok(Some(_))),
                    None => true,
                })
                .unwrap_or(true);
            if done || std::time::Instant::now() > deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        if let Ok(mut c) = self.child.lock() {
            if let Some(child) = c.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

fn internal(what: &str) -> Value {
    json!({"code": "internal", "message": format!("internal error ({what})")})
}

fn route_message<E: Fn(String, Value)>(pending: &Pending, on_event: &E, msg: Value) {
    if let Some(event) = msg.get("event").and_then(Value::as_str) {
        on_event(event.to_string(), msg.get("payload").cloned().unwrap_or(Value::Null));
        return;
    }
    let Some(id) = msg.get("id").and_then(Value::as_u64) else {
        return;
    };
    let Some(tx) = pending.lock().ok().and_then(|mut p| p.remove(&id)) else {
        return;
    };
    let reply = match msg.get("error") {
        Some(err) if !err.is_null() => Err(err.clone()),
        _ => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
    };
    let _ = tx.send(reply);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_events_and_responses() {
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (tx, mut rx) = oneshot::channel();
        pending.lock().unwrap().insert(7, tx);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let seen2 = seen.clone();
        let on_event = move |e: String, _p: Value| seen2.lock().unwrap().push(e);
        route_message(&pending, &on_event, json!({"event": "task.updated", "payload": {"id": 1}}));
        route_message(&pending, &on_event, json!({"id": 7, "result": {"ok": true}}));
        assert_eq!(seen.lock().unwrap().as_slice(), ["task.updated"]);
        assert_eq!(rx.try_recv().unwrap(), Ok(json!({"ok": true})));
        assert!(pending.lock().unwrap().is_empty());
    }

    #[test]
    fn routes_errors() {
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (tx, mut rx) = oneshot::channel();
        pending.lock().unwrap().insert(1, tx);
        route_message(&pending, &|_: String, _: Value| {}, json!({"id": 1, "error": {"code": "x", "message": "m"}}));
        assert_eq!(rx.try_recv().unwrap(), Err(json!({"code": "x", "message": "m"})));
    }

    #[test]
    fn ignores_unknown_ids() {
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        route_message(&pending, &|_: String, _: Value| {}, json!({"id": 99, "result": 1}));
        assert!(pending.lock().unwrap().is_empty());
    }
}

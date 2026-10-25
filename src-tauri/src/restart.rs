//! Admin restart: in an admin dev session the sidecar asks (event `app.restart`) to install the new build
//! and start again. A detached helper waits for this process to exit, runs `scripts/install.sh` when asked,
//! writes the outcome where the sidecar reads it after the restart, and starts the installed app.

use std::fs::OpenOptions;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::Value;

/// Waits up to 30 s for the old app to go, so the install never replaces files of a running Workshop.
const HELPER: &str = r#"
pid="$1"; src="$2"; install="$3"; status="$4"; launcher="$5"; hidden="$6"
for _ in $(seq 1 300); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
echo "== $(date -Is) restarting VOID Workshop (install: $install)"
ok=true
if [ "$install" = 1 ]; then
  if (cd "$src" && ./scripts/install.sh); then echo "== install finished"; else ok=false; echo "== install FAILED, starting the previous build"; fi
fi
printf '{"ok":%s,"at":%s000}\n' "$ok" "$(date +%s)" > "$status"
if [ "$hidden" = 1 ]; then exec "$launcher" --hidden; else exec "$launcher"; fi
"#;

#[derive(Debug, PartialEq, Eq)]
pub struct Request {
    pub install: bool,
    pub source_dir: Option<PathBuf>,
    pub status_file: PathBuf,
    pub log_file: PathBuf,
}

/// The sidecar's request. Paths must be absolute; installing needs a source tree with the install script.
pub fn parse(payload: &Value) -> Result<Request, String> {
    let path = |key: &str| -> Option<PathBuf> { payload.get(key).and_then(Value::as_str).map(PathBuf::from).filter(|p| p.is_absolute()) };
    let install = payload.get("install").and_then(Value::as_bool).unwrap_or(false);
    let status_file = path("statusFile").ok_or("no status file")?;
    let log_file = path("logFile").ok_or("no log file")?;
    let source_dir = path("sourceDir");
    if install && !source_dir.as_deref().is_some_and(|s| s.join("scripts/install.sh").is_file()) {
        return Err("the VOID Workshop source folder (with scripts/install.sh) was not found".into());
    }
    Ok(Request { install, source_dir, status_file, log_file })
}

/// The launcher install.sh writes (`~/.local/bin/void-workshop`).
pub fn launcher(home: &Path) -> PathBuf {
    home.join(".local/bin/void-workshop")
}

/// Start the detached helper. The caller exits the app right after.
pub fn spawn_helper(req: &Request, hidden: bool) -> Result<(), String> {
    let home = std::env::var_os("HOME").map(PathBuf::from).ok_or("HOME is not set")?;
    let launcher = launcher(&home);
    if !launcher.is_file() {
        return Err(format!("{} is missing; install once with ./scripts/install.sh", launcher.display()));
    }
    let log = OpenOptions::new().create(true).append(true).open(&req.log_file).map_err(|e| format!("cannot open the restart log: {e}"))?;
    let err = log.try_clone().map_err(|e| e.to_string())?;
    let src = req.source_dir.as_deref().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    Command::new("/bin/bash")
        .arg("-c")
        .arg(HELPER)
        .arg("void-workshop-restart")
        .arg(std::process::id().to_string())
        .arg(src)
        .arg(if req.install { "1" } else { "0" })
        .arg(&req.status_file)
        .arg(&launcher)
        .arg(if hidden { "1" } else { "0" })
        .stdin(Stdio::null())
        .stdout(log)
        .stderr(err)
        // Its own process group, so it outlives this app.
        .process_group(0)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("cannot start the restart helper: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_a_restart_without_install() {
        let r = parse(&json!({"install": false, "statusFile": "/tmp/s.json", "logFile": "/tmp/r.log"})).unwrap();
        assert!(!r.install);
        assert_eq!(r.status_file, PathBuf::from("/tmp/s.json"));
        assert_eq!(r.source_dir, None);
    }

    #[test]
    fn refuses_relative_paths_and_installs_without_a_source() {
        assert!(parse(&json!({"statusFile": "s.json", "logFile": "/tmp/r.log"})).is_err());
        assert!(parse(&json!({"install": true, "statusFile": "/tmp/s.json", "logFile": "/tmp/r.log"})).is_err());
        assert!(parse(&json!({"install": true, "sourceDir": "/nonexistent", "statusFile": "/tmp/s.json", "logFile": "/tmp/r.log"})).is_err());
    }

    #[test]
    fn accepts_an_install_from_this_repo() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").canonicalize().unwrap();
        let r = parse(&json!({"install": true, "sourceDir": repo, "statusFile": "/tmp/s.json", "logFile": "/tmp/r.log"})).unwrap();
        assert!(r.install);
    }
}

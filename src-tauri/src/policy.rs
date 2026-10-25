//! Narrow interface between the webview and the sidecar.
//!
//! The webview can only reach sidecar methods listed here, with bounded parameter sizes.
//! The sidecar validates every parameter again with its own schemas.

/// Methods the UI may call. Anything else is rejected before it reaches the sidecar.
pub const ALLOWED_METHODS: &[&str] = &[
    "app.init",
    "app.update.check",
    "app.update.install",
    "app.update.dismiss",
    "settings.get",
    "settings.update",
    "auth.status",
    "auth.setKey",
    "auth.deleteKey",
    "auth.verify",
    "auth.subscriptionStatus",
    "auth.subscriptionLogin",
    "auth.subscriptionLoginCancel",
    "auth.subscriptionLoginCode",
    "auth.subscriptionLogout",
    "auth.clearPlanLimit",
    "models.refresh",
    "ollama.status",
    "remote.status",
    "remote.pair",
    "remote.unpair",
    "remote.setRelay",
    "admin.status",
    "admin.setPassword",
    "admin.clearPassword",
    "admin.start",
    "admin.end",
    "billing.acknowledge",
    "usage.summary",
    "plan.usage",
    "project.open",
    "project.recent",
    "project.forget",
    "project.setPermissions",
    "project.allowedCommands",
    "project.forgetCommand",
    "project.listDir",
    "project.readFile",
    "project.writeFile",
    "git.status",
    "git.diff",
    "git.checkpoint",
    "git.commit",
    "task.list",
    "task.active",
    "task.get",
    "task.image",
    "task.saveImage",
    "task.search",
    "task.export",
    "image.upload",
    "task.start",
    "task.send",
    "task.approvePlan",
    "task.setMode",
    "task.setModel",
    "task.cancel",
    "task.compact",
    "task.queue.edit",
    "task.queue.remove",
    "task.queue.sendNow",
    "task.queue.flush",
    "task.finish",
    "approval.respond",
    "approval.pending",
    "review.list",
    "review.accept",
    "review.reject",
    "runner.detect",
    "runner.history",
    "runner.prepare",
    "runner.run",
    "runner.cancel",
];

/// Largest serialized params accepted from the UI (a long task description fits comfortably).
pub const MAX_PARAMS_BYTES: usize = 256 * 1024;

/// Saving from the editor carries the whole file (the sidecar caps it at 1 MiB of UTF-8); JSON
/// escaping can roughly double that.
pub const MAX_SAVE_PARAMS_BYTES: usize = 3 * 1024 * 1024;

fn max_params_for(method: &str) -> usize {
    if method == "project.writeFile" {
        MAX_SAVE_PARAMS_BYTES
    } else {
        MAX_PARAMS_BYTES
    }
}

/// Environment variables passed to the sidecar. Everything else (notably ANTHROPIC_*, CLAUDE_*,
/// proxies and tokens from the launching shell) is dropped.
pub const SIDECAR_ENV_ALLOWLIST: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "SHELL",
    "XDG_RUNTIME_DIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "DBUS_SESSION_BUS_ADDRESS",
    "CARGO_HOME",
    "RUSTUP_HOME",
    "GOPATH",
    "JAVA_HOME",
    "NVM_DIR",
    "VOID_WORKSHOP_DATA_DIR",
    "VOID_WORKSHOP_CONFIG_DIR",
    "VOID_WORKSHOP_KEY_FILE",
    "VOID_WORKSHOP_KEY_BACKEND",
];

#[derive(Debug, PartialEq, Eq)]
pub enum CallRejection {
    UnknownMethod,
    ParamsTooLarge,
    ParamsNotObject,
}

impl std::fmt::Display for CallRejection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CallRejection::UnknownMethod => write!(f, "method is not allowed"),
            CallRejection::ParamsTooLarge => write!(f, "parameters are too large"),
            CallRejection::ParamsNotObject => write!(f, "parameters must be an object"),
        }
    }
}

pub fn check_call(method: &str, params: &serde_json::Value) -> Result<(), CallRejection> {
    if !ALLOWED_METHODS.contains(&method) {
        return Err(CallRejection::UnknownMethod);
    }
    if !(params.is_object() || params.is_null()) {
        return Err(CallRejection::ParamsNotObject);
    }
    let size = serde_json::to_vec(params).map(|v| v.len()).unwrap_or(usize::MAX);
    if size > max_params_for(method) {
        return Err(CallRejection::ParamsTooLarge);
    }
    Ok(())
}

/// Request timeout per method. Calls that wait on the network or a user get longer.
pub fn timeout_for(method: &str) -> std::time::Duration {
    let secs = match method {
        // The user signs in in the browser; the sidecar gives up after 10 minutes.
        "auth.subscriptionLogin" => 660,
        // Downloads and unpacks a release (the sidecar allows 10 minutes for the download).
        "app.update.install" => 900,
        "task.start" | "task.send" | "task.compact" | "task.queue.sendNow" | "task.queue.flush" => 120,
        "auth.verify" | "auth.setKey" | "auth.deleteKey" | "auth.status" | "app.init" | "models.refresh" | "app.update.check" => 60,
        "auth.subscriptionStatus" | "auth.subscriptionLogout" => 90,
        "git.commit" | "git.checkpoint" | "task.cancel" => 60,
        // Ending an admin session stops the tasks still working in it.
        "admin.start" | "admin.end" | "admin.clearPassword" => 60,
        _ => 30,
    };
    std::time::Duration::from_secs(secs)
}

pub fn filtered_env<I: IntoIterator<Item = (String, String)>>(vars: I) -> Vec<(String, String)> {
    vars.into_iter()
        .filter(|(k, _)| SIDECAR_ENV_ALLOWLIST.contains(&k.as_str()))
        .collect()
}

/// The only links the window may open in the browser: Claude's OAuth sign-in page.
pub fn is_login_url(url: &str) -> bool {
    let host_ok = ["https://claude.ai/", "https://claude.com/"].iter().any(|p| url.starts_with(p));
    host_ok && url.contains("/oauth/authorize?") && url.len() < 4000 && url.chars().all(|c| c.is_ascii_graphic())
}

/// True when the process runs with root privileges (real or effective).
pub fn running_as_root() -> bool {
    // SAFETY: getuid/geteuid have no preconditions and cannot fail.
    unsafe { libc::getuid() == 0 || libc::geteuid() == 0 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn allows_known_methods_only() {
        assert!(check_call("task.start", &json!({"root": "/x", "prompt": "hi"})).is_ok());
        // Screenshots in the conversation are fetched with the same call VOID Portal uses.
        assert!(check_call("task.image", &json!({"taskId": "t", "imageId": "i", "offset": 0})).is_ok());
        assert_eq!(check_call("fs.writeAnything", &json!({})), Err(CallRejection::UnknownMethod));
        assert_eq!(check_call("", &json!({})), Err(CallRejection::UnknownMethod));
        assert_eq!(check_call("task.start ", &json!({})), Err(CallRejection::UnknownMethod));
    }

    #[test]
    fn rejects_oversized_or_malformed_params() {
        let big = "x".repeat(MAX_PARAMS_BYTES + 1);
        assert_eq!(check_call("task.start", &json!({ "prompt": big })), Err(CallRejection::ParamsTooLarge));
        assert_eq!(check_call("task.start", &json!([1, 2])), Err(CallRejection::ParamsNotObject));
        assert_eq!(check_call("task.start", &json!("str")), Err(CallRejection::ParamsNotObject));
        assert!(check_call("app.init", &serde_json::Value::Null).is_ok());
    }

    #[test]
    fn only_editor_saves_may_carry_a_whole_file() {
        let file = "x".repeat(1024 * 1024);
        assert!(check_call("project.writeFile", &json!({ "content": file })).is_ok());
        assert_eq!(check_call("task.start", &json!({ "prompt": file })), Err(CallRejection::ParamsTooLarge));
        let huge = "x".repeat(MAX_SAVE_PARAMS_BYTES + 1);
        assert_eq!(check_call("project.writeFile", &json!({ "content": huge })), Err(CallRejection::ParamsTooLarge));
    }

    #[test]
    fn strips_credentials_from_sidecar_environment() {
        let env = vec![
            ("PATH".to_string(), "/usr/bin".to_string()),
            ("ANTHROPIC_API_KEY".to_string(), "sk-ant-api03-secret".to_string()),
            ("ANTHROPIC_BASE_URL".to_string(), "https://proxy".to_string()),
            ("CLAUDE_CODE_OAUTH_TOKEN".to_string(), "oauth".to_string()),
            ("CLAUDECODE".to_string(), "1".to_string()),
            ("HTTPS_PROXY".to_string(), "http://proxy".to_string()),
            ("GITHUB_TOKEN".to_string(), "ghp_x".to_string()),
            ("HOME".to_string(), "/home/u".to_string()),
        ];
        let kept: Vec<String> = filtered_env(env).into_iter().map(|(k, _)| k).collect();
        assert_eq!(kept, vec!["PATH", "HOME"]);
    }

    #[test]
    fn method_list_has_no_duplicates() {
        let mut v = ALLOWED_METHODS.to_vec();
        v.sort_unstable();
        v.dedup();
        assert_eq!(v.len(), ALLOWED_METHODS.len());
    }

    #[test]
    fn opens_only_claude_sign_in_links() {
        assert!(is_login_url("https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=y"));
        assert!(is_login_url("https://claude.ai/oauth/authorize?code=true"));
        assert!(!is_login_url("https://claude.com.evil.example/oauth/authorize?x"));
        assert!(!is_login_url("http://claude.com/oauth/authorize?x"));
        assert!(!is_login_url("https://claude.com/settings"));
        assert!(!is_login_url("https://claude.com/oauth/authorize?x y"));
        assert!(!is_login_url("file:///etc/passwd#https://claude.com/oauth/authorize?"));
    }

    #[test]
    fn timeouts_are_bounded() {
        assert!(timeout_for("task.start").as_secs() <= 120);
        assert!(timeout_for("auth.subscriptionLogin").as_secs() <= 660);
        assert_eq!(timeout_for("project.listDir").as_secs(), 30);
    }
}

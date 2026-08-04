use std::io::{Read, Write};
use std::net::TcpStream;
use std::process::{Command, Stdio};
use std::time::Duration;

pub const LAUNCHD_LABEL: &str = "com.9sako6.zundamonotify";

unsafe extern "C" {
    fn getuid() -> u32;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LaunchAgentStatus {
    Running,
    NotRunning,
    ServerUnreachable,
}

impl LaunchAgentStatus {
    pub fn lines(self) -> Vec<String> {
        let reachable = self == Self::Running;
        let mut lines = vec![
            if reachable {
                "zundamonotify は自動起動に登録されていて、動いているのだ".to_owned()
            } else {
                "zundamonotify は動いていないのだ".to_owned()
            },
            format!("LaunchAgent: {LAUNCHD_LABEL}"),
            format!(
                "通知サーバー: {}",
                if reachable {
                    "接続できるのだ"
                } else {
                    "接続できないのだ"
                }
            ),
        ];
        match self {
            Self::Running => {}
            Self::NotRunning => lines.push(
                "⚠ launchd の job が起動していないのだ。nix-darwin の設定を確認してほしいのだ"
                    .to_owned(),
            ),
            Self::ServerUnreachable => lines.push(
                "⚠ 通知サーバーに接続できないのだ。起動直後か、再起動ループしている可能性があるのだ"
                    .to_owned(),
            ),
        }
        lines
    }
}

pub fn inspect_launch_agent() -> LaunchAgentStatus {
    let uid = unsafe { getuid() };
    let target = format!("gui/{uid}/{LAUNCHD_LABEL}");
    let running = Command::new("launchctl")
        .args(["print", &target])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success());
    if !running {
        return LaunchAgentStatus::NotRunning;
    }
    if probe_notification_server(12378) {
        LaunchAgentStatus::Running
    } else {
        LaunchAgentStatus::ServerUnreachable
    }
}

fn probe_notification_server(port: u16) -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}")
            .parse()
            .expect("valid socket address"),
        Duration::from_secs(10),
    ) else {
        return false;
    };
    if stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = [0_u8; 64];
    stream.read(&mut response).is_ok_and(|size| {
        response[..size].starts_with(b"HTTP/1.1 200")
            || response[..size].starts_with(b"HTTP/1.0 200")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_each_status_without_invalid_combinations() {
        let running = LaunchAgentStatus::Running.lines();
        assert!(running[0].contains("動いているのだ"));
        assert!(running[2].contains("接続できるのだ"));

        let stopped = LaunchAgentStatus::NotRunning.lines();
        assert!(stopped[3].contains("nix-darwin"));

        let unreachable = LaunchAgentStatus::ServerUnreachable.lines();
        assert!(unreachable[3].contains("再起動ループ"));
    }
}

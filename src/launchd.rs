use std::io::{BufRead, BufReader, Write};
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
        match self {
            Self::Running => vec![
                "zundamonotify は動いているのだ".to_owned(),
                format!("LaunchAgent：起動中（{LAUNCHD_LABEL}）"),
                "通知サーバー：接続できたのだ".to_owned(),
            ],
            Self::NotRunning => vec![
                "zundamonotify は動いていないのだ".to_owned(),
                format!("LaunchAgent：見つからないのだ（{LAUNCHD_LABEL}）"),
                "通知サーバー：接続できないのだ".to_owned(),
                "nix-darwin の services.zundamonotify.enable を確認してほしいのだ".to_owned(),
            ],
            Self::ServerUnreachable => vec![
                "zundamonotify は起動しているけど、通知を受け取れないのだ".to_owned(),
                format!("LaunchAgent：起動中（{LAUNCHD_LABEL}）"),
                "通知サーバー：返事がないのだ".to_owned(),
                "少し待ってから、もう一度 status を実行してほしいのだ".to_owned(),
            ],
        }
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
    let timeout = Duration::from_secs(10);
    let Ok(mut stream) = TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}")
            .parse()
            .expect("valid socket address"),
        timeout,
    ) else {
        return false;
    };
    if stream.set_read_timeout(Some(timeout)).is_err()
        || stream.set_write_timeout(Some(timeout)).is_err()
    {
        return false;
    }
    if stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut status_line = String::new();
    if BufReader::new(stream).read_line(&mut status_line).is_err() {
        return false;
    }
    let mut parts = status_line.split_whitespace();
    matches!(
        (parts.next(), parts.next()),
        (Some("HTTP/1.1" | "HTTP/1.0"), Some("200"))
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn formats_each_status_without_invalid_combinations() {
        let running = LaunchAgentStatus::Running.lines();
        assert!(running[0].contains("動いているのだ"));
        assert!(running[2].contains("接続できたのだ"));

        let stopped = LaunchAgentStatus::NotRunning.lines();
        assert!(stopped[1].contains("見つからないのだ"));
        assert!(stopped[3].contains("services.zundamonotify.enable"));

        let unreachable = LaunchAgentStatus::ServerUnreachable.lines();
        assert!(unreachable[0].contains("通知を受け取れないのだ"));
        assert!(unreachable[2].contains("返事がないのだ"));
    }

    #[test]
    fn health_probe_accepts_a_fragmented_status_line() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 128];
            let size = stream.read(&mut request).unwrap();
            assert!(request[..size].starts_with(b"GET /health HTTP/1.1"));
            stream.write_all(b"HTTP/1.1 ").unwrap();
            stream.flush().unwrap();
            thread::sleep(Duration::from_millis(20));
            stream
                .write_all(b"200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .unwrap();
        });

        assert!(probe_notification_server(port));
        server.join().unwrap();
    }
}

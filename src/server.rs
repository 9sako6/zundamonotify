use crate::NotificationEvent;
pub use crate::NotificationHandler;
use serde_json::Value;
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const RES_OK: &str = "{\"ok\":true}";
const RES_NOT_FOUND: &str = "{\"error\":\"Not Found\"}";
const RES_BAD_REQUEST: &str = "{\"error\":\"Bad Request\"}";
const RES_UNAUTHORIZED: &str = "{\"error\":\"Unauthorized\"}";
const RES_FORBIDDEN: &str = "{\"error\":\"Forbidden\"}";
const RES_PAYLOAD_TOO_LARGE: &str = "{\"error\":\"Payload Too Large\"}";
const MAX_BODY_BYTES: usize = 1024;
const MAX_HEADER_BYTES: usize = 16 * 1024;
const TOKEN_BYTES: usize = 32;
const CONNECTION_WORKERS: usize = 4;
const PENDING_CONNECTIONS: usize = 16;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const ACCEPT_RETRY_DELAY: Duration = Duration::from_millis(100);

pub struct Server {
    listener: TcpListener,
    notify: NotificationHandler,
    token: Arc<str>,
    token_path: PathBuf,
}

impl Server {
    pub fn bind(port: u16, notify: NotificationHandler) -> std::io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", port))?;
        let token_path = token_path()?;
        let token = install_token(&token_path)?;
        Ok(Self {
            listener,
            notify,
            token: token.into(),
            token_path,
        })
    }

    pub fn port(&self) -> std::io::Result<u16> {
        Ok(self.listener.local_addr()?.port())
    }

    pub fn token_path(&self) -> &Path {
        &self.token_path
    }

    pub fn run(self) -> std::io::Result<()> {
        let (sender, receiver) = mpsc::sync_channel(PENDING_CONNECTIONS);
        let receiver = Arc::new(Mutex::new(receiver));
        for index in 0..CONNECTION_WORKERS {
            let notify = Arc::clone(&self.notify);
            let token = Arc::clone(&self.token);
            let receiver = Arc::clone(&receiver);
            thread::Builder::new()
                .name(format!("zundamonotify-http-{index}"))
                .spawn(move || connection_worker(receiver, notify, token))?;
        }

        loop {
            match self.listener.accept() {
                Ok((stream, _)) => match sender.try_send(stream) {
                    Ok(()) | Err(TrySendError::Full(_)) => {}
                    Err(TrySendError::Disconnected(_)) => {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::BrokenPipe,
                            "all connection workers stopped",
                        ));
                    }
                },
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => thread::sleep(ACCEPT_RETRY_DELAY),
            }
        }
    }
}

fn connection_worker(
    receiver: Arc<Mutex<Receiver<TcpStream>>>,
    notify: NotificationHandler,
    token: Arc<str>,
) {
    loop {
        let stream = match receiver.lock() {
            Ok(receiver) => receiver.recv(),
            Err(_) => return,
        };
        match stream {
            Ok(stream) => {
                let _ = handle_connection(stream, &notify, &token);
            }
            Err(_) => return,
        }
    }
}

#[derive(Default)]
struct RequestHeaders {
    authorization: Option<String>,
    content_type: Option<String>,
    origin: Option<String>,
}

struct Response {
    status: u16,
    reason: &'static str,
    body: &'static str,
    notification: Option<NotificationEvent>,
}

fn route(
    method: &str,
    path: &str,
    body: &[u8],
    headers: &RequestHeaders,
    token: &str,
    port: u16,
) -> Response {
    if method == "GET" && path == "/health" {
        return response(200, "OK", RES_OK, None);
    }

    if method == "POST" {
        let event = match path {
            "/notifications/stop" => Some(NotificationEvent::Stop),
            "/notifications/notification" => Some(NotificationEvent::Notification),
            _ => None,
        };
        if event.is_none() && path != "/agent-events" {
            return response(404, "Not Found", RES_NOT_FOUND, None);
        }
        if !headers
            .authorization
            .as_deref()
            .is_some_and(|header| bearer_matches(header, token))
        {
            return response(401, "Unauthorized", RES_UNAUTHORIZED, None);
        }
        if headers.origin.as_deref().is_some_and(|origin| {
            origin != format!("http://127.0.0.1:{port}")
                && origin != format!("http://localhost:{port}")
        }) {
            return response(403, "Forbidden", RES_FORBIDDEN, None);
        }
        if !headers
            .content_type
            .as_deref()
            .and_then(|value| value.split(';').next())
            .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"))
        {
            return response(400, "Bad Request", RES_BAD_REQUEST, None);
        }
        if event.is_some() {
            return response(200, "OK", RES_OK, event);
        }

        if path == "/agent-events" {
            let event = serde_json::from_slice::<Value>(body)
                .ok()
                .and_then(|value| value.get("type").and_then(Value::as_str).map(str::to_owned))
                .and_then(|event_type| match event_type.as_str() {
                    "agent_turn.completed" => Some(NotificationEvent::Stop),
                    "alert.requested" => Some(NotificationEvent::Notification),
                    _ => None,
                });
            return match event {
                Some(event) => response(200, "OK", RES_OK, Some(event)),
                None => response(400, "Bad Request", RES_BAD_REQUEST, None),
            };
        }
    }

    response(404, "Not Found", RES_NOT_FOUND, None)
}

fn bearer_matches(header: &str, token: &str) -> bool {
    let expected = format!("Bearer {token}");
    header.len() == expected.len()
        && header
            .bytes()
            .zip(expected.bytes())
            .fold(0_u8, |difference, (actual, expected)| {
                difference | (actual ^ expected)
            })
            == 0
}

fn token_path() -> std::io::Result<PathBuf> {
    let home = env::var_os("HOME").ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "HOME is required to store the server token",
        )
    })?;
    Ok(PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("zundamonotify")
        .join("server-token"))
}

fn install_token(path: &Path) -> std::io::Result<String> {
    let mut random = File::open("/dev/urandom")?;
    let mut bytes = [0_u8; TOKEN_BYTES];
    random.read_exact(&mut bytes)?;
    let token = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();

    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid token path")
    })?;
    fs::create_dir_all(parent)?;
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(path)?;
    file.set_permissions(fs::Permissions::from_mode(0o600))?;
    file.write_all(token.as_bytes())?;
    file.sync_all()?;
    Ok(token)
}

fn response(
    status: u16,
    reason: &'static str,
    body: &'static str,
    notification: Option<NotificationEvent>,
) -> Response {
    Response {
        status,
        reason,
        body,
        notification,
    }
}

fn handle_connection(
    mut stream: TcpStream,
    notify: &NotificationHandler,
    token: &str,
) -> std::io::Result<()> {
    handle_connection_with_timeout(&mut stream, notify, token, REQUEST_TIMEOUT)
}

fn handle_connection_with_timeout(
    stream: &mut TcpStream,
    notify: &NotificationHandler,
    token: &str,
    timeout: Duration,
) -> std::io::Result<()> {
    let port = stream.local_addr()?.port();
    let deadline = Instant::now() + timeout;
    stream.set_write_timeout(Some(timeout))?;
    let mut request = Vec::new();
    let header_end = loop {
        if request.len() > MAX_HEADER_BYTES {
            return write_response(stream, response(400, "Bad Request", RES_BAD_REQUEST, None));
        }
        let mut buffer = [0_u8; 2048];
        let read = read_before(stream, &mut buffer, deadline)?;
        if read == 0 {
            return Ok(());
        }
        request.extend_from_slice(&buffer[..read]);
        if let Some(index) = request.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
    };

    let headers = String::from_utf8_lossy(&request[..header_end]);
    let mut lines = headers.split("\r\n");
    let Some(request_line) = lines.next() else {
        return write_response(stream, response(400, "Bad Request", RES_BAD_REQUEST, None));
    };
    let mut parts = request_line.split_whitespace();
    let (Some(method), Some(path), Some(_version)) = (parts.next(), parts.next(), parts.next())
    else {
        return write_response(stream, response(400, "Bad Request", RES_BAD_REQUEST, None));
    };
    let method = method.to_owned();
    let path = path.to_owned();
    let mut content_length = 0;
    let mut request_headers = RequestHeaders::default();
    for (name, value) in lines.filter_map(|line| line.split_once(':')) {
        let value = value.trim();
        if name.eq_ignore_ascii_case("content-length") {
            content_length = value.parse::<usize>().unwrap_or(0);
        } else if name.eq_ignore_ascii_case("authorization") {
            request_headers.authorization = Some(value.to_owned());
        } else if name.eq_ignore_ascii_case("content-type") {
            request_headers.content_type = Some(value.to_owned());
        } else if name.eq_ignore_ascii_case("origin") {
            request_headers.origin = Some(value.to_owned());
        }
    }
    if content_length > MAX_BODY_BYTES {
        return write_response(
            stream,
            response(413, "Payload Too Large", RES_PAYLOAD_TOO_LARGE, None),
        );
    }

    while request.len() < header_end + content_length {
        let mut buffer = [0_u8; 1024];
        let read = read_before(stream, &mut buffer, deadline)?;
        if read == 0 {
            break;
        }
        request.extend_from_slice(&buffer[..read]);
    }
    let available = request.len().saturating_sub(header_end).min(content_length);
    let result = route(
        &method,
        &path,
        &request[header_end..header_end + available],
        &request_headers,
        token,
        port,
    );
    let notification = result.notification;
    write_response(stream, result)?;
    if let Some(event) = notification {
        notify(event);
    }
    Ok(())
}

fn read_before(
    stream: &mut TcpStream,
    buffer: &mut [u8],
    deadline: Instant,
) -> std::io::Result<usize> {
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::TimedOut, "request deadline exceeded")
        })?;
    stream.set_read_timeout(Some(remaining))?;
    stream.read(buffer)
}

fn write_response(stream: &mut TcpStream, response: Response) -> std::io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        response.status,
        response.reason,
        response.body.len(),
        response.body
    )?;
    stream.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Shutdown, TcpStream};
    use std::sync::Mutex;

    const TOKEN: &str = "test-token";

    fn authorized_headers() -> RequestHeaders {
        RequestHeaders {
            authorization: Some(format!("Bearer {TOKEN}")),
            content_type: Some("application/json".to_owned()),
            origin: None,
        }
    }

    fn test_route(method: &str, path: &str, body: &[u8]) -> Response {
        route(method, path, body, &authorized_headers(), TOKEN, 12378)
    }

    fn round_trip(request: &[u8]) -> (String, Vec<NotificationEvent>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let notifications = Arc::new(Mutex::new(Vec::new()));
        let target = Arc::clone(&notifications);
        let handler: NotificationHandler = Arc::new(move |event| {
            target.lock().unwrap().push(event);
        });
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            handle_connection(stream, &handler, TOKEN).unwrap();
        });

        let mut stream = TcpStream::connect(address).unwrap();
        stream.write_all(request).unwrap();
        stream.shutdown(Shutdown::Write).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        server.join().unwrap();
        let events = notifications.lock().unwrap().clone();
        (response, events)
    }

    #[test]
    fn request_deadline_is_not_renewed_by_trickled_bytes() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let handler: NotificationHandler = Arc::new(|_| {});
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            handle_connection_with_timeout(&mut stream, &handler, TOKEN, Duration::from_millis(50))
        });

        let mut stream = TcpStream::connect(address).unwrap();
        for _ in 0..5 {
            if stream.write_all(b"G").is_err() {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        let error = server.join().unwrap().unwrap_err();
        assert!(matches!(
            error.kind(),
            std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
        ));
    }

    #[test]
    fn routes_health_and_notifications() {
        let health = route(
            "GET",
            "/health",
            b"",
            &RequestHeaders::default(),
            TOKEN,
            12378,
        );
        assert_eq!(health.status, 200);
        assert_eq!(health.body, RES_OK);
        assert_eq!(health.notification, None);

        for (path, expected) in [
            ("/notifications/stop", NotificationEvent::Stop),
            (
                "/notifications/notification",
                NotificationEvent::Notification,
            ),
        ] {
            let result = test_route("POST", path, b"");
            assert_eq!(result.status, 200);
            assert_eq!(result.notification, Some(expected));
        }
    }

    #[test]
    fn maps_agent_events_and_rejects_unknown_json() {
        let completed = test_route(
            "POST",
            "/agent-events",
            br#"{"type":"agent_turn.completed"}"#,
        );
        assert_eq!(completed.status, 200);
        assert_eq!(completed.notification, Some(NotificationEvent::Stop));

        let alert = test_route("POST", "/agent-events", br#"{"type":"alert.requested"}"#);
        assert_eq!(alert.status, 200);
        assert_eq!(alert.notification, Some(NotificationEvent::Notification));

        for body in [br#"{"type":"unknown"}"#.as_slice(), b"not-json"] {
            let result = test_route("POST", "/agent-events", body);
            assert_eq!(result.status, 400);
            assert_eq!(result.notification, None);
        }
    }

    #[test]
    fn rejects_unknown_routes() {
        for (method, path) in [
            ("POST", "/notifications"),
            ("GET", "/notifications/stop"),
            ("POST", "/notifications/unknown"),
            ("GET", "/"),
        ] {
            assert_eq!(test_route(method, path, b"").status, 404);
        }
    }

    #[test]
    fn rejects_unauthorized_notification_requests() {
        for authorization in [None, Some("Bearer wrong-token".to_owned())] {
            let headers = RequestHeaders {
                authorization,
                content_type: Some("application/json".to_owned()),
                origin: None,
            };
            let result = route("POST", "/notifications/stop", b"", &headers, TOKEN, 12378);
            assert_eq!(result.status, 401);
            assert_eq!(result.notification, None);
        }
    }

    #[test]
    fn rejects_untrusted_origins_and_content_types() {
        let mut headers = authorized_headers();
        headers.origin = Some("https://example.com".to_owned());
        let untrusted_origin = route("POST", "/notifications/stop", b"", &headers, TOKEN, 12378);
        assert_eq!(untrusted_origin.status, 403);
        assert_eq!(untrusted_origin.notification, None);

        headers.origin = None;
        headers.content_type = Some("text/plain".to_owned());
        let unexpected_content_type =
            route("POST", "/notifications/stop", b"", &headers, TOKEN, 12378);
        assert_eq!(unexpected_content_type.status, 400);
        assert_eq!(unexpected_content_type.notification, None);
    }

    #[test]
    fn serves_http_and_notifies_after_a_valid_request() {
        let (response, notifications) = round_trip(
            b"POST /agent-events HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer test-token\r\nContent-Type: application/json\r\nContent-Length: 31\r\n\r\n{\"type\":\"agent_turn.completed\"}",
        );
        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert!(response.ends_with(RES_OK));
        assert_eq!(notifications, vec![NotificationEvent::Stop]);
    }

    #[test]
    fn rejects_oversized_http_bodies_without_notifying() {
        let (response, notifications) = round_trip(
            b"POST /notifications/stop HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2048\r\n\r\n",
        );
        assert!(response.starts_with("HTTP/1.1 413 Payload Too Large"));
        assert!(response.ends_with(RES_PAYLOAD_TOO_LARGE));
        assert!(notifications.is_empty());
    }
}

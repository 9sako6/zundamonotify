use crate::NotificationEvent;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const STOP_NOTIFICATION_DEDUP: Duration = Duration::from_millis(5000);
const STOP_SOUND: &[u8] = include_bytes!("../assets/stop/みてほしいのだ.wav");
const NOTIFICATION_SOUND: &[u8] = include_bytes!("../assets/notification/たすけてほしいのだ.wav");

pub struct AssetFiles {
    dir: PathBuf,
    stop: PathBuf,
    notification: PathBuf,
}

impl AssetFiles {
    pub fn install() -> std::io::Result<Self> {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "zundamonotify-assets-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir(&dir)?;
        let stop = dir.join("stop.wav");
        let notification = dir.join("notification.wav");
        let installed = (|| {
            fs::write(&stop, STOP_SOUND)?;
            fs::write(&notification, NOTIFICATION_SOUND)?;
            Ok(Self {
                dir: dir.clone(),
                stop,
                notification,
            })
        })();
        if installed.is_err() {
            let _ = fs::remove_dir_all(dir);
        }
        installed
    }

    fn path(&self, event: NotificationEvent) -> &Path {
        match event {
            NotificationEvent::Stop => &self.stop,
            NotificationEvent::Notification => &self.notification,
        }
    }
}

impl Drop for AssetFiles {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

#[derive(Default)]
struct PlaybackState {
    last_stop_at: Option<Duration>,
    playing: bool,
}

impl PlaybackState {
    fn begin(&mut self, event: NotificationEvent, now: Duration) -> bool {
        if event == NotificationEvent::Stop {
            if self
                .last_stop_at
                .is_some_and(|last| now.saturating_sub(last) < STOP_NOTIFICATION_DEDUP)
            {
                return false;
            }
            self.last_stop_at = Some(now);
        }
        if self.playing {
            return false;
        }
        self.playing = true;
        true
    }

    fn finish(&mut self) {
        self.playing = false;
    }
}

#[derive(Clone)]
pub struct Notifier {
    assets: Arc<AssetFiles>,
    state: Arc<Mutex<PlaybackState>>,
}

impl Notifier {
    pub fn new(assets: AssetFiles) -> Self {
        Self {
            assets: Arc::new(assets),
            state: Arc::new(Mutex::new(PlaybackState::default())),
        }
    }

    pub fn notify(&self, event: NotificationEvent) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();
        if !self
            .state
            .lock()
            .expect("playback state lock")
            .begin(event, now)
        {
            return;
        }

        let path = self.assets.path(event).to_owned();
        let mut child = match Command::new("afplay").arg(path).spawn() {
            Ok(child) => child,
            Err(error) => {
                self.state.lock().expect("playback state lock").finish();
                eprintln!("⚠ 再生に失敗したのだ！ずんだもんの声が出せないのだ！: {error}");
                return;
            }
        };
        let state = Arc::clone(&self.state);
        thread::spawn(move || {
            let result = child.wait();
            state.lock().expect("playback state lock").finish();
            match result {
                Ok(status) if status.success() => {}
                Ok(status) => eprintln!(
                    "⚠ 再生に失敗したのだ！ずんだもんの声が出せないのだ！: afplay exited with {status}"
                ),
                Err(error) => {
                    eprintln!("⚠ 再生に失敗したのだ！ずんだもんの声が出せないのだ！: {error}")
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stop_notifications_are_deduplicated() {
        let mut state = PlaybackState::default();
        assert!(state.begin(NotificationEvent::Stop, Duration::from_secs(1)));
        state.finish();
        assert!(!state.begin(NotificationEvent::Stop, Duration::from_secs(2)));
        assert!(state.begin(NotificationEvent::Stop, Duration::from_secs(6)));
    }

    #[test]
    fn notifications_do_not_overlap() {
        let mut state = PlaybackState::default();
        assert!(state.begin(NotificationEvent::Notification, Duration::ZERO));
        assert!(!state.begin(NotificationEvent::Notification, Duration::from_secs(1)));
        state.finish();
        assert!(state.begin(NotificationEvent::Notification, Duration::from_secs(2)));
    }

    #[test]
    fn embedded_assets_are_materialized_and_removed() {
        let assets = AssetFiles::install().unwrap();
        let dir = assets.dir.clone();
        assert_eq!(
            fs::read(assets.path(NotificationEvent::Stop)).unwrap(),
            STOP_SOUND
        );
        assert_eq!(
            fs::read(assets.path(NotificationEvent::Notification)).unwrap(),
            NOTIFICATION_SOUND
        );
        drop(assets);
        assert!(!dir.exists());
    }
}

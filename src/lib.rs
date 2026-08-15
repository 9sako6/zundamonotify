pub mod launchd;
pub mod monitor;
pub mod notifier;
pub mod server;

use std::sync::Arc;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NotificationEvent {
    Stop,
    Notification,
}

pub type NotificationHandler = Arc<dyn Fn(NotificationEvent) + Send + Sync>;

impl NotificationEvent {
    pub fn name(self) -> &'static str {
        match self {
            Self::Stop => "stop",
            Self::Notification => "notification",
        }
    }
}

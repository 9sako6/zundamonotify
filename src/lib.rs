pub mod launchd;
pub mod monitor;
pub mod notifier;
pub mod server;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NotificationEvent {
    Stop,
    Notification,
}

impl NotificationEvent {
    pub fn name(self) -> &'static str {
        match self {
            Self::Stop => "stop",
            Self::Notification => "notification",
        }
    }
}

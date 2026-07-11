#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "macos")]
pub use macos::SystemUiHandles;

#[cfg(target_os = "macos")]
pub fn configure_event_loop(
    event_loop: &mut tao::event_loop::EventLoop<crate::watcher::UserEvent>,
    resident: bool,
) {
    macos::configure_event_loop(event_loop, resident);
}

#[cfg(not(target_os = "macos"))]
pub struct SystemUiHandles;

#[cfg(not(target_os = "macos"))]
pub fn configure_event_loop(
    _event_loop: &mut tao::event_loop::EventLoop<crate::watcher::UserEvent>,
    _resident: bool,
) {
}

#[cfg(target_os = "macos")]
pub fn install_system_ui(
    proxy: tao::event_loop::EventLoopProxy<crate::watcher::UserEvent>,
) -> Option<SystemUiHandles> {
    macos::install_system_ui(proxy)
}

#[cfg(not(target_os = "macos"))]
pub fn install_system_ui(
    _proxy: tao::event_loop::EventLoopProxy<crate::watcher::UserEvent>,
) -> Option<SystemUiHandles> {
    None
}

#[cfg(target_os = "macos")]
pub fn activate_app() {
    macos::activate_app();
}

#[cfg(target_os = "macos")]
pub fn enter_resident_mode() {
    macos::enter_resident_mode();
}

#[cfg(target_os = "macos")]
pub fn review_notification_sink(
    proxy: tao::event_loop::EventLoopProxy<crate::watcher::UserEvent>,
) -> std::sync::Arc<dyn crate::review::notifications::ReviewNotificationSink> {
    std::sync::Arc::new(macos::MacReviewNotificationSink::new(proxy))
}

#[cfg(not(target_os = "macos"))]
pub fn review_notification_sink(
    _proxy: tao::event_loop::EventLoopProxy<crate::watcher::UserEvent>,
) -> std::sync::Arc<dyn crate::review::notifications::ReviewNotificationSink> {
    std::sync::Arc::new(crate::review::notifications::NoopNotificationSink)
}

#[cfg(target_os = "macos")]
pub fn post_review_notification(notification: &crate::review::notifications::ReviewNotification) {
    macos::post_review_notification(notification);
}

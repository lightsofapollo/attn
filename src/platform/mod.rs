#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "macos")]
pub use macos::SystemUiHandles;

#[cfg(target_os = "macos")]
pub fn configure_event_loop(
    event_loop: &mut tao::event_loop::EventLoop<crate::watcher::UserEvent>,
) {
    macos::configure_event_loop(event_loop);
}

#[cfg(not(target_os = "macos"))]
pub struct SystemUiHandles;

#[cfg(not(target_os = "macos"))]
pub fn configure_event_loop(
    _event_loop: &mut tao::event_loop::EventLoop<crate::watcher::UserEvent>,
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

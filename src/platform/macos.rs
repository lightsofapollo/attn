use crate::watcher::UserEvent;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, ProtocolObject};
use objc2::{AnyThread, ClassType, MainThreadMarker, MainThreadOnly, define_class, msg_send, sel};
use objc2_app_kit::{NSApplication, NSImage, NSMenu, NSMenuItem};
use objc2_foundation::{NSBundle, NSData, NSObject, NSObjectProtocol, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};
use std::sync::{Mutex, OnceLock};
use tao::event_loop::{EventLoop, EventLoopProxy};

pub struct SystemUiHandles {
    _main_menu: Retained<NSMenu>,
    _app_menu: Retained<NSMenu>,
    _edit_menu: Retained<NSMenu>,
    _menu_target: Retained<MenuActionTarget>,
    _notification_delegate: Retained<NotificationActionTarget>,
}

pub struct MacReviewNotificationSink {
    proxy: EventLoopProxy<UserEvent>,
}

impl MacReviewNotificationSink {
    pub fn new(proxy: EventLoopProxy<UserEvent>) -> Self {
        Self { proxy }
    }
}

impl crate::review::notifications::ReviewNotificationSink for MacReviewNotificationSink {
    fn post(&self, notification: crate::review::notifications::ReviewNotification) {
        let _ = self
            .proxy
            .send_event(UserEvent::PostReviewNotification(notification));
    }
}

static MENU_PROXY: OnceLock<Mutex<Option<EventLoopProxy<UserEvent>>>> = OnceLock::new();

fn set_menu_proxy(proxy: EventLoopProxy<UserEvent>) {
    let slot = MENU_PROXY.get_or_init(|| Mutex::new(None));
    if let Ok(mut guard) = slot.lock() {
        *guard = Some(proxy);
    }
}

fn send_user_event(event: UserEvent) {
    let Some(slot) = MENU_PROXY.get() else {
        return;
    };
    let Ok(guard) = slot.lock() else {
        return;
    };
    if let Some(proxy) = guard.as_ref() {
        let _ = proxy.send_event(event);
    }
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    struct MenuActionTarget;

    impl MenuActionTarget {
        #[unsafe(method(openWindow:))]
        fn open_window(&self, _sender: Option<&AnyObject>) {
            send_user_event(UserEvent::ShowWindow);
        }

        #[unsafe(method(hideWindow:))]
        fn hide_window(&self, _sender: Option<&AnyObject>) {
            send_user_event(UserEvent::HideWindow);
        }

        #[unsafe(method(increaseFontScale:))]
        fn increase_font_scale(&self, _sender: Option<&AnyObject>) {
            send_user_event(UserEvent::FontScaleIncrease);
        }

        #[unsafe(method(decreaseFontScale:))]
        fn decrease_font_scale(&self, _sender: Option<&AnyObject>) {
            send_user_event(UserEvent::FontScaleDecrease);
        }

        #[unsafe(method(resetFontScale:))]
        fn reset_font_scale(&self, _sender: Option<&AnyObject>) {
            send_user_event(UserEvent::FontScaleReset);
        }

        #[unsafe(method(installCliAlias:))]
        fn install_cli_alias(&self, _sender: Option<&AnyObject>) {
            send_user_event(UserEvent::InstallCliAlias);
        }

        #[unsafe(method(quitApp:))]
        fn quit_app(&self, _sender: Option<&AnyObject>) {
            send_user_event(UserEvent::Quit);
        }
    }

    unsafe impl NSObjectProtocol for MenuActionTarget {}
);

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    struct NotificationActionTarget;

    impl NotificationActionTarget {
        #[unsafe(method(userNotificationCenter:shouldPresentNotification:))]
        fn should_present_notification(
            &self,
            _center: &AnyObject,
            _notification: &AnyObject,
        ) -> bool {
            true
        }

        #[unsafe(method(userNotificationCenter:didActivateNotification:))]
        fn did_activate_notification(&self, _center: &AnyObject, notification: &AnyObject) {
            let identifier: Option<Retained<NSString>> = unsafe { msg_send![notification, identifier] };
            if let Some(identifier) = identifier {
                let room_id = identifier.to_string();
                send_user_event(UserEvent::OpenReviewDeepLink(format!(
                    "attn://review/{room_id}"
                )));
            }
        }
    }

    unsafe impl NSObjectProtocol for NotificationActionTarget {}

    unsafe impl UNUserNotificationCenterDelegate for NotificationActionTarget {
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        unsafe fn will_present_modern_notification(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion_handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            completion_handler.call((
                UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List,
            ));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        unsafe fn did_receive_modern_response(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion_handler: &block2::DynBlock<dyn Fn()>,
        ) {
            let identifier = unsafe {
                response
                    .notification()
                    .request()
                    .identifier()
                    .to_string()
            };
            send_user_event(UserEvent::OpenReviewDeepLink(format!(
                "attn://review/{identifier}"
            )));
            completion_handler.call(());
        }
    }
);

pub fn configure_event_loop(event_loop: &mut EventLoop<UserEvent>, resident: bool) {
    use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};

    event_loop.set_activation_policy(if resident {
        ActivationPolicy::Accessory
    } else {
        ActivationPolicy::Regular
    });
    set_macos_app_icon();
}

pub fn install_system_ui(proxy: EventLoopProxy<UserEvent>) -> Option<SystemUiHandles> {
    set_menu_proxy(proxy);
    let mtm = MainThreadMarker::new()?;
    let app = NSApplication::sharedApplication(mtm);
    let menu_target: Retained<MenuActionTarget> =
        unsafe { msg_send![MenuActionTarget::class(), new] };
    let notification_delegate: Retained<NotificationActionTarget> =
        unsafe { msg_send![NotificationActionTarget::class(), new] };
    install_notification_delegate(&notification_delegate);

    let main_menu = NSMenu::initWithTitle(NSMenu::alloc(mtm), &NSString::from_str("Main"));
    let app_menu = NSMenu::initWithTitle(NSMenu::alloc(mtm), &NSString::from_str("attn"));
    let edit_menu = NSMenu::initWithTitle(NSMenu::alloc(mtm), &NSString::from_str("Edit"));
    let app_item = unsafe {
        NSMenuItem::initWithTitle_action_keyEquivalent(
            NSMenuItem::alloc(mtm),
            &NSString::from_str("attn"),
            None,
            &NSString::from_str(""),
        )
    };
    let edit_item = unsafe {
        NSMenuItem::initWithTitle_action_keyEquivalent(
            NSMenuItem::alloc(mtm),
            &NSString::from_str("Edit"),
            None,
            &NSString::from_str(""),
        )
    };
    main_menu.addItem(&app_item);
    main_menu.setSubmenu_forItem(Some(&app_menu), &app_item);
    main_menu.addItem(&edit_item);
    main_menu.setSubmenu_forItem(Some(&edit_menu), &edit_item);

    app_menu.addItem(&new_action_item(
        mtm,
        "Open attn",
        Some(sel!(openWindow:)),
        "",
        &menu_target,
    ));
    app_menu.addItem(&new_action_item(
        mtm,
        "Hide attn",
        Some(sel!(hideWindow:)),
        "h",
        &menu_target,
    ));
    app_menu.addItem(&new_action_item(
        mtm,
        "Zoom In",
        Some(sel!(increaseFontScale:)),
        "=",
        &menu_target,
    ));
    app_menu.addItem(&new_action_item(
        mtm,
        "Zoom Out",
        Some(sel!(decreaseFontScale:)),
        "-",
        &menu_target,
    ));
    app_menu.addItem(&new_action_item(
        mtm,
        "Actual Size",
        Some(sel!(resetFontScale:)),
        "0",
        &menu_target,
    ));
    if !crate::cli_alias::has_attn_on_path() {
        app_menu.addItem(&NSMenuItem::separatorItem(mtm));
        app_menu.addItem(&new_action_item(
            mtm,
            "Install attn CLI Alias",
            Some(sel!(installCliAlias:)),
            "",
            &menu_target,
        ));
    }
    app_menu.addItem(&NSMenuItem::separatorItem(mtm));
    app_menu.addItem(&new_action_item(
        mtm,
        "Quit attn",
        Some(sel!(quitApp:)),
        "q",
        &menu_target,
    ));

    // Native first-responder edit actions for WebView text surfaces.
    edit_menu.addItem(&new_first_responder_item(
        mtm,
        "Undo",
        Some(sel!(undo:)),
        "z",
    ));
    edit_menu.addItem(&new_first_responder_item(
        mtm,
        "Redo",
        Some(sel!(redo:)),
        "Z",
    ));
    edit_menu.addItem(&NSMenuItem::separatorItem(mtm));
    edit_menu.addItem(&new_first_responder_item(mtm, "Cut", Some(sel!(cut:)), "x"));
    edit_menu.addItem(&new_first_responder_item(
        mtm,
        "Copy",
        Some(sel!(copy:)),
        "c",
    ));
    edit_menu.addItem(&new_first_responder_item(
        mtm,
        "Paste",
        Some(sel!(paste:)),
        "v",
    ));
    edit_menu.addItem(&new_first_responder_item(
        mtm,
        "Select All",
        Some(sel!(selectAll:)),
        "a",
    ));

    app.setMainMenu(Some(&main_menu));

    Some(SystemUiHandles {
        _main_menu: main_menu,
        _app_menu: app_menu,
        _edit_menu: edit_menu,
        _menu_target: menu_target,
        _notification_delegate: notification_delegate,
    })
}

fn install_notification_delegate(delegate: &NotificationActionTarget) {
    if modern_notification_center_available() {
        let modern = unsafe { UNUserNotificationCenter::currentNotificationCenter() };
        unsafe {
            modern.setDelegate(Some(ProtocolObject::from_ref(delegate)));
        }
        return;
    }

    // Keep the deprecated center only as a compatibility fallback for old
    // systems. It is legitimately nil on current macOS releases.
    let Some(center_class) = AnyClass::get(c"NSUserNotificationCenter") else {
        return;
    };
    let center: Option<Retained<AnyObject>> =
        unsafe { msg_send![center_class, defaultUserNotificationCenter] };
    let Some(center) = center else {
        tracing::warn!("NSUserNotificationCenter is unavailable");
        return;
    };
    unsafe {
        let _: () = msg_send![&*center, setDelegate: Some(delegate)];
    }
}

pub fn post_review_notification(notification: &crate::review::notifications::ReviewNotification) {
    let modern_available = modern_notification_center_available();
    let legacy_available = AnyClass::get(c"NSUserNotificationCenter").is_some()
        && AnyClass::get(c"NSUserNotification").is_some();
    match select_notification_backend(modern_available, legacy_available) {
        NotificationBackend::Modern => post_modern_review_notification(notification.clone()),
        NotificationBackend::Legacy => {
            if post_legacy_review_notification(notification) {
                #[cfg(debug_assertions)]
                append_notification_test_log(notification);
            } else {
                record_raw_binary_test_notification(notification);
            }
        }
        NotificationBackend::Unavailable => {
            tracing::warn!("macOS user notification frameworks are unavailable");
            record_raw_binary_test_notification(notification);
        }
    }
}

/// UserNotifications.framework raises an Objective-C exception (not a Rust
/// error) when invoked from a raw CLI/debug executable with no application
/// bundle proxy. Check the real NSBundle identity before sending any UN
/// message. Production `.app` bundles have both a non-empty identifier and a
/// main bundle whose path ends in `.app`.
fn modern_notification_center_available() -> bool {
    if AnyClass::get(c"UNUserNotificationCenter").is_none() {
        return false;
    }
    let bundle = NSBundle::mainBundle();
    let identifier = bundle.bundleIdentifier().map(|value| value.to_string());
    let path = bundle.bundlePath().to_string();
    valid_notification_bundle(identifier.as_deref(), &path)
}

fn valid_notification_bundle(identifier: Option<&str>, path: &str) -> bool {
    identifier.is_some_and(|value| !value.trim().is_empty())
        && path.trim_end_matches('/').ends_with(".app")
}

/// The raw debug binary cannot post an OS notification because macOS gives it
/// no bundle proxy. Keep the explicit injected JSONL sink usable for E2E after
/// both production backends were attempted, without reporting an OS success.
fn record_raw_binary_test_notification(
    notification: &crate::review::notifications::ReviewNotification,
) {
    #[cfg(debug_assertions)]
    append_notification_test_log(notification);
    #[cfg(not(debug_assertions))]
    let _ = notification;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NotificationBackend {
    Modern,
    Legacy,
    Unavailable,
}

fn select_notification_backend(modern: bool, legacy: bool) -> NotificationBackend {
    if modern {
        NotificationBackend::Modern
    } else if legacy {
        NotificationBackend::Legacy
    } else {
        NotificationBackend::Unavailable
    }
}

fn post_modern_review_notification(notification: crate::review::notifications::ReviewNotification) {
    let center = unsafe { UNUserNotificationCenter::currentNotificationCenter() };
    let completion = block2::RcBlock::new(
        move |granted: objc2::runtime::Bool, error: *mut objc2_foundation::NSError| {
            if !error.is_null() {
                let error = unsafe { &*error };
                tracing::warn!("macOS notification authorization failed: {error}");
            }
            if !granted.as_bool() {
                tracing::info!("macOS notifications are not authorized");
                return;
            }
            enqueue_modern_review_notification(&notification);
        },
    );
    unsafe {
        center.requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert,
            &completion,
        );
    }
}

fn enqueue_modern_review_notification(
    notification: &crate::review::notifications::ReviewNotification,
) {
    let center = unsafe { UNUserNotificationCenter::currentNotificationCenter() };
    let content = unsafe { UNMutableNotificationContent::new() };
    let title = NSString::from_str(&notification.title);
    let body = NSString::from_str(&notification.body);
    let thread = NSString::from_str(notification.room_id.as_str());
    unsafe {
        content.setTitle(&title);
        content.setBody(&body);
        content.setThreadIdentifier(&thread);
    }
    let request = unsafe {
        UNNotificationRequest::requestWithIdentifier_content_trigger(&thread, &content, None)
    };
    let completion = block2::RcBlock::new(move |error: *mut objc2_foundation::NSError| {
        if !error.is_null() {
            let error = unsafe { &*error };
            tracing::warn!("macOS notification scheduling failed: {error}");
        }
    });
    unsafe {
        center.addNotificationRequest_withCompletionHandler(&request, Some(&completion));
    }
    // This seam records a real UserNotifications scheduling attempt, never a
    // pre-attempt or deprecated-center false success.
    #[cfg(debug_assertions)]
    append_notification_test_log(notification);
}

fn post_legacy_review_notification(
    notification: &crate::review::notifications::ReviewNotification,
) -> bool {
    let Some(notification_class) = AnyClass::get(c"NSUserNotification") else {
        tracing::warn!("NSUserNotification is unavailable");
        return false;
    };
    let Some(center_class) = AnyClass::get(c"NSUserNotificationCenter") else {
        return false;
    };
    let native: Retained<AnyObject> = unsafe { msg_send![notification_class, new] };
    let title = NSString::from_str(&notification.title);
    let body = NSString::from_str(&notification.body);
    let identifier = NSString::from_str(notification.room_id.as_str());
    unsafe {
        let _: () = msg_send![&native, setTitle: &*title];
        let _: () = msg_send![&native, setInformativeText: &*body];
        let _: () = msg_send![&native, setIdentifier: &*identifier];
        let center: Option<Retained<AnyObject>> =
            msg_send![center_class, defaultUserNotificationCenter];
        let Some(center) = center else {
            tracing::warn!("NSUserNotificationCenter is unavailable");
            return false;
        };
        let _: () = msg_send![&*center, deliverNotification: &*native];
    }
    true
}

/// Debug-only observation seam written after a production platform attempt.
/// The JSON contains only the already-redacted notification summary.
#[cfg(debug_assertions)]
fn append_notification_test_log(notification: &crate::review::notifications::ReviewNotification) {
    use std::io::Write;

    let Ok(path) = std::env::var("ATTN_NOTIFICATION_TEST_LOG") else {
        return;
    };
    if path.trim().is_empty() {
        return;
    }
    let result = (|| -> std::io::Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;
        serde_json::to_writer(&mut file, notification)?;
        file.write_all(b"\n")?;
        file.flush()
    })();
    if let Err(error) = result {
        tracing::warn!("could not append notification test log: {error}");
    }
}

fn new_action_item(
    mtm: MainThreadMarker,
    title: &str,
    action: Option<objc2::runtime::Sel>,
    key: &str,
    target: &MenuActionTarget,
) -> Retained<NSMenuItem> {
    let item = unsafe {
        NSMenuItem::initWithTitle_action_keyEquivalent(
            NSMenuItem::alloc(mtm),
            &NSString::from_str(title),
            action,
            &NSString::from_str(key),
        )
    };
    unsafe {
        item.setTarget(Some(target.as_ref()));
    }
    item
}

fn new_first_responder_item(
    mtm: MainThreadMarker,
    title: &str,
    action: Option<objc2::runtime::Sel>,
    key: &str,
) -> Retained<NSMenuItem> {
    unsafe {
        NSMenuItem::initWithTitle_action_keyEquivalent(
            NSMenuItem::alloc(mtm),
            &NSString::from_str(title),
            action,
            &NSString::from_str(key),
        )
    }
}

pub fn activate_app() {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(objc2_app_kit::NSApplicationActivationPolicy::Regular);
    app.activate();
}

pub fn enter_resident_mode() {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    NSApplication::sharedApplication(mtm)
        .setActivationPolicy(objc2_app_kit::NSApplicationActivationPolicy::Accessory);
}

fn set_macos_app_icon() {
    static ICON_ICNS_BYTES: &[u8] = include_bytes!("../../icons/attn.icns");
    static ICON_PNG_BYTES: &[u8] = include_bytes!("../../icons/attn.png");

    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };

    let Some(icon_image) =
        icon_image_from_bytes(ICON_ICNS_BYTES).or_else(|| icon_image_from_bytes(ICON_PNG_BYTES))
    else {
        return;
    };

    let app = NSApplication::sharedApplication(mtm);
    unsafe {
        app.setApplicationIconImage(Some(&icon_image));
    }
}

fn icon_image_from_bytes(bytes: &[u8]) -> Option<Retained<NSImage>> {
    let icon_data = NSData::with_bytes(bytes);
    NSImage::initWithData(NSImage::alloc(), &icon_data)
}

#[cfg(test)]
mod notification_tests {
    use super::*;

    #[test]
    fn modern_center_is_always_preferred_and_legacy_is_fallback_only() {
        assert_eq!(
            select_notification_backend(true, true),
            NotificationBackend::Modern
        );
        assert_eq!(
            select_notification_backend(true, false),
            NotificationBackend::Modern
        );
        assert_eq!(
            select_notification_backend(false, true),
            NotificationBackend::Legacy
        );
        assert_eq!(
            select_notification_backend(false, false),
            NotificationBackend::Unavailable
        );
    }

    #[test]
    fn modern_center_requires_real_app_bundle_identity_before_framework_call() {
        assert!(valid_notification_bundle(
            Some("dev.jameslal.attn"),
            "/Applications/attn.app"
        ));
        assert!(valid_notification_bundle(
            Some("dev.jameslal.attn"),
            "/tmp/debug/attn.app/"
        ));
        assert!(!valid_notification_bundle(None, "/workspace/target/debug"));
        assert!(!valid_notification_bundle(
            Some(""),
            "/Applications/attn.app"
        ));
        assert!(!valid_notification_bundle(
            Some("dev.jameslal.attn"),
            "/workspace/target/debug"
        ));
    }

    #[test]
    fn raw_test_binary_rejects_modern_center_without_throwing() {
        let executable = std::env::current_exe().expect("test executable");
        assert!(!executable.to_string_lossy().contains(".app/Contents/"));
        assert!(!modern_notification_center_available());
    }
}

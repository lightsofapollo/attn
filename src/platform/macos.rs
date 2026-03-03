use crate::watcher::UserEvent;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{AnyThread, ClassType, MainThreadMarker, MainThreadOnly, define_class, msg_send, sel};
use objc2_app_kit::{NSApplication, NSImage, NSMenu, NSMenuItem};
use objc2_foundation::{NSData, NSObject, NSObjectProtocol, NSString};
use std::sync::{Mutex, OnceLock};
use tao::event_loop::{EventLoop, EventLoopProxy};

pub struct SystemUiHandles {
    _main_menu: Retained<NSMenu>,
    _app_menu: Retained<NSMenu>,
    _edit_menu: Retained<NSMenu>,
    _menu_target: Retained<MenuActionTarget>,
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

pub fn configure_event_loop(event_loop: &mut EventLoop<UserEvent>) {
    use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};

    event_loop.set_activation_policy(ActivationPolicy::Regular);
    set_macos_app_icon();
}

pub fn install_system_ui(proxy: EventLoopProxy<UserEvent>) -> Option<SystemUiHandles> {
    set_menu_proxy(proxy);
    let mtm = MainThreadMarker::new()?;
    let app = NSApplication::sharedApplication(mtm);
    let menu_target: Retained<MenuActionTarget> =
        unsafe { msg_send![MenuActionTarget::class(), new] };

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
    })
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
    app.activate();
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

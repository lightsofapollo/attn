//! Native WKWebView screenshot via takeSnapshotWithConfiguration.
//! Debug builds only — gated by cfg(debug_assertions) at the call site.

#[cfg(target_os = "macos")]
use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSData, NSDictionary};
#[cfg(target_os = "macos")]
use std::sync::mpsc::Sender;

/// Take a PNG snapshot of the WKWebView and send the file path through `tx`.
#[cfg(target_os = "macos")]
pub fn take_snapshot(wk_webview: &wry::WryWebView, output_path: &str, tx: Sender<String>) {
    use block2::RcBlock;
    use objc2_app_kit::NSImage;
    use objc2_foundation::NSError;

    let path = output_path.to_string();

    let block = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
        if !error.is_null() {
            let err: &NSError = unsafe { &*error };
            eprintln!("attn: snapshot error: {err}");
            let _ = tx.send(String::new());
            return;
        }
        if image.is_null() {
            eprintln!("attn: snapshot returned null image");
            let _ = tx.send(String::new());
            return;
        }

        let image: &NSImage = unsafe { &*image };
        match save_nsimage_as_png(image, &path) {
            Ok(()) => {
                let _ = tx.send(path.clone());
            }
            Err(e) => {
                eprintln!("attn: failed to save screenshot: {e}");
                let _ = tx.send(String::new());
            }
        }
    });

    unsafe {
        wk_webview.takeSnapshotWithConfiguration_completionHandler(None, &block);
    }
}

/// Convert an NSImage to PNG and write to disk.
#[cfg(target_os = "macos")]
fn save_nsimage_as_png(image: &objc2_app_kit::NSImage, path: &str) -> Result<(), String> {
    // Get TIFF representation from NSImage
    let tiff_data: objc2::rc::Retained<NSData> = image
        .TIFFRepresentation()
        .ok_or("failed to get TIFF representation")?;

    // Create NSBitmapImageRep from TIFF data
    let bitmap_rep: objc2::rc::Retained<NSBitmapImageRep> =
        NSBitmapImageRep::imageRepWithData(&tiff_data)
            .ok_or("failed to create bitmap image rep")?;

    // Convert to PNG
    let empty_dict: objc2::rc::Retained<
        NSDictionary<objc2_app_kit::NSBitmapImageRepPropertyKey, objc2::runtime::AnyObject>,
    > = NSDictionary::new();
    let png_data: objc2::rc::Retained<NSData> = unsafe {
        bitmap_rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &empty_dict)
    }
    .ok_or("failed to convert to PNG")?;

    // Write to file
    let bytes = png_data.to_vec();
    std::fs::write(path, &bytes).map_err(|e| format!("failed to write {path}: {e}"))?;

    Ok(())
}

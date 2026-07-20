# Real-device validation checklist — one phone session

Covers the HUMAN/DEVICE gates that cannot be automated: attn-7xl.2.9
(storage v3 on real iOS), attn-7xl.6.6 (offline/lifecycle), plus the iOS
slices of 5.6 (Files/export) and 7.3 (restart behavior). Run top to
bottom on a current iPhone against **https://staging.attn.sh** — about
30 minutes. Annotate results inline in attn and I'll transcribe evidence
onto the beads.

## A. Storage modes (2.9)

1. **Normal Safari tab**: open staging → New workspace → type a heading
   + a paragraph. Kill Safari from the app switcher. Reopen → the
   workspace and text are intact. ☐
2. **Private Browsing**: same flow. Expect the "private session may
   erase your desk" banner; typing + export still work. Close the
   private tab, reopen private → desk is empty (session-only, honest). ☐
3. **Home Screen app**: Share → Add to Home Screen from staging. Launch
   it → your workspace from (1) is there (same storage partition or a
   clean desk — note WHICH, it's fingerprint evidence for the docs). ☐
4. **Low storage** (best-effort): if the device is near-full, note any
   degraded-storage banner appearing; otherwise skip. ☐

## B. Offline + lifecycle (6.6)

5. Open a workspace, then enable Airplane Mode. Reload the page → the
   app shell loads (service worker) and the document renders. Typing
   works; the save chip stays honest. ☐
6. Still offline: open the share sheet → creating a link fails with a
   calm, non-destructive error (document stays local + safe). ☐
7. Airplane Mode off → the app recovers without a reload (or with one
   reload, note which). ☐
8. **Process restart**: background Safari, open 3–4 heavy apps (camera,
   maps) to force eviction, return → the document restores, scroll
   position ideally kept, no data loss. ☐
9. **Mid-typing kill**: type a sentence, immediately swipe-kill Safari
   (within ~1s), reopen → at most the final ~1s of keystrokes lost,
   never the document. ☐

## C. Reader/review UX on the phone (7.3 / ios-ux.md)

10. Open a review link (`/s/…`) from Messages → document readable at
    320–430 px, no horizontal scroll, comments behind the Review dock. ☐
11. Select text → Comment → composer opens with the keyboard; submit;
    the comment appears in the Review sheet. ☐
12. 200% text size (Settings → Accessibility): landing + document remain
    readable, nothing clipped. ☐
13. VoiceOver quick pass: the document is announced as "Document editor"
    (text box); the file rows and Share button have sensible labels. ☐
14. Dynamic browser chrome: scroll down/up — the masthead and thumb dock
    stay usable as Safari's bars collapse/expand. ☐

## D. Files + export (5.6)

15. ⌘K → Export workspace (or the palette on mobile) → zip lands in
    Files; open it → your markdown is inside, readable. ☐
16. Import that zip on ANOTHER device/browser → identical content. ☐

## E. Browser ↔ native handoff (parity matrix)

17. Open a staging share link with native attn (`attn review join …`) —
    comments made on the phone appear in native and vice versa. ☐

Notes field: ………

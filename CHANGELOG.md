# Changelog

## 1.0.11
- Fixed the site settings dialog's tab strip: switching back to the first tab (常规) did nothing, while switching to the second one (数据管理) worked. Root cause: the site renders a decorative gradient-mask element at the start of the tab strip (`position:sticky`, `z-index:1`, only a `mask-image`, `md:hidden`) which defaults to `pointer-events:auto` and sits exactly on top of the first tab, swallowing the tap. The site's own tab logic is fine — a synthetic `.click()` switches both ways. We now inject a rule making non-`[role="tab"]` children of any `[role="tablist"]` click-through.

## 1.0.10
- Fixed the light/dark regression from 1.0.9: `Theme.Material.NoActionBar` made targetSdk ≥ 33 WebViews report `prefers-color-scheme: dark`, so the site rendered in dark and the launch window flashed dark. Now uses a light theme plus a forced `UI_MODE_NIGHT_NO` in `attachBaseContext`. The image viewer stays dark on purpose.
- Consumed window insets in `WindowInsetsHelper` so the safe area is no longer applied twice (root padding + CSS `env(safe-area-inset-*)`).
- Back key now only intercepts when the page can actually go back; the root page is handed to the system (move to background) instead of `finish()`, preserving the WebView session. Same semantics on API 24–32.
- Added `smallestScreenSize|screenLayout` (and `keyboard|navigation`) to `configChanges` so split-screen/foldable size changes no longer recreate the Activity and drop in-progress input.
- Download filenames are truncated to 200 UTF-8 bytes with the extension preserved, split on code points (never through a surrogate pair), and stripped of bidi controls such as `U+202E` plus lone surrogates.
- `GallerySaver` converts MediaStore `RuntimeException`s into `IOException` so callers can't get stuck in the "saving" state.
- `DownloadCompleteReceiver` no longer posts notifications: user-initiated cancels/deletes also fire `DOWNLOAD_COMPLETE`, which used to be reported as a failure, and the system already shows a completion notification. It now only clears bookkeeping, and shares the same prefs file/key format as `DownloadCenter` (they had drifted apart, so the receiver had never actually fired).
- Native download/image requests use the WebView user agent instead of Dalvik's `System.getProperty("http.agent")`; cookies are attached only for trusted site hosts so redirects can't leak them to other domains.
- Signing passwords no longer have built-in defaults (the old one shipped in public source); `GPTCAT_STORE_PASSWORD` is required and validated before compilation.
- AI-generated images now open the preview on the first tap: the site wraps them in a container whose Tailwind arbitrary-value class name contains `composer` (`keyboard-open:pb-[calc(var(--composer-height,100px))]`), which the `[class*="composer"]` substring test mistook for an editing surface and swallowed the click.

## 1.0.9
- Target/compile Android API 36.
- Added predictive-back support on Android 13+.
- Hardened WebView mixed-content/Safe Browsing settings.
- Restricted privileged native fetches to HTTPS and disabled app-data backup.
- Added filename/MIME normalization and safer MediaStore failure handling.
- Fixed Blob download byte accounting and consistent file deletion.
- Reduced in-page Blob/data transfer cap to 128 MiB.
- Avoided download notification ID collisions.
- Validated GitHub release URLs before opening update pages.
- Fixed locale-sensitive Java checks and signing-key-free smoke fixtures.
- Normalized documentation filenames for portable ZIP extraction.

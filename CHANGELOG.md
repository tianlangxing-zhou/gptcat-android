# Changelog

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

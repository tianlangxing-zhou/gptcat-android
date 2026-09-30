package com.gptcat.app.web;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.SystemClock;
import android.util.Base64;
import android.view.View;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;

import com.gptcat.app.ImageViewerActivity;
import com.gptcat.app.image.ImageFiles;
import com.gptcat.app.notify.NotificationHelper;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.lang.ref.WeakReference;
import java.util.UUID;

/**
 * WebView JS bridge：
 * - 图片打开/分块落盘；
 * - 非用户 focus 时隐藏输入法；
 * - 系统 DownloadManager 下载、查询进度、打开下载文件。
 */
public final class ImageBridge {
    private static final int REQUEST_STORAGE = 6102;
    private static final String DOWNLOAD_PREFS = "gptcat_downloads";

    private final WeakReference<Activity> activityRef;
    private final Context context;
    private final String token;

    private volatile boolean enabled;
    private volatile boolean closed;

    private File transferFile;
    private FileOutputStream transfer;
    private String transferId;
    private long expectedBytes;
    private long receivedBytes;
    private long lastOpen;

    public ImageBridge(Activity activity, String token) {
        activityRef = new WeakReference<>(activity);
        context = activity.getApplicationContext();
        this.token = token;
    }

    public synchronized void setEnabled(boolean value) {
        enabled = value;
        if (!value) clearTransfer();
    }

    private boolean allowed(String value) {
        return enabled && !closed && token.equals(value);
    }

    @JavascriptInterface
    public synchronized boolean openImage(String value, String url) {
        if (!allowed(value) || !UrlPolicy.isHttpUrl(url)) return false;
        return launch(url, null);
    }

    @JavascriptInterface
    public synchronized String beginImage(String value, long bytes) {
        if (!allowed(value) || bytes <= 0 || bytes > ImageFiles.MAX_BYTES) return "";
        clearTransfer();

        try {
            transferFile = ImageFiles.create(context);
            transfer = new FileOutputStream(transferFile);
            transferId = UUID.randomUUID().toString();
            expectedBytes = bytes;
            receivedBytes = 0;
            return transferId;
        } catch (IOException e) {
            clearTransfer();
            return "";
        }
    }

    @JavascriptInterface
    public synchronized boolean appendImage(String value, String id, String encoded) {
        if (!allowed(value) || transfer == null || !transferId.equals(id)) return false;

        try {
            if (encoded == null || encoded.length() > 65536) {
                throw new IOException("无效图片分块");
            }

            byte[] bytes = Base64.decode(encoded, Base64.DEFAULT);
            if (bytes.length == 0 || receivedBytes + bytes.length > expectedBytes) {
                throw new IOException("图片分块超过限制");
            }

            transfer.write(bytes);
            receivedBytes += bytes.length;
            return true;
        } catch (IOException | IllegalArgumentException e) {
            clearTransfer();
            return false;
        }
    }

    @JavascriptInterface
    public synchronized boolean finishImage(String value, String id) {
        if (!allowed(value) || transfer == null || !transferId.equals(id)) return false;
        if (receivedBytes != expectedBytes) {
            clearTransfer();
            return false;
        }

        try {
            transfer.close();
            transfer = null;

            File ready = transferFile;
            transferFile = null;
            transferId = null;

            if (!launch(null, ready)) {
                ready.delete();
                return false;
            }
            return true;
        } catch (IOException e) {
            clearTransfer();
            return false;
        }
    }

    @JavascriptInterface
    public synchronized void cancelImage(String value, String id) {
        if (token.equals(value) && id != null && id.equals(transferId)) {
            clearTransfer();
        }
    }

    /** 非用户操作造成网页输入框 focus 时由 JS 调用。 */
    @JavascriptInterface
    public synchronized void hideKeyboard(String value) {
        if (!allowed(value)) return;

        Activity activity = activityRef.get();
        if (activity == null) return;

        activity.runOnUiThread(() -> {
            Activity current = activityRef.get();
            if (!enabled || closed || current == null
                    || current.isFinishing() || current.isDestroyed()) {
                return;
            }

            View focus = current.getCurrentFocus();
            View tokenView = focus != null ? focus : current.getWindow().getDecorView();

            InputMethodManager imm =
                    (InputMethodManager) current.getSystemService(Context.INPUT_METHOD_SERVICE);
            if (imm != null && tokenView.getWindowToken() != null) {
                imm.hideSoftInputFromWindow(tokenView.getWindowToken(), 0);
            }
        });
    }

    /**
     * 返回 DownloadManager ID；返回 "permission" 表示 Android 7-9 需要用户先授权存储。
     * 返回空字符串表示未能创建下载。
     */
    @JavascriptInterface
    public synchronized String downloadFile(String value, String url, String name) {
        if (!allowed(value) || !UrlPolicy.isHttpUrl(url)) return "";

        Activity activity = activityRef.get();
        if (activity == null) return "";

        if (Build.VERSION.SDK_INT <= 28
                && activity.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                != PackageManager.PERMISSION_GRANTED) {
            activity.runOnUiThread(() -> activity.requestPermissions(
                    new String[] { Manifest.permission.WRITE_EXTERNAL_STORAGE },
                    REQUEST_STORAGE));
            return "permission";
        }

        activity.runOnUiThread(() -> NotificationHelper.requestPermissionIfNeeded(activity));

        DownloadManager manager =
                (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
        if (manager == null) return "";

        String safeName = safeFileName(name);

        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            request.setTitle(safeName);
            request.setDescription("GPTCat 下载");
            request.setNotificationVisibility(
                    DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setAllowedOverMetered(true);
            request.setAllowedOverRoaming(true);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, safeName);

            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie != null && !cookie.trim().isEmpty()) {
                request.addRequestHeader("Cookie", cookie);
            }

            String userAgent = System.getProperty("http.agent");
            if (userAgent != null && !userAgent.trim().isEmpty()) {
                request.addRequestHeader("User-Agent", userAgent);
            }

            long id = manager.enqueue(request);

            SharedPreferences prefs =
                    context.getSharedPreferences(DOWNLOAD_PREFS, Context.MODE_PRIVATE);
            prefs.edit()
                    .putString("download." + id + ".name", safeName)
                    .apply();

            return Long.toString(id);
        } catch (RuntimeException e) {
            return "";
        }
    }

    /**
     * 返回 status|percent|downloaded|total
     * status: pending/running/paused/success/failed/unknown
     */
    @JavascriptInterface
    public synchronized String getDownloadProgress(String value, String idValue) {
        if (!allowed(value)) return "unknown|-1|0|0";

        long id = parseId(idValue);
        if (id < 0) return "unknown|-1|0|0";

        DownloadManager manager =
                (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
        if (manager == null) return "unknown|-1|0|0";

        try (Cursor cursor = manager.query(new DownloadManager.Query().setFilterById(id))) {
            if (cursor == null || !cursor.moveToFirst()) {
                return "unknown|-1|0|0";
            }

            int status = intColumn(cursor, DownloadManager.COLUMN_STATUS, 0);
            long downloaded = longColumn(
                    cursor, DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR, 0L);
            long total = longColumn(
                    cursor, DownloadManager.COLUMN_TOTAL_SIZE_BYTES, -1L);

            int percent = total > 0
                    ? (int) Math.max(0L, Math.min(100L, downloaded * 100L / total))
                    : -1;

            return statusName(status)
                    + "|" + percent
                    + "|" + downloaded
                    + "|" + total;
        } catch (RuntimeException e) {
            return "unknown|-1|0|0";
        }
    }

    @JavascriptInterface
    public synchronized boolean openDownloadedFile(String value, String idValue) {
        if (!allowed(value)) return false;

        long id = parseId(idValue);
        if (id < 0) return false;

        DownloadManager manager =
                (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
        Activity activity = activityRef.get();
        if (manager == null || activity == null) return false;

        Uri uri = manager.getUriForDownloadedFile(id);
        if (uri == null) return false;

        String mime = manager.getMimeTypeForDownloadedFile(id);
        if (mime == null || mime.trim().isEmpty()) mime = "*/*";
        final String finalMime = mime;

        activity.runOnUiThread(() -> {
            try {
                Intent open = new Intent(Intent.ACTION_VIEW);
                open.setDataAndType(uri, finalMime);
                open.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                activity.startActivity(open);
            } catch (RuntimeException ignored) { }
        });
        return true;
    }

    private static long parseId(String value) {
        try {
            return Long.parseLong(value);
        } catch (Exception e) {
            return -1L;
        }
    }

    private static int intColumn(Cursor cursor, String name, int fallback) {
        int index = cursor.getColumnIndex(name);
        return index >= 0 ? cursor.getInt(index) : fallback;
    }

    private static long longColumn(Cursor cursor, String name, long fallback) {
        int index = cursor.getColumnIndex(name);
        return index >= 0 ? cursor.getLong(index) : fallback;
    }

    private static String statusName(int status) {
        switch (status) {
            case DownloadManager.STATUS_PENDING:
                return "pending";
            case DownloadManager.STATUS_RUNNING:
                return "running";
            case DownloadManager.STATUS_PAUSED:
                return "paused";
            case DownloadManager.STATUS_SUCCESSFUL:
                return "success";
            case DownloadManager.STATUS_FAILED:
                return "failed";
            default:
                return "unknown";
        }
    }

    private static String safeFileName(String value) {
        String name = value == null ? "" : value.trim();

        // 去掉 URL 查询串残留和路径分隔符；保留中文等 Unicode 文件名。
        int query = name.indexOf('?');
        if (query >= 0) name = name.substring(0, query);

        name = name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_");
        while (name.startsWith(".")) name = name.substring(1);

        if (name.trim().isEmpty()) {
            name = "gptcat-" + System.currentTimeMillis();
        }

        if (name.length() > 120) name = name.substring(0, 120);
        return name;
    }

    private boolean launch(String url, File file) {
        Activity activity = activityRef.get();
        if (activity == null) return false;

        long now = SystemClock.elapsedRealtime();
        if (lastOpen != 0 && now - lastOpen < 500) return false;
        lastOpen = now;

        activity.runOnUiThread(() -> {
            Activity current = activityRef.get();
            if (!enabled || closed || current == null
                    || current.isFinishing() || current.isDestroyed()) {
                if (file != null) file.delete();
                return;
            }

            Intent intent = new Intent(current, ImageViewerActivity.class);
            intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);

            if (file != null) {
                intent.putExtra(ImageViewerActivity.EXTRA_CACHE, file.getName());
            } else {
                intent.putExtra(ImageViewerActivity.EXTRA_URL, url);
            }

            current.startActivity(intent);
        });
        return true;
    }

    public synchronized void close() {
        closed = true;
        enabled = false;
        clearTransfer();
        activityRef.clear();
    }

    private void clearTransfer() {
        if (transfer != null) {
            try {
                transfer.close();
            } catch (IOException ignored) { }
        }

        if (transferFile != null) transferFile.delete();

        transfer = null;
        transferFile = null;
        transferId = null;
        receivedBytes = 0;
        expectedBytes = 0;
    }
}

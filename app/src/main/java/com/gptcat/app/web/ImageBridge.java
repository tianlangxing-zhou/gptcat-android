package com.gptcat.app.web;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.util.Base64;
import android.view.View;
import android.view.inputmethod.InputMethodManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import com.gptcat.app.ImageViewerActivity;
import com.gptcat.app.R;
import com.gptcat.app.download.DownloadCenter;
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
 * - 下载任务（系统 DownloadManager + 网页生成文件）、缓存管理、深浅色切换。
 */
public final class ImageBridge {
    private static final int REQUEST_STORAGE = 6102;

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

    private File fileTransferFile;
    private FileOutputStream fileTransfer;
    private String fileTransferId;
    private String fileName;
    private String fileMime;
    private long fileExpected;
    private long fileReceived;

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
     * 返回任务 ID；返回 "permission" 表示 Android 7-9 需要用户先授权存储。
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

        return DownloadCenter.enqueue(context, url, name, null);
    }

    /** 系统任务 + 网页生成文件的合并列表，供下载任务面板展示。 */
    @JavascriptInterface
    public synchronized String listDownloads(String value) {
        if (!allowed(value)) return "[]";

        String system = DownloadCenter.list(context);
        String local = DownloadCenter.listLocal(context);
        if ("[]".equals(local)) return system;
        if ("[]".equals(system)) return local;

        return "[" + system.substring(1, system.length() - 1)
                + (system.length() > 2 ? "," : "")
                + local.substring(1);
    }

    @JavascriptInterface
    public synchronized boolean removeDownload(String value, String id) {
        if (!allowed(value) || id == null) return false;
        if (id.startsWith("local:")) return DownloadCenter.forgetLocal(context, id);
        return DownloadCenter.remove(context, id);
    }

    /**
     * 返回 status|percent|downloaded|total
     * status: pending/running/paused/success/failed/unknown
     */
    @JavascriptInterface
    public synchronized String getDownloadProgress(String value, String idValue) {
        if (!allowed(value)) return "unknown|-1|0|0";
        return DownloadCenter.statusOf(context, idValue);
    }

    @JavascriptInterface
    public synchronized boolean openDownloadedFile(String value, String idValue) {
        if (!allowed(value) || idValue == null) return false;

        Activity activity = activityRef.get();
        if (activity == null) return false;

        final Uri uri;
        final String mime;
        if (idValue.startsWith("local:")) {
            uri = DownloadCenter.localUriOf(context, idValue);
            mime = "*/*";
        } else {
            uri = DownloadCenter.uriOf(context, idValue);
            mime = DownloadCenter.mimeOf(context, idValue);
        }

        if (uri == null) return false;

        activity.runOnUiThread(() -> {
            try {
                Intent open = new Intent(Intent.ACTION_VIEW);
                open.setDataAndType(uri, mime);
                open.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                activity.startActivity(open);
            } catch (RuntimeException ignored) { }
        });
        return true;
    }

    // ------------------------------------------------------- 网页内生成的文件（blob/data）

    @JavascriptInterface
    public synchronized String beginFile(String value, String name, String mime, long bytes) {
        if (!allowed(value) || bytes <= 0 || bytes > DownloadCenter.maxTempBytes()) return "";
        clearFileTransfer();

        try {
            fileTransferFile = DownloadCenter.createTemp(context);
            fileTransfer = new FileOutputStream(fileTransferFile);
            fileTransferId = UUID.randomUUID().toString();
            fileExpected = bytes;
            fileReceived = 0;
            fileName = DownloadCenter.safeName(name, "");
            fileMime = mime == null ? "" : mime;
            return fileTransferId;
        } catch (IOException e) {
            clearFileTransfer();
            return "";
        }
    }

    @JavascriptInterface
    public synchronized boolean appendFile(String value, String id, String encoded) {
        if (!allowed(value) || fileTransfer == null || !fileTransferId.equals(id)) return false;

        try {
            if (encoded == null || encoded.length() > 65536) {
                throw new IOException("无效文件分块");
            }

            byte[] bytes = Base64.decode(encoded, Base64.DEFAULT);
            if (bytes.length == 0 || fileReceived + bytes.length > fileExpected) {
                throw new IOException("文件分块超过限制");
            }

            fileTransfer.write(bytes);
            fileReceived += bytes.length;
            return true;
        } catch (IOException | IllegalArgumentException e) {
            clearFileTransfer();
            return false;
        }
    }

    /** 完成后登记到系统「下载」目录并通知；返回本地任务 ID。 */
    @JavascriptInterface
    public synchronized String finishFile(String value, String id) {
        if (!allowed(value) || fileTransfer == null || !fileTransferId.equals(id)) return "";
        if (fileReceived != fileExpected) {
            clearFileTransfer();
            return "";
        }

        File ready = fileTransferFile;
        String name = fileName;
        String mime = fileMime;

        try {
            fileTransfer.close();
        } catch (IOException ignored) { }

        fileTransfer = null;
        fileTransferFile = null;
        fileTransferId = null;
        fileReceived = 0;
        fileExpected = 0;

        try {
            Uri uri = DownloadCenter.publish(context, ready, name, mime);
            ready.delete();

            String taskId = DownloadCenter.rememberLocal(context, name, uri, 0L);
            notifySaved(name, uri, mime);
            return taskId;
        } catch (IOException e) {
            ready.delete();
            return "";
        }
    }

    @JavascriptInterface
    public synchronized void cancelFile(String value, String id) {
        if (token.equals(value) && id != null && id.equals(fileTransferId)) {
            clearFileTransfer();
        }
    }

    private void notifySaved(String name, Uri uri, String mime) {
        if (!NotificationHelper.canPost(context)) return;

        Activity activity = activityRef.get();
        Intent open = new Intent(Intent.ACTION_VIEW);
        open.setDataAndType(uri, mime == null || mime.trim().isEmpty() ? "*/*" : mime);
        open.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

        android.app.PendingIntent pending = android.app.PendingIntent.getActivity(
                context,
                6302,
                open,
                android.app.PendingIntent.FLAG_UPDATE_CURRENT
                        | android.app.PendingIntent.FLAG_IMMUTABLE);

        android.app.NotificationManager manager =
                (android.app.NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;

        android.app.Notification notification = NotificationHelper
                .builder(context, NotificationHelper.CHANNEL_DOWNLOADS)
                .setContentTitle("下载完成：" + name)
                .setContentText("已保存到 下载/" + DownloadCenter.SUBDIR)
                .setContentIntent(pending)
                .setCategory(android.app.Notification.CATEGORY_STATUS)
                .build();

        manager.notify(6302, notification);
        if (activity == null) return;
    }

    // ------------------------------------------------------------- 缓存与主题

    /** 返回 {"images":文件数,"imageBytes":字节,"webBytes":字节}。 */
    @JavascriptInterface
    public synchronized String cacheStats(String value) {
        if (!allowed(value)) return "{\"images\":0,\"imageBytes\":0,\"webBytes\":0}";

        String images = ImageFiles.stats(context);
        String[] parts = images.split("\\|");
        long web = directoryBytes(webCacheDir());

        return "{\"images\":" + parts[0]
                + ",\"imageBytes\":" + (parts.length > 1 ? parts[1] : "0")
                + ",\"webBytes\":" + web + "}";
    }

    /** kind: images | web | all；返回 {"images":释放字节,"web":是否清理}。 */
    @JavascriptInterface
    public synchronized String clearCache(String value, String kind) {
        if (!allowed(value) || kind == null) return "{\"images\":0,\"web\":false}";

        long freed = 0;
        boolean web = false;

        if ("images".equals(kind) || "all".equals(kind)) {
            freed += ImageFiles.clear(context);
        }

        if ("web".equals(kind) || "all".equals(kind)) {
            web = clearWebCache();
            freed += clearFileTemp();
        }

        return "{\"images\":" + freed + ",\"web\":" + web + "}";
    }

    private boolean clearWebCache() {
        Activity activity = activityRef.get();
        if (activity == null) return false;

        activity.runOnUiThread(() -> {
            View view = activity.findViewById(R.id.webView);
            if (view instanceof WebView) {
                // 只清缓存，不动 Cookie / 表单，避免把登录状态一起清掉。
                ((WebView) view).clearCache(true);
            }
        });
        return true;
    }

    private long clearFileTemp() {
        return deleteChildren(new File(context.getCacheDir(), "gptcat-files"));
    }

    private File webCacheDir() {
        return new File(context.getCacheDir(), "WebView");
    }

    private static long directoryBytes(File dir) {
        if (dir == null || !dir.isDirectory()) return 0;

        File[] files = dir.listFiles();
        if (files == null) return 0;

        long total = 0;
        for (File file : files) {
            total += file.isDirectory() ? directoryBytes(file) : Math.max(0L, file.length());
        }
        return total;
    }

    private static long deleteChildren(File dir) {
        if (dir == null || !dir.isDirectory()) return 0;

        File[] files = dir.listFiles();
        if (files == null) return 0;

        long freed = 0;
        for (File file : files) {
            if (file.isDirectory()) {
                freed += deleteChildren(file);
                file.delete();
            } else {
                long length = Math.max(0L, file.length());
                if (file.delete()) freed += length;
            }
        }
        return freed;
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
        clearFileTransfer();
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

    private void clearFileTransfer() {
        if (fileTransfer != null) {
            try {
                fileTransfer.close();
            } catch (IOException ignored) { }
        }

        if (fileTransferFile != null) fileTransferFile.delete();

        fileTransfer = null;
        fileTransferFile = null;
        fileTransferId = null;
        fileName = null;
        fileMime = null;
        fileReceived = 0;
        fileExpected = 0;
    }
}

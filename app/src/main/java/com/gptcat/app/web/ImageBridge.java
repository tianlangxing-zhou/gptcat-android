package com.gptcat.app.web;

import android.app.Activity;
import android.content.Intent;
import android.os.SystemClock;
import android.util.Base64;
import android.webkit.JavascriptInterface;

import com.gptcat.app.ImageViewerActivity;
import com.gptcat.app.image.ImageFiles;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.lang.ref.WeakReference;
import java.util.UUID;

/** JS bridge 在 WebView 的后台线程运行；二进制图片按 48 KiB 分块落盘。 */
public final class ImageBridge {
    private final WeakReference<Activity> activityRef;
    private final android.content.Context context;
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
            if (encoded == null || encoded.length() > 65536) throw new IOException("无效图片分块");
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
        if (token.equals(value) && id != null && id.equals(transferId)) clearTransfer();
    }

    private boolean launch(String url, File file) {
        Activity activity = activityRef.get();
        if (activity == null) return false;
        long now = SystemClock.elapsedRealtime();
        if (lastOpen != 0 && now - lastOpen < 500) return false;
        lastOpen = now;
        activity.runOnUiThread(() -> {
            Activity current = activityRef.get();
            if (!enabled || closed || current == null || current.isFinishing() || current.isDestroyed()) {
                if (file != null) file.delete();
                return;
            }
            Intent intent = new Intent(current, ImageViewerActivity.class);
            intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
            if (file != null) intent.putExtra(ImageViewerActivity.EXTRA_CACHE, file.getName());
            else intent.putExtra(ImageViewerActivity.EXTRA_URL, url);
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
            try { transfer.close(); } catch (IOException ignored) { }
        }
        if (transferFile != null) transferFile.delete();
        transfer = null;
        transferFile = null;
        transferId = null;
        receivedBytes = 0;
        expectedBytes = 0;
    }
}

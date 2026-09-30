package com.gptcat.app.download;

import android.app.DownloadManager;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;

import com.gptcat.app.notify.NotificationHelper;

/**
 * 只处理本应用通过 ImageBridge 发起的下载。
 * 下载成功后发送可点击通知，点击后直接交给系统打开该文件。
 */
public final class DownloadCompleteReceiver extends BroadcastReceiver {
    private static final String PREFS = "gptcat_downloads";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null
                || !DownloadManager.ACTION_DOWNLOAD_COMPLETE.equals(intent.getAction())) {
            return;
        }

        long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L);
        if (id < 0) return;

        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String name = prefs.getString("download." + id + ".name", null);
        if (name == null) return; // 不是本应用发起的下载

        DownloadManager manager =
                (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
        if (manager == null) return;

        int status = DownloadManager.STATUS_FAILED;
        try (Cursor cursor = manager.query(new DownloadManager.Query().setFilterById(id))) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(DownloadManager.COLUMN_STATUS);
                if (index >= 0) status = cursor.getInt(index);
            }
        } catch (RuntimeException ignored) { }

        prefs.edit().remove("download." + id + ".name").apply();

        if (!NotificationHelper.canPost(context)) return;

        NotificationManager notifications =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (notifications == null) return;

        Notification.Builder builder =
                NotificationHelper.builder(context, NotificationHelper.CHANNEL_DOWNLOADS)
                        .setContentTitle(status == DownloadManager.STATUS_SUCCESSFUL
                                ? "下载完成" : "下载失败")
                        .setContentText(name)
                        .setCategory(Notification.CATEGORY_PROGRESS);

        if (status == DownloadManager.STATUS_SUCCESSFUL) {
            Uri uri = manager.getUriForDownloadedFile(id);
            if (uri != null) {
                String mime = manager.getMimeTypeForDownloadedFile(id);
                if (mime == null || mime.trim().isEmpty()) mime = "*/*";

                Intent open = new Intent(Intent.ACTION_VIEW);
                open.setDataAndType(uri, mime);
                open.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                        | Intent.FLAG_ACTIVITY_NEW_TASK);

                PendingIntent pending = PendingIntent.getActivity(
                        context,
                        (int) (id ^ (id >>> 32)),
                        open,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                builder.setContentIntent(pending);
            }
        }

        int notificationId = 0x22000000
                | ((int) (id ^ (id >>> 32)) & 0x00ffffff);
        notifications.notify(notificationId, builder.build());
    }
}

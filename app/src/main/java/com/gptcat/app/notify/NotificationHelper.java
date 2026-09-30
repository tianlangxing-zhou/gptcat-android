package com.gptcat.app.notify;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;

import com.gptcat.app.R;

/** 系统通知的小型公共封装，不依赖 AndroidX。 */
public final class NotificationHelper {
    public static final String CHANNEL_DOWNLOADS = "gptcat_downloads";
    public static final String CHANNEL_UPDATES = "gptcat_updates";
    public static final int REQUEST_NOTIFICATIONS = 6101;

    private NotificationHelper() { }

    public static void ensureChannels(Context context) {
        if (Build.VERSION.SDK_INT < 26) return;

        NotificationManager manager =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;

        NotificationChannel downloads = new NotificationChannel(
                CHANNEL_DOWNLOADS,
                "文件下载",
                NotificationManager.IMPORTANCE_DEFAULT);
        downloads.setDescription("佐助 文件下载完成通知");

        NotificationChannel updates = new NotificationChannel(
                CHANNEL_UPDATES,
                "应用更新",
                NotificationManager.IMPORTANCE_DEFAULT);
        updates.setDescription("佐助 新版本提醒");

        manager.createNotificationChannel(downloads);
        manager.createNotificationChannel(updates);
    }

    public static Notification.Builder builder(Context context, String channelId) {
        ensureChannels(context);

        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= 26) {
            builder = new Notification.Builder(context, channelId);
        } else {
            builder = new Notification.Builder(context);
        }

        return builder
                .setSmallIcon(R.mipmap.ic_launcher)
                .setShowWhen(true)
                .setAutoCancel(true);
    }

    public static boolean canPost(Context context) {
        if (Build.VERSION.SDK_INT < 33) return true;
        return context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
    }

    public static void requestPermissionIfNeeded(Activity activity) {
        if (Build.VERSION.SDK_INT < 33) return;
        if (activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED) {
            return;
        }

        activity.requestPermissions(
                new String[] { Manifest.permission.POST_NOTIFICATIONS },
                REQUEST_NOTIFICATIONS);
    }
}

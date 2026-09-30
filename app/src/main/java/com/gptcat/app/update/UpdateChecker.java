package com.gptcat.app.update;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.widget.Toast;

import com.gptcat.app.notify.NotificationHelper;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 轻量更新检测：
 * - 最多每 12 小时检查一次；
 * - 只读取 GitHub 最新 Release 元数据；
 * - 只提醒，不静默下载/安装 APK。
 */
public final class UpdateChecker {
    private static final String API =
            "https://api.github.com/repos/tianlangxing-zhou/gptcat-android/releases/latest";
    private static final long CHECK_INTERVAL_MS = 12L * 60L * 60L * 1000L;
    private static final int MAX_RESPONSE = 256 * 1024;
    private static final Pattern NUMBER = Pattern.compile("\\d+");

    private UpdateChecker() { }

    public static void check(Activity activity) {
        final Context context = activity.getApplicationContext();
        final SharedPreferences prefs =
                context.getSharedPreferences("gptcat_update", Context.MODE_PRIVATE);

        long now = System.currentTimeMillis();
        long last = prefs.getLong("last_check", 0L);
        if (last > 0 && now - last < CHECK_INTERVAL_MS) return;

        // 先记录本次尝试，避免断网状态每次切回 Activity 都重复打 GitHub。
        prefs.edit().putLong("last_check", now).apply();

        new Thread(() -> runCheck(context, prefs), "gptcat-update-check").start();
    }

    private static void runCheck(Context context, SharedPreferences prefs) {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(API);
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(7000);
            connection.setReadTimeout(7000);
            connection.setUseCaches(false);
            connection.setRequestProperty("Accept", "application/vnd.github+json");
            connection.setRequestProperty("User-Agent", "GPTCat-Android");

            int status = connection.getResponseCode();
            if (status == 404) return; // 仓库还没有 Release
            if (status < 200 || status >= 300) return;

            byte[] data;
            try (InputStream input = connection.getInputStream();
                 ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[4096];
                int read;
                int total = 0;
                while ((read = input.read(buffer)) != -1) {
                    total += read;
                    if (total > MAX_RESPONSE) return;
                    output.write(buffer, 0, read);
                }
                data = output.toByteArray();
            }

            JSONObject release = new JSONObject(new String(data, "UTF-8"));
            if (release.optBoolean("draft", false)
                    || release.optBoolean("prerelease", false)) {
                return;
            }

            String tag = release.optString("tag_name", "");
            String page = release.optString("html_url", "");
            if (tag.isEmpty() || page.isEmpty()) return;

            String current = currentVersion(context);
            if (compareVersions(tag, current) <= 0) return;

            String lastNotified = prefs.getString("last_notified", "");
            if (tag.equals(lastNotified)) return;

            prefs.edit().putString("last_notified", tag).apply();
            notifyUpdate(context, current, tag, page);
        } catch (Exception ignored) {
            // 更新检查永远不能影响主功能。
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static String currentVersion(Context context) {
        try {
            PackageInfo info = context.getPackageManager()
                    .getPackageInfo(context.getPackageName(), 0);
            return info.versionName == null ? "0" : info.versionName;
        } catch (Exception e) {
            return "0";
        }
    }

    static int compareVersions(String left, String right) {
        int[] a = numbers(left);
        int[] b = numbers(right);
        int count = Math.max(a.length, b.length);

        for (int i = 0; i < count; i++) {
            int av = i < a.length ? a[i] : 0;
            int bv = i < b.length ? b[i] : 0;
            if (av != bv) return av < bv ? -1 : 1;
        }
        return 0;
    }

    private static int[] numbers(String value) {
        Matcher matcher = NUMBER.matcher(value == null ? "" : value);
        int[] temp = new int[8];
        int count = 0;

        while (matcher.find() && count < temp.length) {
            try {
                temp[count++] = Integer.parseInt(matcher.group());
            } catch (NumberFormatException ignored) {
                temp[count++] = 0;
            }
        }

        int[] result = new int[count];
        System.arraycopy(temp, 0, result, 0, count);
        return result;
    }

    private static void notifyUpdate(
            Context context, String current, String latest, String page) {
        Intent browser = new Intent(Intent.ACTION_VIEW, Uri.parse(page));
        browser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

        PendingIntent pending = PendingIntent.getActivity(
                context,
                6301,
                browser,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        if (NotificationHelper.canPost(context)) {
            NotificationManager manager =
                    (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) {
                Notification notification =
                        NotificationHelper.builder(
                                        context, NotificationHelper.CHANNEL_UPDATES)
                                .setContentTitle("发现 GPTCat 新版本 " + latest)
                                .setContentText("当前 " + current + "，点击查看更新")
                                .setContentIntent(pending)
                                .setCategory(Notification.CATEGORY_STATUS)
                                .build();
                manager.notify(6301, notification);
                return;
            }
        }

        // Android 13+ 未授权通知时，在前台用 Toast 兜底，不强制索取通知权限。
        new Handler(Looper.getMainLooper()).post(() ->
                Toast.makeText(
                        context,
                        "发现 GPTCat 新版本 " + latest + "，可前往 GitHub 更新",
                        Toast.LENGTH_LONG).show());
    }
}

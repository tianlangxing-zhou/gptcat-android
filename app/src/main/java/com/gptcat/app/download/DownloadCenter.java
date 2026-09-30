package com.gptcat.app.download;

import android.app.DownloadManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.webkit.CookieManager;

import com.gptcat.app.web.UrlPolicy;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * 下载任务中心：
 * 1) http(s) 交给系统 DownloadManager，任务列表直接读系统库；
 * 2) 网页生成的 blob:/data: 文件先落应用私有目录，完成后再登记到「下载」目录。
 */
public final class DownloadCenter {
    public static final String SUBDIR = "佐助";

    private static final String PREFS = "gptcat-downloads";
    private static final long MAX_TEMP_BYTES = 512L * 1024 * 1024;

    private DownloadCenter() { }

    // ---------------------------------------------------------------- 系统下载

    /** 返回任务 ID 字符串；返回空串表示未能创建。 */
    public static String enqueue(Context context, String url, String name, String mime) {
        if (!UrlPolicy.isHttpUrl(url)) return "";

        DownloadManager manager =
                (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
        if (manager == null) return "";

        String safe = safeName(name, url);

        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            request.setTitle(safe);
            request.setDescription("佐助 下载");
            request.setNotificationVisibility(
                    DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setAllowedOverMetered(true);
            request.setAllowedOverRoaming(true);
            request.setDestinationInExternalPublicDir(
                    Environment.DIRECTORY_DOWNLOADS, SUBDIR + "/" + safe);

            if (mime != null && !mime.trim().isEmpty()) {
                request.setMimeType(mime);
            }

            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie != null && !cookie.trim().isEmpty()) {
                request.addRequestHeader("Cookie", cookie);
            }

            String agent = System.getProperty("http.agent");
            if (agent != null && !agent.trim().isEmpty()) {
                request.addRequestHeader("User-Agent", agent);
            }

            long id = manager.enqueue(request);
            remember(context, id, safe);
            return Long.toString(id);
        } catch (RuntimeException e) {
            return "";
        }
    }

    /** 任务列表 JSON：[{id,name,status,percent,downloaded,total}]，仅保留最近 30 条。 */
    public static String list(Context context) {
        JSONArray array = new JSONArray();
        DownloadManager manager =
                (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
        if (manager == null) return array.toString();

        // 收集后按任务 ID 倒序，最新的任务排在最前。
        java.util.List<Object[]> rows = new java.util.ArrayList<>();

        try (Cursor cursor = manager.query(new DownloadManager.Query())) {
            if (cursor == null) return array.toString();

            int guard = 0;
            while (cursor.moveToNext() && guard++ < 30) {
                long id = longAt(cursor, DownloadManager.COLUMN_ID, -1L);
                if (id < 0) continue;

                long total = longAt(cursor, DownloadManager.COLUMN_TOTAL_SIZE_BYTES, -1L);
                long done = longAt(cursor, DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR, 0L);
                int status = (int) longAt(cursor, DownloadManager.COLUMN_STATUS, -1L);

                rows.add(new Object[] { id, nameOf(context, id, cursor), status, total, done });
            }
        } catch (RuntimeException e) {
            return array.toString();
        }

        rows.sort((left, right) -> Long.compare((Long) right[0], (Long) left[0]));

        for (Object[] row : rows) {
            long total = (Long) row[3];
            long done = (Long) row[4];

            try {
                JSONObject item = new JSONObject();
                item.put("id", Long.toString((Long) row[0]));
                item.put("name", row[1]);
                item.put("status", statusName((Integer) row[2]));
                item.put("percent",
                        total > 0 ? (int) Math.max(0L, Math.min(100L, done * 100L / total)) : -1);
                item.put("downloaded", done);
                item.put("total", total);
                item.put("local", false);
                array.put(item);
            } catch (Exception ignored) { }
        }

        return array.toString();
    }

    public static boolean remove(Context context, String idValue) {
        long id = parseId(idValue);
        if (id < 0) return false;

        DownloadManager manager =
                (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
        if (manager == null) return false;

        try {
            manager.remove(id);
            prefs(context).edit().remove(key(id)).apply();
            return true;
        } catch (RuntimeException e) {
            return false;
        }
    }

    public static String statusOf(Context context, String idValue) {
        long id = parseId(idValue);
        if (id < 0) return "unknown|-1|0|0";

        DownloadManager manager =
                (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
        if (manager == null) return "unknown|-1|0|0";

        try (Cursor cursor = manager.query(new DownloadManager.Query().setFilterById(id))) {
            if (cursor == null || !cursor.moveToFirst()) return "unknown|-1|0|0";

            int status = (int) longAt(cursor, DownloadManager.COLUMN_STATUS, -1L);
            long done = longAt(cursor, DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR, 0L);
            long total = longAt(cursor, DownloadManager.COLUMN_TOTAL_SIZE_BYTES, -1L);
            int percent = total > 0
                    ? (int) Math.max(0L, Math.min(100L, done * 100L / total))
                    : -1;

            return statusName(status) + "|" + percent + "|" + done + "|" + total;
        } catch (RuntimeException e) {
            return "unknown|-1|0|0";
        }
    }

    public static Uri uriOf(Context context, String idValue) {
        long id = parseId(idValue);
        if (id < 0) return null;

        DownloadManager manager =
                (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
        if (manager == null) return null;

        try {
            return manager.getUriForDownloadedFile(id);
        } catch (RuntimeException e) {
            return null;
        }
    }

    public static String mimeOf(Context context, String idValue) {
        long id = parseId(idValue);
        if (id < 0) return "*/*";

        DownloadManager manager =
                (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
        if (manager == null) return "*/*";

        try {
            String mime = manager.getMimeTypeForDownloadedFile(id);
            return mime == null || mime.trim().isEmpty() ? "*/*" : mime;
        } catch (RuntimeException e) {
            return "*/*";
        }
    }

    // ---------------------------------------------------------------- 网页内生成的文件

    private static final java.util.List<Object[]> LOCAL = new java.util.ArrayList<>();

    /** 登记一个已落盘的网页文件，返回带前缀的本地任务 ID。 */
    public static String rememberLocal(String name, Uri uri, long bytes) {
        String id = "local:" + java.util.UUID.randomUUID();
        synchronized (LOCAL) {
            LOCAL.add(0, new Object[] { id, name, uri, bytes, System.currentTimeMillis() });
            while (LOCAL.size() > 20) LOCAL.remove(LOCAL.size() - 1);
        }
        return id;
    }

    /** 本地任务列表，字段与系统任务保持一致，另外多一个 uri。 */
    public static String listLocal() {
        JSONArray array = new JSONArray();
        synchronized (LOCAL) {
            for (Object[] entry : LOCAL) {
                try {
                    JSONObject item = new JSONObject();
                    item.put("id", entry[0]);
                    item.put("name", entry[1]);
                    item.put("status", "success");
                    item.put("percent", 100);
                    item.put("downloaded", entry[3]);
                    item.put("total", entry[3]);
                    item.put("local", true);
                    array.put(item);
                } catch (Exception ignored) { }
            }
        }
        return array.toString();
    }

    public static Uri localUriOf(String id) {
        synchronized (LOCAL) {
            for (Object[] entry : LOCAL) {
                if (entry[0].equals(id)) return (Uri) entry[2];
            }
        }
        return null;
    }

    public static boolean forgetLocal(String id) {
        synchronized (LOCAL) {
            for (int i = 0; i < LOCAL.size(); i++) {
                if (LOCAL.get(i)[0].equals(id)) {
                    LOCAL.remove(i);
                    return true;
                }
            }
        }
        return false;
    }

    public static File createTemp(Context context) throws IOException {
        File dir = new File(context.getCacheDir(), "gptcat-files");
        if (!dir.isDirectory() && !dir.mkdirs() && !dir.isDirectory()) {
            throw new IOException("无法创建下载缓存");
        }
        return File.createTempFile("file-", ".part", dir);
    }

    public static long maxTempBytes() {
        return MAX_TEMP_BYTES;
    }

    /** 把完成后的临时文件登记到系统「下载」目录，返回可分享/打开的 Uri。 */
    public static Uri publish(Context context, File temp, String name, String mime)
            throws IOException {
        String safe = safeName(name, "");
        String type = mime == null || mime.trim().isEmpty()
                ? "application/octet-stream"
                : mime;

        if (Build.VERSION.SDK_INT >= 29) {
            ContentResolver resolver = context.getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, safe);
            values.put(MediaStore.MediaColumns.MIME_TYPE, type);
            values.put(MediaStore.MediaColumns.RELATIVE_PATH,
                    Environment.DIRECTORY_DOWNLOADS + "/" + SUBDIR);
            values.put(MediaStore.MediaColumns.IS_PENDING, 1);

            Uri target = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (target == null) throw new IOException("无法创建下载文件");

            try (InputStream input = new FileInputStream(temp);
                 OutputStream output = resolver.openOutputStream(target)) {
                if (output == null) throw new IOException("无法写入下载文件");
                copy(input, output);
            } catch (IOException e) {
                resolver.delete(target, null, null);
                throw e;
            }

            values.clear();
            values.put(MediaStore.MediaColumns.IS_PENDING, 0);
            resolver.update(target, values, null, null);
            return target;
        }

        File dir = new File(
                Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
                SUBDIR);
        if (!dir.isDirectory() && !dir.mkdirs() && !dir.isDirectory()) {
            throw new IOException("无法创建下载目录");
        }

        File target = unique(dir, safe);
        try (InputStream input = new FileInputStream(temp);
             OutputStream output = new FileOutputStream(target)) {
            copy(input, output);
        }

        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DATA, target.getAbsolutePath());
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, target.getName());
        values.put(MediaStore.MediaColumns.MIME_TYPE, type);
        Uri uri = context.getContentResolver()
                .insert(MediaStore.Files.getContentUri("external"), values);
        return uri != null ? uri : Uri.fromFile(target);
    }

    // ---------------------------------------------------------------- 工具

    public static String safeName(String name, String url) {
        String value = name == null ? "" : name.trim();
        if (value.isEmpty() && url != null) {
            try {
                String path = Uri.parse(url).getLastPathSegment();
                value = path == null ? "" : path;
            } catch (RuntimeException ignored) { }
        }
        if (value.isEmpty()) value = "gptcat-download";

        value = value.replace('\\', '_').replace('/', '_').replaceAll("[\\p{Cntrl}]", "_");
        if (value.length() > 120) value = value.substring(0, 120);
        return value.isEmpty() ? "gptcat-download" : value;
    }

    public static String nameFromDisposition(String disposition, String url) {
        if (disposition != null) {
            String[] parts = disposition.split(";");
            for (String part : parts) {
                String item = part.trim();
                if (item.regionMatches(true, 0, "filename*=", 0, 10)) {
                    String raw = item.substring(10).trim().replace("\"", "");
                    int mark = raw.indexOf("''");
                    if (mark >= 0) raw = raw.substring(mark + 2);
                    try {
                        return java.net.URLDecoder.decode(raw, "UTF-8");
                    } catch (Exception ignored) { }
                }
                if (item.regionMatches(true, 0, "filename=", 0, 9)) {
                    String raw = item.substring(9).trim().replace("\"", "");
                    if (!raw.isEmpty()) {
                        try {
                            return java.net.URLDecoder.decode(raw, "UTF-8");
                        } catch (Exception ignored) {
                            return raw;
                        }
                    }
                }
            }
        }
        return safeName("", url);
    }

    private static void copy(InputStream input, OutputStream output) throws IOException {
        byte[] buffer = new byte[64 * 1024];
        long total = 0;
        int count;
        while ((count = input.read(buffer)) != -1) {
            total += count;
            if (total > MAX_TEMP_BYTES) throw new IOException("文件超过 512 MiB 限制");
            output.write(buffer, 0, count);
        }
        output.flush();
    }

    private static File unique(File dir, String name) {
        File target = new File(dir, name);
        if (!target.exists()) return target;

        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";

        for (int i = 1; i < 200; i++) {
            target = new File(dir, base + " (" + i + ")" + ext);
            if (!target.exists()) return target;
        }
        return new File(dir, base + "-" + System.currentTimeMillis() + ext);
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static String key(long id) {
        return "download." + id + ".name";
    }

    private static void remember(Context context, long id, String name) {
        prefs(context).edit().putString(key(id), name).apply();
    }

    private static String nameOf(Context context, long id, Cursor cursor) {
        String fromPrefs = prefs(context).getString(key(id), null);
        if (fromPrefs != null && !fromPrefs.isEmpty()) return fromPrefs;

        String local = stringAt(cursor, DownloadManager.COLUMN_LOCAL_URI);
        if (local != null) {
            try {
                String path = Uri.parse(local).getLastPathSegment();
                if (path != null && !path.isEmpty()) return path;
            } catch (RuntimeException ignored) { }
        }

        String title = stringAt(cursor, DownloadManager.COLUMN_TITLE);
        return title == null || title.isEmpty() ? "下载文件" : title;
    }

    private static String statusName(int status) {
        switch (status) {
            case DownloadManager.STATUS_PENDING: return "pending";
            case DownloadManager.STATUS_RUNNING: return "running";
            case DownloadManager.STATUS_PAUSED: return "paused";
            case DownloadManager.STATUS_SUCCESSFUL: return "success";
            case DownloadManager.STATUS_FAILED: return "failed";
            default: return status < 0 ? "unknown" : "failed";
        }
    }

    private static long longAt(Cursor cursor, String column, long fallback) {
        int index = cursor.getColumnIndex(column);
        if (index < 0 || cursor.isNull(index)) return fallback;
        try {
            return cursor.getLong(index);
        } catch (RuntimeException e) {
            return fallback;
        }
    }

    private static String stringAt(Cursor cursor, String column) {
        int index = cursor.getColumnIndex(column);
        if (index < 0 || cursor.isNull(index)) return null;
        try {
            return cursor.getString(index);
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static long parseId(String value) {
        try {
            return Long.parseLong(value);
        } catch (Exception e) {
            return -1L;
        }
    }
}

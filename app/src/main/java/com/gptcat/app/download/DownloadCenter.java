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
import com.gptcat.app.web.UserAgent;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * 下载任务中心：
 * 1) http(s) 交给系统 DownloadManager，任务列表直接读系统库；
 * 2) 网页生成的 blob:/data: 文件先落应用私有目录，完成后再登记到「下载」目录。
 */
public final class DownloadCenter {
    public static final String SUBDIR = "佐助";

    private static final String PREFS = "gptcat-downloads";
    private static final String KEY_LOCAL = "localTasks";
    private static final long MAX_TEMP_BYTES = 128L * 1024 * 1024;
    private static final Pattern MIME = Pattern.compile("[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+");

    private DownloadCenter() { }

    // ---------------------------------------------------------------- 系统下载

    /** 返回任务 ID 字符串；返回空串表示未能创建。 */
    public static String enqueue(Context context, String url, String name, String mime) {
        if (!UrlPolicy.isHttpsUrl(url)) return "";

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
                request.setMimeType(safeMime(mime));
            }

            // Cookie 只发给站点自己的主机：DownloadManager 可能跟随重定向，
            // 把站点凭据带到别的域上有风险，而外站 CDN 本来也不需要它。
            if (UrlPolicy.isTrusted(url)) {
                String cookie = CookieManager.getInstance().getCookie(url);
                if (cookie != null && !cookie.trim().isEmpty()) {
                    request.addRequestHeader("Cookie", cookie);
                }
            }

            // 用 WebView 的 UA，而不是 Dalvik 的 System.getProperty("http.agent")：
            // 站点 Cookie（如 cf_clearance）可能绑定 UA，UA 不一致会被判成换客户端而拒绝下载。
            String agent = UserAgent.current();
            if (!agent.trim().isEmpty()) {
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

            int scanned = 0;
            while (cursor.moveToNext() && scanned++ < 500) {
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

        int visible = Math.min(30, rows.size());
        for (int i = 0; i < visible; i++) {
            Object[] row = rows.get(i);
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
            int removed = manager.remove(id);
            prefs(context).edit().remove(key(id)).apply();
            return removed > 0;
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
    private static boolean localLoaded = false;

    /**
     * 本地任务落盘后会写进 SharedPreferences。
     * 只在内存里存是不够的：网页生成的 blob/data 文件下载完，进程一重启列表就空了，
     * 而文件其实还在「下载/佐助」里 —— 用户会以为下载没成功。
     */
    private static void loadLocal(Context context) {
        synchronized (LOCAL) {
            if (localLoaded) return;
            if (context == null) return;

            localLoaded = true;

            String raw;
            try {
                raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                        .getString(KEY_LOCAL, "");
            } catch (RuntimeException e) {
                return;
            }

            if (raw == null || raw.isEmpty()) return;

            try {
                JSONArray array = new JSONArray(raw);
                for (int i = 0; i < array.length() && LOCAL.size() < 20; i++) {
                    JSONObject item = array.optJSONObject(i);
                    if (item == null) continue;

                    String id = item.optString("id", "");
                    String name = item.optString("name", "");
                    String uri = item.optString("uri", "");
                    if (id.isEmpty() || uri.isEmpty()) continue;

                    LOCAL.add(new Object[] {
                            id, name, Uri.parse(uri),
                            item.optLong("bytes", 0L), item.optLong("time", 0L) });
                }
            } catch (Exception ignored) { }
        }
    }

    private static void saveLocal(Context context) {
        if (context == null) return;

        JSONArray array = new JSONArray();
        synchronized (LOCAL) {
            for (Object[] entry : LOCAL) {
                try {
                    JSONObject item = new JSONObject();
                    item.put("id", entry[0]);
                    item.put("name", entry[1]);
                    item.put("uri", String.valueOf(entry[2]));
                    item.put("bytes", (Long) entry[3]);
                    item.put("time", (Long) entry[4]);
                    array.put(item);
                } catch (Exception ignored) { }
            }
        }

        try {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().putString(KEY_LOCAL, array.toString()).apply();
        } catch (RuntimeException ignored) { }
    }

    /** 登记一个已落盘的网页文件，返回带前缀的本地任务 ID。 */
    public static String rememberLocal(Context context, String name, Uri uri, long bytes) {
        String id = "local:" + java.util.UUID.randomUUID();
        loadLocal(context);

        synchronized (LOCAL) {
            LOCAL.add(0, new Object[] { id, name, uri, bytes, System.currentTimeMillis() });
            while (LOCAL.size() > 20) LOCAL.remove(LOCAL.size() - 1);
        }

        saveLocal(context);
        return id;
    }

    /** 本地任务列表，字段与系统任务保持一致，另外多一个 uri。 */
    public static String listLocal(Context context) {
        loadLocal(context);

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

    public static Uri localUriOf(Context context, String id) {
        loadLocal(context);

        synchronized (LOCAL) {
            for (Object[] entry : LOCAL) {
                if (entry[0].equals(id)) return (Uri) entry[2];
            }
        }
        return null;
    }

    public static boolean forgetLocal(Context context, String id) {
        loadLocal(context);

        boolean removed = false;
        Uri uri = null;
        synchronized (LOCAL) {
            for (int i = 0; i < LOCAL.size(); i++) {
                if (LOCAL.get(i)[0].equals(id)) {
                    uri = (Uri) LOCAL.get(i)[2];
                    LOCAL.remove(i);
                    removed = true;
                    break;
                }
            }
        }

        if (!removed) return false;
        saveLocal(context);
        if (uri != null) {
            try { context.getContentResolver().delete(uri, null, null); }
            catch (RuntimeException ignored) { }
        }
        return true;
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
        String type = safeMime(mime);

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
            try {
                if (resolver.update(target, values, null, null) == 0) {
                    resolver.delete(target, null, null);
                    throw new IOException("无法发布下载文件");
                }
            } catch (RuntimeException e) {
                try { resolver.delete(target, null, null); } catch (RuntimeException ignored) { }
                throw new IOException("无法发布下载文件", e);
            }
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
        final Uri uri;
        try {
            uri = context.getContentResolver()
                    .insert(MediaStore.Files.getContentUri("external"), values);
        } catch (RuntimeException e) {
            target.delete();
            throw new IOException("无法登记下载文件", e);
        }
        if (uri == null) {
            target.delete();
            throw new IOException("无法登记下载文件");
        }
        return uri;
    }

    // ---------------------------------------------------------------- 工具

    public static String safeName(String name, String url) {
        return FileNamePolicy.safeName(name, url);
    }

    /** Strip MIME parameters and reject malformed values before handing them to system APIs. */
    public static String safeMime(String mime) {
        String value = mime == null ? "" : mime.trim();
        int semicolon = value.indexOf(';');
        if (semicolon >= 0) value = value.substring(0, semicolon).trim();
        if (value.length() > 127 || !MIME.matcher(value).matches()) {
            return "application/octet-stream";
        }
        return value.toLowerCase(Locale.ROOT);
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
                        return safeName(java.net.URLDecoder.decode(raw, "UTF-8"), url);
                    } catch (Exception ignored) { }
                }
                if (item.regionMatches(true, 0, "filename=", 0, 9)) {
                    String raw = item.substring(9).trim().replace("\"", "");
                    if (!raw.isEmpty()) {
                        try {
                            return safeName(java.net.URLDecoder.decode(raw, "UTF-8"), url);
                        } catch (Exception ignored) {
                            return safeName(raw, url);
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
            if (total > MAX_TEMP_BYTES) throw new IOException("文件超过 128 MiB 限制");
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

    /** 与 DownloadCompleteReceiver 共用同一个 prefs 文件（历史上两边名字不一致）。 */
    public static SharedPreferences sharedPrefs(Context context) {
        return prefs(context);
    }

    /** 与 DownloadCompleteReceiver 共用同一个键格式。 */
    public static String nameKey(long id) {
        return key(id);
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

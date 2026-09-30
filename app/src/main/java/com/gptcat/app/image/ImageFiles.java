package com.gptcat.app.image;

import android.content.Context;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.io.OutputStream;
import java.util.Arrays;
import java.util.Comparator;
import java.util.regex.Pattern;

/** 仅访问应用私有图片缓存；所有输入均设大小与缓存总量上限。 */
public final class ImageFiles {
    public static final long MAX_BYTES = 32L * 1024 * 1024;

    private static final long MAX_CACHE_BYTES = 64L * 1024 * 1024;
    private static final int MAX_CACHE_FILES = 12;
    private static final long MAX_AGE_MS = 6L * 60 * 60 * 1000;
    private static final long ACTIVE_GRACE_MS = 2L * 60 * 1000;
    private static final Pattern CACHE_NAME =
            Pattern.compile("image-[A-Za-z0-9-]+\\.cache");

    private ImageFiles() { }

    private static File directory(Context context) throws IOException {
        File dir = new File(context.getCacheDir(), "gptcat-images");
        if (!dir.isDirectory() && !dir.mkdirs() && !dir.isDirectory()) {
            throw new IOException("无法创建图片缓存");
        }
        return dir;
    }

    public static File create(Context context) throws IOException {
        File dir = directory(context);
        prune(dir);
        return File.createTempFile("image-", ".cache", dir);
    }

    public static File resolve(Context context, String name) throws IOException {
        if (name == null || !CACHE_NAME.matcher(name).matches()) {
            throw new IOException("无效图片缓存");
        }

        File dir = directory(context).getCanonicalFile();
        File file = new File(dir, name).getCanonicalFile();
        if (!dir.equals(file.getParentFile())
                || !file.isFile()
                || file.length() == 0
                || file.length() > MAX_BYTES) {
            throw new IOException("图片缓存已失效，请重新打开图片");
        }

        // 标记为正在使用，容量清理会优先保留最近访问的文件。
        file.setLastModified(System.currentTimeMillis());
        return file;
    }

    /**
     * 缓存策略：
     * 1) 超过 6 小时的临时图片直接删除；
     * 2) 其余文件按最旧优先缩减到约 64 MiB / 12 个；
     * 3) 两分钟内刚访问过的文件暂不因容量规则删除，避免误删正在查看的图片。
     */
    private static void prune(File dir) {
        File[] files = cacheFiles(dir);
        if (files.length == 0) return;

        long now = System.currentTimeMillis();
        long cutoff = now - MAX_AGE_MS;

        for (File file : files) {
            if (file.lastModified() < cutoff) file.delete();
        }

        files = cacheFiles(dir);
        Arrays.sort(files, Comparator.comparingLong(File::lastModified));

        long total = 0;
        int count = 0;
        for (File file : files) {
            total += Math.max(0L, file.length());
            count++;
        }

        for (File file : files) {
            if (count <= MAX_CACHE_FILES && total <= MAX_CACHE_BYTES) break;
            if (now - file.lastModified() < ACTIVE_GRACE_MS) continue;

            long length = Math.max(0L, file.length());
            if (file.delete()) {
                total = Math.max(0L, total - length);
                count--;
            }
        }
    }

    private static File[] cacheFiles(File dir) {
        File[] files = dir.listFiles(file -> file.isFile()
                && CACHE_NAME.matcher(file.getName()).matches());
        return files == null ? new File[0] : files;
    }

    /** 返回 "文件数|字节数"；用于设置面板展示。 */
    public static String stats(Context context) {
        try {
            File[] files = cacheFiles(directory(context));
            long bytes = 0;
            for (File file : files) {
                bytes += Math.max(0L, file.length());
            }
            return files.length + "|" + bytes;
        } catch (IOException e) {
            return "0|0";
        }
    }

    /** 清空图片缓存，返回释放的字节数。 */
    public static long clear(Context context) {
        long freed = 0;

        try {
            for (File file : cacheFiles(directory(context))) {
                long length = Math.max(0L, file.length());
                if (file.delete()) freed += length;
            }
        } catch (IOException ignored) { }

        return freed;
    }

    /** 判断某个缓存文件名是否合法，供清理时过滤。 */
    public static boolean isCacheName(String name) {
        return name != null && CACHE_NAME.matcher(name).matches();
    }

    public static long copy(InputStream input, OutputStream output) throws IOException {
        byte[] buffer = new byte[32 * 1024];
        long total = 0;
        int count;

        while ((count = input.read(buffer)) != -1) {
            checkInterrupted();
            total += count;
            if (total > MAX_BYTES) throw new IOException("图片超过 32 MiB 限制");
            output.write(buffer, 0, count);
        }
        return total;
    }

    public static void checkInterrupted() throws InterruptedIOException {
        if (Thread.currentThread().isInterrupted()) {
            throw new InterruptedIOException("已取消");
        }
    }
}

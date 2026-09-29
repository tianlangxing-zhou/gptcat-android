package com.gptcat.app.image;

import android.content.Context;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.io.OutputStream;

/** 仅访问应用私有图片缓存；所有输入均设大小上限。 */
public final class ImageFiles {
    public static final long MAX_BYTES = 32L * 1024 * 1024;
    private static final long MAX_AGE_MS = 24L * 60 * 60 * 1000;

    private ImageFiles() { }

    private static File directory(Context context) throws IOException {
        File dir = new File(context.getCacheDir(), "gptcat-images");
        if (!dir.isDirectory() && !dir.mkdirs() && !dir.isDirectory()) throw new IOException("无法创建图片缓存");
        return dir;
    }

    public static File create(Context context) throws IOException {
        File dir = directory(context);
        File[] stale = dir.listFiles();
        long cutoff = System.currentTimeMillis() - MAX_AGE_MS;
        if (stale != null) {
            for (File file : stale) {
                if (file.isFile() && file.lastModified() < cutoff) file.delete();
            }
        }
        return File.createTempFile("image-", ".cache", dir);
    }

    public static File resolve(Context context, String name) throws IOException {
        if (name == null || !name.matches("image-[A-Za-z0-9-]+\\.cache")) {
            throw new IOException("无效图片缓存");
        }
        File dir = directory(context).getCanonicalFile();
        File file = new File(dir, name).getCanonicalFile();
        if (!dir.equals(file.getParentFile()) || !file.isFile()
                || file.length() == 0 || file.length() > MAX_BYTES) {
            throw new IOException("图片缓存已失效，请重新打开图片");
        }
        file.setLastModified(System.currentTimeMillis());
        return file;
    }

    public static long copy(InputStream input, OutputStream output) throws IOException {
        byte[] buffer = new byte[16 * 1024];
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
        if (Thread.currentThread().isInterrupted()) throw new InterruptedIOException("已取消");
    }
}

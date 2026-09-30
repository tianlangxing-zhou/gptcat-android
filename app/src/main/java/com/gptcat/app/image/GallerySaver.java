package com.gptcat.app.image;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.webkit.MimeTypeMap;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.UUID;

/** 后台复制原图，不在主线程压缩 Bitmap，失败时删除未完成的相册条目。 */
public final class GallerySaver {
    private GallerySaver() { }

    /** 统一只抛 IOException，调用方不用关心 MediaStore 的各种运行时异常。 */
    public static void save(Context context, ImageLoader.Result image) throws IOException {
        try {
            saveInternal(context, image);
        } catch (RuntimeException e) {
            // 存储不可用、权限被撤销或 MIME 被拒时，MediaStore 会抛
            // IllegalArgumentException / IllegalStateException / SecurityException。
            // 不转换的话调用方只 catch IOException，"正在保存"状态会一直卡住。
            throw new IOException("保存到相册失败", e);
        }
    }

    private static void saveInternal(Context context, ImageLoader.Result image) throws IOException {
        ContentResolver resolver = context.getContentResolver();
        String extension = MimeTypeMap.getSingleton().getExtensionFromMimeType(image.mimeType);
        if (extension == null) extension = "img";
        String name = "gptcat_" + System.currentTimeMillis() + "_"
                + UUID.randomUUID().toString().substring(0, 8) + "." + extension;

        ContentValues values = new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME, name);
        values.put(MediaStore.Images.Media.MIME_TYPE, image.mimeType);
        if (Build.VERSION.SDK_INT >= 29) {
            values.put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/GPTCat");
            values.put(MediaStore.Images.Media.IS_PENDING, 1);
        } else {
            File dir = new File(Environment.getExternalStoragePublicDirectory(
                    Environment.DIRECTORY_PICTURES), "GPTCat");
            if (!dir.isDirectory() && !dir.mkdirs() && !dir.isDirectory()) {
                throw new IOException("无法创建相册目录");
            }
            values.put(MediaStore.Images.Media.DATA, new File(dir, name).getAbsolutePath());
        }

        Uri uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
        if (uri == null) throw new IOException("无法创建相册文件");

        boolean success = false;
        try {
            try (FileInputStream input = new FileInputStream(image.file);
                 OutputStream output = resolver.openOutputStream(uri)) {
                if (output == null) throw new IOException("无法写入相册");
                if (ImageFiles.copy(input, output) == 0) throw new IOException("图片为空");
            }
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues ready = new ContentValues();
                ready.put(MediaStore.Images.Media.IS_PENDING, 0);
                if (resolver.update(uri, ready, null, null) == 0) {
                    throw new IOException("相册发布失败");
                }
            }
            success = true;
        } finally {
            if (!success) {
                try { resolver.delete(uri, null, null); }
                catch (RuntimeException ignored) { }
            }
        }
    }
}

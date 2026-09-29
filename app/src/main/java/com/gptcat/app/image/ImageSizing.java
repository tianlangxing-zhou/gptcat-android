package com.gptcat.app.image;

/** 独立的采样策略，限制预览像素数；保存原文件不受采样影响。 */
public final class ImageSizing {
    private static final long MAX_PIXELS = 4L * 1024 * 1024;
    private ImageSizing() { }

    public static int sampleSize(int width, int height, int targetWidth, int targetHeight) {
        int sample = 1;
        targetWidth = Math.max(1, targetWidth);
        targetHeight = Math.max(1, targetHeight);
        while (sample < (1 << 30)) {
            long w = ((long) width + sample - 1) / sample;
            long h = ((long) height + sample - 1) / sample;
            if (w * h <= MAX_PIXELS && w <= 4096 && h <= 4096
                    && !(w / 2 >= targetWidth && h / 2 >= targetHeight)) break;
            sample *= 2;
        }
        return sample;
    }
}

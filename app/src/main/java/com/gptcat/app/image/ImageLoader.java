package com.gptcat.app.image;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.webkit.CookieManager;

import com.gptcat.app.web.UrlPolicy;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.net.HttpURLConnection;
import java.net.URL;

/** 一个实例对应一次可取消请求，下载落盘后仅解码有限大小的预览。 */
public final class ImageLoader {
    private final Context context;
    private volatile boolean cancelled;
    private volatile HttpURLConnection connection;

    public static final class Result {
        public final File file;
        public final Bitmap preview;
        public final String mimeType;

        private Result(File file, Bitmap preview, String mimeType) {
            this.file = file;
            this.preview = preview;
            this.mimeType = mimeType;
        }
    }

    public ImageLoader(Context context) {
        this.context = context.getApplicationContext();
    }

    public void cancel() {
        cancelled = true;
        HttpURLConnection active = connection;
        if (active != null) active.disconnect();
    }

    public Result load(String url, String cacheName, int width, int height) throws IOException {
        File file = null;
        boolean downloaded = false;
        Bitmap preview = null;

        try {
            checkCancelled();

            if (cacheName != null) {
                try {
                    file = ImageFiles.resolve(context, cacheName);
                } catch (IOException e) {
                    if (!UrlPolicy.isHttpUrl(url)) throw e;
                }
            }

            if (file == null) {
                file = ImageFiles.create(context);
                downloaded = true;
                download(url, file);
            }

            checkCancelled();

            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(file.getAbsolutePath(), bounds);
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0 || bounds.outMimeType == null) {
                throw new IOException("图片格式不受当前系统支持");
            }

            BitmapFactory.Options options = new BitmapFactory.Options();
            options.inSampleSize =
                    ImageSizing.sampleSize(bounds.outWidth, bounds.outHeight, width, height);
            preview = BitmapFactory.decodeFile(file.getAbsolutePath(), options);
            if (preview == null) throw new IOException("图片解析失败");

            checkCancelled();
            return new Result(file, preview, bounds.outMimeType);
        } catch (IOException | RuntimeException | OutOfMemoryError e) {
            if (preview != null && !preview.isRecycled()) preview.recycle();

            // 来自 Intent 的缓存可能正被新 Activity 复用，仅清理本次下载。
            if (downloaded && file != null) file.delete();

            if (e instanceof IOException) throw (IOException) e;
            throw new IOException("无法加载图片，请关闭其他页面后重试", e);
        }
    }

    private void checkCancelled() throws InterruptedIOException {
        ImageFiles.checkInterrupted();
        if (cancelled) throw new InterruptedIOException("已取消");
    }

    private void download(String source, File destination) throws IOException {
        if (!UrlPolicy.isHttpUrl(source)) throw new IOException("无效的图片地址");

        URL url = new URL(source);
        for (int redirect = 0; redirect <= 5; redirect++) {
            checkCancelled();

            HttpURLConnection current = (HttpURLConnection) url.openConnection();
            connection = current;
            try {
                checkCancelled();

                current.setInstanceFollowRedirects(false);
                current.setUseCaches(false);
                current.setConnectTimeout(15000);
                current.setReadTimeout(15000);
                current.setRequestProperty("Accept", "image/*,*/*;q=0.8");

                String userAgent = System.getProperty("http.agent");
                if (userAgent != null && !userAgent.isEmpty()) {
                    current.setRequestProperty("User-Agent", userAgent);
                }

                // 每次跳转重新按目标域取 Cookie，不把上一域凭据带到下一域。
                String cookie = CookieManager.getInstance().getCookie(url.toString());
                if (cookie != null) current.setRequestProperty("Cookie", cookie);

                int status = current.getResponseCode();
                if (status == 301 || status == 302 || status == 303
                        || status == 307 || status == 308) {
                    String location = current.getHeaderField("Location");
                    if (location == null) throw new IOException("图片重定向地址缺失");

                    URL next = new URL(url, location);
                    if (!UrlPolicy.isHttpUrl(next.toString())
                            || ("https".equalsIgnoreCase(url.getProtocol())
                            && !"https".equalsIgnoreCase(next.getProtocol()))) {
                        throw new IOException("不支持的图片重定向");
                    }

                    url = next;
                    continue;
                }

                if (status < 200 || status >= 300) {
                    throw new IOException("图片请求失败 (HTTP " + status + ")");
                }

                long contentLength = current.getContentLengthLong();
                if (contentLength > ImageFiles.MAX_BYTES) {
                    throw new IOException("图片超过 32 MiB 限制");
                }

                try (InputStream input = current.getInputStream();
                     FileOutputStream output = new FileOutputStream(destination, false)) {
                    if (ImageFiles.copy(input, output) == 0) {
                        throw new IOException("图片为空");
                    }
                    output.getFD().sync();
                }

                checkCancelled();
                return;
            } finally {
                current.disconnect();
                if (connection == current) connection = null;
            }
        }

        throw new IOException("图片重定向次数过多");
    }
}

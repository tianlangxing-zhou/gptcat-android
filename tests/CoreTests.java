import com.gptcat.app.image.ImageSizing;
import com.gptcat.app.web.UrlPolicy;

/** 不依赖 Android SDK 的边界回归测试。运行方法见 README_优化说明.md。 */
public final class CoreTests {
    private static int checks;
    private static void check(boolean condition, String message) {
        checks++;
        if (!condition) throw new AssertionError(message);
    }

    public static void main(String[] args) {
        String[] trusted = { "https://gptcat.cc/", "https://share.gptcat.cc/chat?a=1",
                "https://chat2.gptcat.cc/", "https://SHARE.GPTCAT.CC/path", "https://share.gptcat.cc/会话" };
        for (String url : trusted) check(UrlPolicy.isTrusted(url), "trusted: " + url);
        String[] untrusted = { null, "", "https://evilgptcat.cc/", "https://gptcat.cc.evil.com/",
                "http://share.gptcat.cc/", "javascript:alert(1)", "file:///sdcard/a.png",
                "https://gptcat.cc@evil.example/", "https://evil@share.gptcat.cc/",
                "data:image/png;base64,abc", "https://share.gptcat.cc\n.evil/", "//share.gptcat.cc/" };
        for (String url : untrusted) check(!UrlPolicy.isTrusted(url), "untrusted: " + url);
        check(UrlPolicy.isHttpUrl("https://cdn.example.com/a.jpg?key=x"), "external image URL");
        check(UrlPolicy.isHttpUrl("http://cdn.example.com/a.jpg"), "legacy HTTP URL parsing");
        check(!UrlPolicy.isHttpUrl("content://test/a"), "reject content input");
        check(!UrlPolicy.isHttpUrl("https://cdn.example.com/" + new String(new char[8192])), "URL size bound");
        check(ImageSizing.sampleSize(100, 100, 1080, 1920) == 1, "small image unchanged");
        check(ImageSizing.sampleSize(8000, 8000, 1080, 1920) == 4, "64 MP image samples to 4 MP");
        int[] dimensions = { 1, 24, 200, 1000, 2048, 4096, 8000, 50000, Integer.MAX_VALUE };
        for (int width : dimensions) {
            for (int height : dimensions) {
                int sample = ImageSizing.sampleSize(width, height, 1080, 1920);
                long w = ((long) width + sample - 1) / sample;
                long h = ((long) height + sample - 1) / sample;
                check(sample > 0 && (sample & (sample - 1)) == 0, "power of two");
                check(w * h <= 4L * 1024 * 1024, "preview pixel limit");
                check(w <= 4096 && h <= 4096, "preview dimension limit");
            }
        }
        System.out.println("PASS: " + checks + " URL and image sizing assertions");
    }
}

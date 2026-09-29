package com.gptcat.app;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.AsyncTask;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.webkit.CookieManager;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.Toast;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

// 点击对话图片后进入的全屏查看页：可缩放查看 + 一键保存到相册(DCIM/Pictures/GPTCat)
public class ImageViewerActivity extends Activity {

    private ImageView imageView;
    private Bitmap current;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_image_viewer);
        imageView = findViewById(R.id.iv);
        Button close = findViewById(R.id.btnClose);
        Button save = findViewById(R.id.btnSave);
        close.setOnClickListener(v -> finish());
        save.setOnClickListener(v -> saveToGallery());
        load(getIntent().getStringExtra("image"));
    }

    // 已有实例时再次收到图片(如连点不同图)：重投 intent 重新加载
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        current = null;
        imageView.setImageBitmap(null);
        load(intent.getStringExtra("image"));
    }

    private void load(String payload) {
        if (payload == null || payload.isEmpty()) return;
        if (payload.startsWith("data:image")) {
            try {
                String b64 = payload.substring(payload.indexOf(',') + 1);
                byte[] data = android.util.Base64.decode(b64, android.util.Base64.DEFAULT);
                current = BitmapFactory.decodeByteArray(data, 0, data.length);
                imageView.setImageBitmap(current);
            } catch (Exception e) {
                Toast.makeText(this, "图片解析失败", Toast.LENGTH_SHORT).show();
            }
        } else {
            new LoadTask().execute(payload);
        }
    }

    // 后台拉取图片(带上站点 cookie，兼容需登录的图片)
    private class LoadTask extends AsyncTask<String, Void, Bitmap> {
        @Override
        protected Bitmap doInBackground(String... urls) {
            try {
                URL u = new URL(urls[0]);
                HttpURLConnection c = (HttpURLConnection) u.openConnection();
                c.setInstanceFollowRedirects(true);
                c.setConnectTimeout(15000);
                c.setReadTimeout(15000);
                String cookie = CookieManager.getInstance().getCookie(urls[0]);
                if (cookie != null) c.setRequestProperty("Cookie", cookie);
                InputStream is = c.getInputStream();
                Bitmap bm = BitmapFactory.decodeStream(is);
                is.close();
                return bm;
            } catch (Exception e) {
                return null;
            }
        }

        @Override
        protected void onPostExecute(Bitmap bm) {
            if (bm == null) {
                Toast.makeText(ImageViewerActivity.this, "图片加载失败(可能需先登录)", Toast.LENGTH_SHORT).show();
                return;
            }
            current = bm;
            imageView.setImageBitmap(bm);
        }
    }

    // 写入系统相册(Pictures/GPTCat)，无需存储权限(Android10+ 作用域存储)
    private void saveToGallery() {
        if (current == null) {
            Toast.makeText(this, "没有可保存的图片", Toast.LENGTH_SHORT).show();
            return;
        }
        try {
            String name = "gptcat_" + System.currentTimeMillis() + ".png";
            ContentValues v = new ContentValues();
            v.put(MediaStore.Images.Media.DISPLAY_NAME, name);
            v.put(MediaStore.Images.Media.MIME_TYPE, "image/png");
            if (Build.VERSION.SDK_INT >= 29) {
                v.put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/GPTCat");
            }
            Uri uri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v);
            OutputStream os = getContentResolver().openOutputStream(uri);
            current.compress(Bitmap.CompressFormat.PNG, 100, os);
            os.close();
            Toast.makeText(this, "已保存到相册 Pictures/GPTCat", Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(this, "保存失败：" + e.getMessage(), Toast.LENGTH_SHORT).show();
        }
    }
}

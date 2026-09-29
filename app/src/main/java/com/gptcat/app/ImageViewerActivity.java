package com.gptcat.app;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.net.Uri;
import android.os.AsyncTask;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.view.MotionEvent;
import android.view.ScaleGestureDetector;
import android.view.View;
import android.webkit.CookieManager;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.Toast;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

// 点击对话图片后进入的全屏查看页：双指缩放/单指拖动 + 一键保存到相册
public class ImageViewerActivity extends Activity {

    private ImageView imageView;
    private Bitmap current;
    private final Matrix matrix = new Matrix();
    private ScaleGestureDetector scaleDetector;
    private float lastX, lastY;
    private boolean dragging = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_image_viewer);
        imageView = findViewById(R.id.iv);
        Button close = findViewById(R.id.btnClose);
        Button save = findViewById(R.id.btnSave);
        close.setOnClickListener(v -> finish());
        save.setOnClickListener(v -> saveToGallery());
        setupGestures();
        load(getIntent().getStringExtra("image"));
    }

    // 已有实例时再次收到图片(连点不同图)：重投 intent 重新加载
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
                Bitmap bm = BitmapFactory.decodeByteArray(data, 0, data.length);
                if (bm == null) {
                    Toast.makeText(this, "图片解析失败", Toast.LENGTH_SHORT).show();
                    return;
                }
                show(bm);
            } catch (Exception e) {
                Toast.makeText(this, "图片解析失败", Toast.LENGTH_SHORT).show();
            }
        } else {
            new LoadTask().execute(payload);
        }
    }

    // 后台拉取图片(带站点 cookie，兼容需登录的图)
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
            show(bm);
        }
    }

    // 双指缩放(0.5x~10x，以双指中心为轴) + 单指拖动
    private void setupGestures() {
        scaleDetector = new ScaleGestureDetector(this, new ScaleGestureDetector.SimpleOnScaleGestureListener() {
            @Override
            public boolean onScale(ScaleGestureDetector d) {
                float factor = d.getScaleFactor();
                float[] v = new float[9];
                matrix.getValues(v);
                float cur = v[Matrix.MSCALE_X];
                float next = Math.max(0.5f, Math.min(10f, cur * factor));
                matrix.postScale(next / cur, next / cur, d.getFocusX(), d.getFocusY());
                imageView.setImageMatrix(matrix);
                return true;
            }
        });
        imageView.setOnTouchListener(new View.OnTouchListener() {
            @Override
            public boolean onTouch(View v, MotionEvent ev) {
                scaleDetector.onTouchEvent(ev);
                switch (ev.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        lastX = ev.getX();
                        lastY = ev.getY();
                        dragging = true;
                        break;
                    case MotionEvent.ACTION_MOVE:
                        if (!scaleDetector.isInProgress() && dragging) {
                            matrix.postTranslate(ev.getX() - lastX, ev.getY() - lastY);
                            imageView.setImageMatrix(matrix);
                        }
                        lastX = ev.getX();
                        lastY = ev.getY();
                        break;
                    case MotionEvent.ACTION_UP:
                    case MotionEvent.ACTION_CANCEL:
                        dragging = false;
                        break;
                    default:
                        break;
                }
                return true;
            }
        });
    }

    // 首次显示按 fitCenter 初始化矩阵，之后的缩放/拖动基于此
    private void show(Bitmap bm) {
        current = bm;
        imageView.setImageBitmap(bm);
        imageView.post(new Runnable() {
            @Override
            public void run() { fitImage(); }
        });
    }

    private void fitImage() {
        if (current == null || imageView.getWidth() == 0) return;
        float vw = imageView.getWidth(), vh = imageView.getHeight();
        float bw = current.getWidth(), bh = current.getHeight();
        float s = Math.min(vw / bw, vh / bh);
        matrix.reset();
        matrix.postScale(s, s);
        matrix.postTranslate((vw - bw * s) / 2f, (vh - bh * s) / 2f);
        imageView.setScaleType(ImageView.ScaleType.MATRIX);
        imageView.setImageMatrix(matrix);
    }

    // 写入系统相册 Pictures/GPTCat
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

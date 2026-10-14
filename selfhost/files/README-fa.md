# نصب همصحبت روی سرور شخصی (مثلاً VPS ایرانی)

این پوشه همه‌چیز لازم را دارد: `server.mjs` (کل سرور در یک فایل) و پوشه‌ی `public` (خود برنامه).
نیازمندی‌ها: یک VPS لینوکسی (اوبونتو ۲۲ یا ۲۴)، **Node.js نسخه‌ی ۲۲.۵ یا بالاتر** و یک دامنه (یا زیردامنه).
حدود ۱ گیگ رم و ۱ هسته برای ده‌ها نفر کافی است.

## ۱. نصب Node.js و Caddy

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt install -y nodejs caddy
```

(اگر از داخل ایران مخزن‌ها باز نشدند، از آینه‌های داخلی مثل mirror.arvancloud.ir استفاده کنید.)

## ۲. کپی فایل‌ها

کل این پوشه را در مسیر `/opt/hamsohbat` روی سرور بگذارید (مثلاً با `scp` یا WinSCP)، بعد:

```bash
sudo mkdir -p /opt/hamsohbat/data
sudo chown -R www-data:www-data /opt/hamsohbat
sudo cp /opt/hamsohbat/hamsohbat.service /etc/systemd/system/
sudo systemctl enable --now hamsohbat
```

## ۳. HTTPS با Caddy

در فایل `Caddyfile` دامنه را عوض کنید و بعد:

```bash
sudo cp /opt/hamsohbat/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

حالا برنامه روی `https://دامنه‌ی-شما` بالاست. **بدون HTTPS میکروفون و دوربین کار نمی‌کنند.**

## ۴. (پیشنهادی) سرور TURN برای تماس‌ها

اگر بعضی‌ها (مخصوصاً با اینترنت موبایل) صدای همدیگر را نمی‌شنوند، coturn نصب کنید:

```bash
sudo apt install -y coturn
```

در `/etc/turnserver.conf` این خطوط را بگذارید و پورت‌های 3478 و 49152-65535 (UDP) را در فایروال باز کنید:

```
listening-port=3478
fingerprint
lt-cred-mech
user=hamsohbat:choose-a-password
realm=chat.example.ir
```

بعد در `hamsohbat.service` خط `ICE_SERVERS` را از حالت توضیح دربیاورید، مقدارها را درست کنید و اجرا کنید:

```bash
sudo systemctl daemon-reload && sudo systemctl restart hamsohbat coturn
```

## تنظیمات

| متغیر | کار |
| --- | --- |
| `PORT` / `HOST` | پورت و آدرسی که سرور گوش می‌دهد (پیش‌فرض 3000) |
| `DATA_DIR` | محل پایگاه‌داده و فایل‌ها (`hamsohbat.db`) — از همین فایل نسخه‌ی پشتیبان بگیرید |
| `REGISTRATION_CODE` | اگر مقدار داشته باشد، ثبت‌نام فقط با این کد ممکن است |
| `TRUST_PROXY` | اگر برنامه پشت پروکسی‌ای غیر از Caddy روی همین سرور است، `1` بگذارید تا IP واقعی کاربران (از `X-Forwarded-For`) برای محدودیت تلاش ورود و فهرست دستگاه‌ها استفاده شود |
| `ICE_SERVERS` | فهرست JSON سرورهای STUN/TURN |

## پشتیبان‌گیری

```bash
sudo sqlite3 /opt/hamsohbat/data/hamsohbat.db ".backup /root/hamsohbat-backup.db"
```

## اجرای سریع روی ویندوز برای تست

```bash
node server.mjs
```

و `http://localhost:3000` را باز کنید.

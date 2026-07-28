# Idesk — RustDesk tabanlı, landing page + kurumsal satın alma

Bu proje iki parçadan oluşur:

```
idesk/
├── public/index.html   → Statik frontend (giriş, kayıt, kurumsal satın alma, ÖDEAL checkout)
└── server/             → Node.js/Express backend (kullanıcı/şirket veritabanı + ÖDEAL ödeme entegrasyonu)
```

## Neden iki parça?

Tarayıcıda çalışan tek bir statik dosya; gerçek kullanıcı şifrelerini güvenle saklayamaz ve
ÖDEAL API gizli anahtarınızı (secret key) güvenle tutamaz — tarayıcıya konan her şeyi
herkes görebilir. Bu yüzden:

- **Frontend** (`public/index.html`) tek dosya statik HTML/CSS/JS olarak kaldı, istediğiniz gibi.
- **Backend** (`server/`) küçük bir Express API'si: kullanıcı/şirket kayıtlarını SQLite'ta
  tutar, şifreleri bcrypt ile hashler, ÖDEAL ile ödeme linki oluşturur.

## Kurulum

```bash
cd server
npm install
cp .env.example .env
# .env dosyasını kendi ÖDEAL merchant bilgilerinizle doldurun
npm start
```

Sunucu `http://localhost:3001` üzerinde çalışır. Frontend'i açtığınızda
(`public/index.html`), varsayılan olarak `/api` yoluna istek atar — bunu kendi
domaininize göre `index.html` içindeki `window.IDESK_API_BASE` değişkeniyle
değiştirebilirsiniz, ya da backend'i aynı domain altında `/api` reverse-proxy
olarak yayınlayabilirsiniz (nginx / Caddy ile kolayca yapılır).

## ÖDEAL entegrasyonu — yapmanız gerekenler

`server/index.js` içindeki `/api/payment/odeal/init` fonksiyonu ÖDEAL'in
Sanal POS / "Pay by Link" servisine genel bir örnek yapı ile istek atacak
şekilde hazırlandı. Ancak:

1. **Gerçek endpoint ve alan adlarını doğrulayın.** ÖDEAL'in resmi dokümantasyonu
   https://docs.odeal.com/sanalpos/tr/ adresinde. Bot erişimi engellendiği için
   bu döküman tarafımca otomatik okunamadı — Merchant Panel'inizden veya
   entegrasyon ekibinden (integration@odeal.com) tam istek/yanıt şemasını
   (token alma, ödeme linki oluşturma, webhook imza doğrulama) isteyin.
2. `.env` dosyasına `ODEAL_API_KEY`, `ODEAL_MERCHANT_ID`, `ODEAL_TERMINAL_ID`
   ve callback/redirect URL'lerinizi girin.
3. `getOdealAccessToken()` ve `/api/payment/odeal/init` içindeki path'leri,
   ÖDEAL'in size verdiği gerçek şema ile güncelleyin (alan adları farklıysa
   `body` içeriğini buna göre değiştirin).
4. `/api/payment/odeal/callback` webhook'unda, ÖDEAL'in gönderdiği imza/HMAC
   doğrulamasını mutlaka ekleyin — aksi halde herkes sahte "ödeme başarılı"
   bildirimi gönderebilir.
5. ÖDEAL bilgileri `.env`'de doldurulmadan test ederseniz, sistem gerçek bir
   ödeme linki üretmeden akışı test etmenize izin verir (uyarı mesajı döner).

## Fiyatlandırma mantığı

- Kişi başı: **500 ₺ / ay** (frontend'de `PRICE_PER_SEAT`, backend'de şirket
  kayıt akışında `seats` alanı ile hesaplanır).
- Şirket, ana sayfadaki sayaçla kişi sayısını seçer → "Şirket Girişi Yap ve
  Devam Et" ile şirket bilgilerini girer → sistem şirket kaydı oluşturur →
  ÖDEAL'e ödeme linki isteği atar → kullanıcı ÖDEAL'in ödeme sayfasına
  yönlendirilir → ödeme tamamlanınca webhook ile şirket `active` durumuna geçer.
- Şirkete özel kurumsal kod (`IDK-XXXXXX` formatında) kayıt anında otomatik
  üretilir ve `companies` tablosunda saklanır.

## Şifremi Unuttum (SMTP)

1. `.env` dosyasına domain postanızın SMTP bilgilerini girin (`SMTP_HOST`,
   `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`). idesk.com.tr için mail
   kutusu açtıysanız bu bilgileri genelde hosting panelinizden (cPanel/DirectAdmin)
   alırsınız.
2. `FRONTEND_BASE_URL` değişkenini `https://www.idesk.com.tr` olarak ayarlayın —
   e-postadaki sıfırlama linki bu adrese `/reset-password.html?token=...` şeklinde eklenir.
3. Akış: kullanıcı "Şifremi Unuttum" → e-posta girer → `/api/auth/forgot-password`
   çağrılır → kayıtlıysa 1 saat geçerli, tek kullanımlık bir token üretilip
   e-postayla gönderilir → kullanıcı linke tıklar → `reset-password.html` yeni
   şifreyi alır → `/api/auth/reset-password` ile şifre güncellenir.
4. Güvenlik notu: `forgot-password` endpoint'i, e-posta kayıtlı olsun ya da
   olmasın her zaman aynı başarı mesajını döner (user enumeration'ı önlemek için).
   `.env` doldurulmadan (SMTP_HOST boşken) test ederseniz, link konsola yazdırılır.

## Marka / görsel notu

Tasarım, ekran görüntüsündeki koyu tema ve alpemix.com'daki genel "uzak masaüstü"
sayfa yapısından ilham alınarak **"Idesk"** markası için sıfırdan yazıldı. Alpemix'in
kendi metinleri, logoları ve referans/müşteri logoları kullanılmadı — bunlar üçüncü
tarafların telif hakkına/markasına ait olduğu için kopyalanmadı. İsterseniz kendi
logonuzu ve referans listenizi ekleyebilirsiniz.

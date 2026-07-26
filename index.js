require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const fetch = require('node-fetch');
const Database = require('better-sqlite3');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());

// ---------------------------------------------------------------------------
// Veritabanı (SQLite dosyası: idesk.db). Prod'da bunu düzenli yedekleyin.
// ---------------------------------------------------------------------------
const db = new Database(path.join(__dirname, 'idesk.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    account_type TEXT NOT NULL DEFAULT 'individual', -- individual | company
    company_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS companies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    contact_name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    seats INTEGER NOT NULL,
    corporate_code TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending_payment', -- pending_payment | active | suspended
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'TRY',
    odeal_reference TEXT,
    status TEXT NOT NULL DEFAULT 'created', -- created | paid | failed
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.warn('UYARI: JWT_SECRET tanımlı değil. .env dosyanızı kontrol edin.');
}

function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, accountType: user.account_type },
    JWT_SECRET || 'gelistirme-icin-varsayilan-anahtar',
    { expiresIn: '7d' }
  );
}

// ---------------------------------------------------------------------------
// SMTP (Şifremi Unuttum e-postaları)
// ---------------------------------------------------------------------------
const mailTransporter = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 465),
      secure: String(process.env.SMTP_SECURE || 'true') === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    })
  : null;

if (!mailTransporter) {
  console.warn('UYARI: SMTP_HOST tanımlı değil. Şifremi unuttum e-postaları gönderilemeyecek.');
}

async function sendPasswordResetEmail(toEmail, resetUrl) {
  if (!mailTransporter) {
    console.log(`[DEV] Şifre sıfırlama linki (${toEmail}): ${resetUrl}`);
    return;
  }
  await mailTransporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: toEmail,
    subject: 'Idesk - Şifre Sıfırlama Talebiniz',
    html: `
      <div style="font-family:Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto;">
        <h2 style="color:#4f7cff;">Şifrenizi mi unuttunuz?</h2>
        <p>Idesk hesabınız için bir şifre sıfırlama talebi aldık. Aşağıdaki butona tıklayarak yeni bir şifre belirleyebilirsiniz. Bu talebi siz yapmadıysanız bu e-postayı yok sayabilirsiniz.</p>
        <p style="margin:28px 0;">
          <a href="${resetUrl}" style="background:#4f7cff;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;">Şifremi Sıfırla</a>
        </p>
        <p style="color:#8b93a7;font-size:13px;">Bağlantı 1 saat sonra geçersiz olur. Buton çalışmazsa şu linki tarayıcınıza yapıştırın: ${resetUrl}</p>
      </div>
    `
  });
}

function generateCorporateCode() {
  // Örn: IDK-7F3K9Q gibi kısa, benzersiz bir kurumsal kod üretir.
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `IDK-${random}`;
}

// ---------------------------------------------------------------------------
// AUTH: Kayıt ve Giriş
// ---------------------------------------------------------------------------
app.post('/api/auth/register', (req, res) => {
  try {
    const { fullName, email, password, accountType, companyName } = req.body;
    if (!fullName || !email || !password) {
      return res.status(400).json({ error: 'Ad soyad, e-posta ve şifre zorunludur.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Şifre en az 6 karakter olmalıdır.' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
      return res.status(409).json({ error: 'Bu e-posta ile zaten bir hesap var.' });
    }

    const passwordHash = bcrypt.hashSync(password, 10);
    const userId = uuidv4();
    let companyId = null;

    // Şirket hesabıysa boş bir şirket kaydı iskeleti oluşturulur; kişi sayısı ve
    // ödeme /api/company/register + /api/payment/odeal/init üzerinden tamamlanır.
    if (accountType === 'company' && companyName) {
      companyId = uuidv4();
      db.prepare(`
        INSERT INTO companies (id, name, contact_name, email, phone, seats, corporate_code, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_payment')
      `).run(companyId, companyName, fullName, email, '', 1, generateCorporateCode());
    }

    db.prepare(`
      INSERT INTO users (id, full_name, email, password_hash, account_type, company_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, fullName, email, passwordHash, accountType === 'company' ? 'company' : 'individual', companyId);

    const user = { id: userId, email, account_type: accountType };
    return res.json({ token: signToken(user), userId, companyId });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Kayıt sırasında bir hata oluştu.' });
  }
});

app.post('/api/auth/login', (req, res) => {
  try {
    const { email, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'E-posta veya şifre hatalı.' });
    }
    return res.json({ token: signToken(user), userId: user.id });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Giriş sırasında bir hata oluştu.' });
  }
});

// ---------------------------------------------------------------------------
// ŞİFREMİ UNUTTUM: 1) sıfırlama linki talep et
// ---------------------------------------------------------------------------
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'E-posta zorunludur.' });
    }

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

    // Güvenlik notu: kayıtlı olmayan bir e-posta için de aynı başarı mesajını
    // döndürüyoruz. Aksi halde "bu mail kayıtlı mı değil mi" bilgisini dışarıya
    // sızdırmış (user enumeration) oluruz.
    if (user) {
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 saat

      db.prepare(`
        INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at)
        VALUES (?, ?, ?, ?)
      `).run(uuidv4(), user.id, tokenHash, expiresAt);

      const resetUrl = `${process.env.FRONTEND_BASE_URL || ''}/reset-password.html?token=${rawToken}`;
      await sendPasswordResetEmail(user.email, resetUrl);
    }

    return res.json({ message: 'Eğer bu e-posta kayıtlıysa, sıfırlama linki gönderildi.' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'İstek işlenirken bir hata oluştu.' });
  }
});

// ---------------------------------------------------------------------------
// ŞİFREMİ UNUTTUM: 2) token ile yeni şifre belirle
// ---------------------------------------------------------------------------
app.post('/api/auth/reset-password', (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) {
      return res.status(400).json({ error: 'Token ve yeni şifre zorunludur.' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Şifre en az 6 karakter olmalıdır.' });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const record = db.prepare(`
      SELECT * FROM password_reset_tokens WHERE token_hash = ? AND used = 0
    `).get(tokenHash);

    if (!record) {
      return res.status(400).json({ error: 'Bağlantı geçersiz veya daha önce kullanılmış.' });
    }
    if (new Date(record.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: 'Bağlantının süresi dolmuş. Lütfen yeniden talep edin.' });
    }

    const passwordHash = bcrypt.hashSync(newPassword, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, record.user_id);
    db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE id = ?').run(record.id);

    return res.json({ message: 'Şifreniz başarıyla güncellendi. Şimdi giriş yapabilirsiniz.' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Şifre sıfırlanırken bir hata oluştu.' });
  }
});

// ---------------------------------------------------------------------------
// ŞİRKET KAYDI (toplu lisans satın alma akışının 1. adımı)
// ---------------------------------------------------------------------------
app.post('/api/company/register', (req, res) => {
  try {
    const { companyName, contactName, email, phone, seats } = req.body;
    if (!companyName || !contactName || !email || !phone || !seats) {
      return res.status(400).json({ error: 'Tüm şirket bilgileri zorunludur.' });
    }
    const companyId = uuidv4();
    const corporateCode = generateCorporateCode();
    db.prepare(`
      INSERT INTO companies (id, name, contact_name, email, phone, seats, corporate_code, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_payment')
    `).run(companyId, companyName, contactName, email, phone, seats, corporateCode);

    return res.json({ companyId, corporateCode });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Şirket kaydı oluşturulamadı.' });
  }
});

// ---------------------------------------------------------------------------
// ÖDEAL ÖDEME BAŞLATMA (Sanal POS - Pay by Link)
//
// ÖNEMLİ: Aşağıdaki uç nokta (endpoint) ve gövde (body) alanları, ÖDEAL'in
// "Sanal POS" / "Pay by Link" servisi için genel örnek yapıyı temsil eder.
// Gerçek alan adlarını ve URL'i ÖDEAL Merchant Panel'inizdeki API dokümanından
// (docs.odeal.com/sanalpos/tr) veya entegrasyon ekibinizden teyit edip
// ODEAL_API_BASE ve aşağıdaki path'i güncelleyin.
// ---------------------------------------------------------------------------
async function getOdealAccessToken() {
  const resp = await fetch(`${process.env.ODEAL_API_BASE}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiKey: process.env.ODEAL_API_KEY,
      merchantId: process.env.ODEAL_MERCHANT_ID
    })
  });
  if (!resp.ok) {
    throw new Error('ÖDEAL yetkilendirme (token) alınamadı.');
  }
  const data = await resp.json();
  return data.accessToken || data.token;
}

app.post('/api/payment/odeal/init', async (req, res) => {
  try {
    const { companyId, amount, currency, description } = req.body;
    if (!companyId || !amount) {
      return res.status(400).json({ error: 'Şirket ve tutar bilgisi zorunludur.' });
    }
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId);
    if (!company) {
      return res.status(404).json({ error: 'Şirket bulunamadı.' });
    }

    const paymentId = uuidv4();
    db.prepare(`
      INSERT INTO payments (id, company_id, amount, currency, status)
      VALUES (?, ?, ?, ?, 'created')
    `).run(paymentId, companyId, amount, currency || 'TRY');

    // ÖDEAL kimlik bilgileri girilmediyse (geliştirme ortamı) sahte bir ödeme
    // linkiyle akışı test edebilmeniz için erken dönüş yapılır.
    if (!process.env.ODEAL_API_KEY || process.env.ODEAL_API_KEY.includes('odeal-live-veya-test')) {
      return res.json({
        paymentId,
        redirectUrl: null,
        warning: 'ÖDEAL API bilgileri .env dosyasında tanımlı değil. Gerçek ödeme linki için ODEAL_API_KEY ve ilgili alanları doldurun.'
      });
    }

    const accessToken = await getOdealAccessToken();

    const linkResp = await fetch(`${process.env.ODEAL_API_BASE}/api/paymentLinks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`
      },
      body: JSON.stringify({
        merchantId: process.env.ODEAL_MERCHANT_ID,
        terminalId: process.env.ODEAL_TERMINAL_ID,
        amount,
        currency: currency || 'TRY',
        description: description || `Idesk Kurumsal Lisans - ${company.seats} kişi`,
        externalReferenceId: paymentId,
        callbackUrl: process.env.ODEAL_CALLBACK_URL,
        successRedirectUrl: process.env.ODEAL_SUCCESS_REDIRECT,
        failRedirectUrl: process.env.ODEAL_FAIL_REDIRECT
      })
    });

    if (!linkResp.ok) {
      const errBody = await linkResp.text();
      console.error('ÖDEAL ödeme linki oluşturma hatası:', errBody);
      return res.status(502).json({ error: 'ÖDEAL ödeme linki oluşturulamadı.' });
    }

    const linkData = await linkResp.json();
    db.prepare('UPDATE payments SET odeal_reference = ? WHERE id = ?')
      .run(linkData.referenceCode || linkData.id || null, paymentId);

    return res.json({
      paymentId,
      redirectUrl: linkData.paymentUrl || linkData.url
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Ödeme başlatılırken bir hata oluştu.' });
  }
});

// ---------------------------------------------------------------------------
// ÖDEAL CALLBACK (webhook) — ödeme sonucu bildirimi
// ÖDEAL Merchant Panel'inde bu URL'i ODEAL_CALLBACK_URL olarak tanımlayın.
// ---------------------------------------------------------------------------
app.post('/api/payment/odeal/callback', (req, res) => {
  try {
    // TODO: ÖDEAL'in gönderdiği imza/HMAC doğrulamasını burada yapın
    // (docs.odeal.com üzerindeki "webhook güvenliği" bölümüne bakın).
    const { externalReferenceId, status } = req.body;
    if (!externalReferenceId) {
      return res.status(400).json({ error: 'externalReferenceId eksik.' });
    }

    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(externalReferenceId);
    if (!payment) {
      return res.status(404).json({ error: 'Ödeme kaydı bulunamadı.' });
    }

    const newStatus = status === 'success' || status === 'paid' ? 'paid' : 'failed';
    db.prepare('UPDATE payments SET status = ? WHERE id = ?').run(newStatus, payment.id);

    if (newStatus === 'paid') {
      db.prepare("UPDATE companies SET status = 'active' WHERE id = ?").run(payment.company_id);
    }

    return res.json({ received: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Callback işlenirken hata oluştu.' });
  }
});

// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Idesk API http://localhost:${PORT} üzerinde çalışıyor.`);
});

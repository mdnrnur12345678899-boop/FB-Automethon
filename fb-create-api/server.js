import express from 'express';
import { faker } from '@faker-js/faker';
import puppeteer from 'puppeteer-core';
import { v4 as uuidv4 } from 'uuid';

const app = express();
app.use(express.json());

const sessions = new Map();

// ─── Profile Generator ───────────────────────────────────────────────────────
function generateProfile() {
  const gender = Math.random() > 0.5 ? 'male' : 'female';
  const firstName = faker.person.firstName(gender);
  const lastName = faker.person.lastName();
  const birthYear = new Date().getFullYear() - (18 + Math.floor(Math.random() * 17));
  const birthMonth = Math.floor(Math.random() * 12) + 1;
  const birthDay = Math.floor(Math.random() * 28) + 1;
  return { firstName, lastName, gender, birthYear, birthMonth, birthDay };
}

// ─── Browser Launch ──────────────────────────────────────────────────────────
async function launchBrowser() {
  return puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/chromium-browser',
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--user-agent=Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36'
    ]
  });
}

// ─── POST /api/fb/init ───────────────────────────────────────────────────────
app.post('/api/fb/init', async (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) {
    return res.status(400).json({ error: 'phone এবং password দাও' });
  }

  const sessionId = uuidv4();
  const profile = generateProfile();
  let browser, page;

  try {
    browser = await launchBrowser();
    page = await browser.newPage();

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    await page.goto('https://m.facebook.com/reg/', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    await page.waitForSelector('input[name="firstname"]');
    await page.type('input[name="firstname"]', profile.firstName, { delay: 80 });
    await page.type('input[name="lastname"]', profile.lastName, { delay: 80 });
    await page.type('input[name="reg_email__"]', phone, { delay: 60 });
    await page.type('input[name="reg_email_confirmation__"]', phone, { delay: 60 });
    await page.type('input[name="reg_passwd__"]', password, { delay: 70 });

    await page.select('select[name="birthday_day"]', String(profile.birthDay));
    await page.select('select[name="birthday_month"]', String(profile.birthMonth));
    await page.select('select[name="birthday_year"]', String(profile.birthYear));

    if (profile.gender === 'male') {
      await page.click('input[value="2"]');
    } else {
      await page.click('input[value="1"]');
    }

    await Promise.all([
      page.click('button[name="websubmit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 })
    ]);

    sessions.set(sessionId, {
      browser,
      page,
      profile,
      phone,
      password,
      createdAt: Date.now()
    });

    res.json({
      success: true,
      session_id: sessionId,
      profile: {
        name: `${profile.firstName} ${profile.lastName}`,
        dob: `${profile.birthDay}/${profile.birthMonth}/${profile.birthYear}`,
        gender: profile.gender
      },
      message: 'OTP তোমার নম্বরে গেছে। /api/fb/verify তে OTP দাও।'
    });

  } catch (err) {
    if (browser) await browser.close();
    sessions.delete(sessionId);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/fb/verify ─────────────────────────────────────────────────────
app.post('/api/fb/verify', async (req, res) => {
  const { session_id, otp } = req.body;
  if (!session_id || !otp) {
    return res.status(400).json({ error: 'session_id এবং otp দাও' });
  }

  const session = sessions.get(session_id);
  if (!session) {
    return res.status(404).json({ error: 'Session নেই বা মেয়াদ শেষ' });
  }

  const { browser, page, profile } = session;

  try {
    await page.waitForSelector('input[name="code"]', { timeout: 10000 })
      .catch(() => page.waitForSelector('input[name="confirm_code_field"]', { timeout: 5000 }));

    const otpField = await page.$('input[name="code"]')
      || await page.$('input[name="confirm_code_field"]');

    if (!otpField) throw new Error('OTP field পাওয়া যায়নি');

    await otpField.type(otp, { delay: 100 });

    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 })
    ]);

    const url = page.url();
    const cookies = await page.cookies();
    const cUserCookie = cookies.find(c => c.name === 'c_user');

    if (!cUserCookie && !url.includes('home')) {
      throw new Error('OTP ভুল অথবা FB checkpoint দিয়েছে');
    }

    const uid = cUserCookie?.value || 'unknown';
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    await browser.close();
    sessions.delete(session_id);

    res.json({
      success: true,
      uid,
      profile: {
        name: `${profile.firstName} ${profile.lastName}`,
        dob: `${profile.birthDay}/${profile.birthMonth}/${profile.birthYear}`,
        gender: profile.gender,
        phone: session.phone
      },
      cookies: cookieStr
    });

  } catch (err) {
    await browser.close();
    sessions.delete(session_id);
    res.status(500).json({ error: err.message });
  }
});

// ─── Cleanup Expired Sessions ────────────────────────────────────────────────
setInterval(async () => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.createdAt > 5 * 60 * 1000) {
      try { await session.browser.close(); } catch {}
      sessions.delete(id);
    }
  }
}, 60000);

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ 
  status: 'roost is warm', 
  time: new Date() 
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

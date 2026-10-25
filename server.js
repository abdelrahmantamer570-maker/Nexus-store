'use strict';
require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = String(
  process.env.BASE_URL || `http://localhost:${PORT}`
).replace(/\/$/, '');

const PAYPAL_MODE =
  String(process.env.PAYPAL_MODE || process.env.PAYPAL_ENV || 'sandbox')
    .toLowerCase() === 'live'
    ? 'live'
    : 'sandbox';

const PAYPAL_API =
  PAYPAL_MODE === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_SECOND_PASSWORD = process.env.ADMIN_SECOND_PASSWORD || '';


const CURRENCY = /^[A-Z]{3}$/.test(
  String(process.env.STORE_CURRENCY || 'USD').toUpperCase()
)
  ? String(process.env.STORE_CURRENCY || 'USD').toUpperCase()
  : 'USD';

const DATA_FILE = path.join(__dirname, 'nexus-data.json');

function choosePublicDir() {
  const candidates = [];

  if (process.env.PUBLIC_DIR) {
    candidates.push(
      path.resolve(__dirname, process.env.PUBLIC_DIR)
    );
  }

  candidates.push(
    path.join(__dirname, 'public'),
    __dirname,
    path.resolve(__dirname, '..', 'public')
  );

  for (const dir of candidates) {
    try {
      if (fs.statSync(path.join(dir, 'index.html')).isFile()) {
        return dir;
      }
    } catch (_) {}
  }

  return path.join(__dirname, 'public');
}

const PUBLIC_DIR = choosePublicDir();

app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({
  extended: false,
  limit: '20kb'
}));

const defaultProducts = [
  {
    id: 'nexus-plus',
    name: 'Nexus+',
    description: 'Get started with the Nexus rank.',
    price: 4.99,
    icon: '💜',
    active: true
  },
  {
    id: 'nexus-plus-plus',
    name: 'Nexus++',
    description: 'Take your Minecraft experience further.',
    price: 9.99,
    icon: '💎',
    active: true
  },
  {
    id: 'nexus-plus-plus-plus',
    name: 'Nexus+++',
    description: 'The ultimate Nexus rank experience.',
    price: 19.99,
    icon: '👑',
    active: true
  },
  {
    id: 'elytra',
    name: 'Elytra',
    description: 'Take to the skies in Minecraft.',
    price: 4.99,
    icon: '🪽',
    active: true
  },
  {
    id: 'amethyst-key',
    name: 'Amethyst Key',
    description: 'An amethyst-themed key.',
    price: 1.99,
    icon: '🔮',
    active: true
  },
  {
    id: 'common-key',
    name: 'Common Key',
    description: 'A common key for your adventure.',
    price: 0.99,
    icon: '🗝️',
    active: true
  },
  {
    id: 'time-key',
    name: 'Time Key',
    description: 'A key for time-themed rewards.',
    price: 1.99,
    icon: '⏳',
    active: true
  },
  {
    id: 'crimson-key',
    name: 'Crimson Key',
    description: 'A crimson-themed key.',
    price: 2.49,
    icon: '🩸',
    active: true
  },
  {
    id: 'gold-key',
    name: 'Gold Key',
    description: 'A gold-themed key.',
    price: 4.99,
    icon: '🔑',
    active: true
  }
];

function defaults() {
  return {
    version: 2,
    settings: {
      ticketUrl: '',
      currency: CURRENCY,
      currencySymbol: '$'
    },
    products: defaultProducts.map(p => ({ ...p })),
    vouchers: [],
    orders: [],
    pendingPayments: []
  };
}

function writeData(value = store) {
  const tempFile = DATA_FILE + '.tmp';

  fs.writeFileSync(
    tempFile,
    JSON.stringify(value, null, 2),
    'utf8'
  );

  fs.renameSync(tempFile, DATA_FILE);
}

function readData() {
  let raw = {};

  try {
    raw = JSON.parse(
      fs.readFileSync(DATA_FILE, 'utf8')
    );
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(
        'Could not read nexus-data.json:',
        error.message
      );
    }
    raw = {};
  }

  const base = defaults();

  const data = {
    ...base,
    ...raw,
    settings: {
      ...base.settings,
      ...(raw.settings && typeof raw.settings === 'object'
        ? raw.settings
        : {})
    },
    products: Array.isArray(raw.products)
      ? raw.products
      : base.products,
    vouchers: Array.isArray(raw.vouchers)
      ? raw.vouchers
      : base.vouchers,
    orders: Array.isArray(raw.orders)
      ? raw.orders
      : base.orders,
    pendingPayments: Array.isArray(raw.pendingPayments)
      ? raw.pendingPayments
      : (
          raw.pendingPayments &&
          typeof raw.pendingPayments === 'object'
            ? Object.values(raw.pendingPayments)
            : base.pendingPayments
        )
  };

  if (!fs.existsSync(DATA_FILE)) {
    writeData(data);
  }

  return data;
}

let store = readData();

store.pendingPayments = store.pendingPayments.filter(
  p => p && typeof p === 'object'
);

if (!store.settings.currency) {
  store.settings.currency = CURRENCY;
}
if (!store.settings.currencySymbol) {
  store.settings.currencySymbol = '$';
}

const adminTokens = new Map();
const adminChallenges = new Map();
const loginAttempts = new Map();

const SESSION_MS = 8 * 60 * 60 * 1000;
const CHALLENGE_MS = 2 * 60 * 1000;

let adminSecondPasswordHash = null;

function hashSecret(value) {
  return crypto
    .createHash('sha256')
    .update(String(value), 'utf8')
    .digest();
}

function constantTimeSecretMatches(value, expectedHash) {
  if (typeof value !== 'string' || !Buffer.isBuffer(expectedHash)) {
    return false;
  }

  const providedHash = hashSecret(value);
  return crypto.timingSafeEqual(providedHash, expectedHash);
}

function getLoginAttempt(ip) {
  const now = Date.now();
  let attempt = loginAttempts.get(ip);

  if (!attempt || now - attempt.since > 15 * 60 * 1000) {
    attempt = { count: 0, since: now };
    loginAttempts.set(ip, attempt);
  }

  return attempt;
}

function checkLoginLimit(req, res) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';

  if (getLoginAttempt(ip).count >= 10) {
    res.status(429).json({
      ok: false,
      error: 'Too many admin sign-in attempts. Wait 15 minutes.'
    });
    return false;
  }

  return true;
}

function recordFailedLogin(req) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const attempt = getLoginAttempt(ip);
  attempt.count += 1;
  loginAttempts.set(ip, attempt);
}

/* Read the second password without displaying typed characters. */
function readHiddenSecret(promptText) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;

    if (!input.isTTY || typeof input.setRawMode !== 'function') {
      reject(new Error(
        'Start node server.js in the VS Code Terminal to enter the second admin code without saving it to a file.'
      ));
      return;
    }

    process.stdout.write(promptText);
    input.setRawMode(true);
    input.resume();

    let value = '';
    let finished = false;

    const finish = (result, error) => {
      if (finished) return;
      finished = true;

      input.removeListener('data', onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write('\n');

      if (error) reject(error);
      else resolve(result);
    };

    const onData = chunk => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003') {
          finish('', new Error('Startup cancelled.'));
          process.exitCode = 130;
          return;
        }

        if (character === '\r' || character === '\n') {
          finish(value);
          return;
        }

        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
          continue;
        }

        if (character >= ' ' && character !== '\u007f') {
          value += character;
        }
      }
    };

    input.on('data', onData);
  });
}

async function configureSecondAdminPassword() {
  if (!ADMIN_PASSWORD) {
    throw new Error(
      'ADMIN_PASSWORD is missing. Set ADMIN_PASSWORD in the environment before starting the server.'
    );
  }

  /*
   * Production/hosting mode:
   * Render and other cloud hosts do not provide an interactive terminal.
   * Use ADMIN_SECOND_PASSWORD from the environment instead of prompting.
   */
  if (ADMIN_SECOND_PASSWORD) {
    if (ADMIN_SECOND_PASSWORD.length > 200) {
      throw new Error(
        'ADMIN_SECOND_PASSWORD must contain 1 to 200 characters.'
      );
    }

    adminSecondPasswordHash = hashSecret(ADMIN_SECOND_PASSWORD);
    console.log('Second admin code loaded from environment.');
    return;
  }

  /*
   * Local development fallback:
   * If no second code is supplied, keep the original interactive setup
   * for a normal VS Code terminal.
   */
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error(
      'ADMIN_SECOND_PASSWORD is missing. Set it in your hosting environment, or start the server in a normal VS Code terminal to create it interactively.'
    );
  }

  console.log('Nexus Store admin setup');
  console.log(
    'Choose a second admin sign-in code. It is kept in memory only and requested again when the server restarts.'
  );

  while (true) {
    const first = await readHiddenSecret(
      'Create second admin code (8+ characters recommended): '
    );

    if (!first || first.length > 200) {
      console.log(
        'The second admin code must contain 1 to 200 characters. Try again.'
      );
      continue;
    }

    const confirmation = await readHiddenSecret(
      'Confirm second admin code: '
    );

    if (first !== confirmation) {
      console.log('The codes did not match. Try again.');
      continue;
    }

    adminSecondPasswordHash = hashSecret(first);
    break;
  }

  console.log(
    'Second admin code loaded into memory. It was not saved to disk.'
  );
}

function makeId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function cleanString(value, max = 200) {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.trim().length <= max
  );
}

function roundMoney(value) {
  return Math.round(
    (Number(value) + Number.EPSILON) * 100
  ) / 100;
}

function verificationCode() {
  const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  const code = Array.from(
    { length: 12 },
    () => characters[crypto.randomInt(characters.length)]
  ).join('');

  return `NX-${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
}

function publicProducts() {
  return store.products.filter(
    product => product.active !== false
  );
}

function findVoucher(code) {
  const cleanedCode = String(code || '').trim();

  if (
    !cleanedCode ||
    (
      ADMIN_PASSWORD &&
      cleanedCode.toUpperCase() === ADMIN_PASSWORD.toUpperCase()
    )
  ) {
    return null;
  }

  return store.vouchers.find(
    voucher =>
      String(voucher.code || '').toUpperCase() ===
      cleanedCode.toUpperCase()
  ) || null;
}

function isVoucherReserved(voucher) {
  return store.pendingPayments.filter(
    payment =>
      String(payment.voucherCode || '').toUpperCase() ===
      String(voucher.code || '').toUpperCase()
  ).length;
}

function voucherAvailable(voucher) {
  if (
    !voucher ||
    voucher.disabled ||
    voucher.active === false
  ) {
    return false;
  }

  const limit = Number(
    voucher.limit ?? voucher.maxUses ?? 0
  );
  const used = Number(
    voucher.used ?? voucher.uses ?? 0
  );

  return (
    limit > 0 &&
    used + isVoucherReserved(voucher) < limit
  );
}

function adminOnly(req, res, next) {
  const authorization = String(
    req.get('authorization') || ''
  );

  const token = authorization.startsWith('Bearer ')
    ? authorization.slice(7)
    : '';

  const session = adminTokens.get(token);

  if (!session || session.expiresAt < Date.now()) {
    if (token) adminTokens.delete(token);

    return res.status(401).json({
      ok: false,
      error: 'Admin login required. Enter the two admin codes again.'
    });
  }

  session.expiresAt = Date.now() + SESSION_MS;
  next();
}

/* ---------------- PayPal ---------------- */

async function paypalToken() {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    throw new Error(
      'PayPal is not configured. Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to .env.'
    );
  }

  const authorization = Buffer.from(
    `${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`
  ).toString('base64');

  const response = await fetch(
    `${PAYPAL_API}/v1/oauth2/token`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${authorization}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    }
  );

  const result = await response.json().catch(() => ({}));

  if (!response.ok || !result.access_token) {
    throw new Error(
      result.error_description ||
      result.message ||
      `PayPal authentication failed (${response.status}).`
    );
  }

  return result.access_token;
}

async function paypalRequest(url, options = {}) {
  const token = await paypalToken();

  const response = await fetch(
    `${PAYPAL_API}${url}`,
    {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    }
  );

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    const details = result.details
      ?.map(item => item.description || item.issue)
      .filter(Boolean)
      .join('; ');

    throw new Error(
      details ||
      result.message ||
      result.name ||
      `PayPal request failed (${response.status}).`
    );
  }

  return result;
}

/* ---------------- Public API ---------------- */

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    status: 'ok',
    publicDir: path.relative(__dirname, PUBLIC_DIR) || '.'
  });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, status: 'ok' });
});

app.get('/api/store', (req, res) => {
  res.json({
    ok: true,
    products: publicProducts(),
    currency: CURRENCY,
    settings: store.settings,
    ticketUrl: store.settings.ticketUrl || ''
  });
});

app.get('/api/products', (req, res) => {
  res.json(publicProducts());
});

app.get('/api/settings', (req, res) => {
  res.json(store.settings);
});

app.get('/api/paypal/status', async (req, res) => {
  try {
    await paypalToken();

    res.json({
      ok: true,
      mode: PAYPAL_MODE,
      message: 'PayPal authentication successful.'
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      mode: PAYPAL_MODE,
      message: error.message
    });
  }
});

/* ---------------- Vouchers ---------------- */

app.get('/api/vouchers/validate', (req, res) => {
  const voucher = findVoucher(req.query.code);

  if (!voucherAvailable(voucher)) {
    return res.status(400).json({
      ok: false,
      valid: false,
      message: 'This voucher is invalid, disabled, or has reached its usage limit.'
    });
  }

  res.json({
    ok: true,
    valid: true,
    voucher: {
      code: voucher.code,
      discount: Number(voucher.discount),
      valid: true,
      active: true
    }
  });
});

/* ---------------- Two-step admin login ---------------- */

/* Step 1: compare the typed code with ADMIN_PASSWORD from .env. */
app.post('/api/admin/first-step', (req, res) => {
  if (!checkLoginLimit(req, res)) return;

  const password =
    typeof req.body?.password === 'string'
      ? req.body.password
      : '';

  if (
    !ADMIN_PASSWORD ||
    password.length > 200 ||
    !constantTimeSecretMatches(password, hashSecret(ADMIN_PASSWORD))
  ) {
    recordFailedLogin(req);
    return res.status(401).json({
      ok: false,
      error: 'Invalid admin access code.'
    });
  }

  const challengeToken = crypto.randomBytes(32).toString('hex');
  const ip = req.ip || req.socket.remoteAddress || 'unknown';

  adminChallenges.set(challengeToken, {
    ip,
    expiresAt: Date.now() + CHALLENGE_MS,
    attempts: 0
  });

  res.json({
    ok: true,
    challengeToken,
    expiresIn: CHALLENGE_MS
  });
});

/* Step 2: compare the second code entered at server startup. */
app.post('/api/admin/login', (req, res) => {
  if (!checkLoginLimit(req, res)) return;

  const challengeToken =
    typeof req.body?.challengeToken === 'string'
      ? req.body.challengeToken
      : '';

  const password =
    typeof req.body?.password === 'string'
      ? req.body.password
      : '';

  const challenge = adminChallenges.get(challengeToken);
  const ip = req.ip || req.socket.remoteAddress || 'unknown';

  if (
    !challenge ||
    challenge.expiresAt < Date.now() ||
    challenge.ip !== ip
  ) {
    if (challengeToken) adminChallenges.delete(challengeToken);

    return res.status(401).json({
      ok: false,
      error: 'The sign-in request expired. Enter the first admin code again.'
    });
  }

  if (
    !password ||
    password.length > 200 ||
    !constantTimeSecretMatches(password, adminSecondPasswordHash)
  ) {
    challenge.attempts += 1;
    recordFailedLogin(req);

    if (challenge.attempts >= 5) {
      adminChallenges.delete(challengeToken);
    }

    return res.status(401).json({
      ok: false,
      error: 'Incorrect second sign-in code.'
    });
  }

  adminChallenges.delete(challengeToken);
  loginAttempts.delete(ip);

  const token = crypto.randomBytes(32).toString('hex');

  adminTokens.set(token, {
    expiresAt: Date.now() + SESSION_MS
  });

  res.json({
    ok: true,
    token,
    expiresIn: SESSION_MS
  });
});

app.post('/api/admin/logout', adminOnly, (req, res) => {
  const authorization = String(
    req.get('authorization') || ''
  );

  const token = authorization.slice(7);
  adminTokens.delete(token);

  res.json({ ok: true });
});

/* Everything below /api/admin requires an admin session. */
app.use('/api/admin', adminOnly);

app.get('/api/admin/data', (req, res) => {
  res.json({
    ok: true,
    data: {
      products: store.products,
      vouchers: store.vouchers,
      orders: store.orders,
      currency: CURRENCY,
      settings: store.settings
    }
  });
});

app.get('/api/admin/backup', (req, res) => {
  res.json({
    ok: true,
    exportedAt: new Date().toISOString(),
    ...store
  });
});

app.post('/api/admin/vouchers', (req, res) => {
  const body = req.body || {};
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  const discount = Number(body.discount);
  const limit = Number(body.limit);

  if (
    !cleanString(code, 60) ||
    (
      ADMIN_PASSWORD &&
      code.toUpperCase() === ADMIN_PASSWORD.toUpperCase()
    ) ||
    !Number.isInteger(discount) ||
    discount < 1 ||
    discount > 100 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 1000000
  ) {
    return res.status(400).json({
      ok: false,
      error: 'Enter a custom code, a discount from 1–100, and a maximum use count of at least 1.'
    });
  }

  const exists = store.vouchers.some(
    voucher =>
      String(voucher.code).toUpperCase() === code.toUpperCase()
  );

  if (exists) {
    return res.status(409).json({
      ok: false,
      error: 'That voucher already exists.'
    });
  }

  const voucher = {
    id: makeId('VOUCHER'),
    code,
    discount,
    limit,
    used: 0,
    disabled: false,
    note: typeof body.note === 'string'
      ? body.note.slice(0, 200)
      : '',
    createdAt: new Date().toISOString()
  };

  store.vouchers.unshift(voucher);
  writeData();

  res.status(201).json({ ok: true, voucher });
});

app.patch('/api/admin/vouchers/:id', (req, res) => {
  const voucher = store.vouchers.find(
    item => String(item.id) === req.params.id
  );

  if (!voucher) {
    return res.status(404).json({
      ok: false,
      error: 'Voucher not found.'
    });
  }

  if (typeof req.body?.disabled === 'boolean') {
    voucher.disabled = req.body.disabled;
  } else if (typeof req.body?.active === 'boolean') {
    voucher.disabled = !req.body.active;
  }

  const limit = Number(
    voucher.limit || voucher.maxUses || Infinity
  );

  if (Number(voucher.used || 0) >= limit) {
    voucher.disabled = true;
  }

  voucher.updatedAt = new Date().toISOString();
  writeData();

  res.json({ ok: true, voucher });
});

app.delete('/api/admin/vouchers/:id', (req, res) => {
  const originalLength = store.vouchers.length;

  store.vouchers = store.vouchers.filter(
    voucher => String(voucher.id) !== req.params.id
  );

  if (originalLength === store.vouchers.length) {
    return res.status(404).json({
      ok: false,
      error: 'Voucher not found.'
    });
  }

  writeData();
  res.json({ ok: true });
});

app.post('/api/admin/products', (req, res) => {
  const body = req.body || {};
  const price = Number(body.price);

  if (
    !cleanString(body.name, 100) ||
    !cleanString(body.description || 'No description provided.', 200) ||
    !cleanString(body.icon, 20) ||
    !Number.isFinite(price) ||
    price < 0 ||
    price > 1000000
  ) {
    return res.status(400).json({
      ok: false,
      error: 'Check product name, description, icon and price.'
    });
  }

  const productId = cleanString(body.id, 120)
    ? body.id.trim()
    : `${body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'product'}-${crypto.randomBytes(3).toString('hex')}`;

  const product = {
    id: productId,
    name: body.name.trim(),
    description: String(body.description || '').trim(),
    price: roundMoney(price),
    icon: body.icon.trim(),
    active: body.active !== false
  };

  const index = store.products.findIndex(
    item => String(item.id) === productId
  );

  if (index >= 0) {
    store.products[index] = {
      ...store.products[index],
      ...product
    };
  } else {
    store.products.push(product);
  }

  writeData();
  res.json({ ok: true, product });
});

app.patch('/api/admin/products/:id/visibility', (req, res) => {
  const product = store.products.find(
    item => String(item.id) === req.params.id
  );

  if (!product) {
    return res.status(404).json({
      ok: false,
      error: 'Product not found.'
    });
  }

  product.active = req.body?.active === true;
  writeData();

  res.json({ ok: true, product });
});

app.patch('/api/admin/orders/:id', (req, res) => {
  const validStatuses = [
    'Pending',
    'Processing',
    'Completed',
    'Cancelled'
  ];

  if (!validStatuses.includes(req.body?.status)) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid order status.'
    });
  }

  const order = store.orders.find(
    item => String(item.id) === req.params.id
  );

  if (!order) {
    return res.status(404).json({
      ok: false,
      error: 'Order not found.'
    });
  }

  order.status = req.body.status;
  order.updatedAt = new Date().toISOString();

  writeData();
  res.json({ ok: true, order });
});

app.put('/api/admin/settings', (req, res) => {
  const ticketUrl =
    typeof req.body?.ticketUrl === 'string'
      ? req.body.ticketUrl.trim()
      : '';

  if (ticketUrl) {
    try {
      const url = new URL(ticketUrl);

      if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error();
      }
    } catch {
      return res.status(400).json({
        ok: false,
        error: 'Ticket URL must start with https:// or http://.'
      });
    }
  }

  store.settings.ticketUrl = ticketUrl;
  writeData();

  res.json({ ok: true, settings: store.settings });
});

/* ---------------- Create PayPal order ---------------- */

app.post('/api/create-order', async (req, res, next) => {
  try {
    const body = req.body || {};

    if (!cleanString(body.customerName, 80)) {
      return res.status(400).json({
        ok: false,
        error: 'Enter your Minecraft username.'
      });
    }

    if (
      !['discord', 'email'].includes(body.contactType) ||
      !cleanString(body.contactValue, 150)
    ) {
      return res.status(400).json({
        ok: false,
        error: 'Enter your Discord username or email.'
      });
    }

    if (
      !Array.isArray(body.items) ||
      body.items.length < 1 ||
      body.items.length > 30
    ) {
      return res.status(400).json({
        ok: false,
        error: 'Add at least one product to your cart.'
      });
    }

    const activeProducts = publicProducts();
    const items = [];

    for (const item of body.items) {
      const product = activeProducts.find(
        p => String(p.id) === String(item.id)
      );
      const quantity = Number(item.quantity);

      if (
        !product ||
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > 100
      ) {
        return res.status(400).json({
          ok: false,
          error: 'A product in your cart is unavailable or has an invalid quantity.'
        });
      }

      items.push({
        id: product.id,
        name: product.name,
        unitPrice: Number(product.price),
        quantity,
        lineTotal: roundMoney(Number(product.price) * quantity)
      });
    }

    const subtotal = roundMoney(
      items.reduce((sum, item) => sum + item.lineTotal, 0)
    );

    let voucher = null;
    let discountPercent = 0;
    let discount = 0;

    const voucherCode = String(body.voucherCode || '').trim();

    if (voucherCode) {
      voucher = findVoucher(voucherCode);

      if (!voucherAvailable(voucher)) {
        return res.status(400).json({
          ok: false,
          error: 'Voucher is invalid, disabled, or its usage limit has been reached.'
        });
      }

      discountPercent = Number(voucher.discount) || 0;
      discount = Math.min(
        subtotal,
        roundMoney(subtotal * discountPercent / 100)
      );
    }

    const total = roundMoney(
      Math.max(0, subtotal - discount)
    );

    const order = {
      id: makeId('ORDER'),
      customerName: body.customerName.trim(),
      contactType: body.contactType,
      contactValue: body.contactValue.trim(),
      items,
      subtotal,
      voucherCode: voucher ? voucher.code : null,
      discountPercent,
      discount,
      total,
      currency: CURRENCY,
      status: 'Pending',
      createdAt: new Date().toISOString()
    };

    if (total <= 0) {
      if (voucher) {
        voucher.used = Number(voucher.used || 0) + 1;

        if (
          voucher.used >=
          Number(voucher.limit || voucher.maxUses || Infinity)
        ) {
          voucher.disabled = true;
        }
      }

      order.paymentStatus = 'FREE';
      order.verificationCode = verificationCode();
      order.paidAt = new Date().toISOString();

      store.orders.unshift(order);
      writeData();

      return res.status(201).json({
        ok: true,
        freeOrder: true,
        order
      });
    }

    const paypalOrder = await paypalRequest(
      '/v2/checkout/orders',
      {
        method: 'POST',
        body: JSON.stringify({
          intent: 'CAPTURE',
          purchase_units: [
            {
              reference_id: order.id,
              custom_id: order.id,
              invoice_id: order.id,
              description: 'Nexus Store purchase',
              amount: {
                currency_code: CURRENCY,
                value: total.toFixed(2)
              }
            }
          ],
          application_context: {
            brand_name: 'Nexus Store',
            user_action: 'PAY_NOW',
            shipping_preference: 'NO_SHIPPING',
            return_url: `${BASE_URL}/?paypal=success`,
            cancel_url: `${BASE_URL}/?paypal=cancel`
          }
        })
      }
    );

    const approvalUrl = (paypalOrder.links || []).find(
      link => link.rel === 'approve'
    )?.href;

    if (!paypalOrder.id || !approvalUrl) {
      throw new Error(
        'PayPal did not return an approval URL. Check your PayPal app settings.'
      );
    }

    store.pendingPayments.push({
      ...order,
      paypalOrderID: paypalOrder.id
    });

    writeData();

    res.status(201).json({
      ok: true,
      orderID: paypalOrder.id,
      approvalUrl
    });
  } catch (error) {
    next(error);
  }
});

/* ---------------- Confirm payment ---------------- */

app.post('/api/capture-order', async (req, res, next) => {
  try {
    const orderID =
      typeof req.body?.orderID === 'string'
        ? req.body.orderID.trim()
        : '';

    if (!orderID) {
      return res.status(400).json({
        ok: false,
        error: 'Missing PayPal order ID.'
      });
    }

    const alreadyCaptured = store.orders.find(
      order => order.paypalOrderID === orderID
    );

    if (alreadyCaptured) {
      return res.json({
        ok: true,
        order: alreadyCaptured
      });
    }

    const pending = store.pendingPayments.find(
      payment => payment.paypalOrderID === orderID
    );

    if (!pending) {
      return res.status(404).json({
        ok: false,
        error: 'This pending order was not found. Contact support before paying again.'
      });
    }

    const captured = await paypalRequest(
      `/v2/checkout/orders/${encodeURIComponent(orderID)}/capture`,
      {
        method: 'POST',
        body: '{}'
      }
    );

    const capture = (captured.purchase_units || [])
      .flatMap(unit => unit.payments?.captures || [])
      .find(item => item.status === 'COMPLETED');

    if (captured.status !== 'COMPLETED' || !capture) {
      return res.status(400).json({
        ok: false,
        error: 'PayPal has not confirmed a completed payment.'
      });
    }

    if (
      capture.amount?.currency_code !== CURRENCY ||
      roundMoney(Number(capture.amount?.value)) !==
      roundMoney(pending.total)
    ) {
      return res.status(400).json({
        ok: false,
        error: 'The captured amount does not match the expected order total.'
      });
    }

    const order = {
      ...pending,
      verificationCode: verificationCode(),
      paymentStatus: 'COMPLETED',
      paypalOrderStatus: captured.status,
      paypalCaptureID: capture.id || '',
      paidAt: new Date().toISOString(),
      paypalOrderID: orderID
    };

    if (pending.voucherCode) {
      const voucher = findVoucher(pending.voucherCode);

      if (voucher) {
        voucher.used = Number(voucher.used || 0) + 1;

        if (
          voucher.used >=
          Number(voucher.limit || voucher.maxUses || Infinity)
        ) {
          voucher.disabled = true;
        }
      }
    }

    store.pendingPayments = store.pendingPayments.filter(
      payment => payment.paypalOrderID !== orderID
    );

    store.orders.unshift(order);
    writeData();

    res.json({
      ok: true,
      order
    });
  } catch (error) {
    next(error);
  }
});

app.use('/api', (req, res) => {
  res.status(404).json({
    ok: false,
    error: `API route not found: ${req.method} ${req.originalUrl}`
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use(express.static(PUBLIC_DIR, {
  index: 'index.html',
  fallthrough: true
}));

app.use((req, res) => {
  res.status(404).send(
    'Page not found. Check the URL and open http://localhost:' +
    PORT +
    '/'
  );
});

app.use((error, req, res, next) => {
  console.error(
    `[${new Date().toISOString()}]`,
    error?.stack || error
  );

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    ok: false,
    error: error?.message || 'An internal server error occurred.'
  });
});

async function startServer() {
  await configureSecondAdminPassword();

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Nexus Store running at ${BASE_URL}`);
    console.log(`Website folder: ${PUBLIC_DIR}`);
    console.log(`Product API: ${BASE_URL}/api/store`);

    console.log(
      `PayPal mode: ${PAYPAL_MODE}` +
      (PAYPAL_CLIENT_ID && PAYPAL_CLIENT_SECRET
        ? ' (credentials set)'
        : ' (credentials missing)')
    );
  });

  server.on('error', error => {
    if (error.code === 'EADDRINUSE') {
      console.error(
        `Port ${PORT} is already in use. Stop the old server before starting this one.`
      );
    } else {
      console.error('Server failed to start:', error.message);
    }
    process.exitCode = 1;
  });
}

startServer().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
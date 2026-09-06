// server.js
// Простой бэкенд-прокси для OpenRouter API.
// Ключ API никогда не хранится на сервере — клиент присылает его в заголовке
// на каждый запрос, сервер сразу пересылает его в OpenRouter и забывает.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');

const app = express();
const PORT = process.env.PORT || 3000;
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

// ---------- Простое файловое хранилище пользователей ----------
// MVP-решение: JSON-файл на диске вместо полноценной БД, чтобы не тащить
// компиляцию нативных пакетов на сервер. Мигрируется на SQL позже без
// изменения API-контракта (все обращения идут через функции ниже).
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SECRET_FILE = path.join(DATA_DIR, '.jwt-secret');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify({ users: [] }, null, 2));
if (!fs.existsSync(SECRET_FILE)) {
  // Генерируем и сохраняем секрет один раз — чтобы сессии не слетали при рестарте сервера
  fs.writeFileSync(SECRET_FILE, require('crypto').randomBytes(48).toString('hex'));
}
const JWT_SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch {
    return { users: [] };
  }
}
function saveUsers(data) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
}
function findUserByEmail(email) {
  const data = loadUsers();
  return data.users.find(u => u.email.toLowerCase() === String(email).toLowerCase());
}
function findUserById(id) {
  const data = loadUsers();
  return data.users.find(u => u.id === id);
}

const COOKIE_NAME = 'or_session';

function issueSession(res, user) {
  const token = jwt.sign({ uid: user.id }, JWT_SECRET, { expiresIn: '90d' });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,     // сайт уже на HTTPS
    sameSite: 'lax',
    maxAge: 90 * 24 * 60 * 60 * 1000
  });
}

function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Не авторизован' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = findUserById(payload.uid);
    if (!user) return res.status(401).json({ error: 'Пользователь не найден' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Сессия недействительна' });
  }
}

function publicUser(u) {
  return { id: u.id, email: u.email, isPro: !!u.isPro, createdAt: u.createdAt };
}

// ---------- Тихий счётчик использования моделей ----------
// Копим статистику молча — на фронтенде счётчики не показываем, пока
// у конкретной модели не наберётся 10 000+ использований (порог решаем позже).
const STATS_FILE = path.join(DATA_DIR, 'model-stats.json');
if (!fs.existsSync(STATS_FILE)) fs.writeFileSync(STATS_FILE, JSON.stringify({}));
function incrementModelUsage(modelId) {
  try {
    const stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    stats[modelId] = (stats[modelId] || 0) + 1;
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats));
  } catch { /* не критично, просто пропускаем инкремент при сбое */ }
}

app.use(cors());
app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- POST /api/auth/register --------------------------------------------
app.post('/api/auth/register', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Нужны email и пароль' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Некорректный email' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Пароль должен быть не короче 6 символов' });

  if (findUserByEmail(email)) return res.status(409).json({ error: 'Пользователь с таким email уже зарегистрирован' });

  const data = loadUsers();
  const user = {
    id: 'u_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    email: String(email).trim(),
    passwordHash: bcrypt.hashSync(password, 10),
    isPro: false,
    createdAt: new Date().toISOString()
  };
  data.users.push(user);
  saveUsers(data);
  issueSession(res, user);
  res.json({ user: publicUser(user) });
});

// --- POST /api/auth/login -------------------------------------------------
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Нужны email и пароль' });

  const user = findUserByEmail(email);
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Неверный email или пароль' });
  }
  issueSession(res, user);
  res.json({ user: publicUser(user) });
});

// --- POST /api/auth/logout ------------------------------------------------
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

// --- GET /api/auth/me -------------------------------------------------
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// --- POST /api/auth/set-pro ---------------------------------------------
// Демо-подписка: помечает АККАУНТ (не браузер) как Pro. Здесь же будет
// точка входа для реальной оплаты (Платега/ЮKassa) на следующем этапе.
app.post('/api/auth/set-pro', requireAuth, (req, res) => {
  const data = loadUsers();
  const user = data.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  user.isPro = true;
  saveUsers(data);
  res.json({ user: publicUser(user) });
});

// Небольшой in-memory кэш списка моделей (публичный эндпоинт, ключ не нужен)
let modelsCache = { data: null, ts: 0 };
const MODELS_TTL_MS = 10 * 60 * 1000; // 10 минут

function getApiKey(req) {
  const header = req.get('x-openrouter-key');
  if (header && header.trim()) return header.trim();
  // fallback на серверный .env, если вы хотите зашить свой ключ на бэкенде
  return process.env.OPENROUTER_API_KEY || null;
}

// --- GET /api/models -----------------------------------------------------
// Отдаёт список доступных моделей (название, id, цена за 1M токенов и т.д.)
app.get('/api/models', async (req, res) => {
  try {
    const now = Date.now();
    if (modelsCache.data && now - modelsCache.ts < MODELS_TTL_MS) {
      return res.json(modelsCache.data);
    }

    const r = await fetch(`${OPENROUTER_BASE}/models`);
    if (!r.ok) {
      const text = await r.text();
      return res.status(r.status).json({ error: 'Не удалось получить список моделей', details: text });
    }
    const json = await r.json();
    modelsCache = { data: json, ts: now };
    res.json(json);
  } catch (err) {
    res.status(500).json({ error: 'Сетевая ошибка при получении моделей', details: err.message });
  }
});

// --- POST /api/chat --------------------------------------------------------
// Тело: { model, messages, stream, temperature? }
// Прокидывает запрос в OpenRouter. Если stream=true — пробрасывает SSE поток
// напрямую в браузер, чтобы ответ печатался постепенно.
app.post('/api/chat', async (req, res) => {
  const apiKey = getApiKey(req);
  if (!apiKey) {
    return res.status(401).json({ error: 'Нет API-ключа. Укажите его в настройках приложения.' });
  }

  const { model, messages, stream = true, temperature } = req.body || {};
  if (!model || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Нужно передать model и messages[]' });
  }

  try {
    const upstream = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        // Необязательные, но рекомендуемые OpenRouter заголовки для атрибуции:
        'HTTP-Referer': req.get('origin') || 'http://localhost',
        'X-Title': 'OpenRouter Test Chat'
      },
      body: JSON.stringify({
        model,
        messages,
        stream,
        usage: { include: true }, // просим у OpenRouter реальную $-стоимость в ответе
        ...(temperature !== undefined ? { temperature } : {})
      })
    });

    if (!upstream.ok) {
      const errBody = await upstream.text();
      let parsed;
      try { parsed = JSON.parse(errBody); } catch { parsed = { error: errBody }; }
      return res.status(upstream.status).json(parsed);
    }

    incrementModelUsage(model); // успех — считаем использование модели

    if (!stream) {
      const json = await upstream.json();
      return res.json(json);
    }

    // Проброс SSE-потока как есть
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();

    req.on('close', () => {
      try { reader.cancel(); } catch {}
    });

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: 'Сетевая ошибка при обращении к OpenRouter', details: err.message });
    } else {
      res.end();
    }
  }
});

// --- POST /api/generate-image ------------------------------------------
// Тело: { model, prompt, aspect_ratio?, resolution?, input_references? }
// Проксирует в дедикейтед Image API OpenRouter (POST /api/v1/images).
app.post('/api/generate-image', async (req, res) => {
  const apiKey = getApiKey(req);
  if (!apiKey) {
    return res.status(401).json({ error: 'Нет API-ключа. Укажите его в настройках приложения.' });
  }

  const { model, prompt, aspect_ratio, resolution, input_references } = req.body || {};
  if (!model || !prompt) {
    return res.status(400).json({ error: 'Нужно передать model и prompt' });
  }

  try {
    const upstream = await fetch(`${OPENROUTER_BASE}/images`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': req.get('origin') || 'http://localhost',
        'X-Title': 'OpenRouter Test Chat'
      },
      body: JSON.stringify({
        model,
        prompt,
        ...(aspect_ratio ? { aspect_ratio } : {}),
        ...(resolution ? { resolution } : {}),
        ...(input_references ? { input_references } : {})
      })
    });

    const json = await upstream.json();
    if (!upstream.ok) {
      return res.status(upstream.status).json(json);
    }
    incrementModelUsage(model);
    res.json(json);
  } catch (err) {
    res.status(500).json({ error: 'Сетевая ошибка при обращении к OpenRouter Image API', details: err.message });
  }
});

// --- GET /api/video-models --------------------------------------------
// Видео-модели живут в ОТДЕЛЬНОМ каталоге, не в общем /api/v1/models
let videoModelsCache = { data: null, ts: 0 };
app.get('/api/video-models', async (req, res) => {
  try {
    const now = Date.now();
    if (videoModelsCache.data && now - videoModelsCache.ts < MODELS_TTL_MS) {
      return res.json(videoModelsCache.data);
    }
    const r = await fetch(`${OPENROUTER_BASE}/videos/models`);
    if (!r.ok) {
      const text = await r.text();
      return res.status(r.status).json({ error: 'Не удалось получить список видео-моделей', details: text });
    }
    const json = await r.json();
    videoModelsCache = { data: json, ts: now };
    res.json(json);
  } catch (err) {
    res.status(500).json({ error: 'Сетевая ошибка при получении видео-моделей', details: err.message });
  }
});

// --- POST /api/generate-video ------------------------------------------
// Асинхронная генерация: создаёт задачу, сразу возвращает job id + polling_url
app.post('/api/generate-video', async (req, res) => {
  const apiKey = getApiKey(req);
  if (!apiKey) return res.status(401).json({ error: 'Нет API-ключа.' });

  const { model, prompt, duration, resolution, aspect_ratio, generate_audio, input_references } = req.body || {};
  if (!model || !prompt) return res.status(400).json({ error: 'Нужно передать model и prompt' });

  try {
    const upstream = await fetch(`${OPENROUTER_BASE}/videos`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': req.get('origin') || 'http://localhost',
        'X-Title': 'OpenRouter Test Chat'
      },
      body: JSON.stringify({
        model,
        prompt,
        ...(duration ? { duration } : {}),
        ...(resolution ? { resolution } : {}),
        ...(aspect_ratio ? { aspect_ratio } : {}),
        ...(generate_audio !== undefined ? { generate_audio } : {}),
        ...(input_references ? { input_references } : {})
      })
    });
    const json = await upstream.json();
    if (!upstream.ok) return res.status(upstream.status).json(json);
    incrementModelUsage(model);
    res.json(json);
  } catch (err) {
    res.status(500).json({ error: 'Сетевая ошибка при создании видео-задачи', details: err.message });
  }
});

// --- GET /api/video-status/:jobId ---------------------------------------
app.get('/api/video-status/:jobId', async (req, res) => {
  const apiKey = getApiKey(req);
  if (!apiKey) return res.status(401).json({ error: 'Нет API-ключа.' });
  try {
    const upstream = await fetch(`${OPENROUTER_BASE}/videos/${req.params.jobId}`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    const json = await upstream.json();
    if (!upstream.ok) return res.status(upstream.status).json(json);
    res.json(json);
  } catch (err) {
    res.status(500).json({ error: 'Сетевая ошибка при опросе статуса', details: err.message });
  }
});

// --- GET /api/video-content/:jobId --------------------------------------
// Скачивает готовое видео с OpenRouter и стримит его клиенту (клиент не может
// сам приложить Bearer-заголовок к <video src>, поэтому проксируем через себя)
app.get('/api/video-content/:jobId', async (req, res) => {
  const apiKey = getApiKey(req);
  if (!apiKey) return res.status(401).json({ error: 'Нет API-ключа.' });
  try {
    const upstream = await fetch(`${OPENROUTER_BASE}/videos/${req.params.jobId}/content?index=0`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (!upstream.ok) {
      const text = await upstream.text();
      return res.status(upstream.status).send(text);
    }
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'video/mp4');
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: 'Сетевая ошибка при скачивании видео', details: err.message });
  }
});

// --- GET /api/model-stats -------------------------------------------------
// Отдаёт накопленную статистику использования моделей (без авторизации,
// это не персональные данные). Фронтенд сейчас её не показывает —
// только копит, пока не наберётся порог (10 000+) для конкретной модели.
app.get('/api/model-stats', (req, res) => {
  try {
    const stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    res.json(stats);
  } catch {
    res.json({});
  }
});

// --- GET /api/key-check ----------------------------------------------------
// Быстрая проверка валидности ключа (дергает /auth/key у OpenRouter)
app.get('/api/key-check', async (req, res) => {
  const apiKey = getApiKey(req);
  if (!apiKey) return res.status(401).json({ error: 'Нет ключа' });
  try {
    const r = await fetch(`${OPENROUTER_BASE}/auth/key`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    const json = await r.json();
    if (!r.ok) return res.status(r.status).json(json);
    res.json(json);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`OpenRouter test chat запущен: http://localhost:${PORT}`);
});

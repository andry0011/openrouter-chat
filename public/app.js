// app.js — вся логика клиента.
// Данные (ключ, чаты, выбранная модель) живут в localStorage браузера.

const LS_KEYS = {
  apiKey: 'or_api_key',
  chats: 'or_chats',
  activeChat: 'or_active_chat',
  model: 'or_model',
  temperature: 'or_temperature',
  sessionCost: 'or_session_cost',
  isPro: 'or_is_pro'
};

const PLANS = {
  quarter: { label: '3 месяца', totalRub: 4770, periodMonths: 3 },
  month: { label: 'Месяц', totalRub: 1990, periodMonths: 1 }
};

const state = {
  apiKey: localStorage.getItem(LS_KEYS.apiKey) || '',
  models: [],
  selectedModel: localStorage.getItem(LS_KEYS.model) || '',
  temperature: parseFloat(localStorage.getItem(LS_KEYS.temperature) || '0.7'),
  chats: loadChats(),
  activeChatId: localStorage.getItem(LS_KEYS.activeChat) || null,
  sessionCost: parseFloat(localStorage.getItem(LS_KEYS.sessionCost) || '0'),
  streaming: false,
  isPro: localStorage.getItem(LS_KEYS.isPro) === '1',
  selectedPlan: 'quarter',
  mode: 'text', // 'text' | 'image' | 'video'
  videoModels: [],
  user: null, // {id, email, isPro} | null
  activeProvider: null,
  tools: []
};

// ---------- DOM refs ----------
const el = (id) => document.getElementById(id);
const sidebar = el('sidebar');
const chatList = el('chatList');
const newChatBtn = el('newChatBtn');
const settingsBtn = el('settingsBtn');
const settingsOverlay = el('settingsOverlay');
const closeSettings = el('closeSettings');
const saveSettingsBtn = el('saveSettingsBtn');
const apiKeyInput = el('apiKeyInput');
const toggleKeyVisibility = el('toggleKeyVisibility');
const checkKeyBtn = el('checkKeyBtn');
const keyCheckResult = el('keyCheckResult');
const clearAllBtn = el('clearAllBtn');
const tempInput = el('tempInput');
const tempValue = el('tempValue');
const modelPickerBtn = el('modelPickerBtn');
const modelPickerLabel = el('modelPickerLabel');
const modelDropdown = el('modelDropdown');
const modelSearch = el('modelSearch');
const modelOptions = el('modelOptions');
const keyDot = el('keyDot');
const keyStatusText = el('keyStatusText');
const emptyState = el('emptyState');
const messagesEl = el('messages');
const composerForm = el('composerForm');
const composerInput = el('composerInput');
const sendBtn = el('sendBtn');
const usageText = el('usageText');
const attachBtn = el('attachBtn');
const attachInput = el('attachInput');
const attachPreview = el('attachPreview');
const attachPreviewImg = el('attachPreviewImg');
const attachRemoveBtn = el('attachRemoveBtn');
const attachDocChip = el('attachDocChip');
const attachDocName = el('attachDocName');
const composerInner = el('composerInner');
// (изображение теперь часть pendingAttachment, см. ниже по файлу)
const modeToggle = el('modeToggle');
const accountBtn = el('accountBtn');
const accountBtnLabel = el('accountBtnLabel');
const authOverlay = el('authOverlay');
const closeAuth = el('closeAuth');
const authForm = el('authForm');
const authEmail = el('authEmail');
const authPassword = el('authPassword');
const authError = el('authError');
const authSubmitBtn = el('authSubmitBtn');
const authTitle = el('authTitle');
const providerRow = el('providerRow');
const providerClearBtn = el('providerClearBtn');
const catalogOpenBtn = el('catalogOpenBtn');
const catalogOverlay = el('catalogOverlay');
const closeCatalog = el('closeCatalog');
const catalogTabs = el('catalogTabs');
const catalogGrid = el('catalogGrid');
let catalogMode = 'text';
const tileRow = el('tileRow');
const pillRow = el('pillRow');
const toolsSection = el('toolsSection');
const toolsRow = el('toolsRow');
let authMode = 'login'; // 'login' | 'register'
const sidebarToggle = el('sidebarToggle');
const proBadge = el('proBadge');
const paywallOverlay = el('paywallOverlay');
const closePaywall = el('closePaywall');
const planOptions = el('planOptions');
const paywallCta = el('paywallCta');

// ---------- Storage helpers ----------
function loadChats() {
  try {
    const raw = localStorage.getItem(LS_KEYS.chats);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
function saveChats() {
  localStorage.setItem(LS_KEYS.chats, JSON.stringify(state.chats));
}
function saveSessionCost() {
  localStorage.setItem(LS_KEYS.sessionCost, String(state.sessionCost));
}

// ---------- Init ----------
async function init() {
  apiKeyInput.value = state.apiKey;
  tempInput.value = state.temperature;
  tempValue.textContent = state.temperature.toFixed(1);
  usageText.textContent = `$${state.sessionCost.toFixed(4)}`;
  updateKeyStatus();
  await checkAuth();
  updateProBadge();
  renderChatList();

  if (!state.activeChatId || !state.chats.find(c => c.id === state.activeChatId)) {
    if (state.chats.length) {
      state.activeChatId = state.chats[0].id;
    }
  }
  renderActiveChat();
  loadModels();
  loadTools();
  autoresizeTextarea();
}

function updateKeyStatus() {
  if (state.apiKey) {
    keyDot.classList.add('ok');
    keyStatusText.textContent = 'Ключ задан';
  } else {
    keyDot.classList.remove('ok');
    keyStatusText.textContent = 'Ключ не задан';
  }
  sendBtn.disabled = !(state.apiKey && state.selectedModel && (composerInput.value.trim() || pendingAttachment));
}

// ---------- Models ----------
// Модели, которые физически не работают через обычный чат-эндпоинт —
// скрываем их из списка, чтобы не натыкаться на предсказуемые ошибки.
const NON_CHAT_PATTERNS = [
  '(batch)', '-batch', '/batch',
  'embedding', 'embed-',
  'moderation', 'moderat',
  'rerank', 're-rank',
  'whisper', 'tts', 'text-to-speech', 'speech-to-text',
  '-instruct-tuning', 'classifier'
];

function isChatCompatible(m) {
  const hay = `${m.id} ${m.name || ''}`.toLowerCase();
  return !NON_CHAT_PATTERNS.some(p => hay.includes(p));
}

function getModelsForMode() {
  let pool;
  if (state.mode === 'video') pool = state.videoModels; // видео-каталог отдельный, этот фильтр к нему не относится
  else if (state.mode === 'image') pool = state.models.filter(m => (m.architecture?.output_modalities || []).includes('image'));
  else pool = state.models.filter(m => (m.architecture?.output_modalities || ['text']).includes('text'));

  if (state.mode !== 'video') pool = pool.filter(isChatCompatible);

  if (state.activeProvider) {
    pool = pool.filter(m => m.id.toLowerCase().startsWith(state.activeProvider + '/'));
  }
  return pool;
}

async function loadVideoModels() {
  if (state.videoModels.length) return; // уже загружены
  try {
    const res = await fetch('/api/video-models');
    const json = await res.json();
    state.videoModels = (json.data || []).slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  } catch (err) {
    console.error('Не удалось загрузить видео-модели', err);
  }
}

async function loadModels() {
  modelOptions.innerHTML = '<div class="model-loading">Загружаю список моделей…</div>';
  try {
    const res = await fetch('/api/models');
    const json = await res.json();
    state.models = (json.data || []).slice().sort((a, b) => a.name.localeCompare(b.name));
    renderModelOptions(getModelsForMode());

    if (state.selectedModel) {
      const m = state.models.find(m => m.id === state.selectedModel);
      modelPickerLabel.textContent = m ? m.name : state.selectedModel;
    } else if (state.models.length) {
      // разумный дефолт
      const pool = getModelsForMode();
      const preferred = pickDefaultModel(pool);
      if (preferred) selectModel(preferred.id, false);
    }
  } catch (err) {
    modelOptions.innerHTML = `<div class="model-empty">Не удалось загрузить модели: ${escapeHtml(err.message)}</div>`;
  }
  initProviderTiles();
}

function renderModelOptions(list) {
  if (!list.length) {
    modelOptions.innerHTML = '<div class="model-empty">Ничего не найдено</div>';
    return;
  }
  modelOptions.innerHTML = '';
  list.slice(0, 200).forEach(m => {
    const opt = document.createElement('div');
    opt.className = 'model-option' + (m.id === state.selectedModel ? ' selected' : '');
    let priceLabel;
    if (state.mode === 'video') {
      // У видео-моделей другая тарификация (за секунду/клип, не за токены) —
      // не показываем вводящие в заблуждение "$?/$?", просто честно отмечаем это
      priceLabel = 'цена рассчитывается при генерации';
    } else {
      const priceIn = m.pricing?.prompt ? (parseFloat(m.pricing.prompt) * 1_000_000).toFixed(2) : null;
      const priceOut = m.pricing?.completion ? (parseFloat(m.pricing.completion) * 1_000_000).toFixed(2) : null;
      priceLabel = (priceIn !== null && priceOut !== null)
        ? `$${priceIn}/$${priceOut} за 1M токенов`
        : 'цена уточняется при запросе';
    }
    const supportsVision = (m.architecture?.input_modalities || []).includes('image');
    opt.innerHTML = `
      <span class="m-name">${escapeHtml(m.name || m.id)}${supportsVision ? ' <span class="vision-badge" title="Понимает изображения">👁</span>' : ''}</span>
      <span class="m-meta">${escapeHtml(m.id)} · ${priceLabel}</span>
    `;
    opt.addEventListener('click', () => {
      selectModel(m.id, true);
      modelDropdown.classList.remove('open');
    });
    modelOptions.appendChild(opt);
  });
}

function selectModel(id, persist) {
  state.selectedModel = id;
  const m = state.models.find(x => x.id === id);
  modelPickerLabel.textContent = m ? m.name : id;
  if (persist) localStorage.setItem(LS_KEYS.model, id);
  else localStorage.setItem(LS_KEYS.model, id);
  updateKeyStatus();
}

modelPickerBtn.addEventListener('click', () => {
  modelDropdown.classList.toggle('open');
  if (modelDropdown.classList.contains('open')) {
    modelSearch.value = '';
    renderModelOptions(getModelsForMode());
    modelSearch.focus();
  }
});
modelSearch.addEventListener('input', () => {
  const q = modelSearch.value.trim().toLowerCase();
  const filtered = getModelsForMode().filter(m =>
    m.id.toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q)
  );
  renderModelOptions(filtered);
});

// ---------- Mode toggle (text / image / video) ----------
modeToggle.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    modeToggle.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.mode = btn.dataset.mode;
    activeQuickChipKeyword = null;
    providerRow.querySelectorAll('.provider-chip').forEach(c => c.classList.remove('active'));
    providerClearBtn.style.display = 'none';
    updateComposerHint();

    if (state.mode === 'video' && !state.videoModels.length) {
      modelOptions.innerHTML = '<div class="model-loading">Загружаю видео-модели…</div>';
      await loadVideoModels();
    }

    // сброс модели при смене режима, если она не подходит новому режиму
    const pool = getModelsForMode();
    if (!pool.find(m => m.id === state.selectedModel)) {
      state.selectedModel = '';
      modelPickerLabel.textContent = 'Выберите модель';
      const preferred = pickDefaultModel(pool);
      if (preferred) selectModel(preferred.id, true);
    }
    renderModelOptions(pool);
    updateKeyStatus();
  });
});
document.addEventListener('click', (e) => {
  if (!el('modelPicker').contains(e.target)) modelDropdown.classList.remove('open');
});

// ---------- Chat list / sidebar ----------
function renderChatList() {
  chatList.innerHTML = '';
  state.chats.forEach(chat => {
    const item = document.createElement('div');
    item.className = 'chat-item' + (chat.id === state.activeChatId ? ' active' : '');
    item.innerHTML = `<span>${escapeHtml(chat.title || 'Новый чат')}</span><button class="del-btn" aria-label="Удалить">✕</button>`;
    item.addEventListener('click', (e) => {
      if (e.target.closest('.del-btn')) return;
      state.activeChatId = chat.id;
      localStorage.setItem(LS_KEYS.activeChat, chat.id);
      renderChatList();
      renderActiveChat();
      closeSidebarOnMobile();
    });
    item.querySelector('.del-btn').addEventListener('click', () => {
      state.chats = state.chats.filter(c => c.id !== chat.id);
      saveChats();
      if (state.activeChatId === chat.id) {
        state.activeChatId = state.chats[0]?.id || null;
      }
      renderChatList();
      renderActiveChat();
    });
    chatList.appendChild(item);
  });
}

function getActiveChat() {
  return state.chats.find(c => c.id === state.activeChatId) || null;
}

function createChat() {
  const chat = { id: 'c_' + Date.now(), title: 'Новый чат', messages: [], createdAt: Date.now() };
  state.chats.unshift(chat);
  state.activeChatId = chat.id;
  localStorage.setItem(LS_KEYS.activeChat, chat.id);
  saveChats();
  renderChatList();
  renderActiveChat();
  composerInput.focus();
}

newChatBtn.addEventListener('click', () => {
  createChat();
  closeSidebarOnMobile();
});

// ---------- Rendering messages ----------
function renderActiveChat() {
  const chat = getActiveChat();
  messagesEl.innerHTML = '';
  if (!chat || chat.messages.length === 0) {
    emptyState.style.display = 'block';
    return;
  }
  emptyState.style.display = 'none';
  chat.messages.forEach(msg => appendMessageEl(msg));
  scrollToBottom();
}

function appendMessageEl(msg) {
  emptyState.style.display = 'none';
  const wrap = document.createElement('div');
  wrap.className = `msg ${msg.role}${msg.error ? ' error' : ''}`;

  if (msg.role === 'assistant') {
    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    avatar.textContent = '✦';
    wrap.appendChild(avatar);
  }

  const inner = document.createElement('div');
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';

  if (msg.fileName) {
    const fileChip = document.createElement('div');
    fileChip.className = 'msg-file-chip';
    fileChip.textContent = '📎 ' + msg.fileName;
    bubble.appendChild(fileChip);
  }

  const isLockedNow = msg.role === 'assistant' && msg.locked && !state.isPro;

  if (msg.image) {
    if (isLockedNow) {
      const imgWrap = document.createElement('div');
      imgWrap.className = 'locked-image-wrap';
      const img = document.createElement('img');
      img.className = 'msg-image';
      img.src = msg.image;
      const overlay = document.createElement('div');
      overlay.className = 'locked-image-overlay';
      overlay.innerHTML = '<span class="locked-cta">🔒 Оформите Pro, чтобы увидеть картинку</span>';
      overlay.addEventListener('click', openPaywall);
      imgWrap.appendChild(img);
      imgWrap.appendChild(overlay);
      bubble.appendChild(imgWrap);
    } else {
      const img = document.createElement('img');
      img.className = 'msg-image';
      img.src = msg.image;
      img.alt = 'Изображение';
      bubble.appendChild(img);
      if (msg.content) {
        const textEl = document.createElement('div');
        textEl.textContent = msg.content;
        bubble.appendChild(textEl);
      }
    }
  } else if (isLockedNow) {
    bubble.classList.add('locked');
    const preview = document.createElement('div');
    preview.className = 'locked-preview';
    preview.textContent = msg.content ? msg.content.slice(0, 90) + '…' : 'Ответ готов.';
    const cta = document.createElement('div');
    cta.className = 'locked-cta';
    cta.textContent = '🔒 Оформите Pro, чтобы прочитать ответ';
    bubble.appendChild(preview);
    bubble.appendChild(cta);
    bubble.addEventListener('click', openPaywall);
  } else {
    const textEl = document.createElement('span');
    textEl.textContent = msg.content;
    bubble.appendChild(textEl);
  }
  inner.appendChild(bubble);

  if (msg.meta && !isLockedNow) {
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.textContent = msg.meta;
    inner.appendChild(meta);
  }

  wrap.appendChild(inner);
  messagesEl.appendChild(wrap);
  return { wrap, bubble, inner };
}

function toApiContent(m) {
  const textForApi = m.apiContent !== undefined ? m.apiContent : m.content;
  if (!m.image) return textForApi;
  const parts = [];
  if (textForApi) parts.push({ type: 'text', text: textForApi });
  parts.push({ type: 'image_url', image_url: { url: m.image } });
  return parts;
}

function pickDefaultModel(pool) {
  if (!pool.length) return null;
  // Не выбираем автоматически "openrouter/auto" и подобные мета-модели —
  // они не подходят как разумный дефолт (непредсказуемая цена/поведение).
  const withoutAuto = pool.filter(m => !m.id.toLowerCase().includes('auto'));
  const searchIn = withoutAuto.length ? withoutAuto : pool;
  return searchIn.find(m => m.id.includes('claude')) || searchIn[0];
}

function scrollToBottom() {
  const area = el('chatArea');
  area.scrollTop = area.scrollHeight;
}

// ---------- Sending messages ----------
// ---------- Attachments: изображения (vision) + документы (Excel/ZIP/текст) ----------
// pendingAttachment: { kind: 'image', dataUrl } | { kind: 'doc', filename, extractedText } | null
let pendingAttachment = null;

function sheetToMarkdown(sheet) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false });
  if (!rows.length) return '(пустой лист)';
  const header = rows[0].map(c => String(c ?? ''));
  const body = rows.slice(1, 201); // ограничим 200 строками, чтобы не раздувать запрос
  let md = `| ${header.join(' | ')} |\n| ${header.map(() => '---').join(' | ')} |\n`;
  body.forEach(r => { md += `| ${header.map((_, i) => String(r[i] ?? '')).join(' | ')} |\n`; });
  if (rows.length - 1 > 200) md += `\n… и ещё ${rows.length - 1 - 200} строк (обрезано)\n`;
  return md;
}

// Ищет итоговую сумму сметы (формат "ГРАНД-Смета" и похожие): строка с текстом
// ровно "Итого" -> число в столбце L. Если такой строки нет — берём "Итого c
// накладными и см. прибылью". Если и её нет — суммируем справочные компоненты
// (прямые затраты + накладные расходы + сметная прибыль). Возвращает число или null.
function findSmetaTotal(sheet) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false });
  const COL_L = 11; // A=0 ... L=11
  let itogo = null, sNakladnymi = null, refDirect = null, refOverhead = null, refProfit = null;
  rows.forEach(r => {
    const label = String(r[0] ?? '').trim();
    const val = r[COL_L];
    if (typeof val !== 'number') return;
    if (label === 'Итого') itogo = val;
    else if (label === 'Итого c накладными и см. прибылью') sNakladnymi = val;
    else if (label.includes('Итого прямые затраты') && label.includes('справочно')) refDirect = val;
    else if (label.includes('Итого накладные расходы') && label.includes('справочно')) refOverhead = val;
    else if (label.includes('Итого сметная прибыль') && label.includes('справочно')) refProfit = val;
  });
  if (itogo !== null) return itogo;
  if (sNakladnymi !== null) return sNakladnymi;
  if (refDirect !== null && refOverhead !== null && refProfit !== null) return refDirect + refOverhead + refProfit;
  return null;
}

async function extractExcel(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  let out = '';
  wb.SheetNames.forEach(name => {
    const total = findSmetaTotal(wb.Sheets[name]);
    if (total !== null) out += `💰 Итог сметы «${name}»: ${total.toLocaleString('ru-RU')} ₽\n\n`;
    out += `### Лист «${name}»\n${sheetToMarkdown(wb.Sheets[name])}\n\n`;
  });
  return out.trim();
}

const TEXT_EXTENSIONS = ['.txt', '.md', '.csv', '.json', '.js', '.py', '.html', '.css', '.xml', '.yml', '.yaml', '.log'];
const EXCEL_EXTENSIONS = ['.xlsx', '.xls'];

async function extractZip(file) {
  const zip = await JSZip.loadAsync(file);
  const entries = Object.values(zip.files).filter(f => !f.dir);
  const smetaTotals = []; // { name, total } — для итоговой сводки по всему архиву
  let out = `Архив «${file.name}», файлов: ${entries.length}\n\n`;
  let textFilesCount = 0;
  let excelDumpsCount = 0;

  for (const entry of entries) {
    const lower = entry.name.toLowerCase();
    const isText = TEXT_EXTENSIONS.some(ext => lower.endsWith(ext));
    const isExcel = EXCEL_EXTENSIONS.some(ext => lower.endsWith(ext));

    if (isExcel) {
      try {
        const buf = await entry.async('arraybuffer');
        const wb = XLSX.read(buf, { type: 'array' });
        const firstSheet = wb.Sheets[wb.SheetNames[0]];
        const total = findSmetaTotal(firstSheet);
        if (total !== null) {
          // Похоже на смету — не раздуваем текст всей таблицей, достаточно итога
          smetaTotals.push({ name: entry.name, total });
          out += `📄 ${entry.name} — обнаружен итог сметы: ${total.toLocaleString('ru-RU')} ₽\n`;
        } else if (excelDumpsCount < 10) {
          // Не похоже на смету — выгружаем как обычную таблицу (с разумным лимитом)
          out += `--- ${entry.name} ---\n${sheetToMarkdown(firstSheet)}\n\n`;
          excelDumpsCount++;
        } else {
          out += `[Excel-файл пропущен (лимит подробного разбора исчерпан): ${entry.name}]\n`;
        }
      } catch (err) {
        out += `[не удалось прочитать Excel-файл ${entry.name}: ${err.message}]\n`;
      }
    } else if (isText && textFilesCount < 15) {
      const content = await entry.async('string');
      out += `--- ${entry.name} ---\n${content.slice(0, 4000)}${content.length > 4000 ? '\n…(обрезано)' : ''}\n\n`;
      textFilesCount++;
    } else {
      out += `[бинарный/пропущенный файл: ${entry.name}]\n`;
    }
  }

  if (smetaTotals.length) {
    const grandTotal = smetaTotals.reduce((s, x) => s + x.total, 0);
    out += `\n\n📊 Автоматически найдены итоги по ${smetaTotals.length} из ${entries.length} файлов.\n`;
    out += `ОБЩАЯ СУММА ПО ВСЕМ СМЕТАМ: ${grandTotal.toLocaleString('ru-RU')} ₽\n`;
    if (smetaTotals.length < entries.length) {
      out += `(в остальных файлах итог не распознан по стандартному шаблону — проверьте их отдельно)\n`;
    }
  }

  return out.trim();
}

async function extractPlainText(file) {
  const text = await file.text();
  return text.slice(0, 20000) + (text.length > 20000 ? '\n…(обрезано)' : '');
}

function showDocPreview(filename) {
  attachPreviewImg.style.display = 'none';
  attachDocChip.style.display = 'flex';
  attachDocName.textContent = filename;
  attachPreview.style.display = 'flex';
}
function showImagePreview(dataUrl) {
  attachDocChip.style.display = 'none';
  attachPreviewImg.style.display = 'block';
  attachPreviewImg.src = dataUrl;
  attachPreview.style.display = 'flex';
}

async function handleIncomingFile(file) {
  if (!file) return;
  const name = file.name.toLowerCase();

  try {
    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = () => {
        pendingAttachment = { kind: 'image', dataUrl: reader.result };
        showImagePreview(reader.result);
        updateKeyStatus();
      };
      reader.readAsDataURL(file);
      return;
    }

    if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
      const text = await extractExcel(file);
      pendingAttachment = { kind: 'doc', filename: file.name, extractedText: text };
      showDocPreview(file.name);
      updateKeyStatus();
      return;
    }

    if (name.endsWith('.zip')) {
      const text = await extractZip(file);
      pendingAttachment = { kind: 'doc', filename: file.name, extractedText: text };
      showDocPreview(file.name);
      updateKeyStatus();
      return;
    }

    if (TEXT_EXTENSIONS.some(ext => name.endsWith(ext))) {
      const text = await extractPlainText(file);
      pendingAttachment = { kind: 'doc', filename: file.name, extractedText: text };
      showDocPreview(file.name);
      updateKeyStatus();
      return;
    }

    alert('Этот тип файла пока не поддерживается. Можно: изображения, .xlsx/.xls, .zip, .txt/.md/.csv/.json и похожие текстовые форматы.');
  } catch (err) {
    alert('Не удалось прочитать файл: ' + err.message);
  }
}

attachBtn.addEventListener('click', () => attachInput.click());
attachInput.addEventListener('change', () => {
  handleIncomingFile(attachInput.files[0]);
});

attachRemoveBtn.addEventListener('click', () => {
  pendingAttachment = null;
  attachInput.value = '';
  attachPreview.style.display = 'none';
});

// Drag-and-drop прямо на поле ввода
let dragCounter = 0;
composerInner.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragCounter++;
  composerInner.classList.add('drag-over');
});
composerInner.addEventListener('dragover', (e) => e.preventDefault());
composerInner.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragCounter--;
  if (dragCounter <= 0) { dragCounter = 0; composerInner.classList.remove('drag-over'); }
});
composerInner.addEventListener('drop', (e) => {
  e.preventDefault();
  dragCounter = 0;
  composerInner.classList.remove('drag-over');
  const file = e.dataTransfer?.files?.[0];
  if (file) handleIncomingFile(file);
});

composerInput.addEventListener('input', () => {
  updateKeyStatus();
  autoresizeTextarea();
});
composerInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    composerForm.requestSubmit();
  }
});
function autoresizeTextarea() {
  composerInput.style.height = 'auto';
  composerInput.style.height = Math.min(composerInput.scrollHeight, 200) + 'px';
}

composerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = composerInput.value.trim();
  const image = (pendingAttachment?.kind === 'image') ? pendingAttachment.dataUrl : null;
  const docAttachment = (pendingAttachment?.kind === 'doc') ? pendingAttachment : null;
  if (!text && !image && !docAttachment) return;
  if (state.streaming) return;
  if (!state.apiKey) { openSettings(); return; }
  if (!state.selectedModel) { alert('Выберите модель'); return; }

  let chat = getActiveChat();
  const titleSeed = text || docAttachment?.filename || 'Изображение';
  if (!chat) {
    chat = { id: 'c_' + Date.now(), title: titleSeed.slice(0, 40), messages: [], createdAt: Date.now() };
    state.chats.unshift(chat);
    state.activeChatId = chat.id;
    localStorage.setItem(LS_KEYS.activeChat, chat.id);
  }
  if (chat.messages.length === 0) {
    chat.title = titleSeed.slice(0, 40) || 'Новый чат';
  }

  // Итоговый текст, который уйдёт модели: если есть документ — его содержимое
  // добавляется перед сообщением пользователя (сама модель этого не увидит
  // отдельно от текста, для неё это просто часть одного сообщения).
  const apiText = docAttachment
    ? `[Файл: ${docAttachment.filename}]\n${docAttachment.extractedText}\n\n${text || 'Проанализируй содержимое файла выше.'}`
    : text;

  const userMsg = { role: 'user', content: text, apiContent: apiText, image, fileName: docAttachment?.filename || null };
  chat.messages.push(userMsg);
  appendMessageEl(userMsg);
  saveChats();
  renderChatList();

  // сброс вложения после отправки
  pendingAttachment = null;
  attachInput.value = '';
  attachPreview.style.display = 'none';

  composerInput.value = '';
  autoresizeTextarea();
  updateKeyStatus();
  scrollToBottom();

  if (state.mode === 'image') {
    await generateImage(chat, text, image);
  } else if (state.mode === 'video') {
    await generateVideo(chat, text, image);
  } else if (state.isPro) {
    await streamAssistantReply(chat);
  } else {
    await sendLockedMessage(chat);
  }
});

async function generateImage(chat, prompt, refImage) {
  state.streaming = true;
  sendBtn.disabled = true;

  const assistantMsg = { role: 'assistant', content: '', image: null, locked: true };
  const { bubble } = appendMessageEl(assistantMsg);
  bubble.innerHTML = '<div class="img-loading"><span class="typing-dots"><span></span><span></span><span></span></span> Генерирую изображение…</div>';
  scrollToBottom();

  try {
    const res = await fetch('/api/generate-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-openrouter-key': state.apiKey },
      body: JSON.stringify({
        model: state.selectedModel,
        prompt: prompt || 'Опиши и создай изображение',
        ...(refImage ? { input_references: [refImage] } : {})
      })
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message || json.error || `HTTP ${res.status}`);

    const item = json.data?.[0];
    if (!item?.b64_json) throw new Error('Модель не вернула изображение');
    const mediaType = item.media_type || 'image/png';
    const dataUrl = `data:${mediaType};base64,${item.b64_json}`;

    assistantMsg.image = dataUrl;
    assistantMsg.locked = !state.isPro;
    if (json.usage?.cost !== undefined) {
      assistantMsg.meta = `$${Number(json.usage.cost).toFixed(5)}`;
      state.sessionCost += Number(json.usage.cost);
      usageText.textContent = `$${state.sessionCost.toFixed(4)}`;
      saveSessionCost();
    }

    chat.messages.push(assistantMsg);
    saveChats();
    renderChatList();
    renderActiveChat();
    if (!state.isPro) openPaywall();
  } catch (err) {
    bubble.innerHTML = '';
    bubble.classList.add('locked');
    bubble.textContent = 'Ошибка генерации: ' + err.message;
  } finally {
    state.streaming = false;
    updateKeyStatus();
  }
}

async function generateVideo(chat, prompt, refImage) {
  state.streaming = true;
  sendBtn.disabled = true;

  const assistantMsg = { role: 'assistant', content: '', video: null, locked: true };
  const { bubble } = appendMessageEl(assistantMsg);

  function renderProgress(label) {
    bubble.innerHTML = `<div class="video-progress"><div class="vp-row">🎬 ${escapeHtml(label)}</div><div class="vp-bar-track"><div class="vp-bar-fill"></div></div></div>`;
  }
  renderProgress('Отправляю запрос на генерацию…');
  scrollToBottom();

  try {
    const submitRes = await fetch('/api/generate-video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-openrouter-key': state.apiKey },
      body: JSON.stringify({
        model: state.selectedModel,
        prompt: prompt || 'Сгенерируй видео',
        ...(refImage ? { input_references: [refImage] } : {})
      })
    });
    const submitJson = await submitRes.json();
    if (!submitRes.ok) throw new Error(submitJson.error?.message || submitJson.error || `HTTP ${submitRes.status}`);

    const jobId = submitJson.id;
    if (!jobId) throw new Error('Сервер не вернул id задачи');

    renderProgress('Видео генерируется — это может занять несколько минут…');

    // Поллинг статуса каждые 8 секунд, до 20 попыток (~2.5 минуты); можно увеличить при необходимости
    let statusJson = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      await new Promise(r => setTimeout(r, 8000));
      const statusRes = await fetch(`/api/video-status/${jobId}`, {
        headers: { 'x-openrouter-key': state.apiKey }
      });
      statusJson = await statusRes.json();
      if (!statusRes.ok) throw new Error(statusJson.error?.message || statusJson.error || `HTTP ${statusRes.status}`);

      if (statusJson.status === 'completed') break;
      if (['failed', 'cancelled', 'expired'].includes(statusJson.status)) {
        throw new Error(statusJson.error || `Задача завершилась со статусом: ${statusJson.status}`);
      }
      renderProgress(`Статус: ${statusJson.status || 'обрабатывается'}…`);
    }

    if (!statusJson || statusJson.status !== 'completed') {
      throw new Error('Превышено время ожидания генерации видео');
    }

    renderProgress('Скачиваю готовое видео…');

    const contentRes = await fetch(`/api/video-content/${jobId}`, {
      headers: { 'x-openrouter-key': state.apiKey }
    });
    if (!contentRes.ok) throw new Error('Не удалось скачать видео');
    const blob = await contentRes.blob();
    const videoUrl = URL.createObjectURL(blob);

    assistantMsg.video = videoUrl;
    assistantMsg.locked = !state.isPro;
    if (statusJson.usage?.cost !== undefined) {
      assistantMsg.meta = `$${Number(statusJson.usage.cost).toFixed(5)}`;
      state.sessionCost += Number(statusJson.usage.cost);
      usageText.textContent = `$${state.sessionCost.toFixed(4)}`;
      saveSessionCost();
    }

    // Видео (blob URL) не переживёт перезагрузку страницы — в истории чата не сохраняем сам ролик,
    // только факт и мету, чтобы не засорять localStorage. Отображаем в текущей сессии.
    chat.messages.push({ ...assistantMsg, video: null, content: assistantMsg.locked ? '' : '(видео сгенерировано в этой сессии)' });
    saveChats();
    renderChatList();

    // Рендерим сам плеер напрямую в DOM (не через renderActiveChat, чтобы не потерять blob URL)
    bubble.innerHTML = '';
    if (assistantMsg.locked) {
      const wrap = document.createElement('div');
      wrap.className = 'locked-video-wrap';
      const video = document.createElement('video');
      video.className = 'msg-video';
      video.src = videoUrl;
      video.muted = true;
      const overlay = document.createElement('div');
      overlay.className = 'locked-image-overlay';
      overlay.innerHTML = '<span class="locked-cta">🔒 Оформите Pro, чтобы посмотреть видео</span>';
      overlay.addEventListener('click', openPaywall);
      wrap.appendChild(video);
      wrap.appendChild(overlay);
      bubble.appendChild(wrap);
      openPaywall();
    } else {
      const video = document.createElement('video');
      video.className = 'msg-video';
      video.src = videoUrl;
      video.controls = true;
      bubble.appendChild(video);
    }
  } catch (err) {
    bubble.innerHTML = '';
    bubble.classList.add('locked');
    bubble.textContent = 'Ошибка генерации видео: ' + err.message;
  } finally {
    state.streaming = false;
    updateKeyStatus();
  }
}

async function streamAssistantReply(chat) {
  state.streaming = true;
  sendBtn.disabled = true;

  const assistantMsg = { role: 'assistant', content: '' };
  const { bubble, inner } = appendMessageEl(assistantMsg);
  const dots = document.createElement('span');
  dots.className = 'typing-dots';
  dots.innerHTML = '<span></span><span></span><span></span>';
  bubble.appendChild(dots);
  scrollToBottom();

  const payloadMessages = chat.messages.map(m => ({ role: m.role, content: toApiContent(m) }));

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-openrouter-key': state.apiKey
      },
      body: JSON.stringify({
        model: state.selectedModel,
        messages: payloadMessages,
        stream: true,
        temperature: state.temperature
      })
    });

    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      throw new Error(errJson.error?.message || errJson.error || `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    let usage = null;
    let firstChunk = true;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // может быть неполной строкой

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;
        let json;
        try { json = JSON.parse(data); } catch { continue; }

        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          if (firstChunk) { dots.remove(); firstChunk = false; }
          fullText += delta;
          bubble.textContent = fullText;
          scrollToBottom();
        }
        if (json.usage) usage = json.usage;
      }
    }

    if (firstChunk) dots.remove();
    assistantMsg.content = fullText || '(пустой ответ)';
    bubble.textContent = assistantMsg.content;

    if (usage) {
      const cost = estimateCost(state.selectedModel, usage);
      assistantMsg.meta = `${usage.prompt_tokens ?? '?'} → ${usage.completion_tokens ?? '?'} токенов` +
        (cost !== null ? ` · $${cost.toFixed(5)}` : '');
      if (cost !== null) {
        state.sessionCost += cost;
        usageText.textContent = `$${state.sessionCost.toFixed(4)}`;
        saveSessionCost();
      }
      const metaEl = document.createElement('div');
      metaEl.className = 'msg-meta';
      metaEl.textContent = assistantMsg.meta;
      inner.appendChild(metaEl);
    }

    chat.messages.push(assistantMsg);
    saveChats();
    renderChatList();
  } catch (err) {
    dots.remove();
    bubble.parentElement.parentElement.classList.add('error');
    bubble.textContent = 'Ошибка: ' + err.message;
  } finally {
    state.streaming = false;
    updateKeyStatus();
  }
}

function estimateCost(modelId, usage) {
  // Приоритет — реальная стоимость от OpenRouter (usage.cost, приходит благодаря
  // параметру usage:{include:true}). Наш расчёт по таблице цен — только запасной
  // вариант, и он ненадёжен для мета-моделей вроде "Auto Router" (там в pricing
  // служебные значения вместо обычной цены за токен).
  if (usage && usage.cost !== undefined && usage.cost !== null) {
    return Number(usage.cost);
  }
  const m = state.models.find(x => x.id === modelId);
  if (!m || !m.pricing) return null;
  const promptPrice = parseFloat(m.pricing.prompt || '0');
  const completionPrice = parseFloat(m.pricing.completion || '0');
  if (Number.isNaN(promptPrice) || Number.isNaN(completionPrice)) return null;
  // Отрицательные тарифы — служебные "sentinel"-значения, а не реальная цена.
  if (promptPrice < 0 || completionPrice < 0) return null;
  return (usage.prompt_tokens || 0) * promptPrice + (usage.completion_tokens || 0) * completionPrice;
}

// ---------- Settings modal ----------
function openSettings() { settingsOverlay.classList.add('open'); }
function closeSettingsModal() { settingsOverlay.classList.remove('open'); }

settingsBtn.addEventListener('click', openSettings);
closeSettings.addEventListener('click', closeSettingsModal);
settingsOverlay.addEventListener('click', (e) => { if (e.target === settingsOverlay) closeSettingsModal(); });

toggleKeyVisibility.addEventListener('click', () => {
  const isPw = apiKeyInput.type === 'password';
  apiKeyInput.type = isPw ? 'text' : 'password';
  toggleKeyVisibility.textContent = isPw ? 'Скрыть' : 'Показать';
});

tempInput.addEventListener('input', () => {
  tempValue.textContent = parseFloat(tempInput.value).toFixed(1);
});

saveSettingsBtn.addEventListener('click', () => {
  state.apiKey = apiKeyInput.value.trim();
  state.temperature = parseFloat(tempInput.value);
  localStorage.setItem(LS_KEYS.apiKey, state.apiKey);
  localStorage.setItem(LS_KEYS.temperature, String(state.temperature));
  updateKeyStatus();
  closeSettingsModal();
});

checkKeyBtn.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  if (!key) { keyCheckResult.textContent = 'Введите ключ сначала.'; keyCheckResult.className = 'key-check-result err'; return; }
  keyCheckResult.textContent = 'Проверяю…';
  keyCheckResult.className = 'key-check-result';
  try {
    const res = await fetch('/api/key-check', { headers: { 'x-openrouter-key': key } });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message || json.error || 'Ошибка проверки');
    const d = json.data || {};
    const limit = d.limit !== null && d.limit !== undefined ? `$${d.limit}` : 'не ограничен';
    const usage = d.usage !== undefined ? `$${Number(d.usage).toFixed(4)}` : '?';
    keyCheckResult.textContent = `✓ Ключ рабочий. Использовано: ${usage}, лимит: ${limit}.`;
    keyCheckResult.className = 'key-check-result ok';
  } catch (err) {
    keyCheckResult.textContent = '✗ ' + err.message;
    keyCheckResult.className = 'key-check-result err';
  }
});

clearAllBtn.addEventListener('click', () => {
  if (!confirm('Удалить все чаты, ключ и настройки безвозвратно?')) return;
  Object.values(LS_KEYS).forEach(k => localStorage.removeItem(k));
  location.reload();
});

// ---------- Auth (accounts) ----------
async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (res.ok) {
      const json = await res.json();
      state.user = json.user;
      state.isPro = !!json.user.isPro;
    } else {
      state.user = null;
      state.isPro = false;
    }
  } catch {
    state.user = null;
  }
  updateAccountBtn();
}

function updateAccountBtn() {
  accountBtnLabel.textContent = state.user ? state.user.email.split('@')[0] : 'Войти';
}

function openAuth(mode) {
  authMode = mode || 'login';
  authOverlay.classList.add('open');
  authTitle.textContent = authMode === 'login' ? 'Вход' : 'Регистрация';
  authSubmitBtn.textContent = authMode === 'login' ? 'Войти' : 'Зарегистрироваться';
  authError.style.display = 'none';
  document.querySelectorAll('.auth-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === authMode));
}
function closeAuthModal() { authOverlay.classList.remove('open'); }

accountBtn.addEventListener('click', async () => {
  if (state.user) {
    if (confirm(`Выйти из аккаунта ${state.user.email}?`)) {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
      state.user = null;
      state.isPro = false;
      updateAccountBtn();
      updateProBadge();
      renderActiveChat();
    }
  } else {
    openAuth('login');
  }
});
closeAuth.addEventListener('click', closeAuthModal);
authOverlay.addEventListener('click', (e) => { if (e.target === authOverlay) closeAuthModal(); });

document.querySelectorAll('.auth-tab').forEach(tab => {
  tab.addEventListener('click', () => openAuth(tab.dataset.tab));
});

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  authError.style.display = 'none';
  authSubmitBtn.disabled = true;
  try {
    const res = await fetch(`/api/auth/${authMode === 'login' ? 'login' : 'register'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ email: authEmail.value.trim(), password: authPassword.value })
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Ошибка');
    state.user = json.user;
    state.isPro = !!json.user.isPro;
    updateAccountBtn();
    updateProBadge();
    closeAuthModal();
    authForm.reset();
    renderActiveChat();
  } catch (err) {
    authError.textContent = err.message;
    authError.style.display = 'block';
  } finally {
    authSubmitBtn.disabled = false;
  }
});

// ---------- Provider tiles + version pills (пустой экран нового чата, как у Umnik) ----------
function renderVersionPills(prefix) {
  const pool = state.models
    .filter(m => (m.architecture?.output_modalities || ['text']).includes('text'))
    .filter(isChatCompatible)
    .filter(m => m.id.toLowerCase().startsWith(prefix));

  pillRow.innerHTML = '';
  if (!pool.length) return;

  pool.forEach((m, i) => {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'version-pill' + (i === 0 ? ' active' : '');
    // короткое имя без названия провайдера (например "Claude Sonnet 5" -> "Sonnet 5")
    pill.textContent = (m.name || m.id).replace(/^.*?:\s*/, '');
    pill.addEventListener('click', () => {
      pillRow.querySelectorAll('.version-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      selectModel(m.id, true);
    });
    pillRow.appendChild(pill);
  });

  if (pool[0]) selectModel(pool[0].id, true);
}

tileRow.querySelectorAll('.provider-tile').forEach(tile => {
  tile.addEventListener('click', () => {
    tileRow.querySelectorAll('.provider-tile').forEach(t => t.classList.remove('active'));
    tile.classList.add('active');
    renderVersionPills(tile.dataset.prefix);
  });
});

function initProviderTiles() {
  if (!state.models.length) return;
  const defaultTile = tileRow.querySelector('[data-tile="anthropic"]') || tileRow.querySelector('.provider-tile');
  if (defaultTile) {
    tileRow.querySelectorAll('.provider-tile').forEach(t => t.classList.remove('active'));
    defaultTile.classList.add('active');
    renderVersionPills(defaultTile.dataset.prefix);
  }
}

// ---------- Карусель "Инструменты" (готовые пресеты для правки фото, как у Umnik) ----------
async function loadTools() {
  try {
    const r = await fetch('/api/tools');
    state.tools = await r.json();
  } catch {
    state.tools = [];
  }
  renderToolsRow();
}

function renderToolsRow() {
  if (!state.tools.length) {
    toolsSection.style.display = 'none';
    return;
  }
  toolsSection.style.display = '';
  toolsRow.innerHTML = '';
  state.tools.forEach(tool => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'tool-card';

    const hasImages = tool.beforeImage && tool.afterImage;
    card.innerHTML = `
      <div class="tool-media">
        ${hasImages ? `
          <div class="ba-slider">
            <img class="ba-img ba-before" src="${escapeHtml(tool.beforeImage)}" alt="" draggable="false">
            <img class="ba-img ba-after" src="${escapeHtml(tool.afterImage)}" alt="" draggable="false" style="clip-path: inset(0 0 0 50%);">
            <div class="ba-handle" style="left:50%;"></div>
          </div>
        ` : `
          <div class="tool-media-placeholder"><span class="tool-card-icon">${tool.icon || '✨'}</span></div>
        `}
        <div class="tool-media-gradient"></div>
      </div>
      <div class="tool-info">
        <div class="tool-card-title">${escapeHtml(tool.title)}</div>
        ${tool.subtitle ? `<div class="tool-card-subtitle">${escapeHtml(tool.subtitle)}</div>` : ''}
      </div>
    `;

    if (hasImages) initBeforeAfterSlider(card.querySelector('.ba-slider'));

    card.addEventListener('click', async () => {
      await switchMode('image');
      activeQuickChipKeyword = null;
      providerRow.querySelectorAll('.provider-chip').forEach(c => c.classList.remove('active'));
      providerClearBtn.style.display = 'none';
      renderModelOptions(getModelsForMode());
      composerInput.value = tool.prompt;
      composerInput.dispatchEvent(new Event('input'));
      composerInput.focus();
      attachBtn.click(); // сразу открываем выбор файла — эти пресеты работают со своим фото
    });
    toolsRow.appendChild(card);
  });
}

// Интерактивный слайдер "до/после": тянем бегунок мышью или пальцем,
// clip-path у верхней (after) картинки двигается вслед за курсором.
function initBeforeAfterSlider(slider) {
  const afterImg = slider.querySelector('.ba-after');
  const handle = slider.querySelector('.ba-handle');
  let dragging = false;
  let moved = false;
  let startX = 0;

  function setPct(clientX) {
    const rect = slider.getBoundingClientRect();
    let pct = ((clientX - rect.left) / rect.width) * 100;
    pct = Math.max(0, Math.min(100, pct));
    afterImg.style.clipPath = `inset(0 0 0 ${pct}%)`;
    handle.style.left = `${pct}%`;
  }

  slider.addEventListener('pointerdown', (e) => {
    dragging = true;
    moved = false;
    startX = e.clientX;
    slider.setPointerCapture(e.pointerId);
    setPct(e.clientX);
    e.preventDefault();
  });
  slider.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    if (Math.abs(e.clientX - startX) > 3) moved = true;
    setPct(e.clientX);
  });
  const stop = () => { dragging = false; };
  slider.addEventListener('pointerup', stop);
  slider.addEventListener('pointercancel', stop);

  // Перетаскивание бегунка не должно запускать переход к генерации —
  // только настоящий клик (без движения) открывает выбор фото.
  slider.addEventListener('click', (e) => {
    if (moved) { e.stopPropagation(); e.preventDefault(); }
  }, true);
}

// ---------- Каталог "Все нейросети" (полноэкранная модалка) ----------
const BRAND_ICONS = [
  { keyword: 'claude', icon: '/icons/anthropic.png' },
  { keyword: 'anthropic', icon: '/icons/anthropic.png' },
  { keyword: 'gpt-image', icon: '/icons/openai.png' },
  { keyword: 'sora', icon: '/icons/openai.png' },
  { keyword: 'gpt', icon: '/icons/openai.png' },
  { keyword: 'openai', icon: '/icons/openai.png' },
  { keyword: 'banana', icon: '/icons/nanobanana.png' },
  { keyword: 'gemini', icon: '/icons/gemini.png' },
  { keyword: 'google', icon: '/icons/gemini.png' },
  { keyword: 'deepseek', icon: '/icons/deepseek.png' },
  { keyword: 'llama', icon: '/icons/meta.png' },
  { keyword: 'meta-llama', icon: '/icons/meta.png' },
  { keyword: 'kling', icon: '/icons/kling.png' },
  { keyword: 'seedance', icon: '/icons/seedance.png' },
  { keyword: 'bytedance', icon: '/icons/seedance.png' },
  { keyword: 'suno', icon: '/icons/suno.png' }
];

function getIconForModel(m) {
  const hay = `${m.id} ${m.name || ''}`.toLowerCase();
  const found = BRAND_ICONS.find(b => hay.includes(b.keyword));
  return found ? found.icon : null;
}

const MODEL_BLURBS = [
  { keyword: 'claude', text: 'Для сложных, длительных задач: код, анализ, рассуждения.' },
  { keyword: 'gpt-image', text: 'Подходит для фотореализма, постеров и визуалов с текстом.' },
  { keyword: 'sora', text: 'Кинематографичное видео с сюжетной связностью.' },
  { keyword: 'gpt', text: 'Хорошо работает с кодом, анализом документов и логикой.' },
  { keyword: 'banana', text: 'Для сложных сцен, высокой детализации и фотореализма.' },
  { keyword: 'gemini', text: 'Сильна в анализе, таблицах и работе с большим контекстом.' },
  { keyword: 'deepseek', text: 'Хорошо решает математику и задачи по шагам.' },
  { keyword: 'llama', text: 'Открытая модель, универсальная для повседневных задач.' },
  { keyword: 'kling', text: 'Видео с плавным движением и переносом стиля.' },
  { keyword: 'seedance', text: 'Быстрая генерация видео с хорошей физикой движения.' },
  { keyword: 'veo', text: 'Реалистичное видео от Google с качественной анимацией.' }
];
function getDescriptionForModel(m) {
  const hay = `${m.id} ${m.name || ''}`.toLowerCase();
  const found = MODEL_BLURBS.find(b => hay.includes(b.keyword));
  if (found) return found.text;
  if (state.mode === 'image' || catalogMode === 'image') return 'Модель для генерации изображений.';
  if (state.mode === 'video' || catalogMode === 'video') return 'Модель для генерации видео.';
  return 'Универсальная модель для текстовых задач.';
}

function catalogPriceLabel(m) {
  if (catalogMode === 'video') return 'по запросу';
  const priceIn = m.pricing?.prompt ? parseFloat(m.pricing.prompt) : null;
  const priceOut = m.pricing?.completion ? parseFloat(m.pricing.completion) : null;
  if (priceIn === null || priceOut === null || priceIn < 0 || priceOut < 0) return 'по запросу';
  return `$${(priceIn * 1_000_000).toFixed(2)}/$${(priceOut * 1_000_000).toFixed(2)}`;
}

function getCatalogPool(mode) {
  if (mode === 'video') return state.videoModels;
  if (mode === 'image') return state.models.filter(m => (m.architecture?.output_modalities || []).includes('image'));
  return state.models.filter(m => (m.architecture?.output_modalities || ['text']).includes('text')).filter(isChatCompatible);
}

async function renderCatalogGrid() {
  if (catalogMode === 'video' && !state.videoModels.length) {
    catalogGrid.innerHTML = '<div class="model-loading">Загружаю видео-модели…</div>';
    await loadVideoModels();
  }
  const pool = getCatalogPool(catalogMode);
  if (!pool.length) {
    catalogGrid.innerHTML = '<div class="model-empty">Список пуст</div>';
    return;
  }
  catalogGrid.innerHTML = '';
  pool.forEach(m => {
    const card = document.createElement('div');
    card.className = 'catalog-card';
    const icon = getIconForModel(m);
    card.innerHTML = `
      <div class="catalog-card-price">${escapeHtml(catalogPriceLabel(m))}</div>
      <div class="catalog-card-icon">${icon ? `<img src="${icon}" alt="">` : '<span class="fallback-mark">✦</span>'}</div>
      <div class="catalog-card-name">${escapeHtml(m.name || m.id)}</div>
      <div class="catalog-card-desc">${escapeHtml(getDescriptionForModel(m))}</div>
    `;
    card.addEventListener('click', async () => {
      await switchMode(catalogMode);
      renderModelOptions(getModelsForMode());
      selectModel(m.id, true);
      activeQuickChipKeyword = null;
      providerRow.querySelectorAll('.provider-chip').forEach(c => c.classList.remove('active'));
      providerClearBtn.style.display = 'none';
      updateComposerHint();
      closeCatalogModal();
    });
    catalogGrid.appendChild(card);
  });
}

function openCatalogModal() {
  catalogOverlay.classList.add('open');
  catalogMode = state.mode === 'video' ? 'video' : state.mode === 'image' ? 'image' : 'text';
  catalogTabs.querySelectorAll('.catalog-tab').forEach(t => t.classList.toggle('active', t.dataset.catMode === catalogMode));
  renderCatalogGrid();
}
function closeCatalogModal() { catalogOverlay.classList.remove('open'); }

catalogOpenBtn.addEventListener('click', openCatalogModal);
closeCatalog.addEventListener('click', closeCatalogModal);
catalogOverlay.addEventListener('click', (e) => { if (e.target === catalogOverlay) closeCatalogModal(); });
catalogTabs.querySelectorAll('.catalog-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    catalogTabs.querySelectorAll('.catalog-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    catalogMode = tab.dataset.catMode;
    renderCatalogGrid();
  });
});

// ---------- Popular-model quick-select chips (as on Umnik: click = switch mode + pick that model) ----------
const EXAMPLE_PROMPTS = {
  claude: 'Например: «Объясни теорию относительности простыми словами»',
  gpt: 'Например: «Напиши план урока по фотографии для начинающих»',
  gemini: 'Например: «Сравни Python и JavaScript в таблице»',
  banana: 'Опишите изображение: «Космический пейзаж с двумя лунами, кинематографичный стиль…»',
  'gpt-image': 'Опишите изображение: «Ретро постер фильма в стиле 80-х»',
  kling: 'Опишите видео: «Дрон пролетает над горным озером на рассвете»'
};

function defaultHintForMode(mode) {
  if (mode === 'image') return 'Опишите изображение, которое хотите сгенерировать…';
  if (mode === 'video') return 'Опишите видео, которое хотите сгенерировать…';
  return 'Напишите сообщение…';
}

let activeQuickChipKeyword = null;

function updateComposerHint() {
  composerInput.placeholder = (activeQuickChipKeyword && EXAMPLE_PROMPTS[activeQuickChipKeyword]) || defaultHintForMode(state.mode);
}

async function switchMode(newMode) {
  state.mode = newMode;
  modeToggle.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === newMode));
  if (newMode === 'video' && !state.videoModels.length) {
    modelOptions.innerHTML = '<div class="model-loading">Загружаю видео-модели…</div>';
    await loadVideoModels();
  }
}

providerRow.querySelectorAll('.provider-chip[data-keyword]').forEach(chip => {
  chip.addEventListener('click', async () => {
    const keyword = chip.dataset.keyword;
    const mode = chip.dataset.mode;

    providerRow.querySelectorAll('.provider-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    providerClearBtn.style.display = 'inline-flex';
    activeQuickChipKeyword = keyword;

    await switchMode(mode);
    const pool = getModelsForMode();
    const match = pool.find(m => m.id.toLowerCase().includes(keyword) || (m.name || '').toLowerCase().includes(keyword)) || pool[0];
    renderModelOptions(pool);
    if (match) selectModel(match.id, true);
    updateComposerHint();
  });
});
providerClearBtn.addEventListener('click', () => {
  activeQuickChipKeyword = null;
  providerRow.querySelectorAll('.provider-chip').forEach(c => c.classList.remove('active'));
  providerClearBtn.style.display = 'none';
  renderModelOptions(getModelsForMode());
  updateComposerHint();
});

// ---------- Paywall / subscription (demo mock) ----------
function updateProBadge() {
  if (state.isPro) {
    proBadge.textContent = 'Pro ✓';
    proBadge.classList.add('is-pro');
  } else {
    proBadge.textContent = 'Pro';
    proBadge.classList.remove('is-pro');
  }
}

function openPaywall() {
  if (!state.user) { openAuth('login'); return; }
  paywallOverlay.classList.add('open');
}
function closePaywallModal() {
  paywallOverlay.classList.remove('open');
}

proBadge.addEventListener('click', () => {
  if (state.isPro) return; // уже подписан — нечего показывать
  openPaywall();
});
closePaywall.addEventListener('click', closePaywallModal);
paywallOverlay.addEventListener('click', (e) => { if (e.target === paywallOverlay) closePaywallModal(); });

planOptions.querySelectorAll('.plan-option').forEach(opt => {
  opt.addEventListener('click', () => {
    planOptions.querySelectorAll('.plan-option').forEach(o => o.classList.remove('selected'));
    opt.classList.add('selected');
    opt.querySelector('input').checked = true;
    state.selectedPlan = opt.dataset.plan;
  });
});

paywallCta.addEventListener('click', async () => {
  if (!state.user) { closePaywallModal(); openAuth('login'); return; }
  // Демо-режим: реальный платёжный шлюз (ЮKassa/Stripe/Платега) сюда пока не подключен.
  // Статус Pro уже помечается на СЕРВЕРЕ и привязан к аккаунту — работает на любом устройстве.
  paywallCta.disabled = true;
  paywallCta.textContent = 'Обрабатываем платёж…';
  try {
    const res = await fetch('/api/auth/set-pro', { method: 'POST', credentials: 'same-origin' });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Не удалось активировать подписку');
    state.user = json.user;
    state.isPro = true;
  } catch (err) {
    alert('Ошибка: ' + err.message);
  } finally {
    paywallCta.disabled = false;
    paywallCta.textContent = 'Продолжить';
    updateProBadge();
    closePaywallModal();
    renderActiveChat(); // разблокирует ранее скрытые ответы
  }
});

// ---------- Locked (paywalled) messages ----------
async function sendLockedMessage(chat) {
  state.streaming = true;
  sendBtn.disabled = true;

  const assistantMsg = { role: 'assistant', content: '', locked: true };
  const { bubble } = appendMessageEl(assistantMsg);
  const dots = document.createElement('span');
  dots.className = 'typing-dots';
  dots.innerHTML = '<span></span><span></span><span></span>';
  bubble.appendChild(dots);
  scrollToBottom();

  const payloadMessages = chat.messages
    .filter(m => !(m.role === 'assistant' && m.locked && !state.isPro))
    .map(m => ({ role: m.role, content: toApiContent(m) }));

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-openrouter-key': state.apiKey },
      body: JSON.stringify({
        model: state.selectedModel,
        messages: payloadMessages,
        stream: false,
        temperature: state.temperature
      })
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message || json.error || `HTTP ${res.status}`);

    const text = json.choices?.[0]?.message?.content || '(пустой ответ)';
    assistantMsg.content = text;
    if (json.usage) {
      const cost = estimateCost(state.selectedModel, json.usage);
      assistantMsg.meta = `${json.usage.prompt_tokens ?? '?'} → ${json.usage.completion_tokens ?? '?'} токенов` +
        (cost !== null ? ` · $${cost.toFixed(5)}` : '');
      if (cost !== null) {
        state.sessionCost += cost;
        usageText.textContent = `$${state.sessionCost.toFixed(4)}`;
        saveSessionCost();
      }
    }
    chat.messages.push(assistantMsg);
    saveChats();
    renderChatList();
    renderActiveChat(); // перерисовать с заблокированным (размытым) видом
    if (!state.isPro) openPaywall();
  } catch (err) {
    dots.remove();
    bubble.classList.add('locked');
    bubble.textContent = 'Ошибка: ' + err.message;
  } finally {
    state.streaming = false;
    updateKeyStatus();
  }
}

// ---------- Mobile sidebar ----------
sidebarToggle?.addEventListener('click', () => sidebar.classList.toggle('open'));
function closeSidebarOnMobile() {
  if (window.innerWidth <= 820) sidebar.classList.remove('open');
}

// ---------- Utils ----------
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

init();

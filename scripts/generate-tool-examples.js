// scripts/generate-tool-examples.js
//
// Генерирует реальные примеры "до/после" для карточек в config/tools.json,
// прогоняя ОДНО исходное фото через промпт каждого пресета via OpenRouter
// Images API. Результаты сохраняются в public/tools/, config/tools.json
// обновляется автоматически (beforeImage/afterImage).
//
// Запускать на сервере (там есть выход в интернет к OpenRouter), не в
// песочнице Claude Code — она не пропускает внешний трафик.
//
// Использование:
//   OPENROUTER_API_KEY=sk-or-v1-... node scripts/generate-tool-examples.js путь/к/фото.jpg [model]
//
// По умолчанию модель: google/gemini-2.5-flash-image (Nano Banana) —
// хорошо работает с image-to-image правками.

const fs = require('fs');
const path = require('path');

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const TOOLS_FILE = path.join(__dirname, '..', 'config', 'tools.json');
const OUT_DIR = path.join(__dirname, '..', 'public', 'tools');

const MIME_BY_EXT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const EXT_BY_MIME = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error('Нужен ключ: OPENROUTER_API_KEY=sk-or-v1-... node scripts/generate-tool-examples.js фото.jpg');
    process.exit(1);
  }
  const beforePath = process.argv[2];
  if (!beforePath || !fs.existsSync(beforePath)) {
    console.error('Укажите путь к исходному фото первым аргументом.');
    process.exit(1);
  }
  const model = process.argv[3] || 'google/gemini-2.5-flash-image';

  const beforeExt = path.extname(beforePath).toLowerCase();
  const beforeMime = MIME_BY_EXT[beforeExt];
  if (!beforeMime) {
    console.error(`Неподдерживаемый формат ${beforeExt}. Используйте jpg/png/webp.`);
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const beforeBuf = fs.readFileSync(beforePath);
  const beforeDataUrl = `data:${beforeMime};base64,${beforeBuf.toString('base64')}`;

  // Общий исходник для всех карточек — один раз копируем в public/tools/
  const sourceFilename = `_source${beforeExt}`;
  fs.copyFileSync(beforePath, path.join(OUT_DIR, sourceFilename));

  const tools = JSON.parse(fs.readFileSync(TOOLS_FILE, 'utf8'));

  for (const tool of tools) {
    process.stdout.write(`→ ${tool.id}… `);
    try {
      const r = await fetch(`${OPENROUTER_BASE}/images`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'X-Title': 'OpenRouter Test Chat — tool examples'
        },
        body: JSON.stringify({
          model,
          prompt: tool.prompt,
          input_references: [beforeDataUrl]
        })
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error?.message || JSON.stringify(json));

      const item = json.data?.[0];
      if (!item?.b64_json) throw new Error('модель не вернула изображение');

      const mime = item.media_type || 'image/png';
      const ext = EXT_BY_MIME[mime] || '.png';
      const afterFilename = `${tool.id}_after${ext}`;
      fs.writeFileSync(path.join(OUT_DIR, afterFilename), Buffer.from(item.b64_json, 'base64'));

      tool.beforeImage = `/tools/${sourceFilename}`;
      tool.afterImage = `/tools/${afterFilename}`;
      console.log('OK');
    } catch (err) {
      console.log('ОШИБКА: ' + err.message);
      // beforeImage/afterImage для этого пресета оставляем как есть (null) —
      // карточка просто продолжит показывать иконку-заглушку.
    }
  }

  fs.writeFileSync(TOOLS_FILE, JSON.stringify(tools, null, 2) + '\n');
  console.log('\nГотово. Проверьте public/tools/ и config/tools.json, затем закоммитьте и запушьте изменения.');
}

main();

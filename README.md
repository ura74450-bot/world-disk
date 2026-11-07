# Всемирный диск — инструкция

## 1. Репозиторий для файлов
1. github.com → New repository → имя `disk-files` → Private или Public → поставьте «Add a README» → Create.

## 2. Токен
1. GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.
2. Repository access → Only select repositories → `disk-files`.
3. Permissions → Repository permissions → **Contents: Read and write**.
4. Generate и скопируйте токен (показывается один раз).

## 3. Репозиторий с кодом
1. Создайте второй репозиторий `world-disk` (Private подойдёт).
2. Распакуйте архив. Загрузите содержимое папки (server.js, package.json, public/, render.yaml...) в корень репозитория: Add file → Upload files.

## 4. Render
1. render.com → New → Web Service → подключите GitHub → выберите `world-disk`.
2. Runtime: Node. Build Command: `npm install`. Start Command: `node server.js`.
3. Environment Variables:
   - `GITHUB_TOKEN` — токен из шага 2
   - `GITHUB_OWNER` — ваш логин GitHub
   - `GITHUB_REPO` — `disk-files`
   - `GITHUB_BRANCH` — `main` (необязательно)
4. Create Web Service. Через 2–3 минуты сайт доступен по ссылке вида `https://название.onrender.com`.

## Как это работает
- Файлы режутся в браузере на куски по 20 МБ и по очереди уходят на сервер, оттуда в GitHub (папка `files/`). Лимита на размер нет, склейка происходит при открытии/скачивании.
- На бесплатном Render сервер засыпает после 15 минут простоя (первый заход ~30 сек), чат при этом очищается.
- Практические пределы: GitHub рекомендует держать репозиторий до нескольких ГБ, а в папке показывается максимум 1000 файлов (куски считаются отдельно).
- Большие видео открываются в плеере без перемотки; .exe и .torrent скачиваются и запускаются на ПК.

## Мои файлы
Раздел «🔒 Мои файлы» — личные папки и файлы. Доступ по личному ключу (создаётся в браузере, кнопка 🔑). Файлы лежат в папке `private/` репозитория файлов, поэтому **репозиторий `disk-files` должен быть Private**, иначе их увидят все, кто откроет репозиторий на GitHub.

## Удаление
- В «Мои файлы» и папки, и файлы удаляются кнопкой 🗑 (по личному ключу).
- Файлы общего диска может удалять только админ: добавьте на Render переменную `ADMIN_KEY` (ваш пароль), затем в окне «Поиск файлов» нажмите 🛡 и введите его — рядом с файлами появится 🗑. Без `ADMIN_KEY` удаление общих файлов выключено.

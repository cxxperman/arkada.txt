# Сторонний код в Arkada

Плагин Arkada включает переработанный код плагинов DWMX и Kapsula — см. разделы «DWMX (Window Styler) — в плагине» и «Плагин Kapsula — в плагине» в конце.

Тема Arkada (`dist/arkada`, её собирает `tools/build-se.js`) построена на теме **Steam Enhanced**. Её код лежит нетронутым в `upstream/steam-enhanced` и попадает в собранную тему как есть; изменения Arkada — отдельным слоем из `overlay/`.

Пути ниже даны дважды: в этом репозитории и в собранной теме (`dist/arkada`).

## Steam Enhanced

- Автор: NVHT, <https://github.com/NVHT/Steam-Enhanced>
- Версия: записана в `upstream/steam-enhanced.json` (тег и коммит)
- Лицензия: MIT
- Текст лицензии: `upstream/steam-enhanced/LICENSE`; в собранной теме — `LICENSE-steam-enhanced`

```
MIT License

Copyright (c) 2026 NVHT

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Что Steam Enhanced включает от других

Каждый компонент — под своей лицензией; файл лицензии лежит рядом с файлами, к которым относится, и вместе с ними попадает в собранную тему.

| Компонент | Зачем | Лицензия | Файл лицензии |
|---|---|---|---|
| [SN Pro](https://github.com/supernotes/sn-pro), © 2024 The SN Pro Project Authors | шрифт (в Arkada — по выбору, настройка Font) | SIL Open Font License 1.1 | `upstream/steam-enhanced/core/fonts/SNPro-OFL.txt` → `core/fonts/SNPro-OFL.txt` |
| [Xmind](https://github.com/lamzhonghang/xmind), © 2025 The Xmind Project Authors | шрифт по выбору | SIL Open Font License 1.1 | `upstream/steam-enhanced/core/fonts/Xmind-OFL.txt` → `core/fonts/Xmind-OFL.txt` |
| [hls.js](https://github.com/video-dev/hls.js), © 2017 Dailymotion | трейлеры в магазине и фон-трейлер на главной | Apache License 2.0 | `upstream/steam-enhanced/web/store/vendor/hls.js-LICENSE` → `web/store/vendor/hls.js-LICENSE` |

## DWMX (Window Styler) — в плагине

Бэкенд плагина Arkada (`plugin/backend/main.lua`; в собранном плагине — `backend/main.lua`) частично основан на бэкенде плагина Millennium **DWMX (Window Styler)**, а подмена `window.open` во фронтенде (`plugin/src/steam.js`, `plugin/src/backdrop.js`) повторяет его фронтенд.

- Автор: shdwmtr, <https://github.com/shdwmtr/dwmx> (репозиторий теперь открывается как <https://github.com/ejalxndr/dwmx>)
- Взято из: `backend/main.lua` и `frontend/index.tsx`, коммит `8c996ca3e66a9e5e5e24ad9a42f0a71c97d71872`
- Лицензия: Apache License 2.0. Строки copyright в их файле `LICENSE` нет; авторство — по репозиторию
- Текст лицензии: `plugin/backend/LICENSE-dwmx`; в собранном плагине — `backend/LICENSE-dwmx`. В файле `.star` текста лицензии нет (там только код), уведомление об источнике там — строка `NOTICE` в коде бэкенда
- **Изменено** (как требует раздел 4 лицензии; в заголовке `main.lua` то же): взяты поиск процессов `steamwebhelper.exe` через снимок Toolhelp, перебор их окон через `EnumWindows`, размытие accent через `SetWindowCompositionAttribute`, предпочтение скругления углов и замена `createflags` 4114/2 → 274 в `window.open`. Исправлены типы структур для 64 бит, у типов приставка `arkada_`, имена функций Windows привязаны через `__asm__`. Добавлены: подложка Windows 11 (`DWMWA_SYSTEMBACKDROP_TYPE`, тёмный режим, `DwmExtendFrameIntoClientArea`), проверка версии Windows, деление окон на главные, малые и пропускаемые, возврат окон к исходному виду, ответ фронтенду. Подмена `window.open` работает только при включённой подложке и отменяется при выгрузке плагина.

## Плагин Kapsula — в плагине

Модуль «Уведомления в Kapsula» (`plugin/src/kapsula.js`; в собранном плагине — внутри `.millennium/Dist/index.js`) — перенос плагина Kapsula для Millennium, чтобы приложение Kapsula получало от Arkada ровно то же, что от своего плагина.

- Автор: Kapsula contributors (kapsula.txt, часть dev.txt)
- Взято из: `integrations/millennium/kapsula/.millennium/Dist/index.js`, версия плагина 0.7.0
- Лицензия: MIT
- **Изменено:** к Steam модуль обращается через `plugin/src/steam.js` (один перехват уведомлений и одна подписка на загрузки на весь плагин), включается настройкой темы, молчит, пока в Steam работает сам плагин Kapsula. Протокол (адрес `ws://127.0.0.1:42071/?client=millennium`, сообщения и команды) не менялся.

```
MIT License

Copyright (c) 2026 Kapsula contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Size on Disk и Steam Share — только поведение, без кода

Модули «Размер на диске» (`plugin/src/disksize.js`) и «Поделиться» (`plugin/src/share.js`) повторяют то, что делают плагины Millennium **Size on Disk** (1.2.1) и **Steam Share** (1.1.0), но написаны для Arkada заново. В установленных копиях этих плагинов нет файла лицензии, поэтому их код не взят ни строчкой: из них известно только, где и что они показывают и какими вызовами клиента Steam пользуются (`SteamClient.InstallFolder.GetInstallFolders`, `MILLENNIUM_API.findClassModule`, `MILLENNIUM_API.callable` со словом `frontend:`). Вызовы клиента — это интерфейс Steam и Millennium, а не их код.

Steam и логотип Steam — товарные знаки Valve Corporation. Ни Arkada, ни Steam Enhanced не связаны с Valve и не одобрены ею.

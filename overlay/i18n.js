/*
 * Arkada over Steam Enhanced: the words their scripts write into the DOM, in Russian when Steam is.
 * (Their words drawn by CSS, content: '…', are in overlay/i18n.css.)
 *
 * Loaded into every window by its own Patch (overlay/skin.json, TargetJs). Their files stay
 * untouched: one MutationObserver translates what their code has just written.
 *
 * What is touched. Only text that is theirs, and only when the whole of it is known:
 *   - a text node whose element is theirs: an element with a class `se-…`, or one without any
 *     class inside such an element (their templates' <b>, <em>, <span>). Steam's own nodes carry
 *     Steam's hashed classes and are never touched, even inside their containers (the friends
 *     dock holds Steam's whole friends UI); elements with names, descriptions or messages
 *     (`se-…name`, `-desc`, `-msg`, …) are skipped too;
 *   - placeholder, title, aria-label and their tooltip attribute on those elements, and the
 *     data-se-… attributes their CSS draws with content: attr(…);
 *   - the text must equal a key of EXACT, or match one of PATTERNS whole (strings with numbers;
 *     names inside them, a game's or a friend's, are carried over as they are). Anything else
 *     (a game, a nickname, a chat message, Steam's descriptions) stays.
 *
 * Their code often checks `if (el.textContent !== 'Queued') el.textContent = 'Queued'` on its next
 * pass, which would undo a translation and redo it forever. A node they keep putting back is left
 * in English after a few rounds (CONTESTED_AFTER) instead of flickering.
 *
 * Only for a Russian client: <html lang> (or the opener's, for popups), else LANGUAGE= in the
 * window's address, else navigator.language. Otherwise nothing runs.
 *
 * tools/check.js loads this file in Node (module.exports below) to see that every key and every
 * pattern's probe still occurs in their code.
 */
(() => {
  /* ---------- Russian plurals and numbers ---------- */

  // 1 игра, 2 игры, 5 игр; a fraction takes the "few" form (2,5 часа)
  const plural = (n, one, few, many) => {
    if (!Number.isInteger(n)) return few;
    const a = Math.abs(n) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b === 1) return one;
    if (b >= 2 && b <= 4) return few;
    return many;
  };
  // A number as their code wrote it: "3.4" (String()), "4,409" (toLocaleString('en')), "1 234" (ru)
  const value = (s) => {
    let t = String(s).replace(/[\s  ]/g, '');
    if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, '');
    return Number(t.replace(',', '.'));
  };
  // The same number in Russian: decimal comma, thin space between thousands
  const ru = (s) => {
    const t = String(s).trim();
    if (/^\d+\.\d+$/.test(t)) return t.replace('.', ',');
    if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return t.replace(/,/g, ' ').replace('.', ',');
    return t;
  };
  const lower = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);
  const N = '([\\d][\\d.,\\u00a0\\u202f ]*)'; // a number in a pattern

  const games = (n) => plural(value(n), 'игра', 'игры', 'игр');
  const days = (n) => plural(value(n), 'день', 'дня', 'дней');
  const TIER = { Legendary: 'Легендарное', Epic: 'Эпическое', Rare: 'Редкое', Uncommon: 'Необычное', Common: 'Обычное' };
  const TIERS = { Legendary: 'Легендарные', Epic: 'Эпические', Rare: 'Редкие', Uncommon: 'Необычные', Common: 'Обычные' };
  const TIER_RE = '(Legendary|Epic|Rare|Uncommon|Common)';

  /* ---------- Whole strings ---------- */

  // Their copy, by the file that writes it (client/… unless named). Product names (Steam,
  // Millennium, Steam Deck, Metacritic, Brew Hub) and diagnostics meant for logs stay English.
  const EXACT = {
    // browser/url-bar.js
    'Back': 'Назад', 'Forward': 'Вперёд', 'Copy link': 'Копировать ссылку', 'Reload': 'Обновить', 'Open in browser': 'Открыть в браузере',

    // dialogs/about-steam.js
    'About Steam': 'О Steam', 'Updates': 'Обновления', 'Steam Client Update': 'Обновление клиента Steam', 'Steam version': 'Версия Steam',
    'Client build': 'Сборка клиента', 'Web build': 'Веб-сборка', 'Branch': 'Ветка', 'just now': 'только что', 'Yesterday': 'Вчера',
    'yesterday': 'вчера', 'Today': 'Сегодня', 'Copied': 'Скопировано', 'Click to copy': 'Нажмите, чтобы скопировать',
    'Check for updates': 'Проверить обновления', 'Restart': 'Перезапустить', 'Restarting…': 'Перезапуск…', 'Click again': 'Нажмите ещё раз',
    'Restart Steam to install the update': 'Перезапустите Steam, чтобы установить обновление', 'Checking for updates': 'Проверка обновлений',
    'Update ready': 'Обновление готово', 'Downloading update': 'Загрузка обновления', 'Update available': 'Доступно обновление',
    'Up to date': 'Обновлений нет', 'Steam updates': 'Обновления Steam', 'not checked yet': 'ещё не проверялось', 'None': 'Нет',
    'Opening…': 'Открытие…', 'Change ›': 'Изменить ›', 'Change in Settings › Interface': 'Изменить в «Настройки › Интерфейс»',
    'Interface': 'Интерфейс', 'Report an issue': 'Сообщить о проблеме', 'Patch notes': 'Список изменений',
    'Report an issue on GitHub': 'Сообщить о проблеме на GitHub', 'Latest Steam patch notes': 'Последние изменения в Steam',
    'Open in Steam': 'Открыть в Steam', 'Loading the latest patch notes…': 'Загрузка последнего списка изменений…',
    "Couldn't load the patch notes. Open in Steam to read them there.": 'Не удалось загрузить список изменений. Откройте его в Steam.',
    'This post has no text here. Open in Steam to read it.': 'Здесь у этой записи нет текста. Откройте её в Steam.',
    'Copy all': 'Копировать всё', 'Copy all (Ctrl+C)': 'Копировать всё (Ctrl+C)',

    // dialogs/activate-product.js
    'Standard key': 'Обычный ключ', 'Extended key': 'Расширенный ключ', 'Retail CD/DVD': 'Коробочная версия (CD/DVD)',
    'Activate a Product': 'Активировать продукт', 'Clear': 'Очистить', 'to activate': 'активировать', 'Product code': 'Код продукта',
    'Type or paste the code exactly as it’s printed': 'Введите или вставьте код точно так, как он напечатан', 'Keep going': 'Продолжайте',
    'Unusual format. Steam will still check it': 'Необычный формат. Steam всё равно его проверит',

    // dialogs/add-non-steam.js
    'Add a Non-Steam Game': 'Добавить стороннюю игру', 'In Library': 'В библиотеке', 'Program': 'Программа', 'Location': 'Расположение',
    'Selected': 'Выбранные', 'Every program found': 'Все найденные программы', 'Only the programs you picked': 'Только выбранные программы',
    'Clear the selection': 'Снять выбор', 'Nothing selected yet': 'Пока ничего не выбрано',
    'Pick programs from All, or Browse for one that isn’t listed.': 'Выберите программы во вкладке «Все» или найдите программу через «Обзор».',
    'Try another name or folder, or Browse for the program.': 'Попробуйте другое название или папку либо найдите программу через «Обзор».',
    'No programs found': 'Программы не найдены', 'Browse for the program you want to add.': 'Найдите программу, которую хотите добавить, через «Обзор».',
    'Already in your Library. Adding it again makes a second shortcut.': 'Уже есть в библиотеке. Повторное добавление создаст второй ярлык.',
    'A to Z': 'А–Я', 'Z to A': 'Я–А',

    // dialogs/backups.js
    'Backups': 'Резервные копии', 'No folder selected': 'Папка не выбрана', 'Games': 'Игры',
    'Steam creates the backup files in this folder': 'Steam создаст файлы резервной копии в этой папке', 'Preparing…': 'Подготовка…',
    'Pick the folder that holds the backup’s sku.sis file': 'Выберите папку с файлом sku.sis резервной копии',

    // dialogs/delete-collection.js, new-collection.js, mark-private.js
    'Delete collection': 'Удалить коллекцию', 'It has no games. Only the collection goes.': 'В ней нет игр. Удалится только коллекция.',
    'Delete': 'Удалить', 'Cancel': 'Отмена', 'Create': 'Создать', 'Collection': 'Коллекция', 'Games you add yourself': 'Игры, которые вы добавляете сами',
    'Dynamic': 'Динамическая', 'Filters you set next keep it up to date': 'Фильтры, которые вы зададите дальше, будут её обновлять',
    'New collection': 'Новая коллекция', 'Type': 'Тип', 'Ownership': 'Владение', 'In-game status': 'Статус в игре',
    'Playtime and activity': 'Время в игре и активность', 'In your library': 'В вашей библиотеке', 'Saves and achievements': 'Сохранения и достижения',
    'Undo from the game menu': 'Отменить можно в меню игры', 'Mark as private': 'Сделать скрытой', 'Hidden everywhere outside your library': 'Не видно нигде, кроме вашей библиотеки',
    'Hidden from others': 'Скрыто от других', 'Still yours': 'Остаётся у вас',

    // dialogs/eula.js, exit-game.js, install.js, uninstall.js
    'Read so far': 'Прочитано', 'Back to top': 'В начало', 'Jump to end': 'В конец', 'Exit game': 'Выйти из игры', 'Keep playing': 'Продолжить игру',
    'Install': 'Установить', 'Uninstall': 'Удалить',

    // dialogs/system-info.js, system-report/
    'Computer': 'Компьютер', 'Processor': 'Процессор', 'Graphics': 'Видеокарта', 'Audio': 'Звук', 'Network': 'Сеть', 'Software': 'Программы',
    'Failures': 'Сбои', 'Misc': 'Разное', 'System Information': 'Сведения о системе', 'Memory': 'Память', 'Display': 'Монитор',
    'Sections': 'Разделы', 'Filter': 'Фильтр', 'Filter hardware details': 'Фильтр сведений об оборудовании', 'Clear filter': 'Сбросить фильтр',
    'Detecting hardware…': 'Определение оборудования…', 'Copy specs': 'Копировать характеристики',
    'Copy specs (Ctrl+C). IP and hardware IDs are left out.': 'Копировать характеристики (Ctrl+C). IP-адрес и идентификаторы оборудования не копируются.',
    'Copy section': 'Копировать раздел', 'Resolution': 'Разрешение', 'System': 'Система', 'Operating system': 'Операционная система',
    'Displays': 'Мониторы', 'Storage': 'Хранилище', 'Input': 'Ввод', 'Failure reports': 'Отчёты о сбоях', 'Other': 'Другое',
    'System Report': 'Отчёт о системе', 'Filter the report': 'Фильтр отчёта', 'Expand all': 'Развернуть всё', 'Collapse all': 'Свернуть всё',
    'Expand or collapse all groups': 'Развернуть или свернуть все группы', 'Details': 'Подробности', 'Raw': 'Исходный текст', 'Empty': 'Пусто',
    'Yes': 'Да', 'No': 'Нет', 'Instruction sets': 'Наборы инструкций', 'not supported': 'не поддерживается',

    // downloads/page/
    'Drag to reorder': 'Перетащите, чтобы изменить порядок', 'Current download': 'Текущая загрузка', 'Speed': 'Скорость', 'Disk': 'Диск',
    'Pause': 'Пауза', 'Resume': 'Продолжить', 'Game list': 'Список игр', 'No matching games': 'Подходящих игр нет', 'No games to show': 'Нет игр',
    'Download': 'Загрузить', 'Downloads': 'Загрузки', 'Now downloading': 'Загружается', 'Paused': 'Приостановлено', 'Installing': 'Установка',
    'Show more games': 'Показать больше игр',

    // entrance/entrance.js, startup/startup.js
    'Library': 'Библиотека', 'Loading': 'Загрузка', 'Ready': 'Готово', 'Password': 'Пароль', 'Connecting': 'Подключение',
    'Signing in': 'Вход', 'Signed in': 'Вход выполнен', 'Waiting': 'Ожидание', 'Connected': 'Подключено', 'QR code': 'QR-код',

    // friends/
    'In game': 'В игре', 'Away': 'Нет на месте', 'Online': 'В сети', 'Offline': 'Не в сети', 'Start voice chat': 'Начать голосовой чат',
    'Invite to a group chat': 'Пригласить в групповой чат', 'More': 'Ещё', 'End voice chat': 'Завершить голосовой чат',
    'Unable to create the Steam chat popup. Return to Library to use the flyout.': 'Не удалось открыть окно чата Steam. Вернитесь в библиотеку и откройте чат в панели.',
    'Chat': 'Чат', 'Playing now': 'Сейчас играют', 'Busy': 'Не беспокоить', 'Snooze': 'Не активен', 'Invisible': 'Невидимка',
    'Group chats': 'Групповые чаты', 'Search friends': 'Поиск друзей', 'Add a friend': 'Добавить друга', 'Search': 'Поиск',
    'No one matches': 'Никого не найдено', 'Chats': 'Чаты', 'Favorites': 'Избранное', 'Playing': 'Играют', 'Groups': 'Группы',
    'Send message': 'Отправить сообщение', 'Open a chat with them': 'Открыть чат с этим другом', 'View profile': 'Открыть профиль',
    'Their page on Steam Community': 'Его страница в сообществе Steam', 'Its page in your library': 'Её страница в вашей библиотеке',
    'Open chat': 'Открыть чат', 'The group’s chat': 'Чат группы', 'Add to favorites': 'Добавить в избранное',
    'Pin it to the top of your list': 'Закрепить в начале списка', 'Remove from favorites': 'Убрать из избранного',
    'Unpin it from the top': 'Открепить из начала списка', 'Leave group chat': 'Покинуть групповой чат', 'You can rejoin by invite': 'Вернуться можно по приглашению',
    "Unable to open this group chat: Steam's chat isn't ready.": 'Не удалось открыть групповой чат: чат Steam ещё не готов.',
    'This group has no chat.': 'У этой группы нет чата.',
    "Only followers can join this game's group chat. Follow it, then open Group Chat again.": 'В групповой чат этой игры могут войти только подписчики. Подпишитесь на игру и снова откройте групповой чат.',
    'Show text and voice channels': 'Показать текстовые и голосовые каналы', 'Show group members': 'Показать участников группы',
    'Channels': 'Каналы', 'Channels ▾': 'Каналы ▾', 'Members': 'Участники', 'Voice channels': 'Голосовые каналы', 'Manage voice': 'Голосовой чат',
    'Join voice ▾': 'Войти в голосовой ▾', 'Friends': 'Друзья', 'Resize Friends': 'Изменить ширину панели друзей', 'Close chat': 'Закрыть чат',
    'Minimize chat': 'Свернуть чат', 'Dismiss chat error': 'Скрыть ошибку чата',
    'Unable to open chat here. Open its window from the Friends & Chat menu.': 'Здесь чат не открыть. Откройте его окно из меню «Друзья и чат».',
    'Message': 'Сообщение', 'Voice': 'Голос', 'Profile': 'Профиль', 'Favorite': 'В избранное', 'Remove': 'Удалить',
    'A name only you see': 'Имя, которое видите только вы', 'Sort them into your groups': 'Распределить по вашим группам',
    'Sounds and alerts for them': 'Звуки и оповещения для этого друга', 'Their items on Steam': 'Его предметы в Steam', 'Swap items with them': 'Обменяться предметами',
    'Tell Steam about this player': 'Пожаловаться на этого игрока', 'No messages, invites or requests': 'Никаких сообщений, приглашений и запросов',
    'Close this chat': 'Закрыть этот чат', 'Add them to your friends': 'Добавить в друзья', 'Dismiss their request': 'Отклонить запрос',
    'Send a friend request': 'Отправить запрос в друзья', 'Take back your request': 'Отозвать запрос', 'Unfavorite': 'Из избранного',
    'Play it now': 'Играть сейчас', 'Join their game': 'Присоединиться к игре', 'Find it in your library': 'Найти в вашей библиотеке',
    'Watch their stream': 'Смотреть трансляцию', 'Server and session details': 'Сведения о сервере и сессии', 'Price and reviews': 'Цена и обзоры',
    'Guides, art and discussions': 'Руководства, арты и обсуждения', 'A new group for your friends': 'Новая группа для друзей',
    'Its name and members': 'Название и участники', 'Your friends stay friends': 'Друзья останутся в друзьях', 'Its page on Steam Community': 'Её страница в сообществе Steam',
    'Games you all own': 'Игры, которые есть у всех', 'In its own window': 'В отдельном окне', 'Play': 'Играть', 'Join': 'Войти', 'View': 'Вид',
    'Watch': 'Смотреть', 'Info': 'Сведения', 'Store': 'Магазин', 'Hub': 'Центр', 'Open': 'Открыть', 'Leave': 'Выйти', '1 friend playing': 'Играет 1 друг',
    'Collapsed': 'Свёрнуто', '1 chat': '1 чат', '1 member': '1 участник',

    // game-page/
    'Hidden achievement': 'Скрытое достижение', 'Locked': 'Не получено', 'Unlocked': 'Получено', 'Completed': 'Завершено',
    'Mastered': 'Все достижения', 'Almost there': 'Почти готово', 'Just started': 'Только начало', 'In progress': 'В процессе',
    'Latest unlock': 'Последнее достижение', 'Previous': 'Назад', 'Next': 'Далее', 'Achievement Manager': 'Менеджер достижений',
    'Recently': 'Недавно', 'Previously': 'Раньше', 'Wishlist': 'Список желаемого', 'played before': 'играли раньше', 'wishlisted': 'хотят купить',
    'Your review helps other players decide.': 'Ваш обзор поможет другим игрокам решить.', 'Would you recommend this game?': 'Вы рекомендуете эту игру?',
    'show less': 'свернуть', 'Request failed': 'Ошибка запроса', 'Loading…': 'Загрузка…', 'Players': 'Сейчас играют', 'Screenshot': 'Скриншот',
    'Players currently in game on Steam. Updates once per minute; click to refresh.': 'Сейчас в игре в Steam. Обновляется раз в минуту; нажмите, чтобы обновить.',
    'Legendary': 'Легендарное', 'Epic': 'Эпическое', 'Rare': 'Редкое', 'Uncommon': 'Необычное', 'Common': 'Обычное',

    // header/
    'Announcements': 'Объявления', 'Mark all read': 'Отметить всё прочитанным', 'Loading news…': 'Загрузка новостей…',
    'No news lately': 'Новостей пока нет', 'Your games': 'Ваши игры', 'Open Steam News': 'Открыть новости Steam', 'Queued': 'В очереди',
    'Nothing queued': 'Очередь пуста', 'No downloads': 'Нет загрузок', 'Downloading': 'Загрузка', 'Up next': 'Далее', 'Open Downloads': 'Открыть загрузки',
    'After it': 'Следом', 'Resume downloads': 'Продолжить загрузки', 'Pause downloads': 'Приостановить загрузки', 'Add a Game': 'Добавить игру',
    'Friends & Chat': 'Друзья и чат', 'Download progress': 'Ход загрузки', 'Show friends': 'Показать друзей', 'Bring the dock back': 'Вернуть панель',
    'Expand friends': 'Развернуть друзей', 'Show the full list': 'Показать весь список', 'Collapse friends': 'Свернуть друзей',
    'Keep just a rail of games': 'Оставить только полосу игр', 'Hide friends': 'Скрыть друзей', 'Take the dock off the side': 'Убрать панель сбоку',
    'Compact list': 'Компактный список', 'Tighter rows in the list and chats': 'Плотнее строки в списке и чатах', 'Compact favorites': 'Компактное избранное',
    'Favorites as avatars only': 'Избранное только аватарами', 'Dock': 'Панель', 'Window': 'Окно', 'Open chat window': 'Открыть окно чата',
    'Friends & Chat on its own': '«Друзья и чат» отдельным окном', 'Browser': 'Браузер', 'Settings': 'Настройки', 'Account, downloads, display': 'Аккаунт, загрузки, экран',
    'Themes, plugins, updates': 'Темы, плагины, обновления', 'Library Manager': 'Менеджер библиотеки', 'Theme and plugin settings': 'Настройки темы и плагинов',
    'Steam actions': 'Действия Steam', 'Community': 'Сообщество', 'Big Picture Mode': 'Режим Big Picture', 'Notifications': 'Уведомления',
    'Do Not Disturb': 'Не беспокоить', 'Mute chat and notifications': 'Без звука чата и уведомлений', 'Edit Profile Name': 'Изменить имя профиля',
    'Your name and picture': 'Ваше имя и аватар', 'Status': 'Статус', 'Account': 'Аккаунт', 'Your page on Steam Community': 'Ваша страница в сообществе Steam',
    'What the Store shows you': 'Что показывает вам магазин', 'Your balance and its history': 'Ваш баланс и его история',
    'Sign in with another account': 'Войти в другой аккаунт', 'Steam asks for your sign-in next time': 'В следующий раз Steam попросит войти',
    'Version and credits': 'Версия и авторы', 'Check for Updates': 'Проверить обновления', 'Get the latest client': 'Получить последнюю версию клиента',
    'TV and controller mode': 'Режим для телевизора и контроллера', 'Restart Steam': 'Перезапустить Steam', 'Close and reopen Steam': 'Закрыть и снова открыть Steam',
    'Reload UI': 'Перезагрузить интерфейс', 'Refresh the interface': 'Обновить интерфейс', 'Quit Steam': 'Выйти из Steam', 'Get help with an issue': 'Помощь с проблемой',
    "Your PC's hardware": 'Оборудование вашего ПК', 'Logs for troubleshooting': 'Журналы для поиска неполадок', 'Runtime diagnostics': 'Диагностика среды',
    'Help': 'Справка', 'Client': 'Клиент', 'Legal': 'Правовая информация', 'Privacy, terms, agreement': 'Конфиденциальность, условия, соглашение',
    'Show': 'Показать',

    // home/
    'Favorites, or any collection, as capsules': 'Избранное или любая коллекция — обложками', 'Recent': 'Недавние', 'Most played': 'Больше всего часов',
    'Hide': 'Скрыть', 'Collections': 'Коллекции', 'Your collections as cards': 'Ваши коллекции карточками', 'Most games': 'Больше всего игр', 'Sort': 'Сортировка',
    'Hours': 'Часы', 'Previous page': 'Предыдущая страница', 'Next page': 'Следующая страница', 'Choose games': 'Выбрать игры', 'Choose collections': 'Выбрать коллекции',
    'Replaced': 'Заменено', 'All': 'Все', 'Width': 'Ширина', 'Panel pages': 'Страницы панели', 'This panel isn’t on the board': 'Этой панели нет на доске',
    'Remove from Home': 'Убрать с главной', 'Use Steam Enhanced Home': 'Главная Steam Enhanced', 'Achievements': 'Достижения', 'New games': 'Новые игры',
    'Wishlists': 'Списки желаемого', 'Recommendations': 'Рекомендации', 'Screenshots and videos': 'Скриншоты и видео', 'First plays': 'Первые запуски',
    'From every friend': 'От всех друзей', 'Show everything again': 'Снова показывать всё', 'Also': 'А также', 'View all': 'Все',
    'Friend activity': 'Активность друзей', 'What your friends did today': 'Чем сегодня занимались друзья', 'A friend': 'Друг', 'a game': 'игра', 'A game': 'Игра',
    'Friend activity isn’t available yet': 'Активность друзей пока недоступна', 'Loading friend activity…': 'Загрузка активности друзей…',
    'Nothing from your friends today': 'Сегодня от друзей ничего нет', 'Recently added': 'Недавно добавленные', 'Every game added has been played': 'Во все добавленные игры уже играли',
    'No games added yet': 'Пока не добавлено ни одной игры', 'Installed': 'Установленные', 'The newest games in your library': 'Самые новые игры в вашей библиотеке',
    'Not played': 'Не запускалась', 'Search your library': 'Поиск по библиотеке', 'Chosen': 'Выбранные', 'Search collections': 'Поиск коллекций',
    'Collections to show': 'Какие коллекции показывать', 'Logo': 'Логотип', 'Developer · year': 'Разработчик · год', 'Reviews': 'Обзоры', 'Description': 'Описание',
    'Hours played': 'Часы в игре', 'Last played': 'Последний запуск', 'Recently played': 'Недавно запущенные', 'Thumbnails': 'Миниатюры', 'Dots': 'Точки',
    'Hidden': 'Скрыто', 'Off': 'Выкл.', 'Slow zoom': 'Медленное приближение', 'Parallax': 'Параллакс', 'Screenshots': 'Скриншоты', 'Trailer': 'Трейлер',
    'Still': 'Неподвижно', 'A slow push-in on the art': 'Медленное приближение картинки', 'Moves a little with your pointer': 'Слегка смещается за указателем',
    'The game’s screenshots, one after another': 'Скриншоты игры один за другим', 'Its short silent trailer, on repeat': 'Короткий трейлер без звука по кругу',
    'The art, held still': 'Картинка без движения', 'Pick one below': 'Выберите ниже', 'Last played first': 'Сначала последние запущенные',
    'Your favorites, A–Z': 'Ваше избранное, А–Я', 'Newest in your library': 'Новейшие в вашей библиотеке', 'Home': 'Главная', 'No collections yet': 'Коллекций пока нет',
    'How many games': 'Сколько игр', 'Switching games': 'Смена игр', 'Game picker': 'Выбор игры', 'Auto-switch': 'Автосмена', 'Background art': 'Фоновая картинка',
    'Panels': 'Панели', 'Home stage settings': 'Настройки витрины главной', 'Home stage': 'Витрина главной', 'Played': 'Вы играли', 'playing now': 'играют сейчас',
    'Chosen games': 'Выбранные игры', 'A collection': 'Коллекция', 'Open game page': 'Открыть страницу игры', 'Featured games': 'Избранные игры',
    'None of the chosen games are in your library': 'Ни одной из выбранных игр нет в вашей библиотеке', 'No favorites yet': 'В избранном пока пусто',
    'No games in this collection': 'В этой коллекции нет игр', 'No collections chosen': 'Коллекции не выбраны', 'Not played yet': 'Ещё не запускалась',

    // library/
    'Only this': 'Только эта', 'Show all': 'Показать все', 'Collapse': 'Свернуть', 'Expand': 'Развернуть', 'Rename': 'Переименовать',
    'Change its filters': 'Изменить её фильтры', 'Open every collection': 'Развернуть все коллекции', 'Fold every collection': 'Свернуть все коллекции',
    'Hide the other collections': 'Скрыть остальные коллекции', 'Show every collection again': 'Снова показать все коллекции', 'Fold its games away': 'Свернуть её игры',
    'Show its games': 'Показать её игры', 'Give it a new name': 'Дать новое название', 'Its games stay in your library': 'Её игры останутся в библиотеке',
    'Dynamic collection': 'Динамическая коллекция', 'Friends playing': 'Играют друзья', 'Name': 'Название', 'Size': 'Размер', 'Not installed': 'Не установлена',
    'Grid': 'Сетка', 'List': 'Список', 'Nothing here yet': 'Здесь пока пусто', 'Released': 'Дата выхода', 'Added': 'Добавлена', 'Running': 'Запущена',
    'A collection already has this name': 'Коллекция с таким названием уже есть', 'Not in a collection': 'Не в коллекции', 'In these games': 'В этих играх',
    'In this game': 'В этой игре', 'No collections yet. Type a name to make one.': 'Коллекций пока нет. Введите название, чтобы создать.', 'In none': 'Ни в одной',
    'Launch it from the desktop': 'Запуск с рабочего стола', 'Its files stay on your PC': 'Файлы останутся на компьютере', 'Save a copy to restore later': 'Сохранить копию для восстановления',
    'Friends won’t see it': 'Друзья её не увидят', 'Shortcuts, hide, uninstall': 'Ярлыки, скрытие, удаление', 'Stop suggesting it': 'Больше не предлагать',
    'Updates, launch options, DLC': 'Обновления, параметры запуска, DLC', 'Target, launch options, controller': 'Путь, параметры запуска, контроллер',
    'Your own cover, hero and logo': 'Своя обложка, фон и логотип', 'Back to Steam’s art': 'Вернуть картинки Steam', 'Files': 'Файлы', 'Unhide': 'Вернуть из скрытых',
    'Stop': 'Остановить', 'Take it off your Home': 'Убрать с главной', 'Fewer of its updates on Home': 'Реже показывать её новости на главной',
    'More of its updates on Home': 'Чаще показывать её новости на главной', 'What Home shows you': 'Что показывает главная', 'Open it in your library': 'Открыть в библиотеке',
    'Every collection, side by side': 'Все коллекции рядом', 'Suggest every dismissed game again': 'Снова предлагать все отклонённые игры', 'Suggest it again': 'Снова предлагать',
    'The game stays in your library': 'Игра останется в библиотеке', 'A picture of your own behind the game': 'Своя картинка за игрой', 'Back to Steam’s background': 'Вернуть фон Steam',
    'Your own logo over the art': 'Свой логотип поверх картинки', 'Back to Steam’s logo': 'Вернуть логотип Steam', 'Move and size the logo': 'Положение и размер логотипа',
    'Back to where Steam puts it': 'Вернуть как в Steam', 'Your own cover for the game': 'Своя обложка игры', 'Back to Steam’s cover': 'Вернуть обложку Steam', 'Done': 'Готово',

    // navigation/
    'Shop': 'Магазин', 'The store front page': 'Главная страница магазина', 'Games picked for you': 'Игры, подобранные для вас', 'Top sellers and most played': 'Лидеры продаж и самые популярные',
    'Updates and announcements': 'Обновления и объявления', 'Yours': 'Ваше', "Games you're waiting for": 'Игры, которые вы ждёте', 'Releases you follow': 'Релизы, на которые вы подписаны',
    'Spend your Steam Points': 'Потратить очки Steam', 'Browse': 'Обзор', "Your games and what's new": 'Ваши игры и новинки', 'Your shelves of games': 'Ваши полки игр',
    "Games you've hidden": 'Скрытые вами игры', 'Music you own': 'Ваша музыка', 'The community front page': 'Главная страница сообщества', 'Forums for every game': 'Форумы по каждой игре',
    'Live game streams': 'Трансляции игр', 'Make and Trade': 'Создание и обмен', 'Mods and creations': 'Моды и работы', 'Buy and sell items': 'Покупка и продажа предметов',
    'You': 'Вы', 'Your public page': 'Ваша публичная страница', 'What friends are up to': 'Чем заняты друзья', 'Level and badges': 'Уровень и значки', 'Your year in games': 'Ваш год в играх',
    'People': 'Люди', 'Your friends list': 'Ваш список друзей', "Groups you're in": 'Ваши группы', 'Items': 'Предметы', 'Screenshots, art, guides': 'Скриншоты, арты, руководства',
    'Items and trading': 'Предметы и обмен', 'Redeem': 'Активировать', 'Enter a product key': 'Ввести ключ продукта', 'Redeem Wallet Code': 'Активировать код кошелька',
    'Add funds to your wallet': 'Пополнить кошелёк', 'Gifts and Guest Passes': 'Подарки и гостевые пропуска', 'Your gift inventory': 'Ваш инвентарь подарков',
    'Add Games': 'Добавить игры', 'A game on this PC': 'Игра на этом компьютере', 'Restore a Backup': 'Восстановить из резервной копии', 'Install from backup files': 'Установить из файлов резервной копии',
    'Search games': 'Поиск игр', 'Games, by default': 'Игры, по умолчанию', 'Active': 'Активно', 'Resize game list': 'Изменить ширину списка игр', 'Scroll to top': 'Наверх',
    'Show game list': 'Показать список игр', 'Hide game list': 'Скрыть список игр', 'Filters': 'Фильтры', '· grouped': '· по группам',

    // overlay/
    'No achievements match.': 'Подходящих достижений нет.', 'Nothing here yet.': 'Здесь пока пусто.', 'Store page': 'Страница в магазине', 'Community hub': 'Центр сообщества',
    'Discussions': 'Обсуждения', 'Guides': 'Руководства', 'News': 'Новости', 'No open tabs.': 'Нет открытых вкладок.', 'Darkness': 'Затемнение', 'App': 'Приложение',
    'Filter by rarity': 'Фильтр по редкости', 'Search achievements': 'Поиск достижений', 'Overlay views': 'Разделы оверлея', 'Back to game': 'Вернуться в игру',
    'Remote Play Together': 'Remote Play Together', 'Host': 'Организатор', 'Invite friends or a guest': 'Пригласить друзей или гостя',
    "Steam's Remote Play Together window": 'Окно Remote Play Together в Steam', 'Controller': 'Контроллер', "Use the game's built-in support": 'Встроенная поддержка в игре',
    'Controller layout': 'Раскладка контроллера', 'Game support': 'Поддержка в игре', 'Notes': 'Заметки', 'Note': 'Заметка', '+ New': '+ Новая', 'Delete note': 'Удалить заметку',
    'Keep': 'Оставить', 'Delete this note? This can’t be undone.': 'Удалить эту заметку? Это нельзя отменить.', 'Formatting': 'Форматирование',
    'Open in Steam’s editor': 'Открыть в редакторе Steam', 'Search or enter address': 'Поиск или адрес', 'Open browser': 'Открыть браузер', 'This game': 'Эта игра',
    'Open tabs': 'Открытые вкладки', 'Steam overlay settings': 'Настройки оверлея Steam', 'Backdrop': 'Фон', 'Show all achievements': 'Показать все достижения',
    'Your screenshots': 'Ваши скриншоты', 'Open screenshots': 'Открыть скриншоты', 'Browse guides': 'Руководства', 'Recent news': 'Последние новости', 'All news': 'Все новости',
    'Open all news': 'Открыть все новости', 'This session': 'Этот сеанс', 'Total': 'Всего', 'Last 2 weeks': 'За 2 недели', 'In a game': 'В игре', 'No friends match.': 'Подходящих друзей нет.',
    'No controller support': 'Контроллер не поддерживается', 'Partial Xbox support': 'Частичная поддержка Xbox', 'Full Xbox support': 'Полная поддержка Xbox',
    'Not hosting yet': 'Пока не организовано', "This game can't be shared over Remote Play Together.": 'В эту игру нельзя играть через Remote Play Together.',
    'Steam Input is off: the game reads your controller directly.': 'Steam Input выключен: игра работает с контроллером напрямую.',
    'Steam Input is on: Steam translates your controller for the game.': 'Steam Input включён: Steam передаёт игре ввод с контроллера.',
    'Support not listed': 'Поддержка не указана', 'Using game support': 'Поддержка в игре', 'Using Steam Input': 'Steam Input', 'Wireless': 'Беспроводной', 'Wired': 'Проводной',
    '· charging': '· заряжается', 'No controller connected.': 'Контроллер не подключён.', 'Bold': 'Жирный', 'Italic': 'Курсив', 'Underline': 'Подчёркнутый',
    'Strikethrough': 'Зачёркнутый', 'Code': 'Код', 'Saving…': 'Сохранение…', 'Saved to Steam Cloud': 'Сохранено в Steam Cloud', 'Untitled Note': 'Заметка без названия',
    'Editing…': 'Редактирование…', 'This note uses formatting only Steam’s editor can change.': 'В этой заметке есть оформление, которое меняется только в редакторе Steam.',
    'Note deleted': 'Заметка удалена', "Couldn't delete the note.": 'Не удалось удалить заметку.', 'Steam’s notes aren’t available here. Use Steam’s editor instead.': 'Заметки Steam здесь недоступны. Воспользуйтесь редактором Steam.',
    'Couldn’t load your notes.': 'Не удалось загрузить заметки.', 'Loading notes…': 'Загрузка заметок…', 'No notes for this game yet. Press + New to start one.': 'Для этой игры заметок пока нет. Нажмите «+ Новая», чтобы начать.',
    'Overview': 'Обзор', 'Timer': 'Таймер', 'Timer · paused': 'Таймер · пауза', 'Start a timer': 'Запустить таймер', 'Pause the timer (right-click to reset)': 'Приостановить таймер (правый клик — сброс)',
    'Resume the timer (right-click to reset)': 'Продолжить таймер (правый клик — сброс)', 'Details are revealed once you unlock it.': 'Подробности откроются, когда вы получите это достижение.',
    'Player': 'Игрок', 'Update': 'Обновление', 'Major update': 'Крупное обновление', 'Release': 'Выход',

    // settings/dialog/ — Steam's own settings, as their search and pages list them
    'Microphone test': 'Проверка микрофона', 'Steam Families': 'Семьи Steam', 'installed files': 'установленные файлы', 'local files': 'локальные файлы',
    'game versions & betas': 'версии игры и бета-версии', 'Friend Code': 'Код друга', 'Email Address': 'Адрес эл. почты', 'VAC Status': 'Статус VAC', 'Add Funds': 'Пополнить баланс',
    'Wallet': 'Кошелёк', 'Privacy Settings': 'Настройки приватности', 'Account Details': 'Об аккаунте', 'View Profile': 'Открыть профиль', 'Add Friends': 'Добавить друзей',
    "Append nicknames to friends' names": 'Добавлять никнеймы к именам друзей', 'Group friends together by game': 'Группировать друзей по играм',
    'Hide offline friends in custom categories': 'Скрывать друзей не в сети в своих категориях', 'Hide categorized friends in Online/Offline Friends': 'Скрывать распределённых друзей в списках «В сети» и «Не в сети»',
    "Ignore 'Away' status when sorting friends": 'Не учитывать статус «Нет на месте» при сортировке друзей', 'Sign in to friends when Steam starts': 'Входить в сеть друзей при запуске Steam',
    'Enable Animated Avatars & Animated Avatar Frames': 'Анимированные аватары и рамки', 'Compact friends list & chat view': 'Компактный список друзей и чат',
    'Compact favorite friends area': 'Компактная область избранных друзей', 'Dock chats to the friends list': 'Прикреплять чаты к списку друзей',
    'Open a new window for new chats (rather than a tab)': 'Открывать новые чаты в новом окне (а не во вкладке)', "Don't embed images and other media in-line": 'Не встраивать изображения и другие медиафайлы в сообщения',
    'Remember my open chats': 'Запоминать открытые чаты', 'Disable spellcheck in chat message entry': 'Отключить проверку орфографии в сообщениях', 'Disable animated room effects': 'Отключить анимированные эффекты комнат',
    'Chat Filtering': 'Фильтрация чата', 'Chat Font Size': 'Размер шрифта чата', 'Family': 'Семья', 'Create or Join a Steam Family': 'Создать семью Steam или вступить в неё',
    'Family View': 'Семейный просмотр', 'Parental controls': 'Родительский контроль', 'Library sharing': 'Общий доступ к библиотеке', 'Security': 'Безопасность',
    'Account Name': 'Имя аккаунта', 'Change Password': 'Сменить пароль', "Don't save account credentials on this computer": 'Не сохранять данные аккаунта на этом компьютере',
    'Steam Guard': 'Steam Guard', 'Manage Steam Guard': 'Управление Steam Guard', 'Backup Steam Guard Codes': 'Резервные коды Steam Guard', 'Deauthorize All Devices': 'Деавторизовать все устройства',
    'Show Notification Toasts': 'Показывать всплывающие уведомления', 'Play a sound when a notification toast is displayed': 'Звук при всплывающем уведомлении',
    'Client Notifications': 'Уведомления клиента', 'When I unlock an achievement': 'Когда я получаю достижение', 'When I connect or disconnect a controller': 'Когда я подключаю или отключаю контроллер',
    "When a controller's battery is low": 'Когда у контроллера садится батарея', 'Friend Notifications': 'Уведомления о друзьях', 'When a friend joins a game': 'Когда друг заходит в игру',
    'When a friend comes online': 'Когда друг входит в сеть', 'When I receive a direct chat message': 'Когда я получаю личное сообщение', 'When I receive a chat room notification': 'Когда приходит уведомление из чат-комнаты',
    'Flash window when I receive a chat message': 'Мигать окном при новом сообщении', 'Store News': 'Новости магазина', "There's a major sale": 'Начинается крупная распродажа',
    'Personal Activity': 'Личная активность', 'I receive a friend invitation': 'Я получаю приглашение в друзья', 'A discussion I subscribed to has a reply': 'В обсуждении, на которое я подписан, новый ответ',
    'I receive a new item in my inventory': 'Я получаю новый предмет в инвентарь', 'I receive a gift': 'Я получаю подарок', 'I receive a new trade offer': 'Я получаю новое предложение обмена',
    'I receive a reply from Steam Support': 'Я получаю ответ от поддержки Steam', 'I receive a Steam Turn notification': 'Я получаю уведомление Steam Turn',
    'I receive an invite to a Playtest or Limited Launch': 'Я получаю приглашение в плейтест или ограниченный запуск', 'Review copy for a Steam Curator group': 'Копия для обзора от группы кураторов Steam',
    'I receive Steam Community Awards': 'Я получаю награды сообщества Steam', 'My annual Steam Replay is now available': 'Мой годовой «Итоги года в Steam» готов',
    'Wishlist Activity': 'Активность списка желаемого', 'An item on my wishlist is on sale': 'Товар из списка желаемого продаётся со скидкой', 'An item on my wishlist has released': 'Вышел товар из списка желаемого',
    'A demo for an item on my wishlist has released': 'Вышла демоверсия товара из списка желаемого', 'Developer / Game News': 'Новости разработчиков и игр',
    'A publisher or developer I followed has released': 'Издатель или разработчик, на которого я подписан, выпустил продукт', 'A publisher or developer I followed has released a demo': 'Издатель или разработчик, на которого я подписан, выпустил демоверсию',
    'Game-specific event notifications': 'Уведомления о событиях в играх', 'A season pass I own ships new content': 'В моём сезонном абонементе вышел новый контент',
    'A game I follow has shipped new content from their roadmap': 'В игре, на которую я подписан, вышел новый контент из плана', 'Email Opt-out': 'Отказ от рассылки',
    'Opt out from all email marketing communications': 'Отказаться от всех рекламных писем', 'Steam Client Language': 'Язык клиента Steam', '24-hour clock': '24-часовой формат времени',
    'Client Beta Participation': 'Участие в бета-тесте клиента', 'Report a bug': 'Сообщить об ошибке', 'Start Up Location': 'Начальное окно',
    'Scale text and icons to match monitor settings': 'Масштабировать текст и значки по настройкам монитора', 'Run Steam when my computer starts': 'Запускать Steam при включении компьютера',
    'Start Steam in Big Picture Mode': 'Запускать Steam в режиме Big Picture', 'Ask which account to use each time Steam starts': 'Спрашивать аккаунт при каждом запуске Steam',
    'Notify me about additions or changes to my games': 'Уведомлять о дополнениях и изменениях в моих играх', 'Enable smooth scrolling in web views': 'Плавная прокрутка на веб-страницах',
    'Enable GPU accelerated rendering in web views': 'Аппаратное ускорение отрисовки веб-страниц', 'Enable hardware video decoding': 'Аппаратное декодирование видео',
    'Taskbar Preferences': 'Настройки панели задач', 'Mature Content': 'Контент для взрослых', 'Exclude from My Store': 'Исключить из моего магазина',
    'Discovery Queue Content': 'Содержимое списка рекомендаций', 'New On Steam Queue Content': 'Содержимое очереди новинок', 'Platform Preference': 'Предпочитаемые платформы',
    'Steam Deck Feedback': 'Отзывы о Steam Deck', 'Live Broadcasts': 'Прямые трансляции', 'Display size for Library user interface elements': 'Размер элементов интерфейса библиотеки',
    'Low Bandwidth Mode': 'Режим низкой пропускной способности', 'Low Performance Mode': 'Режим низкой производительности', 'Disable Community Content': 'Отключить контент сообщества',
    'Show game icons in the left column': 'Показывать значки игр в левой колонке', 'Ready to Play should include streamable games': 'Включать в «Готово к запуску» игры для трансляции',
    'Show Steam Deck compatibility information in library': 'Показывать совместимость со Steam Deck в библиотеке', 'Browse the Steam Store': 'Магазин Steam',
    'Download region': 'Регион загрузки', 'Limit download speed': 'Ограничить скорость загрузки', 'Display download rates in bits per second': 'Показывать скорость в битах в секунду',
    'Game update timing': 'Время обновления игр', 'Schedule auto-updates': 'Расписание автообновлений', 'Allow downloads during gameplay': 'Разрешить загрузки во время игры',
    'Throttle downloads while streaming': 'Замедлять загрузки во время трансляции', 'Clear Download Cache': 'Очистить кеш загрузки', 'Game File Transfer over Local Network': 'Передача файлов игр по локальной сети',
    'Allow transfers from this device to': 'Разрешить передачу с этого устройства на', 'Shader Pre-Caching': 'Предварительное кеширование шейдеров', 'Enable Shader Pre-caching': 'Включить предварительное кеширование шейдеров',
    'Allow background processing of Vulkan shaders': 'Фоновая обработка шейдеров Vulkan', 'Drives': 'Диски', 'Installed games': 'Установленные игры', 'Move': 'Переместить',
    'Add Drive': 'Добавить диск', 'Size on Disk': 'Размер на диске', 'Cloud': 'Облако', 'Enable Steam Cloud': 'Включить Steam Cloud', 'Screenshot Management': 'Управление скриншотами',
    'In Game': 'В игре', 'Enable the Steam Overlay while in-game': 'Включить оверлей Steam в игре', 'Show toolbar as list view': 'Показывать панель списком',
    'Restore my previous browser tabs when starting a game': 'Восстанавливать вкладки браузера при запуске игры', 'Use the Big Picture Overlay when using a controller': 'Оверлей Big Picture при игре с контроллером',
    'Scale Steam Overlay text and icons to match monitor settings': 'Масштабировать текст и значки оверлея по настройкам монитора', 'Overlay shortcut key(s)': 'Сочетание клавиш оверлея',
    'Web browser home page': 'Домашняя страница браузера', 'Delete Web Browser Data': 'Удалить данные браузера', 'Toolbar Preferences': 'Настройки панели',
    'Overlay Performance Monitor': 'Монитор производительности в оверлее', 'Show performance monitor': 'Показывать монитор производительности', 'Toggle performance monitor key(s)': 'Клавиши монитора производительности',
    'Performance detail level': 'Подробность монитора', 'Show FPS Avg/Min Graph': 'График средней и минимальной частоты кадров', 'Show CPU Utilization Per-Core Graph': 'График загрузки ядер процессора',
    'Enable kernel driver based metrics (CPU Temperature)': 'Метрики через драйвер ядра (температура процессора)', 'Text size scaling': 'Размер текста', 'Text contrast/saturation': 'Контраст и насыщенность текста',
    'Background opacity': 'Непрозрачность фона', 'Take a screenshot': 'Сделать скриншот', 'When a screenshot is taken, display a notification': 'Показывать уведомление о скриншоте',
    'When a screenshot is taken, play a sound': 'Звук при скриншоте', 'Save an external copy of my screenshots': 'Сохранять копию скриншотов вне Steam', 'Server browser pings/minute': 'Пингов в минуту в списке серверов',
    'Steam Networking': 'Сеть Steam', 'Accessibility': 'Специальные возможности', 'UI Scale': 'Масштаб интерфейса', 'High Contrast Mode': 'Высококонтрастный режим', 'Reduce Motion': 'Уменьшить движение',
    'Connected Controllers': 'Подключённые контроллеры', 'Add a new controller': 'Добавить контроллер', 'Disconnected Controllers': 'Отключённые контроллеры', 'Steam Controller Adapters': 'Адаптеры Steam Controller',
    'Advanced Settings': 'Расширенные настройки', 'Game Recording': 'Запись игр', 'Recording Off': 'Запись выключена', 'Record in Background': 'Запись в фоне', 'Record Manually': 'Запись вручную',
    'Learn More about Game Recording': 'Подробнее о записи игр', 'Voice Input Device': 'Устройство ввода голоса', 'Start Microphone Test': 'Проверить микрофон', 'Voice Output Device': 'Устройство вывода голоса',
    'Input volume/gain': 'Громкость ввода', 'Output volume/gain': 'Громкость вывода', 'Voice Transmission Type': 'Способ передачи голоса', 'Mute toggle hotkey assigned as': 'Клавиша отключения микрофона',
    'Play a short sound on microphone toggle': 'Короткий звук при включении микрофона', 'Voice Transmission Threshold': 'Порог передачи голоса', 'Advanced Options': 'Дополнительные параметры',
    'Remote Play': 'Remote Play', 'Enable Remote Play': 'Включить Remote Play', 'Computers & Devices': 'Компьютеры и устройства', 'Pair Steam Link': 'Связать со Steam Link',
    'Allow Direct Connection (IP sharing)': 'Разрешить прямое подключение (передача IP)', 'Connection PIN': 'PIN-код подключения', 'Enable Advanced Host Options': 'Расширенные параметры сервера',
    'Enable Advanced Client Options': 'Расширенные параметры клиента', 'Learn More about Remote Play': 'Подробнее о Remote Play', 'Broadcast': 'Трансляция', 'Broadcast Status': 'Статус трансляции',
    'Manage Broadcast': 'Управление трансляцией', 'Privacy setting': 'Приватность', 'Video Dimensions': 'Разрешение видео', 'Maximum Bitrate': 'Максимальный битрейт',
    'Optimize encoding for': 'Оптимизировать кодирование для', "Show viewers' chat in game": 'Показывать чат зрителей в игре', 'Record video from all applications on this machine': 'Записывать видео всех приложений',
    'Record audio from all applications on this machine': 'Записывать звук всех приложений', 'Record my microphone': 'Записывать мой микрофон', 'Show upload stats': 'Показывать статистику отправки',
    'View Broadcast Support Pages': 'Справка по трансляциям', 'Music': 'Музыка', 'Volume': 'Громкость', 'Pause music when starting an application': 'Пауза музыки при запуске приложения',
    'Pause music when voice chatting': 'Пауза музыки в голосовом чате', 'Download high quality audio files': 'Загружать аудио высокого качества', 'game recording': 'запись игры',
    'About this build': 'Об этой сборке', 'Last updated': 'Последнее обновление', 'Copy': 'Копировать', 'Maintenance': 'Обслуживание', 'No Workshop items yet': 'Предметов из Мастерской пока нет',
    'Items you subscribe to in the Workshop show up here, in the order the game loads them.': 'Здесь появятся предметы Мастерской, на которые вы подписаны, в порядке загрузки игрой.',
    'Artwork for this game in your library': 'Картинки этой игры в библиотеке', 'Search settings': 'Поиск настроек',
    'Your profile, wallet and how others find you': 'Профиль, кошелёк и как вас находят другие', 'How your friends list and chats look and behave': 'Вид и поведение списка друзей и чатов',
    'Library sharing, parental controls and purchase requests': 'Общая библиотека, родительский контроль и запросы на покупку', 'Sign-in, Steam Guard and devices': 'Вход, Steam Guard и устройства',
    'Toasts, sounds and where Steam reaches you': 'Всплывающие уведомления, звуки и где вас найдёт Steam', 'Language, start-up and how Steam looks': 'Язык, запуск и вид Steam',
    'What the store shows you': 'Что показывает вам магазин', 'Size, performance and what the list shows': 'Размер, производительность и содержимое списка', 'Region, speed, updates and shaders': 'Регион, скорость, обновления и шейдеры',
    'Drives and what is installed on them': 'Диски и что на них установлено', 'Saves and screenshots': 'Сохранения и скриншоты', 'The Steam Overlay, performance monitor and screenshots': 'Оверлей Steam, монитор производительности и скриншоты',
    'Size, contrast and motion': 'Размер, контраст и движение', 'Connected controllers and setup': 'Подключённые контроллеры и настройка', 'Record gameplay in the background or on demand': 'Запись игры в фоне или по запросу',
    'Microphone, speakers and transmission': 'Микрофон, динамики и передача', 'Stream games between your devices': 'Игры с трансляцией между вашими устройствами', 'Let friends watch you play': 'Пусть друзья смотрят, как вы играете',
    'Soundtrack playback in Steam': 'Воспроизведение саундтреков в Steam', 'General': 'Общие', 'How Millennium starts, updates and loads themes': 'Как Millennium запускается, обновляется и загружает темы',
    'Themes': 'Темы', 'Change how Steam looks. One theme runs at a time.': 'Измените вид Steam. Одновременно работает одна тема.', 'Quick CSS': 'Быстрый CSS',
    'Your own tweaks, on top of the theme, in every Steam window as you type': 'Ваши правки поверх темы — во всех окнах Steam прямо по мере ввода', 'Plugins': 'Плагины',
    'Millennium, theme and plugin updates': 'Обновления Millennium, темы и плагинов', 'Logs': 'Журналы', 'What Millennium and its plugins report': 'Что сообщают Millennium и его плагины',
    'Themes and plugins from the community, ready to install': 'Темы и плагины от сообщества, готовые к установке', 'Customize': 'Внешний вид', 'Maintain': 'Обслуживание', 'Devices & media': 'Устройства и медиа',
    'Friends list': 'Список друзей', 'Restrictions': 'Ограничения', 'Transmission': 'Передача', 'Playback': 'Воспроизведение', 'Shortcuts to other programs': 'Ярлыки других программ',
    'Enter a product code': 'Ввести код продукта', 'Find something new': 'Найти что-нибудь новое',

    // settings/library-manager/, settings/millennium/
    'Disabled': 'Отключено', 'Millennium settings': 'Настройки Millennium', 'Close': 'Закрыть', 'Close (Esc)': 'Закрыть (Esc)', 'Plugins and themes': 'Плагины и темы',
    'Find a setting': 'Найти настройку', 'Setting groups': 'Группы настроек', 'Later': 'Позже', 'Reload Steam': 'Перезагрузить Steam', 'No settings': 'Нет настроек', 'On': 'Вкл.',
    'Plugin settings': 'Настройки плагина', 'Active theme': 'Текущая тема', 'Theme': 'Тема', 'Plugin': 'Плагин', 'No setting matches.': 'Подходящих настроек нет.',
    'Plugins on': 'Включённые плагины', 'Plugins off': 'Выключенные плагины', 'With settings': 'С настройками', 'Warn': 'Предупр.', 'Error': 'Ошибка', 'Smaller text': 'Мельче',
    'Bigger text': 'Крупнее', 'Copy these lines': 'Копировать эти строки', 'Sources': 'Источники', 'Search this log': 'Поиск по журналу', 'Level': 'Уровень', 'Errors': 'Ошибки',
    'Warnings': 'Предупреждения', 'Log': 'Журнал', 'Time': 'Время', 'Where': 'Где', 'No lines match.': 'Подходящих строк нет.', 'This source has no lines yet.': 'В этом источнике пока нет строк.',
    'Pages': 'Страницы', 'Watch the file': 'Следить за файлом', 'Watch the file for edits made in another editor': 'Следить за правками файла в другом редакторе',
    'Type CSS and it applies to every Steam window as you go.': 'Пишите CSS — он сразу применяется ко всем окнам Steam.', 'Saved · applied': 'Сохранено · применено', 'Couldn’t save': 'Не удалось сохранить',
    'Can’t reach Millennium from this window': 'Из этого окна Millennium недоступен', 'Checks & alerts': 'Проверки и оповещения', 'What Millennium looks for, and when it tells you': 'Что проверяет Millennium и когда сообщает',
    'What a theme is allowed to change': 'Что может менять тема', 'Route Millennium through a proxy: HTTP, HTTPS or SOCKS5. Empty: a direct connection.': 'Подключение Millennium через прокси: HTTP, HTTPS или SOCKS5. Пусто — напрямую.',
    'Channel': 'Канал', 'When an update is ready': 'Когда обновление готово', 'On after reload': 'Включится после перезагрузки', 'Off after reload': 'Выключится после перезагрузки',
    'Needs an update': 'Нужно обновление', 'Crashed': 'Сбой', 'It logged errors: see Logs': 'Есть ошибки: см. журналы', 'It logged warnings: see Logs': 'Есть предупреждения: см. журналы',
    'Starting…': 'Запуск…', 'Not running': 'Не запущен', '1 change waiting': '1 изменение ждёт перезагрузки', 'Plugins switch on or off after Steam reloads.': 'Плагины включаются и выключаются после перезагрузки Steam.',
    'Switching a plugin on or off takes effect after you save and reload Steam.': 'Включение или выключение плагина вступит в силу после сохранения и перезагрузки Steam.',
    'Loads your theme and plugins': 'Загружает вашу тему и плагины', 'Theme in use': 'Текущая тема', "Couldn't check for updates": 'Не удалось проверить обновления',
    'Millennium could not reach GitHub.': 'Millennium не смог связаться с GitHub.', 'Checking for updates…': 'Проверка обновлений…', 'Asking GitHub about Millennium, your theme and your plugins.': 'Запрос к GitHub о Millennium, вашей теме и плагинах.',
    '1 update available': 'Доступно 1 обновление', 'You’re up to date': 'Всё обновлено', 'Checking…': 'Проверка…', 'Updating…': 'Обновление…', 'What Millennium checks': 'Что проверяет Millennium',
    'Checking': 'Проверка', 'Try again': 'Повторить', 'Check again': 'Проверить снова', 'Restart to finish': 'Перезапустите для завершения', 'Dismiss': 'Скрыть', 'Extend': 'Продлить',
    'Millennium is not reachable': 'Millennium недоступен', 'Reset to defaults': 'Сбросить', 'Save & reload Steam': 'Сохранить и перезагрузить Steam',

    // shared/
    'Events': 'События', 'Live-streams': 'Трансляции', 'Content updates': 'Обновления контента', 'Releases': 'Релизы', 'Sales': 'Распродажи', 'Steam official': 'Официально от Steam',
    'Show none': 'Скрыть все', 'Nothing found': 'Ничего не найдено', 'Cut': 'Вырезать', 'Paste': 'Вставить', 'Move it to the clipboard': 'Переместить в буфер обмена',
    'Keep a copy on the clipboard': 'Копировать в буфер обмена', 'Put the clipboard here': 'Вставить из буфера обмена', 'Stop marking it as a typo': 'Больше не отмечать как опечатку',

    // toasts/, tray/
    'Now playing': 'Сейчас играет', 'Invite': 'Приглашение', 'Friend request': 'Запрос в друзья', 'Voice call': 'Голосовой звонок', 'Achievement unlocked': 'Получено достижение',
    'Ready to play': 'Готово к запуску', 'Updated': 'Обновлено', 'Screenshot saved': 'Скриншот сохранён', 'Gift received': 'Получен подарок', 'New item': 'Новый предмет',
    'Trade offer': 'Предложение обмена', 'Comment': 'Комментарий', 'Steam Family': 'Семья Steam', 'Battery low': 'Низкий заряд', 'Needs attention': 'Требует внимания',
    'Steam overlay': 'Оверлей Steam', 'Game mastered': 'Игра пройдена на 100%', 'Tray menu': 'Меню в трее',
  };

  /* ---------- Strings with numbers or names ---------- */

  // [pattern on the whole trimmed text, its Russian, a piece of their code the pattern stands for
  // (tools/check.js warns when it is gone from upstream)]
  const tr = (s) => translate(s) ?? s; // a part that may itself be a key or a pattern
  const known = (s) => translate(s) != null;
  const ago = (s) => lower(tr(s));
  const PATTERNS = [
    // Their "how long ago" (home/stage/util.js, core/runtime.js ago(), dialogs/about-steam.js)
    [new RegExp(`^${N} days? ago$`), (m) => `${m[1]} ${days(m[1])} назад`, ' days ago'],
    [new RegExp(`^${N} min ago$`), (m) => `${m[1]} мин назад`, ' min ago'],
    [new RegExp(`^${N} (?:h|hr) ago$`), (m) => `${m[1]} ч назад`, ' h ago'],
    [new RegExp(`^${N} wk ago$`), (m) => `${m[1]} нед. назад`, ' wk ago'],
    [new RegExp(`^${N} mo ago$`), (m) => `${m[1]} мес. назад`, ' mo ago'],
    [new RegExp(`^${N} yr ago$`), (m) => `${m[1]} ${plural(value(m[1]), 'год', 'года', 'лет')} назад`, ' yr ago'],
    [/^checked (.+)$/, (m) => `проверено ${ago(m[1])}`, 'checked ${'],
    [/^Last online (.+)$/, (m) => `Был(а) в сети ${ago(m[1])}`, 'Last online ${'],
    [/^Played (.+)$/, (m) => (known(m[1]) ? `Запуск: ${ago(m[1])}` : null), 'Played ${when}'],
    [/^Last checked (.+)$/, (m) => `Последняя проверка в ${m[1]}`, 'Last checked ${'],

    // Home (home/stage/)
    [new RegExp(`^Played · ${N} h lately$`), (m) => `Вы играли · ${ru(m[1])} ч за 2 недели`, ' h lately'],
    [new RegExp(`^${N} h$`), (m) => `${ru(m[1])} ч`, '} h`'],
    [new RegExp(`^${N} min$`), (m) => `${m[1]} мин`, '} min`'],
    [new RegExp(`^${N} games?$`), (m) => `${m[1]} ${games(m[1])}`, " 'game' : 'games'"],
    [new RegExp(`^${N} friends? playing$`), (m) => `${value(m[1]) % 10 === 1 && value(m[1]) % 100 !== 11 ? 'Играет' : 'Играют'} ${m[1]} ${plural(value(m[1]), 'друг', 'друга', 'друзей')}`, ' friends playing'],
    [new RegExp(`^\\+${N} more$`), (m) => `Ещё ${m[1]}`, '+${rest} more'],
    [new RegExp(`^${N} more$`), (m) => `ещё ${m[1]}`, ' more</span>'],
    [new RegExp(`^${N} more favorites$`), (m) => `Ещё ${m[1]} в избранном`, ' more ${entry.moreNoun}'],
    [new RegExp(`^${N} more collections$`), (m) => `Ещё ${m[1]} ${plural(value(m[1]), 'коллекция', 'коллекции', 'коллекций')}`, ' more collections'],
    [new RegExp(`^${N} chosen$`), (m) => `Выбрано: ${m[1]}`, '} chosen'],
    [new RegExp(`^Page ${N} of ${N}$`), (m) => `Страница ${m[1]} из ${m[2]}`, 'Page ${'],
    [new RegExp(`^${N} of 12 columns$`), (m) => `${m[1]} из 12 колонок`, ' of 12 columns'],
    [/^(.+) settings$/, (m) => (known(m[1]) ? `Параметры: ${lower(tr(m[1]))}` : null), '} settings'],
    [new RegExp(`^${N} unlocked$`), (m) => `Получено: ${m[1]}`, '} unlocked</span>'],
    [new RegExp(`^${N} hidden$`), (m) => `Скрыто: ${m[1]}`, '} hidden'],
    [/^(.+)’s profile$/, (m) => `Профиль: ${m[1]}`, '’s profile'],
    [/^(.+)’s activity$/, (m) => `Активность: ${m[1]}`, '’s activity'],
    [new RegExp(`^· ${N} of ${N}$`), (m) => `· ${m[1]} из ${m[2]}`, '· ${'],

    // Game page (game-page/)
    [new RegExp(`^${N} of ${N} achievements unlocked$`), (m) => `Получено ${m[1]} из ${m[2]} ${plural(value(m[2]), 'достижения', 'достижений', 'достижений')}`, ' achievements unlocked'],
    [new RegExp(`^All ${N} achievements unlocked$`), (m) => `Получены все достижения: ${m[1]}`, 'All ${s.total} achievements unlocked'],
    [new RegExp(`^Achievements: ${N} of ${N} unlocked$`), (m) => `Достижения: получено ${m[1]} из ${m[2]}`, 'Achievements: ${'],
    [new RegExp(`^(Almost there|Just started|In progress) · ${N}%$`), (m) => `${tr(m[1])} · ${m[2]}%`, '${stage} · ${pct}%'],
    [new RegExp(`^${N} to go(.*)$`), (m) => toGo(m[1], m[2]), '} to go'],
    [/^Completed (.+?)(?: · (\d+) days? after your first unlock)?$/, (m) => `Завершено ${m[1]}${m[2] ? ` · через ${m[2]} ${days(m[2])} после первого достижения` : ''}`, ' after your first unlock'],
    [new RegExp(`^${TIER_RE} · ([<\\d.]+)% of players(?: · Unlocked (.+))?$`), (m) => `${TIER[m[1]]} · ${ru(m[2])}% игроков${m[3] ? ` · получено ${ago(m[3])}` : ''}`, '% of players'],
    [/^Unlocked (.+)$/, (m) => `Получено ${ago(m[1])}`, 'Unlocked ${'],
    [new RegExp(`^${TIER_RE}: ${N} of ${N}( unlocked)?$`), (m) => `${TIERS[m[1]]}: ${m[4] ? 'получено ' : ''}${m[2]} из ${m[3]}`, ' of ${t.total}'],
    [new RegExp(`^Players: (.+)$`), (m) => `Сейчас играют: ${tr(m[1])}`, 'Players: ${'],
    [/^Player count: (.+)\. Click to retry after one minute\.$/, (m) => `Число игроков: ${m[1]}. Нажмите, чтобы повторить через минуту.`, 'Click to retry after one minute.'],
    [new RegExp(`^and ${N} more$`), (m) => `и ещё ${m[1]}`, 'and ${'],
    [new RegExp(`^Comments · ${N}$`), (m) => `Комментарии · ${m[1]}`, 'Comments · ${'],
    [/^Added (.+)$/, (m) => `Добавлено ${ago(m[1])}`, 'Added ${'],
    [/^(.+)View full size$/, (m) => `${m[1]}Открыть в полном размере`, 'View full size'],

    // Downloads (header/downloads-card.js, dialogs/)
    [new RegExp(`^${N} min left$`), (m) => `Осталось ${m[1]} мин`, ' min left'],
    [new RegExp(`^${N} h ${N} min left$`), (m) => `Осталось ${m[1]} ч ${m[2]} мин`, ' h ${rest} min left'],
    [new RegExp(`^${N} h left$`), (m) => `Осталось ${m[1]} ч`, ' h left'],
    [new RegExp(`^${N} games? queued$`), (m) => `В очереди: ${m[1]} ${games(m[1])}`, ' queued'],
    [new RegExp(`^${N} (TB|GB|MB|KB|MB/s|KB/s|GHz|Hz)$`), (m) => `${ru(m[1])} ${{ TB: 'ТБ', GB: 'ГБ', MB: 'МБ', KB: 'КБ', 'MB/s': 'МБ/с', 'KB/s': 'КБ/с', GHz: 'ГГц', Hz: 'Гц' }[m[2]]}`, '} MB/s'],
    [new RegExp(`^${N} bytes$`), (m) => `${m[1]} байт`, '} bytes'],
    [/^(.+) of (.+) used$/, (m) => `Занято ${m[1]} из ${m[2]}`, ' used`'],
    [/^(.+) of (.+) used, (.+) of it this install$/, (m) => `Занято ${m[1]} из ${m[2]}, из них ${m[3]} — эта игра`, ' of it this install'],
    [/^(.+) left after install$/, (m) => `${m[1]} останется после установки`, ' left after install'],
    [/^Needs (.+) more$/, (m) => `Нужно ещё ${m[1]}`, 'Needs ${'],
    [/^Frees (.+)$/, (m) => `Освободит ${m[1]}`, 'Frees ${'],
    [/^(.+) free after$/, (m) => `${m[1]} свободно после`, ' free after'],
    [/^(.+) free of (.+)$/, (m) => `${m[1]} свободно из ${m[2]}`, ' free of ${'],
    [new RegExp(`^Game ${N} of ${N}$`), (m) => `Игра ${m[1]} из ${m[2]}`, 'Game ${'],
    [new RegExp(`^${N} of ${N} DLC installed$`), (m) => `Установлено DLC: ${m[1]} из ${m[2]}`, ' DLC installed'],
    [/^App (\d+)$/, (m) => `Приложение ${m[1]}`, 'App ${'],

    // Friends (friends/)
    [new RegExp(`^${N} more in (.+)$`), (m) => `Ещё ${m[1]} в разделе «${tr(m[2])}»`, ' more in ${'],
    [new RegExp(`^(.+), ${N} unread$`), (m) => `${m[1]}, непрочитанных: ${m[2]}`, ' unread'],
    [/^View (.+) in Library$/, (m) => `Открыть «${m[1]}» в библиотеке`, ' in Library'],
    [/^Voice · (.+)$/, (m) => `Голос · ${m[1]}`, 'Voice · ${'],
    [new RegExp(`^${N} members$`), (m) => `${m[1]} ${plural(value(m[1]), 'участник', 'участника', 'участников')}`, '} members'],
    [new RegExp(`^${N} online$`), (m) => `${m[1]} в сети`, '} online'],
    [new RegExp(`^${N} in game$`), (m) => `${m[1]} в игре`, '} in game'],
    [new RegExp(`^${N} chats$`), (m) => `${m[1]} ${plural(value(m[1]), 'чат', 'чата', 'чатов')}`, '} chats'],
    [/^Message #(.+)$/, (m) => `Сообщение в #${m[1]}`, 'Message #${'],
    [/^Message (.+)$/, (m) => `Сообщение для ${m[1]}`, 'Message ${partnerName}'],
    [/^Restore (.+), (.+)$/, (m) => `Вернуть ${m[1]}, ${tr(m[2])}`, 'Restore ${'],
    [/^Playing (.+)$/, (m) => `Играет в ${m[1]}`, 'Playing ${'],
    [/^Chat with (.+)$/, (m) => `Чат с ${m[1]}`, 'Chat with ${'],
    [new RegExp(`^Offline · ${N}$`), (m) => `Не в сети · ${m[1]}`, 'Offline · ${'],
    [new RegExp(`^Hosting · ${N} guests?$`), (m) => `Организовано · ${m[1]} ${plural(value(m[1]), 'гость', 'гостя', 'гостей')}`, 'Hosting · ${'],

    // Library, navigation, dialogs
    [/^Create “(.+)”$/, (m) => `Создать «${m[1]}»`, 'Create “${'],
    [/^Delete “(.+)”\?$/, (m) => `Удалить «${m[1]}»?`, 'Delete “${'],
    [/^Clear (\d+) filters?$/, (m) => `Сбросить ${m[1]} ${plural(value(m[1]), 'фильтр', 'фильтра', 'фильтров')}`, "'filter' : 'filters'"],
    [new RegExp(`^Showing ${N}$`), (m) => `Показано ${ru(m[1])}`, 'Showing ${'],
    [new RegExp(`^${N} of ${N} types$`), (m) => `${m[1]} из ${m[2]} типов`, ' types`'],
    [new RegExp(`^${N} of ${N} types · grouped$`), (m) => `${m[1]} из ${m[2]} типов · по группам`, ' · grouped'],
    [/^Games, by default · grouped$/, () => 'Игры, по умолчанию · по группам', ' · grouped'],
    [/^Game type: (.+)$/, (m) => `Тип игр: ${tr(m[1])}`, 'Game type: ${'],
    [new RegExp(`^${N} selected$`), (m) => `Выбрано: ${m[1]}`, '} selected'],
    [/^Sort by (.+)$/, (m) => `Сортировать: ${lower(tr(m[1]))}`, 'Sort by ${'],
    [/^Nothing matches “(.+)”$/, (m) => `Ничего не найдено по запросу «${m[1]}»`, 'Nothing matches “${'],
    [/^No programs match “(.+)”$/, (m) => `Нет программ по запросу «${m[1]}»`, 'No programs match “${'],
    [/^(.+)\. Click to copy$/, (m) => `${m[1]}. Нажмите, чтобы скопировать`, '. Click to copy'],
    [new RegExp(`^${N} min read$`), (m) => `${m[1]} мин чтения`, ' min read'],
    [new RegExp(`^${N} words$`), (m) => `${m[1]} ${plural(value(m[1]), 'слово', 'слова', 'слов')}`, ' words`'],
    [new RegExp(`^${N} cores$`), (m) => `${m[1]} ${plural(value(m[1]), 'ядро', 'ядра', 'ядер')}`, ' cores`'],
    [new RegExp(`^${N} threads$`), (m) => `${m[1]} ${plural(value(m[1]), 'поток', 'потока', 'потоков')}`, ' threads`'],
    [new RegExp(`^${N} displays$`), (m) => `${m[1]} ${plural(value(m[1]), 'монитор', 'монитора', 'мониторов')}`, ' displays`'],
    [/^Driver (.+)$/, (m) => `Драйвер ${m[1]}`, 'Driver ${'],
    [new RegExp(`^${N} of ${N} supported$`), (m) => `Поддерживается ${m[1]} из ${m[2]}`, ' supported`'],
    [new RegExp(`^${N} entries$`), (m) => `${m[1]} ${plural(value(m[1]), 'запись', 'записи', 'записей')}`, ' entries`'],
    [new RegExp(`^${N} characters$`), (m) => `${m[1]} ${plural(value(m[1]), 'символ', 'символа', 'символов')}`, ' characters`'],
    [new RegExp(`^${N} letters and digits$`), (m) => `${m[1]} ${plural(value(m[1]), 'буква или цифра', 'буквы или цифры', 'букв и цифр')}`, ' letters and digits'],

    // Overlay (overlay/)
    [new RegExp(`^${N} recent$`), (m) => `Недавних: ${m[1]}`, '} recent'],
    [/^Screenshot from (.+)$/, (m) => `Скриншот от ${m[1]}`, 'Screenshot from ${'],
    [/^Close (.+)$/, (m) => `Закрыть ${m[1]}`, 'Close ${host}'],

    // Millennium (settings/millennium/)
    [new RegExp(`^${N} errors$`), (m) => `${m[1]} ${plural(value(m[1]), 'ошибка', 'ошибки', 'ошибок')}`, '} errors'],
    [new RegExp(`^${N} warnings$`), (m) => `${m[1]} ${plural(value(m[1]), 'предупреждение', 'предупреждения', 'предупреждений')}`, '} warnings'],
    [new RegExp(`^${N} changes waiting$`), (m) => `${m[1]} ${plural(value(m[1]), 'изменение ждёт', 'изменения ждут', 'изменений ждут')} перезагрузки`, ' changes waiting'],
    [new RegExp(`^${N} updates available$`), (m) => `Доступно ${m[1]} ${plural(value(m[1]), 'обновление', 'обновления', 'обновлений')}`, ' updates available'],
    [/^(.+) available$/, (m) => (/^v?\d/.test(m[1]) ? `Доступна ${m[1]}` : null), ' available`'],
    [new RegExp(`^Installed · ${N}$`), (m) => `Установлено · ${m[1]}`, 'Installed · ${'],
    [/^(.+) channel$/, (m) => `Канал ${m[1]}`, ' channel`'],
    [/^Built (.+)$/, (m) => `Сборка ${m[1]}`, 'Built ${'],
    [/^No (themes|plugins) installed\.$/, (m) => (m[1] === 'themes' ? 'Темы не установлены.' : 'Плагины не установлены.'), ' installed.'],
  ];

  // The achievements banner's line under its title (game-page/achievements.js bannerText)
  function toGo(n, rest) {
    const head = `Осталось ${n}`;
    if (!rest) return head;
    if (rest === ' · Nothing unlocked yet') return `${head} · Пока ничего не получено`;
    let m = /^ · Rarest so far: (.+), ([<\d.]+)% of players$/.exec(rest);
    if (m) return `${head} · Самое редкое: ${m[1]}, ${ru(m[2])}% игроков`;
    m = /^: (.+)$/.exec(rest);
    if (m) {
      // A list of names (Intl.ListFormat in the client's language); only its hidden part is ours
      const list = m[1]
        .replace(/a hidden achievement$/, 'скрытое достижение')
        .replace(/(\d+) hidden achievements$/, (_, k) => `${k} ${plural(Number(k), 'скрытое достижение', 'скрытых достижения', 'скрытых достижений')}`);
      return `${head}: ${list}`;
    }
    return null;
  }

  /*
   * Text that is only theirs inside one container: pieces of a sentence around names, single
   * letters. [selector the text's element matches, map or function].
   */
  const FEED = [
    ['shared a video of', 'делится видео из'], ['shared a screenshot', 'делится скриншотом'],
    [/^shared (\d+) screenshots/, (k) => `делится ${k} ${plural(Number(k), 'скриншотом', 'скриншотами', 'скриншотами')}`],
    [/^unlocked (\d+) achievements/, (k) => `получает ${k} ${plural(Number(k), 'достижение', 'достижения', 'достижений')}`],
    ['wishlisted', 'добавляет в желаемое'], ['recommended', 'рекомендует'], ['unlocked', 'получает достижение'],
    ['started', 'начинает играть в'], ['played', 'играет в'], ['got', 'приобретает'], ['and', 'и'], ['in', 'в'], ['of', 'из'],
  ];
  // A fragment of a friend-activity sentence, all of it made of FEED's words, or null
  function feed(text) {
    let rest = text.trim();
    const out = [];
    while (rest) {
      let hit = null;
      for (const [k, v] of FEED) {
        if (typeof k === 'string') {
          if (rest === k || rest.startsWith(k + ' ')) {
            hit = [k.length, v];
            break;
          }
        } else {
          const m = k.exec(rest);
          if (m && (rest.length === m[0].length || rest[m[0].length] === ' ')) {
            hit = [m[0].length, v(m[1])];
            break;
          }
        }
      }
      if (!hit) return null;
      out.push(hit[1]);
      rest = rest.slice(hit[0]).trim();
    }
    return out.length ? out.join(' ') : null;
  }
  const INITIAL = { L: 'Л', E: 'Э', R: 'Р', U: 'Н', C: 'О' };
  const SCOPED = [
    ['.se-hs-fline', (t) => feed(t)],
    ['.se-hs-ftime', (t) => (t === 'now' ? 'сейчас' : null)],
    ['.se-hs-stat small', (t) => (t === 'h' ? 'ч' : null)],
    // Hours they write with String() (home/stage/util.js hours): 36.7 → 36,7
    ['.se-hs-stat b', (t) => (/^\d+\.\d+$/.test(t) ? ru(t) : null)],
    ['.se-ach-fx b, .se-ach-banner-count b', (t) => INITIAL[t] || null],
  ];

  /* ---------- Lookup ---------- */

  const cache = new Map();
  function translate(text) {
    if (cache.has(text)) return cache.get(text);
    let out = Object.prototype.hasOwnProperty.call(EXACT, text) ? EXACT[text] : null;
    if (out == null && /[A-Za-z]/.test(text)) {
      for (const [re, fn] of PATTERNS) {
        const m = re.exec(text);
        if (m) {
          out = fn(m);
          if (out != null) break;
        }
      }
    }
    if (cache.size > 5000) cache.clear();
    cache.set(text, out ?? null);
    return out ?? null;
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = { EXACT, PATTERNS, SCOPED, FEED, translate, plural };
    return;
  }
  if (typeof window === 'undefined' || window.__arkadaI18n) return;
  window.__arkadaI18n = true;

  /* ---------- Is the client Russian? ---------- */

  function language() {
    const docs = [document];
    try {
      if (window.opener && window.opener.document) docs.push(window.opener.document);
    } catch {}
    for (const d of docs) {
      const lang = d.documentElement && d.documentElement.getAttribute('lang');
      if (lang) return lang.toLowerCase();
    }
    try {
      const fromUrl = new URLSearchParams(location.search).get('LANGUAGE');
      if (fromUrl) return fromUrl.toLowerCase();
    } catch {}
    return null;
  }
  const isRussian = (lang) => !!lang && /^(ru|russian)\b/.test(lang);

  /* ---------- Which nodes are theirs ---------- */

  // Elements with what a game, a friend or Steam said: never touched
  const DATA = /(?:^|\s)se-[\w-]*(?:name|desc|nick|persona|msg|message|caption|quote|body|note-text|editor)(?:\s|$)/;
  const OURS = /(?:^|\s)se-/;
  // Their nodes that wear only Steam's classes (game-page/player-count.js: the label is Steam's PlayBarLabel)
  const ALSO_THEIRS = '.se-player-count-text > *';
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'CODE', 'PRE', 'svg', 'SVG']);

  // Theirs: an se- element, or one without a class right inside one (their templates' <b>, <em>)
  // (forAttr: the element's own attributes, so a field's placeholder counts, never its typed text)
  function owner(el, forAttr = false) {
    for (let k = 0; el && k < 4; k++, el = el.parentElement) {
      if (!(forAttr && k === 0) && (SKIP_TAGS.has(el.tagName) || el.isContentEditable)) return null;
      const c = typeof el.className === 'string' ? el.className : el.getAttribute && el.getAttribute('class');
      if (c) return OURS.test(c) && !DATA.test(c) ? el : null;
    }
    return null;
  }

  // Attributes with words in them: on their elements only, except their own data-se-… ones
  const ATTRS_OWNED = ['placeholder', 'title', 'aria-label', 'data-tip', 'data-se-tip'];
  const ATTRS_THEIRS = [
    'data-se-label', 'data-se-rv-text', 'data-se-acct-hint', 'data-se-day', 'data-se-ntf-time', 'data-se-gm-hint', 'data-se-gm-short',
    'data-se-title', 'data-se-sub', 'data-se-head', 'data-se-pre-text', 'data-se-mglabel', 'data-se-mgtitle', 'data-se-mgsub',
    'data-se-sortlabel', 'data-se-dl-title', 'data-se-k', 'data-se-short', 'data-se-nocolon', 'data-se-text',
  ];
  const ATTRS = [...ATTRS_OWNED, ...ATTRS_THEIRS];
  const ATTR_SELECTOR = ATTRS.map((a) => `[${a}]`).join(',');

  /* ---------- Writing, and leaving alone what they keep putting back ---------- */

  const CONTESTED_AFTER = 3; // a node put back to the same English this many times stays English
  const CONTEST_WINDOW = 4000; // ms
  const contested = new WeakSet();
  const history = new WeakMap(); // element → { key: [english, rounds, since] }

  function allowed(el, key, english) {
    if (contested.has(el)) return false;
    let h = history.get(el);
    if (!h) history.set(el, (h = {}));
    const now = performance.now();
    const prev = h[key];
    if (prev && prev[0] === english && now - prev[2] < CONTEST_WINDOW) {
      prev[1]++;
      if (prev[1] >= CONTESTED_AFTER) {
        contested.add(el);
        stats.contested++;
        if (stats.left.length < 20) stats.left.push(english);
        return false;
      }
    } else {
      h[key] = [english, 0, now];
    }
    return true;
  }

  function scoped(el, text) {
    for (const [sel, fn] of SCOPED) {
      if (el.matches(sel)) {
        const out = fn(text);
        if (out != null) return out;
      }
    }
    return null;
  }

  function doText(node) {
    const raw = node.data;
    // Words, or a decimal point (their hours: "36.7")
    if (raw.length > 400 || !/[A-Za-z]|\d\.\d/.test(raw)) return;
    const el = owner(node.parentElement) || (node.parentElement?.matches(ALSO_THEIRS) ? node.parentElement : null);
    if (!el) return;
    const text = raw.trim();
    if (!text) return;
    const out = scoped(node.parentElement, text) ?? translate(text);
    if (out == null || out === text) return;
    if (!allowed(node.parentElement, '#text', text)) return;
    const lead = raw.match(/^\s*/)[0];
    const trail = raw.match(/\s*$/)[0];
    node.data = lead + out + trail;
    stats.changed++;
  }

  function doAttr(el, name) {
    const v = el.getAttribute(name);
    if (!v || v.length > 400 || !/[A-Za-z]/.test(v)) return;
    if (ATTRS_OWNED.includes(name) && !owner(el, true)) {
      // A placeholder they put on Steam's own field (friends/chat/chat.js), marked by them
      if (!(name === 'placeholder' && hasMark(el))) return;
    }
    const text = v.trim();
    const out = translate(text);
    if (out == null || out === text) return;
    if (!allowed(el, name, text)) return;
    el.setAttribute(name, out);
    stats.changed++;
  }
  const hasMark = (el) => {
    for (const a of el.attributes) if (a.name.startsWith('data-se')) return true;
    return false;
  };

  function doElement(el) {
    for (const name of ATTRS) if (el.hasAttribute(name)) doAttr(el, name);
  }

  // A subtree just added: its text and attributes, when anything in it can be theirs
  function doTree(root) {
    if (root.nodeType === 3) return doText(root);
    if (root.nodeType !== 1 || SKIP_TAGS.has(root.tagName)) return;
    const theirs = owner(root) || root.querySelector('[class*="se-"]');
    if (theirs) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) doText(n);
    }
    if (root.matches(ATTR_SELECTOR)) doElement(root);
    for (const el of root.querySelectorAll(ATTR_SELECTOR)) doElement(el);
  }

  /* ---------- One observer, one batch per callback ---------- */

  const stats = (window.__arkadaI18nStats = { passes: 0, ms: 0, maxMs: 0, changed: 0, contested: 0, left: [], first: 0 });

  function batch(records) {
    const t0 = performance.now();
    const trees = new Set();
    const texts = new Set();
    const attrs = [];
    for (const r of records) {
      if (r.type === 'childList') for (const n of r.addedNodes) trees.add(n);
      else if (r.type === 'characterData') texts.add(r.target);
      else if (r.type === 'attributes') {
        if (r.target === document.documentElement && r.attributeName === 'lang') checkLanguage();
        else attrs.push(r);
      }
    }
    // A node inside another added one is done with it
    for (const n of trees) if (n.isConnected) doTree(n);
    for (const n of texts) if (n.isConnected) doText(n);
    for (const r of attrs) if (r.target.isConnected) doAttr(r.target, r.attributeName);
    const ms = performance.now() - t0;
    stats.passes++;
    stats.ms += ms;
    if (ms > stats.maxMs) stats.maxMs = ms;
  }

  let observer = null;
  function start() {
    if (observer || !document.body) return;
    const t0 = performance.now();
    doTree(document.body);
    stats.first = performance.now() - t0;
    observer = new MutationObserver((records) => {
      // Our own writes come back as records too: they find nothing left to translate
      batch(records);
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...ATTRS, 'lang'],
    });
  }
  function stop() {
    observer?.disconnect();
    observer = null;
  }
  window.__arkadaI18nStop = () => {
    stop();
    waitLang?.disconnect();
  };

  let waitLang = null;
  function checkLanguage() {
    const lang = language();
    if (isRussian(lang)) {
      waitLang?.disconnect();
      waitLang = null;
      start();
    } else if (lang && observer) {
      stop();
    }
    return lang;
  }

  const boot = () => {
    const lang = checkLanguage();
    if (!lang) {
      // No word on the language yet: ask the browser, and listen for Steam setting <html lang>
      if (isRussian((navigator.language || '').toLowerCase())) start();
      if (!observer) {
        waitLang = new MutationObserver(checkLanguage);
        waitLang.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
      }
    }
  };
  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot, { once: true });
})();

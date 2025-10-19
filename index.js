const { VK } = require('vk-io');
const OpenAI = require('openai');
const sqlite3 = require('sqlite3').verbose();
const { promisify } = require('util');

// ---------- Настройки ----------
const VK_TOKEN = "your_token";
const AITUNNEL_API_KEY = "your_token";
const AITUNNEL_BASE_URL = "https://api.aitunnel.ru/v1/";

// Разрешённые пользователи (ID)
const ALLOWED_USERS = new Set([123, 345]);

// Параметры контекста
const MAX_MESSAGES_IN_CONTEXT = 30;
const MAX_CHARS_IN_CONTEXT = 20000;

// Модели и параметры для API
const MODEL_NAME = "gpt-5-mini";
const SEARCH_MODEL_NAME = "gpt-4o-mini-search-preview";
const MAX_TOKENS = 1024;

// ---------- Инициализация SQLite ----------
const db = new sqlite3.Database('./data/bot_contexts.db');

// Промисифицируем методы SQLite
const dbRun = promisify(db.run.bind(db));
const dbGet = promisify(db.get.bind(db));
const dbAll = promisify(db.all.bind(db));

// Корректное закрытие БД при завершении процесса
function closeDatabase() {
    return new Promise((resolve, reject) => {
        db.close((err) => {
            if (err) {
                console.error('Ошибка при закрытии БД:', err);
                reject(err);
            } else {
                console.log('База данных закрыта');
                resolve();
            }
        });
    });
}

// Обработчики завершения процесса
process.on('SIGINT', async () => {
    console.log('\nПолучен сигнал SIGINT, завершаем работу...');
    await closeDatabase();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\nПолучен сигнал SIGTERM, завершаем работу...');
    await closeDatabase();
    process.exit(0);
});

process.on('exit', () => {
    console.log('Процесс завершён');
});

// Создаём таблицу для хранения контекстов
async function initDatabase() {
    await dbRun(`
        CREATE TABLE IF NOT EXISTS contexts (
            user_id INTEGER,
            role TEXT,
            content TEXT,
            timestamp INTEGER,
            message_order INTEGER
        )
    `);
    await dbRun(`
        CREATE INDEX IF NOT EXISTS idx_user_id ON contexts(user_id, message_order)
    `);
}

// ---------- Функции работы с контекстом ----------
async function getContextFor(userId) {
    const rows = await dbAll(
        'SELECT role, content FROM contexts WHERE user_id = ? ORDER BY message_order ASC',
        [userId]
    );
    return rows.map(row => ({ role: row.role, content: row.content }));
}

async function setContextFor(userId, ctx) {
    // Удаляем старый контекст
    await dbRun('DELETE FROM contexts WHERE user_id = ?', [userId]);
    
    // Добавляем новый контекст
    const timestamp = Date.now();
    for (let i = 0; i < ctx.length; i++) {
        await dbRun(
            'INSERT INTO contexts (user_id, role, content, timestamp, message_order) VALUES (?, ?, ?, ?, ?)',
            [userId, ctx[i].role, ctx[i].content, timestamp, i]
        );
    }
}

function trimContext(ctx) {
    // По количеству сообщений
    if (ctx.length > MAX_MESSAGES_IN_CONTEXT) {
        ctx = ctx.slice(-MAX_MESSAGES_IN_CONTEXT);
    }

    // По количеству символов
    while (ctx.length > 0 && ctx.reduce((sum, m) => sum + (m.content && m.content.length || 0), 0) > MAX_CHARS_IN_CONTEXT) {
        ctx.shift();
    }

    return ctx;
}

// ---------- Инициализация клиента API ----------
const apiClient = new OpenAI({
    apiKey: AITUNNEL_API_KEY,
    baseURL: AITUNNEL_BASE_URL,
});

// ---------- Функция обращения к API ----------
async function callAI(messages, model = MODEL_NAME) {
    const chatResult = await apiClient.chat.completions.create({
        messages: messages,
        model: model,
        max_tokens: MAX_TOKENS,
    });

    const choice = chatResult.choices[0];
    const messageObj = choice.message;

    return messageObj.content || "";
}

// ---------- VK бот ----------
const vk = new VK({ token: VK_TOKEN });

vk.updates.on('message_new', async (context) => {
    console.log('Получено сообщение:', {
        isPrivate: context.isPrivateMessage,
        senderId: context.senderId,
        text: context.text,
        peerId: context.peerId,
        isChat: context.isChat,
        chatId: context.chatId
    });

    // Проверяем, что это личное сообщение (peerId === senderId означает ЛС)
    const isPrivate = context.peerId === context.senderId;
    
    if (!isPrivate) {
        console.log('Сообщение не личное, пропускаем');
        return;
    }

    const userId = context.senderId;
    const text = (context.text || "").trim();

    console.log('Проверка пользователя:', userId, 'Разрешён:', ALLOWED_USERS.has(userId));

    // Проверка доступа
    if (!ALLOWED_USERS.has(userId)) {
        console.log('Доступ запрещён для пользователя:', userId);
        await context.send("Доступ запрещён. Этот бот приватный.");
        return;
    }

    console.log('Обработка команды от пользователя:', userId);

    try {
        // Команда help
        if (text.toLowerCase() === "/help") {
            await context.send(
                "Команды:\n" +
                "/clear - очистить контекст\n" +
                "/context - посмотреть контекст\n" +
                "/search <запрос> - поиск в интернете"
            );
            return;
        }

        // Команда очистки контекста
        if (["/clear", "очистить", "clear", "сброс"].includes(text.toLowerCase())) {
            await setContextFor(userId, []);
            await context.send("Контекст очищен.");
            return;
        }

        // Команда показать контекст
        if (["/context", "контекст"].includes(text.toLowerCase())) {
            const ctx = await getContextFor(userId);
            if (ctx.length === 0) {
                await context.send("Контекст пуст.");
                return;
            }

            const preview = ctx.slice(0, 3)
                .map((m, i) => `${i + 1}. (${m.role}) ${m.content.substring(0, 200)}...`)
                .join("\n\n");
            
            await context.send(`В контексте ${ctx.length} сообщений.\n\nПервые 3:\n${preview}`);
            return;
        }

        // Команда поиска
        if (text.toLowerCase().startsWith("/search")) {
            const query = text.substring(7).trim();

            if (!query) {
                await context.send("Укажите запрос для поиска. Пример: /search погода в Москве");
                return;
            }

            let ctx = await getContextFor(userId);
            const searchQuery = `Поиск в интернете: ${query}`;
            ctx.push({ role: "user", content: searchQuery });
            ctx = trimContext(ctx);

            try {
                const statusMsg = await context.send("Ищу в интернете...");
                const aiResponse = await callAI(ctx, SEARCH_MODEL_NAME);

                ctx.push({ role: "assistant", content: aiResponse });
                ctx = trimContext(ctx);
                await setContextFor(userId, ctx);

                // Удаляем статусное сообщение
                await vk.api.messages.delete({
                    message_ids: statusMsg.id,
                    delete_for_all: 1
                });

                await sendLongMessage(context, aiResponse);
            } catch (error) {
                await context.send(`Ошибка при обращении к AI: ${error.message}`);
            }
            return;
        }

        // Обычное сообщение
        let ctx = await getContextFor(userId);
        ctx.push({ role: "user", content: text });
        ctx = trimContext(ctx);

        try {
            const statusMsg = await context.send("Обрабатываю запрос...");
            const aiResponse = await callAI(ctx);

            ctx.push({ role: "assistant", content: aiResponse });
            ctx = trimContext(ctx);
            await setContextFor(userId, ctx);

            // Удаляем статусное сообщение
            await vk.api.messages.delete({
                message_ids: statusMsg.id,
                delete_for_all: 1
            });

            await sendLongMessage(context, aiResponse);
        } catch (error) {
            await context.send(`Ошибка при обращении к AI: ${error.message}`);
        }

    } catch (error) {
        console.error('Ошибка обработки сообщения:', error);
        await context.send('Произошла ошибка при обработке вашего сообщения.');
    }
});

// Функция для отправки длинных сообщений
async function sendLongMessage(context, message) {
    const MAX_VK_LEN = 4000;
    
    if (message.length <= MAX_VK_LEN) {
        await context.send(message);
    } else {
        const parts = [];
        for (let i = 0; i < message.length; i += MAX_VK_LEN) {
            parts.push(message.substring(i, i + MAX_VK_LEN));
        }
        
        for (const part of parts) {
            await context.send(part);
        }
    }
}

// ---------- Запуск ----------
async function start() {
    try {
        await initDatabase();
        console.log('База данных инициализирована');
        
        console.log('Разрешённые пользователи:', Array.from(ALLOWED_USERS));
        
        await vk.updates.start();
        console.log('Бот запущен! (контексты хранятся в SQLite)');
        console.log('Long Poll запущен, ожидаем сообщения...');
    } catch (error) {
        console.error('Ошибка при запуске бота:', error);
        process.exit(1);
    }
}

start();

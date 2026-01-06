const { Telegraf, Markup } = require('telegraf')

// 1. ENV VARS
const BOT_TOKEN = process.env.BOT_TOKEN
const RU_OPERATOR_ID = process.env.RU_OPERATOR_ID // your Telegram user ID
const EN_OPERATOR_ID = process.env.EN_OPERATOR_ID // your friend's Telegram user ID
const WEBHOOK_URL = process.env.WEBHOOK_URL
const WEBHOOK_PATH = process.env.WEBHOOK_PATH

if (!BOT_TOKEN || !RU_OPERATOR_ID || !EN_OPERATOR_ID) {
  console.error('Missing BOT_TOKEN, RU_OPERATOR_ID or EN_OPERATOR_ID')
  process.exit(1)
}

const bot = new Telegraf(BOT_TOKEN)

// 2. In-memory storage (simple for now)
const userLanguage = new Map()           // userId -> 'ru' | 'en'
const ticketMap = new Map()              // operatorMessageId -> userId

// 3. /start – ask for language
bot.start(async (ctx) => {
  await ctx.reply(
    'Выберите язык / Choose your language:',
    Markup.inlineKeyboard([
      [Markup.button.callback('🇷🇺 Русский', 'lang_ru')],
      [Markup.button.callback('🇬🇧 English', 'lang_en')],
    ])
  )
})

// 4. Language selection callbacks
bot.action('lang_ru', async (ctx) => {
  const userId = ctx.from.id
  userLanguage.set(userId, 'ru')
  await ctx.editMessageText('Язык установлен: Русский. Напишите ваш вопрос.')
})

bot.action('lang_en', async (ctx) => {
  const userId = ctx.from.id
  userLanguage.set(userId, 'en')
  await ctx.editMessageText('Language set: English. Please send your question.')
})

// 5. Handle user messages (not from operators)
bot.on('text', async (ctx) => {
  const userId = ctx.from.id

  // Ignore messages from operators here
  if (String(userId) === RU_OPERATOR_ID || String(userId) === EN_OPERATOR_ID) {
    return
  }

  const lang = userLanguage.get(userId)

  if (!lang) {
    // If user hasn't selected language yet
    return ctx.reply(
      'Please choose your language first:',
      Markup.inlineKeyboard([
        [Markup.button.callback('🇷🇺 Русский', 'lang_ru')],
        [Markup.button.callback('🇬🇧 English', 'lang_en')],
      ])
    )
  }

  const text = ctx.message.text
  const username = ctx.from.username
  const operatorId = lang === 'ru' ? RU_OPERATOR_ID : EN_OPERATOR_ID

  const intro =
    lang === 'ru'
      ? `Новый запрос от пользователя @${username || 'unknown'} (id: ${userId}):`
      : `New request from user @${username || 'unknown'} (id: ${userId}):`

  // Send message to appropriate operator
  const sent = await bot.telegram.sendMessage(
    operatorId,
    `${intro}\n\n${text}`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: `Reply to this user`,
              callback_data: `reply_${userId}`,
            },
          ],
        ],
      },
    }
  )

  // Map operator message -> userId so we can reply later
  ticketMap.set(`${operatorId}:${sent.message_id}`, userId)

  await ctx.reply(
    lang === 'ru'
      ? 'Спасибо! Поддержка скоро ответит.'
      : 'Thanks! Support will reply shortly.'
  )
})

// 6. Operator presses "Reply to this user" button
bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data

  if (!data.startsWith('reply_')) return

  const fromId = String(ctx.from.id)
  const isOperator =
    fromId === String(RU_OPERATOR_ID) || fromId === String(EN_OPERATOR_ID)

  if (!isOperator) {
    await ctx.answerCbQuery('Only operators can reply.', { show_alert: true })
    return
  }

  const userId = data.split('_')[1]

  // Tell operator how to reply
  const instruction = await ctx.reply(
    `Type your reply to user ${userId} as a reply to *this* message.`,
    { parse_mode: 'Markdown' }
  )

  // Map instruction message -> userId so replies to it are routed correctly
  ticketMap.set(`${fromId}:${instruction.message_id}`, userId)

  ctx.answerCbQuery()
})

// 7. Operator replies -> send back to user
bot.on('text', async (ctx) => {
  const fromId = String(ctx.from.id)

  // Only operators can trigger this logic
  const isOperator =
    fromId === String(RU_OPERATOR_ID) || fromId === String(EN_OPERATOR_ID)

  if (!isOperator) return

  // Must be a reply to the earlier message from the bot
  const replyTo = ctx.message.reply_to_message
  if (!replyTo) return

  const key = `${fromId}:${replyTo.message_id}`
  const userId = ticketMap.get(key)
  if (!userId) return

  const text = ctx.message.text

  // Send reply to the original user
  await bot.telegram.sendMessage(userId, text)
})

const getWebhookConfig = () => {
  if (!WEBHOOK_URL) return null

  const url = new URL(WEBHOOK_URL)
  const domain = `${url.protocol}//${url.host}`
  const hookPath = url.pathname !== '/' ? url.pathname : WEBHOOK_PATH || `/telegraf/${BOT_TOKEN}`
  const port = Number(process.env.PORT) || 3000

  return { domain, hookPath, port }
}

const startBot = async () => {
  const webhookConfig = getWebhookConfig()

  if (webhookConfig) {
    const { domain, hookPath, port } = webhookConfig
    const fullUrl = `${domain}${hookPath}`

    try {
      const info = await bot.telegram.getWebhookInfo()
      if (info.url !== fullUrl) {
        console.log(`Setting up webhook: ${fullUrl} on port ${port}`)
        await bot.telegram.setWebhook(fullUrl)
      } else {
        console.log(`Webhook already set to ${fullUrl}. Starting server on port ${port}...`)
      }
    } catch (err) {
      console.warn('Could not check/set webhook status:', err.message)
      // Fallback: try to set it anyway if we haven't hit a 429 yet
      if (!err.message.includes('429')) {
        await bot.telegram.setWebhook(fullUrl)
      }
    }

    await bot.launch({ webhook: { port, hookPath } })
    console.log(`Bot started successfully on port ${port}`)
    return
  }

  console.log('No webhook config found. Attempting to start with long polling...')
  await bot.telegram.deleteWebhook({ drop_pending_updates: true })
  await bot.launch({ dropPendingUpdates: true })
  console.log('Bot started with long polling')
}

startBot().catch((error) => {
  console.error('Failed to start bot:', error.message)
  process.exit(1)
})

// Enable graceful stop
const shutdown = (signal) => {
  console.log(`Received ${signal}. Shutting down...`)
  try {
    bot.stop(signal)
  } catch (err) {
    console.warn('Bot was not running or failed to stop gracefully:', err.message)
  }
}

process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))

'use strict'

// Адаптер Яндекс Телемоста: нормализует ответы готового коннектора избранного
// (favorite_chats_list / favorite_chat_messages_list). Вложения и пересланные
// сообщения не выгружаются — только текст, автор и время.

// Адресация — точным названием из пина: chat_id в конфиге ChatHub не хранится.
const URL_RE = /https?:\/\/[^\s<>"'`]+/gi
// Хвостовая пунктуация и закрывающая скобка не входят в ссылку.
const TRAILING_RE = /[.,;:)!?\]]+$/
// Коннектор принимает limit 1..50; глубже листаем курсором.
const PAGE_LIMIT = 50
// Потолок выгрузки одного чата: 10 страниц × 50 сообщений.
const MAX_PAGES = 10
const MAX_MESSAGES = PAGE_LIMIT * MAX_PAGES

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function extractLinks(text) {
  if (typeof text !== 'string') return []
  const links = []
  for (const match of text.matchAll(URL_RE)) {
    const link = match[0].replace(TRAILING_RE, '')
    if (link && !links.includes(link)) links.push(link)
  }
  return links
}

// Время коннектора — created_at (ISO-8601). Неразбираемое время не отбрасываем:
// мост сам посчитает сообщение undated.
function timestampMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN
  if (typeof value !== 'string' || value.trim() === '') return NaN
  return Date.parse(value)
}

function timestampOf(item) {
  if (typeof item.created_at === 'string' && item.created_at.trim() !== '') return item.created_at
  if (typeof item.created_at === 'number' && Number.isFinite(item.created_at)) return item.created_at
  return null
}

// Точное совпадение title: одинаковые названия не должны расширять доступ.
function matchChatId(chats, title) {
  const needle = typeof title === 'string' ? title : ''
  if (!needle) throw fail('CHAT_NOT_FOUND', 'У пина нет названия чата Телемоста.')
  const found = chats.filter(chat => chat && typeof chat.title === 'string' && chat.title === needle)
  if (!found.length) throw fail('CHAT_NOT_FOUND', `Чат «${needle}» не найден среди избранных.`)
  if (found.length > 1) throw fail('MULTIPLE_CHATS', `Несколько избранных чатов с названием «${needle}».`)
  const chatId = found[0].chat_id
  if (typeof chatId !== 'string' || chatId.trim() === '') {
    throw fail('MALFORMED_RESPONSE', 'Избранный чат Телемоста без chat_id.')
  }
  return chatId
}

function toMessage(chatId, item) {
  if (!item || typeof item !== 'object' || item.id === undefined || item.id === null || String(item.id).trim() === '') {
    throw fail('MALFORMED_RESPONSE', 'В ответе Телемоста сообщение без id.')
  }
  if (typeof item.text !== 'string') {
    throw fail('MALFORMED_RESPONSE', 'В ответе Телемоста сообщение без text.')
  }
  const displayName = item.author && typeof item.author.display_name === 'string'
    ? item.author.display_name.trim()
    : ''
  return {
    service: 'ydx',
    chatId,
    messageId: String(item.id),
    author: displayName || '—',
    timestamp: timestampOf(item),
    text: item.text,
    links: extractLinks(item.text)
  }
}

// Допустимый код ошибки коннектора для причины усечения; иначе общий код.
function errorCode(error) {
  if (error && typeof error.code === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(error.code)) return error.code
  return 'TOOL_ERROR'
}

module.exports = async function adapt(target, ctx) {
  const windowStartMs = Number.isFinite(ctx && ctx.windowStartMs) ? ctx.windowStartMs : null

  const listed = await ctx.request('favorite_chats_list', {})
  if (!listed || !Array.isArray(listed.chats)) {
    throw fail('MALFORMED_RESPONSE', 'Ответ Телемоста без массива избранных чатов.')
  }
  const chatId = matchChatId(listed.chats, target && target.title)

  const messages = []
  let cursor = null
  let pages = 0
  let coverage = 'truncated'
  let reason = null

  for (;;) {
    // Первая страница адресуется chat_id + limit, следующие — только курсором.
    const pageNumber = pages + 1
    const args = cursor === null ? { chat_id: chatId, limit: PAGE_LIMIT } : { cursor }
    try {
      const page = await ctx.request('favorite_chat_messages_list', args)
      if (!page || !Array.isArray(page.items)) {
        throw fail('MALFORMED_RESPONSE', 'Ответ Телемоста без массива items.')
      }
      pages += 1

      let reachedDepth = false
      for (const item of page.items) {
        const message = toMessage(chatId, item)
        const ms = timestampMs(message.timestamp)
        // Страница идёт от новых к старым: первое сообщение старше окна означает,
        // что глубина достигнута и листать дальше незачем.
        if (windowStartMs !== null && Number.isFinite(ms) && ms < windowStartMs) {
          reachedDepth = true
          break
        }
        messages.push(message)
        // Упёрлись в потолок сообщений — честно помечаем усечение.
        if (messages.length >= MAX_MESSAGES) {
          return { messages, coverage: 'truncated' }
        }
      }

      const next = typeof page.next_cursor === 'string' && page.next_cursor ? page.next_cursor : null
      // Остановка по глубине или конец списка — данные полные.
      if (reachedDepth || next === null) {
        coverage = 'full'
        break
      }
      // Десятая страница с живым курсором — потолок выгрузки.
      if (pages >= MAX_PAGES) {
        coverage = 'truncated'
        break
      }
      cursor = next
    } catch (error) {
      // Ошибка на странице после успешной первой не отменяет уже прочитанное:
      // останавливаем пагинацию, помечаем усечение и сохраняем причину.
      // Ошибка первой страницы (и favorite_chats_list выше) — провал чата.
      if (pages === 0) throw error
      reason = `страница ${pageNumber}: ${errorCode(error)}`
      coverage = 'truncated'
      break
    }
  }

  const result = { messages, coverage }
  if (reason) result.reason = reason
  return result
}

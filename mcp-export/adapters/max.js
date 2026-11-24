'use strict'

// Адаптер MAX: нормализует ответ max_read_history.

const { classifyCoverage } = require('../core/coverage')

// Смещение в конце времени: Z, +07:00 или +0700.
const OFFSET_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i
// Порог чисел эпохи: миллисекунды и секунды.
const MS_LIMIT = 1e12
const SEC_LIMIT = 1e9
const URL_RE = /https?:\/\/[^\s<>"'`]+/gi
// Хвостовая пунктуация и закрывающая скобка не входят в ссылку.
const TRAILING_RE = /[.,;:)!?\]]+$/

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

// Число эпохи: >= 1e12 — миллисекунды, >= 1e9 — секунды, меньше — не время.
// Новосибирск — фиксированный UTC+7, поэтому время без смещения трактуем так же.
const OFFSET_MS = 7 * 60 * 60 * 1000
function epochIso(value) {
  if (!Number.isFinite(value)) return null
  const ms = value >= MS_LIMIT ? value : value >= SEC_LIMIT ? value * 1000 : null
  // Границы Date: иначе toISOString бросит RangeError на мусорном числе.
  if (ms === null || Math.abs(ms + OFFSET_MS) > 8.64e15) return null
  return new Date(ms + OFFSET_MS).toISOString().slice(0, 19) + '+07:00'
}

// Без смещения время коннектора считается локальным (Новосибирск, +07:00).
function normalizeTimestamp(value) {
  if (typeof value === 'number') return epochIso(value)
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  // Строка из одних цифр — тоже время эпохи (MAX/MM отдают секунды числом).
  if (/^\d+$/.test(text)) return epochIso(Number(text))
  const iso = OFFSET_RE.test(text) ? text : `${text}+07:00`
  return Number.isFinite(Date.parse(iso)) ? iso : null
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

function toMessage(source, chatKey, item) {
  const index = item && item.index
  if (!Number.isFinite(index)) {
    throw fail('MALFORMED_RESPONSE', 'В ответе MAX сообщение без index.')
  }
  if (typeof item.text !== 'string') {
    throw fail('MALFORMED_RESPONSE', 'В ответе MAX сообщение без text.')
  }
  const author = typeof item.author === 'string' && item.author.trim() !== '' ? item.author : '—'
  return {
    service: 'max',
    chatId: source.chatId,
    // Серверного id нет: index уникален внутри абсолютного окна выгрузки.
    messageId: `max:${chatKey}:${index}`,
    author,
    timestamp: normalizeTimestamp(item.timestamp),
    text: item.text,
    links: extractLinks(item.text)
  }
}

module.exports = async function adapt(target, ctx) {
  const rawChat = typeof target.chatId === 'string' ? target.chatId.trim() : ''
  if (!rawChat) throw fail('BAD_CHAT_ID', 'Некорректный идентификатор чата MAX.')
  const limit = Number.isFinite(ctx && ctx.limit) ? ctx.limit : 200

  let result
  try {
    result = await ctx.request('max_read_history', { chat: rawChat, limit })
  } catch (error) {
    // Пустое отрендеренное окно — не ошибка выгрузки.
    if (error && error.code === 'NO_MESSAGES') return { messages: [], coverage: 'window' }
    throw error
  }

  // F2: коннектор может вернуть ошибку объектом в теле результата.
  if (result && typeof result === 'object' && result.ok === false && typeof result.code === 'string') {
    // Пустое окно — не ошибка выгрузки, как и исключение NO_MESSAGES.
    if (result.code === 'NO_MESSAGES') return { messages: [], coverage: 'window' }
    const message = typeof result.message === 'string' && result.message
      ? result.message
      : 'MAX вернул ошибку.'
    throw fail(result.code, message)
  }

  if (!result || result.ok === false || !Array.isArray(result.messages)) {
    throw fail('MALFORMED_RESPONSE', 'Ответ MAX вне ожидаемой схемы.')
  }

  const chatKey = result.chat_id === undefined || result.chat_id === null || String(result.chat_id) === ''
    ? rawChat
    : String(result.chat_id)
  const messages = result.messages.map(item => toMessage(target, chatKey, item))
  // Отрендеренное окно всегда неполное по своей природе.
  return { messages, coverage: classifyCoverage({ kind: 'window' }) }
}

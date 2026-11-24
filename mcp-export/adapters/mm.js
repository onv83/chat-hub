'use strict'

// Адаптер Mattermost: нормализует ответ mmchat_read_channel.

const { classifyCoverage } = require('../core/coverage')
const { dedupeMessages } = require('../core/dedupe')

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
  // Строка из одних цифр — тоже время эпохи.
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

// chatId приходит как '<team>/<channel>' или '<team>/@person'.
function splitChatId(chatId) {
  const raw = typeof chatId === 'string' ? chatId.trim() : ''
  const slash = raw.indexOf('/')
  if (slash <= 0 || slash === raw.length - 1) {
    throw fail('BAD_CHAT_ID', 'Некорректный идентификатор чата Mattermost.')
  }
  const team = raw.slice(0, slash)
  const target = raw.slice(slash + 1)
  if (!team || !target || target === '@') {
    throw fail('BAD_CHAT_ID', 'Некорректный идентификатор чата Mattermost.')
  }
  return { team, target }
}

function buildArgs(chatId, limit) {
  const { team, target } = splitChatId(chatId)
  if (target.startsWith('@')) {
    // person — username без '@'; для личной переписки team не передаётся.
    return { person: target.slice(1), limit }
  }
  return { channel: target, team, limit, include_thread_replies: true }
}

function toMessage(source, post) {
  if (!post || typeof post !== 'object' || post.post_id === undefined || post.post_id === null || String(post.post_id).trim() === '') {
    throw fail('MALFORMED_RESPONSE', 'В ответе Mattermost пост без post_id.')
  }
  if (typeof post.text !== 'string') {
    throw fail('MALFORMED_RESPONSE', 'В ответе Mattermost пост без text.')
  }
  const author = typeof post.author === 'string' && post.author.trim() !== '' ? post.author : '—'
  return {
    service: 'mm',
    chatId: source.chatId,
    messageId: String(post.post_id),
    author,
    timestamp: normalizeTimestamp(post.time),
    text: post.text,
    links: extractLinks(post.text)
  }
}

// Самое старое разбираемое время в миллисекундах.
function oldestTimestamp(messages) {
  let oldest
  for (const message of messages) {
    const ms = Date.parse(message.timestamp)
    if (!Number.isFinite(ms)) continue
    if (oldest === undefined || ms < oldest) oldest = ms
  }
  return oldest
}

module.exports = async function adapt(target, ctx) {
  const limit = Number.isFinite(ctx && ctx.limit) ? ctx.limit : 200
  const args = buildArgs(target.chatId, limit)
  const result = await ctx.request('mmchat_read_channel', args)
  if (!result || !Array.isArray(result.posts)) {
    throw fail('MALFORMED_RESPONSE', 'Ответ Mattermost без массива posts.')
  }
  const messages = result.posts.map(post => toMessage(target, post))
  const count = Number.isFinite(result.count) ? result.count : messages.length
  const coverage = classifyCoverage({
    kind: 'paged',
    limit,
    count,
    oldestTs: oldestTimestamp(messages),
    windowStartMs: ctx && ctx.windowStartMs
  })
  // Одинаковые посты могут прийти из треда и из канала — оставляем один.
  return { messages: dedupeMessages(messages), coverage }
}

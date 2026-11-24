'use strict'

function timestampValue(value) {
  if (typeof value === 'number') return value
  if (value instanceof Date) return value.getTime()
  const numeric = Number(value)
  if (value !== '' && Number.isFinite(numeric)) return numeric
  return Date.parse(value)
}

function dedupeMessages(messages) {
  const seen = new Set()
  const unique = []
  for (const [index, message] of messages.entries()) {
    const key = JSON.stringify([message.service, message.chatId, message.messageId])
    if (seen.has(key)) continue
    seen.add(key)
    unique.push({ message, index })
  }
  unique.sort((a, b) => {
    const byTime = timestampValue(a.message.timestamp) - timestampValue(b.message.timestamp)
    return byTime || a.index - b.index
  })
  return unique.map(item => item.message)
}

module.exports = { dedupeMessages }

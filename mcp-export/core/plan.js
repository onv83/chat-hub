'use strict'

const { URL } = require('node:url')
const { parseProjects } = require('./projects')

// Сервисы, которые экспорт умеет выгружать. ydx адресуется точным названием из
// пина (адаптер ищет чат в избранном коннектора), поэтому chatId из URL не нужен.
const EXPORT_SERVICES = new Set(['mm', 'max', 'ydx'])

const localDateTime = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Novosibirsk',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23'
})

function formatExportedAt(date) {
  const parts = {}
  for (const part of localDateTime.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value
  }
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+07:00`
}

function deriveChatId(service, url) {
  if (service !== 'max' && service !== 'mm') return null
  let parsed
  try {
    parsed = new URL(String(url))
  } catch {
    return null
  }
  const segments = parsed.pathname.split('/').filter(Boolean)
  if (service === 'max') {
    if (!segments.length) return null
    const last = segments[segments.length - 1]
    // MAX адресуется только числовым id, отрицательный тоже допустим
    return /^-?\d+$/.test(last) ? last : null
  }
  if (segments.length !== 3) return null
  if (segments[1] === 'channels') return `${segments[0]}/${segments[2]}`
  if (segments[1] === 'messages' && /^@.+/.test(segments[2])) return `${segments[0]}/${segments[2]}`
  return null
}

function buildManifest(pins, options) {
  const chats = []
  const skipped = []
  for (const pin of Array.isArray(pins) ? pins : []) {
    if (!pin || pin.mcpProject === null || pin.mcpProject === undefined || String(pin.mcpProject).trim() === '') continue
    const chatId = deriveChatId(pin.serviceId, pin.url)
    const base = {
      pinId: pin.id,
      service: pin.serviceId,
      chatId,
      title: pin.title || '',
      url: pin.url
    }
    const { projects } = parseProjects(pin.mcpProject)
    if (!EXPORT_SERVICES.has(pin.serviceId)) {
      skipped.push({ ...base, code: 'unsupported_service' })
      continue
    }
    // Для MM и MAX адрес обязателен; у Яндекса чат ищется по title.
    if (pin.serviceId !== 'ydx' && chatId === null) {
      skipped.push({ ...base, code: 'bad_url' })
      continue
    }
    if (!projects.length) {
      skipped.push({ ...base, code: 'bad_project' })
      continue
    }
    chats.push({ ...base, projects })
  }
  return {
    exportedAt: formatExportedAt(options.now),
    depthDays: options.depthDays,
    exportDir: options.exportDir,
    chats,
    skipped
  }
}

function groupByProject(chats) {
  const groups = new Map()
  for (const chat of chats) {
    for (const project of chat.projects || []) {
      if (!groups.has(project)) groups.set(project, [])
      groups.get(project).push(chat)
    }
  }
  return groups
}

module.exports = { buildManifest, deriveChatId, groupByProject }

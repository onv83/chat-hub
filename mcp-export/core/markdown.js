'use strict'

const SERVICE_NAMES = { mm: 'Mattermost', max: 'MAX', ydx: 'Яндекс' }
const localDateTime = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Novosibirsk',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit',
  hourCycle: 'h23'
})

function dateParts(value) {
  const date = value instanceof Date ? value : new Date(value)
  const parts = {}
  for (const part of localDateTime.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value
  }
  return parts
}

function localDateStamp(date) {
  const parts = dateParts(date)
  return `${parts.day}${parts.month}${parts.year}`
}

function fileName(project, date) {
  return `${project}_${localDateStamp(date)}.md`
}

// Единая точка разбора: null/мусор — это отсутствие даты, а не 1970 год.
function toDate(value) {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value === 'number') return Number.isFinite(value) ? new Date(value) : null
  if (typeof value === 'string') {
    if (value.trim() === '') return null
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return new Date(numeric)
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function formatTimestamp(value) {
  const date = toDate(value)
  if (!date) return '—'
  const parts = dateParts(date)
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
}

// Дата без времени (dayOnly): день известен, час — нет. Печатаем только
// YYYY-MM-DD, чтобы не выдавать полночь за фактическое время сообщения.
function formatDateOnly(value) {
  const date = toDate(value)
  if (!date) return '—'
  const parts = dateParts(date)
  return `${parts.year}-${parts.month}-${parts.day}`
}

function yamlQuote(value) {
  const text = String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r\n|\n|\r/g, '\\n')
  return `"${text}"`
}

function escapeCell(value) {
  return String(value ?? '')
    .trim()
    .replace(/\|/g, '\\|')
    .replace(/\r\n|\n|\r/g, '<br>')
}

// Заголовок и URL должны остаться одной строкой
function singleLine(value) {
  return String(value ?? '')
    .replace(/\r\n|\n|\r/g, ' ')
    .trim()
}

// Исходы чатов файла: секции несут coverage, ошибочные чаты приходят отдельным
// списком chatResults (у них нет секции с сообщениями). Сервис — один раз.
function incompleteServices(sections, chatResults) {
  const services = []
  for (const chat of [...sections, ...(Array.isArray(chatResults) ? chatResults : [])]) {
    if (!chat || typeof chat !== 'object') continue
    const bad = chat.status === 'error' || chat.coverage === 'truncated'
    if (!bad) continue
    const service = typeof chat.service === 'string' && chat.service ? chat.service : 'unknown'
    if (!services.includes(service)) services.push(service)
  }
  return services
}

function renderProjectFile({ project, exportedAt, depthDays, chatSections, chatResults }) {
  const sections = Array.isArray(chatSections) ? chatSections : []
  const lines = [
    '---',
    `project: ${yamlQuote(project)}`,
    `exported_at: ${yamlQuote(exportedAt)}`,
    `depth_days: ${depthDays}`
  ]
  // Неполный состав файла честно помечается в шапке: partial и список сервисов,
  // у которых чат усечён или завершился ошибкой. При полном успехе полей нет.
  const incomplete = incompleteServices(sections, chatResults)
  if (incomplete.length) {
    lines.push('partial: true')
    lines.push(`incomplete: [${incomplete.join(', ')}]`)
  }
  if (!sections.length) {
    lines.push('sources: []')
  } else {
    lines.push('sources:')
    for (const chat of sections) {
      lines.push(`  - service: ${chat.service}`)
      lines.push(`    title: ${yamlQuote(chat.title)}`)
      lines.push(`    url: ${yamlQuote(chat.url)}`)
    }
  }
  lines.push('---', '')

  for (const chat of sections) {
    const serviceName = SERVICE_NAMES[chat.service] || chat.service
    lines.push(`## ${serviceName} · ${singleLine(chat.title)}`)
    lines.push(`URL: ${singleLine(chat.url)}`)
    const messages = Array.isArray(chat.messages) ? chat.messages : []
    // Диапазон по фактическим значениям: если все датированные сообщения —
    // «только день», его границы тоже печатаются датой без времени.
    const dated = messages.filter(message => message && toDate(message.timestamp))
    const dayOnlyRange = dated.length > 0 && dated.every(message => message.dayOnly === true)
    const edgeText = value => dayOnlyRange ? formatDateOnly(value) : formatTimestamp(value)
    const fromText = edgeText(chat.from)
    const toText = edgeText(chat.to)
    // Обе границы неизвестны — одно тире, без ложного диапазона.
    lines.push(`Диапазон: ${fromText === '—' && toText === '—' ? '—' : `${fromText} — ${toText}`}`)
    lines.push('')
    lines.push('| Время | Автор | Текст и ссылки | Message ID |')
    lines.push('|---|---|---|---|')
    for (const message of messages) {
      const links = Array.isArray(message.links) ? message.links : []
      const textParts = [String(message.text ?? '').trim(), ...links.map(link => String(link))].filter(Boolean)
      const textWithLinks = textParts.join(' ')
      const stamp = message && message.dayOnly === true
        ? formatDateOnly(message.timestamp)
        : formatTimestamp(message && message.timestamp)
      lines.push(`| ${stamp} | ${escapeCell(message && message.author)} | ${escapeCell(textWithLinks)} | ${escapeCell(message && message.messageId)} |`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

module.exports = { fileName, localDateStamp, formatTimestamp, formatDateOnly, renderProjectFile }

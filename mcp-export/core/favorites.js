'use strict'

// Выгрузка локального списка «Избранного» в Markdown.
// Модуль ничего не читает: на вход приходит config.pinned, на выходе — строка.
// Никаких секретов: печатаются только разрешённые поля пина.

// Русские имена сервисов для колонки «Сервис»; неизвестный id печатается как есть.
const SERVICE_NAMES = { mm: 'Mattermost', max: 'MAX', tg: 'Telegram', ydx: 'Яндекс Телемост' }
const COLUMNS = ['№', 'Сервис', 'Название', 'URL', 'Комментарий', 'Проект', 'Закреплён']

// Локальная дата Новосибирска — та же зона, что у имён файлов MCP-экспорта.
const localDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Novosibirsk',
  year: 'numeric', month: '2-digit', day: '2-digit'
})

// null/мусор — отсутствие даты, а не 1970 год; без даты берём текущий момент.
function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? new Date() : value
  if (value === null || value === undefined || value === '') return new Date()
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? new Date() : date
}

function dateStamp(value) {
  const parts = {}
  for (const part of localDate.formatToParts(toDate(value))) {
    if (part.type !== 'literal') parts[part.type] = part.value
  }
  return `${parts.day}${parts.month}${parts.year}`
}

// Имя файла выгрузки: favorites_ДДММГГГГ.md (локальная дата Новосибирска).
function fileName(date) {
  return `favorites_${dateStamp(date)}.md`
}

// Как в markdown.js: значение YAML всегда в кавычках, служебные символы экранируются.
function yamlQuote(value) {
  const text = String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r\n|\n|\r/g, '\\n')
  return `"${text}"`
}

// Как в markdown.js: разделитель таблицы экранируется, перевод строки — <br>,
// иначе одна ячейка ломает всю строку Markdown.
function escapeCell(value) {
  return String(value ?? '')
    .trim()
    .replace(/\|/g, '\\|')
    .replace(/\r\n|\n|\r/g, '<br>')
}

function serviceName(serviceId) {
  const id = typeof serviceId === 'string' ? serviceId.trim() : ''
  if (!id) return ''
  return SERVICE_NAMES[id] || id
}

// Счётчики по сервисам: порядок — первое появление в списке, ключ — id сервиса.
function serviceCounts(pins) {
  const counts = new Map()
  for (const pin of pins) {
    const id = pin && typeof pin.serviceId === 'string' ? pin.serviceId.trim() : ''
    if (!id) continue
    counts.set(id, (counts.get(id) || 0) + 1)
  }
  return counts
}

function renderFavoritesMarkdown(pins, options = {}) {
  const list = Array.isArray(pins) ? pins : []
  const exportedAt = options && options.exportedAt !== undefined
    ? options.exportedAt
    : new Date().toISOString()
  const counts = serviceCounts(list)

  const lines = [
    '---',
    `exported_at: ${yamlQuote(exportedAt)}`,
    `count: ${list.length}`
  ]
  if (!counts.size) {
    lines.push('services: {}')
  } else {
    lines.push('services:')
    for (const [id, count] of counts) lines.push(`  ${yamlQuote(id)}: ${count}`)
  }
  lines.push('---', '', '# Избранное', '')
  lines.push('| ' + COLUMNS.join(' | ') + ' |')
  lines.push('|' + COLUMNS.map(() => '---').join('|') + '|')

  list.forEach((pin, index) => {
    const item = pin && typeof pin === 'object' ? pin : {}
    // «Закреплён» — только явный true: отсутствие и false дают пустую ячейку.
    const pinned = item.priority === true ? 'да' : ''
    const cells = [
      String(index + 1),
      escapeCell(serviceName(item.serviceId)),
      escapeCell(item.title),
      escapeCell(item.url),
      escapeCell(item.annotation),
      escapeCell(item.mcpProject),
      pinned
    ]
    lines.push('| ' + cells.join(' | ') + ' |')
  })
  return lines.join('\n')
}

module.exports = { renderFavoritesMarkdown, fileName, escapeCell, serviceName, COLUMNS, SERVICE_NAMES }

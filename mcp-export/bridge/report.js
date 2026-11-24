'use strict'

// DOM-диагностика чтения MAX: берём только известные поля и короткие списки,
// чтобы отчёт не разрастался от посторонних данных.
function normalizeDiag(value) {
  if (!value || typeof value !== 'object') return null
  const count = item => Number.isFinite(item) ? item : 0
  const list = (items, limit) => (Array.isArray(items) ? items : [])
    .filter(item => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean)
    .slice(0, limit)
  const diag = {
    roots: count(value.roots),
    capsuleCount: count(value.capsuleCount),
    capsuleSamples: list(value.capsuleSamples, 5),
    wrapperCount: count(value.wrapperCount),
    metaCount: count(value.metaCount),
    metaSamples: list(value.metaSamples, 3),
    historyClasses: list(value.historyClasses, 20)
  }
  // Второй замер: поля добавляются только если их прислал renderer, — старый
  // отчёт не обрастает пустыми ключами. Списки ограничены, как в renderer.
  if (value.docCapsules && typeof value.docCapsules === 'object') {
    diag.docCapsules = { total: count(value.docCapsules.total), texts: list(value.docCapsules.texts, 5) }
  }
  const nodes = (items, limit) => (Array.isArray(items) ? items : [])
    .filter(item => item && typeof item === 'object')
    .map(item => ({
      tag: String(item.tag == null ? '' : item.tag).trim(),
      cls: String(item.cls == null ? '' : item.cls).trim(),
      text: String(item.text == null ? '' : item.text).trim()
    }))
    .slice(0, limit)
  if (Array.isArray(value.dateLikeNodes)) diag.dateLikeNodes = nodes(value.dateLikeNodes, 8)
  if (Array.isArray(value.firstChildren)) diag.firstChildren = nodes(value.firstChildren, 25)
  if (Array.isArray(value.metaWithDate)) diag.metaWithDate = list(value.metaWithDate, 5)
  return diag
}

// Строки сборщика MAX (сессия, рабочий webview, «собрано …», трасса скроллера)
// идут отдельным полем отчёта: ошибка чата не должна их вытеснять.
function normalizeNotes(value) {
  const lines = []
  for (const item of Array.isArray(value) ? value : []) {
    if (typeof item !== 'string') continue
    const line = item.trim()
    if (line) lines.push(line)
  }
  return lines.slice(0, 100)
}

function buildReport({ exportedAt, files, chats, errors, notes } = {}) {
  const fileList = (Array.isArray(files) ? files : []).map(file => ({
    project: String(file && file.project !== undefined ? file.project : ''),
    path: String(file && file.path !== undefined ? file.path : ''),
    count: Number.isFinite(file && file.count) ? file.count : 0
  }))

  const chatList = (Array.isArray(chats) ? chats : []).map(chat => {
    const entry = {
      pinId: chat && chat.pinId !== undefined ? chat.pinId : null,
      service: chat && chat.service !== undefined ? chat.service : null,
      status: chat && chat.status ? chat.status : 'skipped',
      code: chat && chat.code ? chat.code : null,
      coverage: chat && chat.coverage ? chat.coverage : null,
      count: Number.isFinite(chat && chat.count) ? chat.count : 0,
      undated: Number.isFinite(chat && chat.undated) ? chat.undated : 0
    }
    // Диагностика переключения MAX (expected/actual) — часть отчёта чата:
    // по ней разбирают SWITCH_TIMEOUT, не открывая окно заново.
    if (chat && chat.detail && typeof chat.detail === 'object') {
      entry.detail = {
        expected: String(chat.detail.expected == null ? '' : chat.detail.expected),
        actual: String(chat.detail.actual == null ? '' : chat.detail.actual)
      }
    }
    // DOM-диагностика чтения MAX (капсулы дат и мета) — только у первого чата.
    const diag = normalizeDiag(chat && chat.diag)
    if (diag) entry.diag = diag
    // Причина усечения (например, «страница 6: TOOL_ERROR») — часть отчёта чата:
    // по ней видно, почему файл помечен partial, не открывая MD.
    if (chat && typeof chat.reason === 'string' && chat.reason.trim() !== '') {
      entry.reason = chat.reason.trim()
    }
    return entry
  })

  const errorList = (Array.isArray(errors) ? errors : []).map(error => ({
    code: String(error && error.code ? error.code : 'UNKNOWN'),
    message: String(error && error.message ? error.message : '')
  }))

  return {
    ok: errorList.length === 0 && fileList.length > 0,
    exportedAt: typeof exportedAt === 'string' ? exportedAt : null,
    files: fileList,
    chats: chatList,
    // Строки сборщика — отдельно от ошибок и чатов: частичный успех их не теряет.
    notes: normalizeNotes(notes),
    truncated: chatList.some(chat => chat.coverage === 'truncated' || chat.coverage === 'window'),
    errors: errorList
  }
}

function writeStdout(report, stream = process.stdout) {
  stream.write(JSON.stringify(report) + '\n')
}

module.exports = { buildReport, writeStdout }

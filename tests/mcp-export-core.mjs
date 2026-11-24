import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scratch = path.join(process.env.LOCALAPPDATA || path.dirname(root), 'hermes/cache/scratch')
fs.mkdirSync(scratch, { recursive: true })

function core(name) {
  return require(path.join(root, 'mcp-export', 'core', name + '.js'))
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(scratch, 'mcp-export-core-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function section(overrides = {}) {
  return {
    service: 'mm',
    title: 'Общий',
    url: 'https://mm.example.test/team/channels/general',
    from: '2026-11-16T04:45:00Z',
    to: '2026-11-23T04:45:00Z',
    messages: [],
    ...overrides
  }
}

test('Пустое и отсутствующее mcpProject даёт пустые списки', () => {
  const { parseProjects } = core('projects')
  for (const raw of ['', ' , , ', null, undefined]) {
    assert.deepEqual(parseProjects(raw), { projects: [], rejected: [] })
  }
})

test('Проекты нормализуются с сохранением порядка и без дубликатов', () => {
  const { parseProjects } = core('projects')
  assert.deepEqual(parseProjects(' 14544,   15955 ,14544,  16000   '), {
    projects: ['14544', '15955', '16000'],
    rejected: []
  })
  assert.deepEqual(parseProjects('14544, 15955').projects, ['14544', '15955'])
})

test('Нечисловые и слишком длинные проекты попадают в rejected', () => {
  const { parseProjects } = core('projects')
  assert.deepEqual(parseProjects(' НЭСК   Портал,14544,12345678901,НЭСК Портал,14 544, 0'), {
    projects: ['14544', '0'],
    rejected: ['НЭСК Портал', '12345678901', '14 544']
  })
  assert.deepEqual(parseProjects('1234567890').projects, ['1234567890'])
})

test('Числовое mcpProject преобразуется в строку', () => {
  const { parseProjects } = core('projects')
  assert.deepEqual(parseProjects(14544), { projects: ['14544'], rejected: [] })
})

test('Идентификатор MAX берётся из последнего непустого сегмента URL', () => {
  const { deriveChatId } = core('plan')
  assert.equal(deriveChatId('max', 'https://web.max.ru/123456'), '123456')
  assert.equal(deriveChatId('max', 'https://web.max.ru/chats/123456/?from=pin'), '123456')
})

test('Идентификаторы Mattermost сохраняют команду, канал и собеседника', () => {
  const { deriveChatId } = core('plan')
  assert.equal(deriveChatId('mm', 'https://mm.example.test/astra/channels/town-square'), 'astra/town-square')
  assert.equal(deriveChatId('mm', 'https://mm.example.test/astra/messages/@ivan'), 'astra/@ivan')
})

test('Неподдерживаемый URL или сервис не даёт идентификатора чата', () => {
  const { deriveChatId } = core('plan')
  assert.equal(deriveChatId('max', 'https://web.max.ru/'), null)
  assert.equal(deriveChatId('mm', 'https://mm.example.test/astra/channels/general/extra'), null)
  assert.equal(deriveChatId('mm', 'не URL'), null)
  assert.equal(deriveChatId('tg', 'https://web.telegram.org/#123'), null)
})

test('Манифест содержит только привязанные чаты и пропускает невалидный проект', () => {
  const { buildManifest } = core('plan')
  const pins = [
    { id: 'p1', serviceId: 'mm', title: 'Общий', url: 'https://mm.example.test/team/channels/general', mcpProject: '14544, 15955' },
    { id: 'empty', serviceId: 'max', url: 'https://web.max.ru/2', mcpProject: '  ' },
    { id: 'absent', serviceId: 'max', url: 'https://web.max.ru/3' },
    { id: 'bad', serviceId: 'max', title: 'Личный', url: 'https://web.max.ru/4', mcpProject: 'НЭСК' }
  ]
  const result = buildManifest(pins, {
    exportDir: 'C:/exports',
    depthDays: 7,
    now: new Date('2026-11-23T04:45:36Z')
  })
  assert.equal(result.exportedAt, '2026-11-23T11:45:36+07:00')
  assert.equal(result.depthDays, 7)
  assert.equal(result.exportDir, 'C:/exports')
  assert.deepEqual(result.chats, [{
    pinId: 'p1',
    service: 'mm',
    chatId: 'team/general',
    title: 'Общий',
    url: 'https://mm.example.test/team/channels/general',
    projects: ['14544', '15955']
  }])
  assert.equal(result.skipped.length, 1)
  assert.equal(result.skipped[0].pinId, 'bad')
  assert.equal(result.skipped[0].code, 'bad_project')
})

test('Группировка по проектам сохраняет порядок первого появления', () => {
  const { groupByProject } = core('plan')
  const chats = [
    { chatId: 'a', projects: ['15955', '14544'] },
    { chatId: 'b', projects: ['14544'] },
    { chatId: 'c', projects: ['100', '15955'] }
  ]
  const groups = groupByProject(chats)
  assert.deepEqual([...groups.keys()], ['15955', '14544', '100'])
  assert.deepEqual(groups.get('14544').map(chat => chat.chatId), ['a', 'b'])
  assert.deepEqual(groups.get('15955').map(chat => chat.chatId), ['a', 'c'])
})

test('Отрендеренное окно MAX всегда имеет покрытие window', () => {
  const { classifyCoverage } = core('coverage')
  assert.equal(classifyCoverage({ kind: 'window', limit: 0, count: 0, oldestTs: 0, windowStartMs: 1 }), 'window')
  assert.equal(classifyCoverage({ kind: 'window', limit: 100, count: 100, oldestTs: 200, windowStartMs: 100 }), 'window')
})

test('Незаполненная страница Mattermost означает полное покрытие', () => {
  const { classifyCoverage } = core('coverage')
  assert.equal(classifyCoverage({ kind: 'paged', limit: 100, count: 99, oldestTs: 50, windowStartMs: 100 }), 'full')
  assert.equal(classifyCoverage({ kind: 'paged', limit: 100, count: 100, oldestTs: 100, windowStartMs: 100 }), 'full')
})

test('Заполненная страница с сообщениями новее окна обрезана', () => {
  const { classifyCoverage } = core('coverage')
  assert.equal(classifyCoverage({ kind: 'paged', limit: 100, count: 101, oldestTs: 101, windowStartMs: 100 }), 'truncated')
  assert.equal(classifyCoverage({ kind: 'paged', limit: 100, count: 100, oldestTs: 99, windowStartMs: 100 }), 'full')
})

test('Границы глубины 1, 3, 7 и 30 дней участвуют в классификации окна', () => {
  const { classifyCoverage } = core('coverage')
  const now = Date.parse('2026-11-23T04:45:00Z')
  for (const depthDays of [1, 3, 7, 30]) {
    const windowStartMs = now - depthDays * 24 * 60 * 60 * 1000
    const base = { kind: 'paged', limit: 100, count: 100, windowStartMs }
    assert.equal(classifyCoverage({ ...base, oldestTs: windowStartMs }), 'full')
    assert.equal(classifyCoverage({ ...base, oldestTs: windowStartMs - 1 }), 'full')
    assert.equal(classifyCoverage({ ...base, oldestTs: windowStartMs + 1 }), 'truncated')
  }
})

test('Дедупликация использует service, chatId и messageId и хранит первое вхождение', () => {
  const { dedupeMessages } = core('dedupe')
  const messages = [
    { service: 'mm', chatId: 'team/general', messageId: '1', timestamp: 300, text: 'первый' },
    { service: 'mm', chatId: 'team/general', messageId: '1', timestamp: 100, text: 'дубликат' },
    { service: 'max', chatId: 'team/general', messageId: '1', timestamp: 200, text: 'другой сервис' },
    { service: 'mm', chatId: 'team/other', messageId: '1', timestamp: 100, text: 'другой чат' },
    { service: 'mm', chatId: 'team/general', messageId: '2', timestamp: 250, text: 'другое сообщение' }
  ]
  const result = dedupeMessages(messages)
  assert.equal(result.length, 4)
  assert.equal(result.find(message => message.service === 'mm' && message.chatId === 'team/general' && message.messageId === '1').text, 'первый')
  assert.ok(result.some(message => message.text === 'другой сервис'))
  assert.ok(result.some(message => message.text === 'другой чат'))
})

test('После дедупликации сообщения сортируются по времени стабильно', () => {
  const { dedupeMessages } = core('dedupe')
  const messages = [
    { service: 'mm', chatId: 'c', messageId: '3', timestamp: 300 },
    { service: 'mm', chatId: 'c', messageId: '1', timestamp: 100 },
    { service: 'mm', chatId: 'c', messageId: '2a', timestamp: 200 },
    { service: 'mm', chatId: 'c', messageId: '2b', timestamp: 200 }
  ]
  assert.deepEqual(dedupeMessages(messages).map(message => message.messageId), ['1', '2a', '2b', '3'])
})

test('Имя файла использует дату Новосибирска, включая 31 декабря и полночь', () => {
  const { fileName, localDateStamp } = core('markdown')
  assert.equal(localDateStamp(new Date('2026-12-31T10:15:00Z')), '31122026')
  assert.equal(fileName('14544', new Date('2026-12-31T16:59:59.999Z')), '14544_31122026.md')
  assert.equal(fileName('14544', new Date('2026-12-31T17:00:00Z')), '14544_01012027.md')
})

test('Метка времени принимает миллисекунды и ISO и выводит Новосибирск', () => {
  const { formatTimestamp } = core('markdown')
  const iso = '2026-11-23T04:05:09Z'
  assert.equal(formatTimestamp(iso), '2026-11-23 11:05')
  assert.equal(formatTimestamp(Date.parse(iso)), '2026-11-23 11:05')
})

test('Диапазоны глубины 1, 3, 7 и 30 дней форматируются на границе включительно', () => {
  const { formatTimestamp, renderProjectFile } = core('markdown')
  const now = Date.parse('2026-11-23T04:45:00Z')
  const expected = new Map([[1, '2026-11-22 11:45'], [3, '2026-11-20 11:45'], [7, '2026-11-16 11:45'], [30, '2026-10-24 11:45']])
  for (const [depthDays, fromText] of expected) {
    const from = now - depthDays * 24 * 60 * 60 * 1000
    assert.equal(formatTimestamp(from), fromText)
    const output = renderProjectFile({
      project: '14544', exportedAt: '2026-11-23T11:45:00+07:00', depthDays,
      chatSections: [section({ from, to: now })]
    })
    assert.ok(output.includes(`Диапазон: ${fromText} — 2026-11-23 11:45`))
  }
})

test('YAML-шапка содержит проект, время со смещением, глубину и источники', () => {
  const { renderProjectFile } = core('markdown')
  const output = renderProjectFile({
    project: '14544',
    exportedAt: '2026-11-23T11:45:00+07:00',
    depthDays: 7,
    chatSections: [section()]
  })
  const header = `---\nproject: "14544"\nexported_at: "2026-11-23T11:45:00+07:00"\ndepth_days: 7\nsources:\n  - service: mm\n    title: "Общий"\n    url: "https://mm.example.test/team/channels/general"\n---\n`
  assert.ok(output.startsWith(header))
  // Полный успех: служебных полей частичности нет.
  assert.equal(output.includes('partial:'), false)
  assert.equal(output.includes('incomplete:'), false)
})

test('Шапка помечает partial и incomplete, если чат в файле усечён', () => {
  const { renderProjectFile } = core('markdown')
  const output = renderProjectFile({
    project: '14544', exportedAt: '2026-11-23T11:45:00+07:00', depthDays: 7,
    chatSections: [
      section(),
      section({ service: 'ydx', title: 'Портал-Юг', url: 'https://telemost.yandex.ru/chats/abc', coverage: 'truncated' })
    ]
  })
  assert.ok(output.startsWith('---\nproject: "14544"\nexported_at: "2026-11-23T11:45:00+07:00"\ndepth_days: 7\npartial: true\nincomplete: [ydx]\nsources:\n'))
})

test('Шапка помечает partial и incomplete, если чат файла завершился ошибкой', () => {
  const { renderProjectFile } = core('markdown')
  const output = renderProjectFile({
    project: '14544', exportedAt: '2026-11-23T11:45:00+07:00', depthDays: 7,
    chatSections: [section()],
    chatResults: [
      { service: 'mm', status: 'ok', coverage: 'full' },
      { service: 'max', status: 'error', coverage: null }
    ]
  })
  assert.ok(output.includes('partial: true'))
  assert.ok(output.includes('incomplete: [max]'))
})

test('Шапка без partial, если все чаты файла полные', () => {
  const { renderProjectFile } = core('markdown')
  const output = renderProjectFile({
    project: '14544', exportedAt: '2026-11-23T11:45:00+07:00', depthDays: 7,
    chatSections: [section({ coverage: 'full' }), section({ service: 'ydx', title: 'Команда', url: 'https://telemost.yandex.ru/chats/abc', coverage: 'full' })],
    chatResults: [
      { service: 'mm', status: 'ok', coverage: 'full' },
      { service: 'ydx', status: 'ok', coverage: 'full' }
    ]
  })
  assert.equal(output.includes('partial:'), false)
  assert.equal(output.includes('incomplete:'), false)
})

test('Заголовки секций показывают русские имена сервисов, URL и диапазон', () => {
  const { renderProjectFile } = core('markdown')
  const output = renderProjectFile({
    project: '14544', exportedAt: '2026-11-23T11:45:00+07:00', depthDays: 7,
    chatSections: [
      section(),
      section({ service: 'max', title: 'Рабочий чат', url: 'https://web.max.ru/123' }),
      section({ service: 'ydx', title: 'Команда', url: 'https://telemost.yandex.ru/chats/abc' })
    ]
  })
  assert.ok(output.includes('## Mattermost · Общий'))
  assert.ok(output.includes('## MAX · Рабочий чат'))
  assert.ok(output.includes('## Яндекс · Команда'))
  assert.ok(output.includes('URL: https://web.max.ru/123'))
  assert.ok(output.includes('Диапазон: 2026-11-16 11:45 — 2026-11-23 11:45'))
})

test('Таблица экранирует разделители и переносы, добавляет URL без markdown-ссылок', () => {
  const { renderProjectFile } = core('markdown')
  const output = renderProjectFile({
    project: '14544', exportedAt: '2026-11-23T11:45:00+07:00', depthDays: 7,
    chatSections: [section({ messages: [{
      service: 'mm', chatId: 'team/general', messageId: 'm|1', author: ' Иван | Петров ',
      timestamp: Date.parse('2026-11-23T04:05:09Z'),
      text: '  Первая строка | значение\r\nВторая строка\nТретья\rЧетвёртая  ',
      links: ['https://example.test/a?x=1&y=2', 'https://example.test/b'],
      attachment: 'secret-file', reaction: 'fire', sticker: 'secret-sticker', avatar: 'secret-avatar', html: '<b>secret</b>'
    }] })]
  })
  const row = '| 2026-11-23 11:05 | Иван \\| Петров | Первая строка \\| значение<br>Вторая строка<br>Третья<br>Четвёртая https://example.test/a?x=1&y=2 https://example.test/b | m\\|1 |'
  assert.ok(output.includes(row))
  assert.ok(!output.includes('[https://'))
  assert.ok(!/attachment|reaction|sticker|avatar/i.test(output))
  assert.ok(!output.includes('<b>secret</b>'))
})

test('Пустая секция не создаёт строку сообщения в таблице', () => {
  const { renderProjectFile } = core('markdown')
  const output = renderProjectFile({
    project: '14544', exportedAt: '2026-11-23T11:45:00+07:00', depthDays: 7,
    chatSections: [section({ messages: [] })]
  })
  const tableLines = output.split('\n').filter(line => line.startsWith('|'))
  assert.deepEqual(tableLines, [
    '| Время | Автор | Текст и ссылки | Message ID |',
    '|---|---|---|---|'
  ])
})

test('dayOnly печатает только дату, обычное сообщение — дату и время', () => {
  const { renderProjectFile } = core('markdown')
  const output = renderProjectFile({
    project: '14544', exportedAt: '2026-11-23T11:45:00+07:00', depthDays: 7,
    chatSections: [section({
      service: 'max',
      from: '2026-11-19T00:00:00+07:00',
      to: '2026-11-23T04:05:09Z',
      messages: [
        {
          service: 'max', chatId: '777', messageId: 'max:/777:0', author: 'Иван',
          timestamp: '2026-11-19T00:00:00+07:00', dayOnly: true, text: 'день', links: []
        },
        {
          service: 'max', chatId: '777', messageId: 'max:/777:1', author: 'Пётр',
          timestamp: '2026-11-23T04:05:09Z', dayOnly: false, text: 'минута', links: []
        }
      ]
    })]
  })
  assert.ok(output.includes('| 2026-11-19 | Иван | день | max:/777:0 |'))
  assert.ok(output.includes('| 2026-11-23 11:05 | Пётр | минута | max:/777:1 |'))
  // Смешанная секция: диапазон остаётся со временем, как раньше.
  assert.ok(output.includes('Диапазон: 2026-11-19 00:00 — 2026-11-23 11:05'))
})

test('Диапазон из dayOnly-сообщений печатается только датами', () => {
  const { renderProjectFile } = core('markdown')
  const output = renderProjectFile({
    project: '14544', exportedAt: '2026-11-23T11:45:00+07:00', depthDays: 7,
    chatSections: [section({
      service: 'max',
      from: '2026-11-16T00:00:00+07:00',
      to: '2026-11-23T00:00:00+07:00',
      messages: [
        { service: 'max', chatId: '777', messageId: 'max:/777:0', author: 'Иван', timestamp: '2026-11-16T00:00:00+07:00', dayOnly: true, text: 'старое', links: [] },
        { service: 'max', chatId: '777', messageId: 'max:/777:1', author: 'Пётр', timestamp: '2026-11-23T00:00:00+07:00', dayOnly: true, text: 'новое', links: [] }
      ]
    })]
  })
  assert.ok(output.includes('Диапазон: 2026-11-16 — 2026-11-23'))
  assert.ok(!output.includes('Диапазон: 2026-11-16 00:00'), 'у dayOnly-секции времени в диапазоне нет')
})

test('Дата без времени форматируется как YYYY-MM-DD', () => {
  const { formatDateOnly } = core('markdown')
  assert.equal(formatDateOnly('2026-11-23T04:05:09Z'), '2026-11-23')
  assert.equal(formatDateOnly('2026-05-31T00:00:00+07:00'), '2026-05-31')
  assert.equal(formatDateOnly(null), '—')
})

test('Чат в двух проектах рендерится в два файла с одинаковыми сообщениями', () => {
  const { groupByProject } = core('plan')
  const { renderProjectFile } = core('markdown')
  const chat = { service: 'mm', chatId: 'team/general', title: 'Общий', url: 'https://mm.example.test/team/channels/general', projects: ['14544', '15955'] }
  const message = { service: 'mm', chatId: 'team/general', messageId: 'm1', author: 'Иван', timestamp: Date.parse('2026-11-23T04:05:09Z'), text: 'Одно сообщение', links: [] }
  const outputs = []
  for (const [project, chats] of groupByProject([chat])) {
    outputs.push(renderProjectFile({
      project, exportedAt: '2026-11-23T11:45:00+07:00', depthDays: 7,
      chatSections: chats.map(item => ({ ...item, from: 0, to: message.timestamp, messages: [message] }))
    }))
  }
  assert.equal(outputs.length, 2)
  assert.ok(outputs[0].includes('project: "14544"'))
  assert.ok(outputs[1].includes('project: "15955"'))
  const rows = outputs.map(output => output.split('\n').find(line => line.includes('Одно сообщение')))
  assert.ok(rows[0])
  assert.equal(rows[0], rows[1])
})

test('Атомарная запись заменяет только сегодняшний файл и не оставляет tmp', t => {
  const { writeFileAtomic } = core('write')
  const dir = tempDir(t)
  const today = path.join(dir, '14544_23112026.md')
  const other = path.join(dir, '14544_22112026.md')
  fs.writeFileSync(today, 'старое', 'utf8')
  fs.writeFileSync(other, 'вчерашнее', 'utf8')
  const result = writeFileAtomic(dir, '14544_23112026.md', 'новое')
  assert.equal(result, path.resolve(today))
  assert.equal(fs.readFileSync(today, 'utf8'), 'новое')
  assert.equal(fs.readFileSync(other, 'utf8'), 'вчерашнее')
  assert.equal(fs.readdirSync(dir).some(name => name.includes('.tmp-')), false)
})

test('Перезапись сохраняет предыдущую версию как .prev.md, одно поколение', t => {
  const { writeFileAtomic } = core('write')
  const dir = tempDir(t)
  const name = '14544_23112026.md'
  const prev = path.join(dir, '14544_23112026.prev.md')
  // Первая запись: перезаписывать нечего, .prev не создаётся.
  writeFileAtomic(dir, name, 'версия 1')
  assert.equal(fs.existsSync(prev), false)
  // Вторая запись: новая версия на месте, .prev хранит первую.
  writeFileAtomic(dir, name, 'версия 2')
  assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), 'версия 2')
  assert.equal(fs.readFileSync(prev, 'utf8'), 'версия 1')
  // Третья: .prev перезаписывается, а не копится поколениями.
  writeFileAtomic(dir, name, 'версия 3')
  assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), 'версия 3')
  assert.equal(fs.readFileSync(prev, 'utf8'), 'версия 2')
  assert.deepEqual(fs.readdirSync(dir).sort(), ['14544_23112026.md', '14544_23112026.prev.md'])
  assert.equal(fs.readdirSync(dir).some(entry => entry.includes('.tmp-')), false, 'временных файлов нет')
})

test('Запись в отсутствующий каталог сообщает EXPORT_DIR_MISSING', t => {
  const { writeFileAtomic } = core('write')
  const dir = path.join(tempDir(t), 'missing')
  assert.throws(() => writeFileAtomic(dir, '14544_23112026.md', 'текст'), /EXPORT_DIR_MISSING/)
})

test('Запись с файлом вместо каталога сообщает EXPORT_DIR_NOT_DIR', t => {
  const { writeFileAtomic } = core('write')
  const dir = tempDir(t)
  const file = path.join(dir, 'not-a-directory')
  fs.writeFileSync(file, 'x')
  assert.throws(() => writeFileAtomic(file, '14544_23112026.md', 'текст'), /EXPORT_DIR_NOT_DIR/)
})

test('Небезопасные имена файлов отклоняются с EXPORT_NAME_INVALID', t => {
  const { writeFileAtomic } = core('write')
  const dir = tempDir(t)
  for (const name of ['', '../x.md', 'folder/x.md', 'folder\\x.md', 'bad..md', path.resolve(dir, 'x.md')]) {
    assert.throws(() => writeFileAtomic(dir, name, 'текст'), /EXPORT_NAME_INVALID/, JSON.stringify(name))
  }
  assert.deepEqual(fs.readdirSync(dir), [])
})

function manifestOf(pins) {
  const { buildManifest } = core('plan')
  return buildManifest(pins, {
    exportDir: 'C:/exports',
    depthDays: 7,
    now: new Date('2026-11-23T04:45:36Z')
  })
}

test('R1: пин Telegram с проектом отклоняется как неподдерживаемый сервис', () => {
  const result = manifestOf([
    { id: 'tg1', serviceId: 'tg', title: 'Канал', url: 'https://web.telegram.org/#123', mcpProject: '14544' }
  ])
  assert.deepEqual(result.chats, [])
  assert.deepEqual(result.skipped, [{
    pinId: 'tg1',
    service: 'tg',
    chatId: null,
    title: 'Канал',
    url: 'https://web.telegram.org/#123',
    code: 'unsupported_service'
  }])
})

test('R1: Mattermost без структуры канала попадает в bad_url', () => {
  const result = manifestOf([
    { id: 'mm1', serviceId: 'mm', title: 'Пустой', url: 'https://im.example.com/', mcpProject: '14544' }
  ])
  assert.deepEqual(result.chats, [])
  assert.equal(result.skipped.length, 1)
  assert.equal(result.skipped[0].code, 'bad_url')
  assert.equal(result.skipped[0].chatId, null)
})

test('R1: MAX с нечисловым последним сегментом попадает в bad_url', () => {
  const result = manifestOf([
    { id: 'max1', serviceId: 'max', title: 'Канал', url: 'https://web.max.ru/chats/abc', mcpProject: '14544' }
  ])
  assert.deepEqual(result.chats, [])
  assert.equal(result.skipped.length, 1)
  assert.equal(result.skipped[0].code, 'bad_url')
  assert.equal(result.skipped[0].chatId, null)
})

test('R1: MAX с отрицательным числовым id принимается', () => {
  const result = manifestOf([
    { id: 'max-neg', serviceId: 'max', title: 'Группа', url: 'https://web.max.ru/-1001234567890', mcpProject: '15955' }
  ])
  assert.deepEqual(result.skipped, [])
  assert.deepEqual(result.chats, [{
    pinId: 'max-neg',
    service: 'max',
    chatId: '-1001234567890',
    title: 'Группа',
    url: 'https://web.max.ru/-1001234567890',
    projects: ['15955']
  }])
})

test('R1: пустой mcpProject не попадает ни в чаты, ни в пропуски', () => {
  const result = manifestOf([
    { id: 'blank', serviceId: 'mm', title: 'Общий', url: 'https://mm.example.test/team/channels/general', mcpProject: '   ' },
    { id: 'null', serviceId: 'max', title: 'Личный', url: 'https://web.max.ru/42', mcpProject: null }
  ])
  assert.deepEqual(result.chats, [])
  assert.deepEqual(result.skipped, [])
})

test('YANDEX-ADAPTER: пин Яндекса с проектом попадает в manifest без chatId из URL', () => {
  const result = manifestOf([
    {
      id: 'y1',
      serviceId: 'ydx',
      title: 'Портал-Юг',
      url: 'https://telemost.yandex.ru/chats/0%2F11%2Faaaaaaaa-1111-4111-8111-111111111111',
      mcpProject: '14544'
    }
  ])
  assert.deepEqual(result.skipped, [])
  assert.deepEqual(result.chats, [{
    pinId: 'y1',
    service: 'ydx',
    chatId: null,
    title: 'Портал-Юг',
    url: 'https://telemost.yandex.ru/chats/0%2F11%2Faaaaaaaa-1111-4111-8111-111111111111',
    projects: ['14544']
  }])
})

test('R2: заполненная страница без oldestTs считается обрезанной', () => {
  const { classifyCoverage } = core('coverage')
  assert.equal(classifyCoverage({ kind: 'paged', limit: 100, count: 100, windowStartMs: 100 }), 'truncated')
  assert.equal(classifyCoverage({ kind: 'paged', limit: 100, count: 150, windowStartMs: 100 }), 'truncated')
})

test('R2: NaN в oldestTs или windowStartMs считается отсутствием данных', () => {
  const { classifyCoverage } = core('coverage')
  assert.equal(classifyCoverage({ kind: 'paged', limit: 100, count: 100, oldestTs: NaN, windowStartMs: 100 }), 'truncated')
  assert.equal(classifyCoverage({ kind: 'paged', limit: 100, count: 100, oldestTs: 100, windowStartMs: NaN }), 'truncated')
  assert.equal(classifyCoverage({ kind: 'paged', limit: 100, count: 100, oldestTs: '100', windowStartMs: 100 }), 'truncated')
})

test('R2: неполная страница без oldestTs остаётся полной', () => {
  const { classifyCoverage } = core('coverage')
  assert.equal(classifyCoverage({ kind: 'paged', limit: 100, count: 99, windowStartMs: 100 }), 'full')
  assert.equal(classifyCoverage({ kind: 'paged', limit: 100, count: 0, oldestTs: NaN, windowStartMs: NaN }), 'full')
})

test('R3: перевод строки в заголовке и URL не ломает структуру MD', () => {
  const { renderProjectFile } = core('markdown')
  const output = renderProjectFile({
    project: '14544', exportedAt: '2026-11-23T11:45:00+07:00', depthDays: 7,
    chatSections: [section({
      title: 'Общий\n## Fake',
      url: 'https://mm.example.test/team/channels/general\nвторая строка'
    })]
  })
  const headingLines = output.split('\n').filter(line => line.startsWith('## '))
  assert.deepEqual(headingLines, ['## Mattermost · Общий ## Fake'])
  const urlLines = output.split('\n').filter(line => line.startsWith('URL: '))
  assert.deepEqual(urlLines, ['URL: https://mm.example.test/team/channels/general вторая строка'])
})

test('R4: пустой список источников записывается как sources: []', () => {
  const { renderProjectFile } = core('markdown')
  const output = renderProjectFile({
    project: '14544', exportedAt: '2026-11-23T11:45:00+07:00', depthDays: 7, chatSections: []
  })
  assert.ok(output.startsWith('---\nproject: "14544"\nexported_at: "2026-11-23T11:45:00+07:00"\ndepth_days: 7\nsources: []\n---\n'))
})

test('R2/D1: отсутствующее или неразбираемое время форматируется как тире', () => {
  const { formatTimestamp } = core('markdown')
  assert.equal(formatTimestamp(null), '—')
  assert.equal(formatTimestamp(undefined), '—')
  assert.equal(formatTimestamp('не дата'), '—')
  assert.equal(formatTimestamp(''), '—')
})

test('R2/D1: секция без дат печатает Диапазон: — и тире вместо 1970', () => {
  const { renderProjectFile } = core('markdown')
  const output = renderProjectFile({
    project: '14544', exportedAt: '2026-11-23T11:45:00+07:00', depthDays: 7,
    chatSections: [section({
      from: null,
      to: null,
      messages: [{
        service: 'mm', chatId: 'team/general', messageId: 'm1', author: 'Иван',
        timestamp: null, text: 'Без времени', links: []
      }]
    })]
  })
  assert.ok(output.includes('Диапазон: —'))
  assert.equal(output.includes('1970'), false)
  const row = output.split('\n').find(line => line.includes('Без времени'))
  assert.ok(row)
  assert.equal(row.startsWith('| — | Иван | Без времени | m1 |'), true)
})

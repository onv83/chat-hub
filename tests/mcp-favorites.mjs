// tests/mcp-favorites.mjs — ядро выгрузки «Избранного» в Markdown.
// Проверяется настоящий mcp-export/core/favorites.js: таблица, экранирование,
// пустые поля, счётчики сервисов, имя файла и пустой список. Мессенджеры,
// сеть и живой профиль не участвуют.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const favorites = require(path.join(root, 'mcp-export', 'core', 'favorites.js'))

const EXPORTED_AT = '2026-11-24T10:15:00.000Z'

function pin(overrides = {}) {
  return {
    id: 'p1',
    serviceId: 'mm',
    url: 'https://im.astralinux.ru/team/channels/general',
    title: 'Общий канал',
    annotation: 'Рабочий чат',
    mcpProject: '14544',
    priority: true,
    ...overrides
  }
}

function dataRows(markdown) {
  // Строки таблицы без заголовка и разделителя.
  return markdown.split('\n').filter(line => line.startsWith('| ') && !line.startsWith('| № '))
}

test('Пустой список: count 0, services {} и пустая таблица с заголовком', () => {
  for (const value of [[], null, undefined, 'garbage']) {
    const markdown = favorites.renderFavoritesMarkdown(value, { exportedAt: EXPORTED_AT })
    assert.match(markdown, /^---\n/)
    assert.match(markdown, /exported_at: "2026-11-24T10:15:00\.000Z"/)
    assert.match(markdown, /^count: 0$/m)
    assert.match(markdown, /^services: \{\}$/m)
    assert.match(markdown, /\| № \| Сервис \| Название \| URL \| Комментарий \| Проект \| Закреплён \|/)
    assert.equal(dataRows(markdown).length, 0)
  }
})

test('Таблица: нумерация, русские имена сервисов и поля пина по колонкам', () => {
  const markdown = favorites.renderFavoritesMarkdown([
    pin(),
    pin({ id: 'p2', serviceId: 'max', title: 'MAX чат', url: 'https://web.max.ru/777', annotation: '', mcpProject: '', priority: false }),
    pin({ id: 'p3', serviceId: 'tg', title: 'Telegram', url: 'https://web.telegram.org/k/#1' }),
    pin({ id: 'p4', serviceId: 'ydx', title: 'Телемост', url: 'https://telemost.yandex.ru/j/1' })
  ], { exportedAt: EXPORTED_AT })
  const rows = dataRows(markdown)
  assert.equal(rows.length, 4)
  assert.equal(rows[0], '| 1 | Mattermost | Общий канал | https://im.astralinux.ru/team/channels/general | Рабочий чат | 14544 | да |')
  assert.equal(rows[1], '| 2 | MAX | MAX чат | https://web.max.ru/777 |  |  |  |')
  assert.equal(rows[2], '| 3 | Telegram | Telegram | https://web.telegram.org/k/#1 | Рабочий чат | 14544 | да |')
  assert.equal(rows[3], '| 4 | Яндекс Телемост | Телемост | https://telemost.yandex.ru/j/1 | Рабочий чат | 14544 | да |')
})

test('Экранирование: разделитель таблицы и переводы строк не ломают разметку', () => {
  const markdown = favorites.renderFavoritesMarkdown([
    pin({ title: 'Канал | с pipe', annotation: 'первая\nвторая\r\nтретья', mcpProject: '14544 | 15999' })
  ], { exportedAt: EXPORTED_AT })
  const [row] = dataRows(markdown)
  // Неэкранированных разделителей ровно 8 на 7 колонок: трубы в тексте — «\|».
  assert.equal(row.split(/(?<!\\)\|/).length - 1, 8, 'ровно 7 колонок, труба в тексте экранирована')
  assert.match(row, /Канал \\\| с pipe/)
  assert.match(row, /первая<br>вторая<br>третья/)
  assert.match(row, /14544 \\\| 15999/)
  assert.equal(row.includes('\n'), false)
})

test('Отсутствующие поля пина дают пустые ячейки и не подставляют чужие ключи', () => {
  const markdown = favorites.renderFavoritesMarkdown([
    { id: 'p1', serviceId: 'mm', url: 'https://im.astralinux.ru/team/channels/a' },
    { id: 'p2', serviceId: 'max', url: 'https://web.max.ru/1', title: '  ', annotation: null, mcpProject: undefined, priority: 'yes' }
  ], { exportedAt: EXPORTED_AT })
  const rows = dataRows(markdown)
  assert.equal(rows[0], '| 1 | Mattermost |  | https://im.astralinux.ru/team/channels/a |  |  |  |')
  assert.equal(rows[1], '| 2 | MAX |  | https://web.max.ru/1 |  |  |  |')
})

test('Счётчики сервисов в шапке считаются по каждому сервису', () => {
  const markdown = favorites.renderFavoritesMarkdown([
    pin(),
    pin({ id: 'p2' }),
    pin({ id: 'p3', serviceId: 'tg' }),
    pin({ id: 'p4', serviceId: 'max' }),
    pin({ id: 'p5', serviceId: 'max' })
  ], { exportedAt: EXPORTED_AT })
  assert.match(markdown, /^count: 5$/m)
  assert.match(markdown, /^services:$/m)
  assert.match(markdown, /^ {2}"mm": 2$/m)
  assert.match(markdown, /^ {2}"tg": 1$/m)
  assert.match(markdown, /^ {2}"max": 2$/m)
  const order = markdown.split('\n').filter(line => /^ {2}"/.test(line)).map(line => line.trim().split(':')[0])
  assert.deepEqual(order, ['"mm"', '"tg"', '"max"'], 'порядок — первое появление сервиса в списке')
})

test('Имя файла: favorites_ДДММГГГГ.md по локальной дате Новосибирска', () => {
  assert.equal(favorites.fileName(new Date('2026-11-24T10:15:00.000Z')), 'favorites_24112026.md')
  // 17:30 UTC — это уже 00:30 следующих суток в Новосибирске (UTC+7).
  assert.equal(favorites.fileName(new Date('2026-11-24T17:30:00.000Z')), 'favorites_25112026.md')
  // 16:30 UTC — ещё 23:30 того же дня.
  assert.equal(favorites.fileName(new Date('2026-11-24T16:30:00.000Z')), 'favorites_24112026.md')
  // Переход через Новый год.
  assert.equal(favorites.fileName(new Date('2026-12-31T17:05:00.000Z')), 'favorites_01012027.md')
  assert.match(favorites.fileName('2026-03-09T00:00:00.000Z'), /^favorites_\d{8}\.md$/)
})

test('Шапка YAML цитирует exported_at и не печатает посторонние поля пина', () => {
  const markdown = favorites.renderFavoritesMarkdown([
    pin({ token: 'super-secret', cookie: 'SID=1' })
  ], { exportedAt: '2026-11-24T10:15:00+07:00' })
  assert.match(markdown, /exported_at: "2026-11-24T10:15:00\+07:00"/)
  assert.equal(markdown.includes('super-secret'), false)
  assert.equal(markdown.includes('SID=1'), false)
  assert.equal(markdown.includes('token'), false)
})

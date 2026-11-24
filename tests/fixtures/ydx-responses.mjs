// Фикстуры ответов коннектора Яндекс Телемоста (favorite_*): точная форма
// живого коннектора — items с вложенным chat и author, next_cursor строкой.

export const YDX_CHAT_ID = '0/11/aaaaaaaa-1111-4111-8111-111111111111'
export const YDX_CHAT_TITLE = 'Портал-Юг'

// author — вложенный объект: is_bot и chat_id не должны влиять на выгрузку.
function ydxAuthor(name) {
  return { id: 'u-1', chat_id: YDX_CHAT_ID, display_name: name, is_bot: false }
}

// Настоящий item: id числом, вложения и пересланные сообщения присутствуют,
// created_at — ISO с Z.
export function ydxItem(overrides = {}) {
  return {
    id: 101,
    chat: { id: YDX_CHAT_ID, type: 'group' },
    author: ydxAuthor('Иван Петров'),
    type: 'text',
    text: 'План на неделю: https://example.test/plan?id=7. Подробности позже.',
    attachments: [{ type: 'file', name: 'план.pdf', size: 1234 }],
    forwarded_messages: [{ id: 900, text: 'пересланное сообщение' }],
    created_at: '2026-11-23T02:15:00Z',
    edited_at: null,
    ...overrides
  }
}

export const ydxFavoriteChats = {
  chats: [
    { chat_id: YDX_CHAT_ID, title: YDX_CHAT_TITLE },
    { chat_id: '0/22/bbbbbbbb-2222-4222-8222-222222222222', title: 'НЭСК' }
  ]
}

// Успешный чат: три сообщения, страница последняя.
export const ydxPageThreeMessages = {
  items: [
    ydxItem({ id: 101 }),
    ydxItem({
      id: 102,
      author: ydxAuthor('Анна Смирнова'),
      text: 'Ответ по задаче.',
      created_at: '2026-11-22T18:30:00Z',
      edited_at: '2026-11-22T18:35:00Z'
    }),
    ydxItem({
      id: 103,
      author: ydxAuthor(''),
      text: 'Без ссылок и вложений',
      attachments: [],
      forwarded_messages: [],
      created_at: '2026-11-21T10:05:09Z'
    })
  ],
  next_cursor: null
}

// Две страницы: курсор приходит строкой, вторая страница закрывает список.
export const ydxPageOne = {
  items: [
    ydxItem({ id: 201, text: 'первая страница, свежее', created_at: '2026-11-23T04:00:00Z' }),
    ydxItem({ id: 202, text: 'первая страница, второе', created_at: '2026-11-23T03:00:00Z' })
  ],
  next_cursor: 'cursor-1'
}

export const ydxPageTwo = {
  items: [
    ydxItem({ id: 203, text: 'вторая страница, первое', created_at: '2026-11-22T20:00:00Z' }),
    ydxItem({ id: 204, text: 'вторая страница, второе', created_at: '2026-11-22T19:00:00Z' })
  ],
  next_cursor: null
}

// Глубина: окно 7 дней от 2026-11-23T04:45:00Z, последнее сообщение старше.
export const ydxPageDepthStop = {
  items: [
    ydxItem({ id: 301, text: 'внутри окна', created_at: '2026-11-22T12:00:00Z' }),
    ydxItem({ id: 302, text: 'старше окна', created_at: '2026-11-10T12:00:00Z' })
  ],
  next_cursor: 'cursor-should-not-be-requested'
}

// Два избранных чата с одинаковым названием — точный title неоднозначен.
export const ydxFavoriteChatsDuplicateTitle = {
  chats: [
    { chat_id: YDX_CHAT_ID, title: YDX_CHAT_TITLE },
    { chat_id: '0/44/dddddddd-4444-4444-8444-444444444444', title: YDX_CHAT_TITLE }
  ]
}

// Десять страниц свежих сообщений: курсор всегда есть, потолок не достигнут.
export function ydxTenPages() {
  const pages = []
  for (let page = 0; page < 10; page += 1) {
    pages.push({
      items: [
        ydxItem({ id: 1000 + page * 2, text: `страница ${page + 1}, первое`, created_at: '2026-11-23T04:30:00Z' }),
        ydxItem({ id: 1001 + page * 2, text: `страница ${page + 1}, второе`, created_at: '2026-11-23T04:20:00Z' })
      ],
      next_cursor: `cursor-${page + 1}`
    })
  }
  return pages
}

// Полные страницы по 50 сообщений внутри окна: живой коннектор отдаёт именно
// столько, когда глубже лежит длинная переписка. Курсор ведёт на следующую.
export function ydxFiftyPages(count) {
  const pages = []
  for (let page = 0; page < count; page += 1) {
    const items = []
    for (let index = 0; index < 50; index += 1) {
      items.push(ydxItem({
        id: 5000 + page * 50 + index,
        text: `страница ${page + 1}, сообщение ${index + 1}`,
        created_at: '2026-11-23T04:30:00Z'
      }))
    }
    pages.push({ items, next_cursor: `cursor-${page + 1}` })
  }
  return pages
}

// Готовые ответы max_read_history для тестов адаптера MAX.

// Окно из трёх сообщений: null-автор, пустой текст, две ссылки.
export const maxHistoryThreeMessages = {
  ok: true,
  chat_id: 123456,
  title: 'Рабочий чат',
  bounded: true,
  window: { first_index: 10, last_index: 12, rendered_nodes: 3 },
  count: 3,
  messages: [
    {
      index: 10,
      id: null,
      id_stable: false,
      author: 'Иван',
      timestamp: '2026-11-23T09:00:00',
      timestamp_source: 'dom_date+time',
      outbound: false,
      truncated: false,
      text: 'Две ссылки: https://example.test/one, https://example.test/two.'
    },
    {
      index: 11,
      id: null,
      id_stable: false,
      author: null,
      timestamp: '2026-11-23T09:05:00',
      timestamp_source: 'dom_date+time',
      outbound: true,
      truncated: false,
      text: 'Ответ без автора.'
    },
    {
      index: 12,
      id: null,
      id_stable: false,
      author: '',
      timestamp: '2026-11-23T09:10:00+07:00',
      timestamp_source: 'dom_date+time',
      outbound: false,
      truncated: true,
      text: ''
    }
  ]
}

// Пустое отрендеренное окно: коннектор сообщает NO_MESSAGES, это не ошибка выгрузки.
export const maxNoMessagesError = Object.assign(new Error('В окне нет отрендеренных сообщений'), {
  code: 'NO_MESSAGES'
})

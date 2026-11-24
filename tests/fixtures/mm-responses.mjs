// Готовые ответы mmchat_read_channel для тестов адаптера Mattermost.

// Канал с тремя постами: разные авторы, время со смещением и без, ссылки.
export const mmChannelThreePosts = {
  channel: 'town-square',
  channel_id: 'chan-town-square',
  type: 'O',
  count: 3,
  posts: [
    {
      post_id: 'p1',
      author: 'ivan',
      time: '2026-11-23T09:15:00',
      text: 'План на неделю: https://example.test/plan?id=7. Подробности позже.',
      root_id: '',
      is_reply: false,
      mentions_me: false,
      edited: false,
      reactions: []
    },
    {
      post_id: 'p2',
      author: 'anna',
      time: '2026-11-23T10:05:09+07:00',
      text: 'Смотри (https://example.test/a?x=1&y=2) и ещё https://example.test/b!',
      root_id: '',
      is_reply: false,
      mentions_me: true,
      edited: true,
      reactions: []
    },
    {
      post_id: 'p3',
      author: 'petr',
      time: '2026-11-22T18:30:00',
      text: 'Без ссылок, просто текст.',
      root_id: 'p1',
      is_reply: true,
      mentions_me: false,
      edited: false,
      reactions: []
    }
  ]
}

// Полная страница (count == limit), старейшее сообщение старше начала окна.
export const mmChannelFullOldestOutsideWindow = {
  channel: 'town-square',
  channel_id: 'chan-town-square',
  type: 'O',
  count: 200,
  posts: [
    {
      post_id: 'old-1',
      author: 'ivan',
      time: '2026-11-14T10:00:00',
      text: 'Сообщение за пределами недельного окна.',
      root_id: '',
      is_reply: false,
      mentions_me: false,
      edited: false,
      reactions: []
    }
  ]
}

// Полная страница (count == limit), старейшее сообщение новее начала окна.
export const mmChannelFullOldestInsideWindow = {
  channel: 'town-square',
  channel_id: 'chan-town-square',
  type: 'O',
  count: 200,
  posts: [
    {
      post_id: 'new-1',
      author: 'anna',
      time: '2026-11-20T10:00:00',
      text: 'Сообщение внутри окна, но страница заполнена.',
      root_id: '',
      is_reply: false,
      mentions_me: false,
      edited: false,
      reactions: []
    }
  ]
}

// Два одинаковых поста: адаптер обязан схлопнуть их через dedupeMessages.
export const mmChannelDuplicates = {
  channel: 'town-square',
  channel_id: 'chan-town-square',
  type: 'O',
  count: 2,
  posts: [
    {
      post_id: 'dup-1',
      author: 'ivan',
      time: '2026-11-23T09:00:00',
      text: 'Один и тот же пост.',
      root_id: '',
      is_reply: false,
      mentions_me: false,
      edited: false,
      reactions: []
    },
    {
      post_id: 'dup-1',
      author: 'ivan',
      time: '2026-11-23T09:00:00',
      text: 'Один и тот же пост.',
      root_id: '',
      is_reply: false,
      mentions_me: false,
      edited: false,
      reactions: []
    }
  ]
}

// Пост без поля text — нарушение схемы.
export const mmChannelPostWithoutText = {
  channel: 'town-square',
  channel_id: 'chan-town-square',
  type: 'O',
  count: 1,
  posts: [
    {
      post_id: 'bad-1',
      author: 'ivan',
      time: '2026-11-23T09:00:00',
      root_id: '',
      is_reply: false,
      mentions_me: false,
      edited: false,
      reactions: []
    }
  ]
}

// Пост без post_id — нарушение схемы.
export const mmChannelPostWithoutId = {
  channel: 'town-square',
  channel_id: 'chan-town-square',
  type: 'O',
  count: 1,
  posts: [
    {
      author: 'ivan',
      time: '2026-11-23T09:00:00',
      text: 'Пост без идентификатора.',
      root_id: '',
      is_reply: false,
      mentions_me: false,
      edited: false,
      reactions: []
    }
  ]
}

// Ответ без массива posts — нарушение схемы.
export const mmChannelWithoutPosts = {
  channel: 'town-square',
  channel_id: 'chan-town-square',
  type: 'O',
  count: 0
}

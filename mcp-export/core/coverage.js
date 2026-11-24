'use strict'

function classifyCoverage({ kind, limit, count, oldestTs, windowStartMs }) {
  if (kind === 'window') return 'window'
  if (count < limit) return 'full'
  // Без числовых границ окна полноту утверждать нельзя
  if (!Number.isFinite(oldestTs) || !Number.isFinite(windowStartMs)) return 'truncated'
  if (oldestTs > windowStartMs) return 'truncated'
  return 'full'
}

module.exports = { classifyCoverage }

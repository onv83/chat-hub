'use strict'

function parseProjects(raw) {
  const projects = []
  const rejected = []
  const seenProjects = new Set()
  const seenRejected = new Set()
  if (raw === null || raw === undefined) return { projects, rejected }

  for (const item of String(raw).split(',')) {
    const value = item.trim().replace(/\s+/g, ' ')
    if (!value) continue
    const valid = /^\d{1,10}$/.test(value)
    const target = valid ? projects : rejected
    const seen = valid ? seenProjects : seenRejected
    if (seen.has(value)) continue
    seen.add(value)
    target.push(value)
  }
  return { projects, rejected }
}

module.exports = { parseProjects }

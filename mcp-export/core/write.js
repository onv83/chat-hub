'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

function validateName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.includes('/') || name.includes('\\') || name.includes('..') || path.isAbsolute(name) || path.win32.isAbsolute(name) || path.posix.isAbsolute(name)) {
    throw new Error('EXPORT_NAME_INVALID: имя файла должно быть простым относительным именем без «..»')
  }
}

function validateDirectory(dir) {
  let stat
  try {
    stat = fs.statSync(dir)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      throw new Error(`EXPORT_DIR_MISSING: каталог экспорта не существует: ${dir}`)
    }
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      throw new Error(`EXPORT_DIR_NOT_WRITABLE: нет доступа к каталогу экспорта: ${dir}`)
    }
    throw error
  }
  if (!stat.isDirectory()) throw new Error(`EXPORT_DIR_NOT_DIR: путь экспорта не является каталогом: ${dir}`)
  try {
    fs.accessSync(dir, fs.constants.W_OK)
  } catch {
    throw new Error(`EXPORT_DIR_NOT_WRITABLE: каталог экспорта недоступен на запись: ${dir}`)
  }
}

// Копия предыдущей версии: 14544_01012027.md → 14544_01012027.prev.md.
// Одно поколение: при следующей перезаписи prev заменяется, а не копится.
function previousName(name) {
  return name.toLowerCase().endsWith('.md') ? `${name.slice(0, -3)}.prev.md` : `${name}.prev.md`
}

// Одна атомарная замена: временный файл рядом с целью, fsync и rename.
function atomicReplace(directory, name, content) {
  const target = path.join(directory, name)
  const suffix = crypto.randomBytes(6).toString('hex')
  const temporary = path.join(directory, `${name}.tmp-${process.pid}-${suffix}`)
  let descriptor
  try {
    descriptor = fs.openSync(temporary, 'wx')
    fs.writeFileSync(descriptor, content)
    try {
      fs.fsyncSync(descriptor)
    } catch (error) {
      if (error.code !== 'ENOSYS' && error.code !== 'EINVAL') throw error
    }
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporary, target)
    return target
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch {}
    }
    try { fs.rmSync(temporary, { force: true }) } catch {}
    if (error.code === 'EACCES' || error.code === 'EPERM' || error.code === 'EROFS') {
      throw new Error(`EXPORT_DIR_NOT_WRITABLE: не удалось записать файл экспорта: ${target}`)
    }
    throw error
  }
}

function writeFileAtomic(dir, name, content) {
  validateName(name)
  const directory = path.resolve(dir)
  validateDirectory(directory)
  // Перед перезаписью существующего файла сохраняем его копию: если новый
  // прогон окажется хуже (усечённый чат), у человека останется прежняя версия.
  let existing = null
  try {
    existing = fs.readFileSync(path.join(directory, name))
  } catch (error) {
    // Файла ещё нет — перезаписывать нечего, .prev не создаём.
    if (error.code !== 'ENOENT') throw error
  }
  if (existing !== null) {
    const previous = previousName(name)
    // Копия тоже атомарная: прерванная запись не оставит полуфайл.
    atomicReplace(directory, previous, existing)
  }
  return atomicReplace(directory, name, content)
}

module.exports = { writeFileAtomic, previousName }

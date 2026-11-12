/* Structural, local-only diagnostics. Never read chat text or reset storage. */
;(function (root) {
  function classify(s) {
    if (s.loading || s.ready === 'loading') return 'loading'
    if (s.error) return 'load-error'
    if (s.blank) return 'about-blank'
    if (s.login) return 'login'
    if (!s.root) return 'other-page'
    if (s.bodyChildren > 0) return 'content'
    if (s.ready === 'complete' && s.scripts === 0 && s.bodyChildren === 0) return 'empty-root'
    return 'indeterminate'
  }
  function probe() {
    // Return only structural booleans/counts, not href, title, text or inputs.
    return {
      root: location.origin === 'https://telemost.yandex.ru' && location.pathname === '/' && !location.search && !location.hash,
      blank: location.href === 'about:blank',
      ready: document.readyState,
      bodyChildren: document.body ? document.body.childNodes.length : 0,
      scripts: document.scripts.length,
      login: !!document.querySelector('input[type=password],input[autocomplete=username],form[action*="passport"]')
    }
  }
  function attach(wv, bar, options = {}) {
    const doc = bar.ownerDocument
    const check = doc.createElement('button')
    check.className = 'btn'; check.textContent = 'Проверить Телемост'
    const recover = doc.createElement('button')
    recover.className = 'btn'; recover.textContent = 'Повторить загрузку пустой вкладки'; recover.hidden = true
    const status = doc.createElement('span'); status.setAttribute('role', 'status')
    bar.appendChild(check); bar.appendChild(recover); bar.appendChild(status)
    const schedule = options.setTimeout || setTimeout
    const cancel = options.clearTimeout || clearTimeout
    const confirm = options.confirm || (message => root.confirm(message))
    let pending = false, epoch = 0, error = 0, disposed = false, used = false
    let last = null
    const records = []
    const listeners = []
    function record(state, extra = {}) {
      const item = { state, ...extra }; records.push(item)
      if (records.length > 16) records.shift()
      status.textContent = 'Телемост: ' + state
      status.title = JSON.stringify(records)
    }
    function invalidate() { epoch++; error = 0; last = null; recover.hidden = true }
    function on(name, callback) { wv.addEventListener(name, callback); listeners.push([name, callback]) }
    async function inspect() {
      if (disposed || pending || !wv.isConnected) return null
      pending = true
      const generation = epoch
      let timer
      try {
        // Physical single-flight remains occupied after the UI deadline.
        timer = schedule(() => { if (!disposed && generation === epoch) record('probe-timeout') }, 2500)
        const s = await wv.executeJavaScript('(' + probe.toString() + ')()')
        if (disposed || generation !== epoch || !wv.isConnected) return null
        const result = { ...s, loading: wv.isLoading(), error }
        const state = classify(result)
        last = { state, generation }
        record(state, result)
        recover.hidden = state !== 'empty-root' || used
        return last
      } catch (_) {
        if (!disposed && generation === epoch) record('probe-error')
        return null
      } finally { cancel(timer); pending = false }
    }
    check.onclick = inspect
    recover.onclick = async () => {
      if (used || !last || last.state !== 'empty-root') return
      if (!confirm('Повторить загрузку только пустой корневой вкладки? Сервис может восстановить ранее открытый чат. Данные входа не удаляются.')) return
      const result = await inspect()
      if (!result || result.generation !== epoch || result.state !== 'empty-root' || disposed || used) return
      used = true; recover.hidden = true; last = null
      try { wv.reload(); record('manual-reload-requested') } catch (_) { record('manual-reload-failed') }
    }
    on('did-start-loading', invalidate)
    on('did-navigate-in-page', invalidate)
    on('did-fail-load', e => {
      if (e.isMainFrame !== true || e.errorCode === -3) return
      invalidate(); error = e.errorCode; record('load-error', { error })
    })
    on('render-process-gone', () => { invalidate(); record('renderer-gone') })
    // One bounded startup probe; no polling, retries, forced navigation or recreation.
    const startup = schedule(inspect, 15000)
    return {
      inspect, records,
      dispose() { disposed = true; epoch++; cancel(startup); for (const [n, cb] of listeners) wv.removeEventListener(n, cb); check.remove(); recover.remove(); status.remove() }
    }
  }
  const api = { classify, probe, attach }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.ChatHubServiceHealth = api
})(typeof window !== 'undefined' ? window : globalThis)

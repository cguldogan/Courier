// Progressive enhancement for the Courier site. Without it, every download link points at the
// latest release page and the page is complete.
//  1. Asks the GitHub API (the only other origin the CSP allows) for the latest release, shows its
//     version and points the download buttons at the matching installers. Any failure (no published
//     release yet, rate limit, offline) leaves the release-page links in place.
//  2. Marks the visitor's operating system in the download section.
//  3. Adds copy buttons to the code blocks.
;(function () {
  'use strict'

  var RELEASES = 'https://github.com/cguldogan/Courier/releases/latest'
  var API = 'https://api.github.com/repos/cguldogan/Courier/releases/latest'
  var CACHE_KEY = 'courier-latest-release'
  var CACHE_MS = 10 * 60 * 1000

  // Installer file names: Courier-<version>-<os>-<arch>… (electron-builder.yml, artifactName).
  var ASSETS = {
    'mac-arm64': /-mac-arm64\.dmg$/,
    'mac-x64': /-mac-x64\.dmg$/,
    'win-x64': /-win-x64-setup\.exe$/,
    'win-arm64': /-win-arm64-setup\.exe$/,
    'linux-x64-appimage': /-linux-x86_64\.AppImage$/,
    'linux-x64-deb': /-linux-amd64\.deb$/,
    'linux-arm64-appimage': /-linux-arm64\.AppImage$/,
    'linux-arm64-deb': /-linux-arm64\.deb$/
  }

  function detectOs() {
    var p = ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || '').toLowerCase()
    if (/android|iphone|ipad|ipod/.test(navigator.userAgent.toLowerCase())) return null
    if (p.indexOf('mac') !== -1) return 'mac'
    if (p.indexOf('win') !== -1) return 'windows'
    if (p.indexOf('linux') !== -1 || p.indexOf('x11') !== -1) return 'linux'
    return null
  }

  function readCache() {
    try {
      var raw = sessionStorage.getItem(CACHE_KEY)
      if (!raw) return null
      var c = JSON.parse(raw)
      return Date.now() - c.at < CACHE_MS ? c.release : null
    } catch (e) {
      return null
    }
  }

  function writeCache(release) {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), release: release }))
    } catch (e) {
      /* storage unavailable: no cache */
    }
  }

  function safeUrl(u) {
    // Only GitHub download and release URLs become links.
    return typeof u === 'string' && /^https:\/\/github\.com\/cguldogan\/Courier\/releases\//.test(u) ? u : null
  }

  function fetchRelease() {
    var cached = readCache()
    if (cached) return Promise.resolve(cached)
    if (!window.fetch) return Promise.reject(new Error('no fetch'))
    var ctrl = window.AbortController ? new AbortController() : null
    var timer = ctrl ? setTimeout(function () { ctrl.abort() }, 8000) : null
    return fetch(API, {
      headers: { Accept: 'application/vnd.github+json' },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: ctrl ? ctrl.signal : undefined
    })
      .then(function (res) {
        if (timer) clearTimeout(timer)
        if (!res.ok) throw new Error('HTTP ' + res.status)
        return res.json()
      })
      .then(function (data) {
        var tag = typeof data.tag_name === 'string' && /^v\d+\.\d+\.\d+[\w.-]*$/.test(data.tag_name) ? data.tag_name : null
        if (!tag || data.draft) throw new Error('no published release')
        var assets = {}
        ;(Array.isArray(data.assets) ? data.assets : []).forEach(function (a) {
          var url = a && safeUrl(a.browser_download_url)
          if (!url || typeof a.name !== 'string') return
          Object.keys(ASSETS).forEach(function (key) {
            if (ASSETS[key].test(a.name)) assets[key] = { url: url, name: a.name }
          })
        })
        var release = { tag: tag, url: safeUrl(data.html_url) || RELEASES, assets: assets }
        writeCache(release)
        return release
      })
  }

  function applyRelease(release) {
    document.querySelectorAll('[data-release-version]').forEach(function (el) {
      el.textContent = release.tag
      el.hidden = false
    })
    document.querySelectorAll('[data-asset]').forEach(function (a) {
      var asset = release.assets[a.getAttribute('data-asset')]
      if (asset) {
        a.href = asset.url
        a.setAttribute('title', asset.name)
      } else {
        a.href = release.url
      }
    })
    var status = document.querySelector('[data-release-status]')
    if (status) {
      status.textContent = ''
      status.append('Every installer, the .zip and .tar.gz archives and a SHA256SUMS file are on the ')
      var link = document.createElement('a')
      link.href = release.url
      link.textContent = 'release page'
      status.append(link, '.')
    }
  }

  function markOs() {
    var os = detectOs()
    if (!os) return
    var card = document.querySelector('.os-card[data-os="' + os + '"]')
    if (card) card.classList.add('is-current')
    return os
  }

  function primaryLabel(os) {
    var names = { mac: 'macOS', windows: 'Windows', linux: 'Linux' }
    var label = document.querySelector('[data-download-label]')
    var primary = document.querySelector('[data-download-primary]')
    if (!label || !primary || !names[os]) return
    // The link stays on the release page, which lists every arch.
    label.textContent = 'Download for ' + names[os]
  }

  function copyButtons() {
    if (!navigator.clipboard || !window.isSecureContext) return
    document.querySelectorAll('.code-block').forEach(function (block) {
      var btn = block.querySelector('.copy')
      var code = block.querySelector('code')
      if (!btn || !code) return
      btn.hidden = false
      btn.setAttribute('aria-label', 'Copy command')
      btn.addEventListener('click', function () {
        navigator.clipboard.writeText(code.textContent).then(
          function () {
            btn.textContent = 'Copied'
            setTimeout(function () { btn.textContent = 'Copy' }, 1600)
          },
          function () {
            btn.textContent = 'Copy failed'
          }
        )
      })
    })
  }

  var os = markOs()
  if (os) primaryLabel(os)
  copyButtons()
  fetchRelease().then(applyRelease, function () {
    /* Keep the links to the release page. */
  })
})()

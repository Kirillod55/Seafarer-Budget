import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (p: string) => readFileSync(`${process.cwd()}/src-tauri/${p}`, 'utf8')

describe('Windows app config (spec §11 «Ширина окна», «Автообновление»)', () => {
  const conf = JSON.parse(read('tauri.conf.json'))

  it('the window is at least 400 × 640', () => {
    expect(conf.app.windows[0]).toMatchObject({ minWidth: 400, minHeight: 640 })
  })

  it('updates come signed from the latest GitHub release', () => {
    expect(conf.bundle.createUpdaterArtifacts).toBe(true)
    expect(conf.plugins.updater.endpoints).toEqual(['https://github.com/Kirillod55/Seafarer-Budget/releases/latest/download/latest.json'])
    // the public key goes in at release (stage 7); a private key is never in the repository
    expect(typeof conf.plugins.updater.pubkey).toBe('string')
    expect(read('tauri.conf.json')).not.toMatch(/PRIVATE KEY|untrusted comment: rsign encrypted secret key/i)
  })

  it('the plugins are registered and allowed', () => {
    expect(read('Cargo.toml')).toMatch(/tauri-plugin-updater = "2"[\s\S]*tauri-plugin-process = "2"/)
    expect(read('src/main.rs')).toContain('tauri_plugin_updater::Builder::new().build()')
    expect(JSON.parse(read('capabilities/default.json')).permissions).toEqual(expect.arrayContaining(['updater:default', 'process:allow-restart']))
  })

  it('app and package versions agree', () => {
    const pkg = JSON.parse(readFileSync(`${process.cwd()}/package.json`, 'utf8'))
    expect(conf.version).toBe(pkg.version)
  })
})

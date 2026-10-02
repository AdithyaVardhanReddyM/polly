import { useEffect, useState } from 'react'
import type { AppInfo } from '../../../shared/contracts'
import type { ServerState } from '../App'
import { PageHead } from '../components/PageHead'
import { type StageArt, useStageArt } from '../components/StageArt'
import { type ThemePref, useTheme } from '../theme'

const STAGES: [StageArt, string][] = [
  ['pixel', 'Pixel'],
  ['blueprint', 'Blueprint'],
  ['off', 'Off']
]

interface Props {
  server: ServerState
  onRecheck: () => void
}

export function Settings({ server, onRecheck }: Props): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [theme, setTheme] = useTheme()
  const [art, setArt] = useStageArt()

  useEffect(() => {
    void window.polly?.appInfo().then((r) => r.ok && setInfo(r.data))
  }, [])

  const h = server.health
  const rows: [string, string, boolean | null][] = h
    ? [
        ['Agent server', `${h.service} ${h.version}`, true],
        ['Model', `${h.model.provider} · ${h.model.id}`, h.model.configured],
        ['Sandboxes', h.sandbox.provider, h.sandbox.configured],
        ['Web search', h.search.provider, h.search.configured]
      ]
    : [['Agent server', server.error ?? 'Connecting…', false]]

  return (
    <div className="page">
      <PageHead title="Settings" subtitle="Where Polly runs and what it is connected to.">
        <button className="btn" onClick={onRecheck} disabled={server.checking}>
          {server.checking ? 'Checking…' : 'Recheck'}
        </button>
      </PageHead>

      <section>
        <div className="section-head">
          <h2>Runtime</h2>
        </div>
        <div className="list">
          {rows.map(([label, value, ok]) => (
            <div key={label} className="row is-setting">
              <span className="setting-label">{label}</span>
              <span className="row-body setting-value">{value}</span>
              <span className={ok ? 'dot dot-ok' : 'dot dot-warn'} />
            </div>
          ))}
        </div>
        <p className="hint">Keys live in the repo-root <code>.env</code>; see <code>.env.example</code>.</p>
      </section>

      <section>
        <div className="section-head">
          <h2>Appearance</h2>
        </div>
        <div className="list">
          <div className="row is-setting">
            <span className="setting-label">Theme</span>
            <span className="row-body">
              <span className="segmented">
                {(['system', 'light', 'dark'] as ThemePref[]).map((t) => (
                  <button
                    key={t}
                    className={t === theme ? 'is-active' : ''}
                    onClick={() => setTheme(t)}
                  >
                    {t[0].toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </span>
            </span>
          </div>
          <div className="row is-setting">
            <span className="setting-label">Header art</span>
            <span className="row-body">
              <span className="segmented">
                {STAGES.map(([a, label]) => (
                  <button key={a} className={a === art ? 'is-active' : ''} onClick={() => setArt(a)}>
                    {label}
                  </button>
                ))}
              </span>
            </span>
          </div>
        </div>
      </section>

      {info && (
        <section>
          <div className="section-head">
            <h2>App</h2>
          </div>
          <div className="list">
            <div className="row is-setting">
              <span className="setting-label">Version</span>
              <span className="row-body setting-value">
                {info.version} · Electron {info.electron} · Node {info.node} · {info.platform}
              </span>
            </div>
          </div>
        </section>
      )}
    </div>
  )
}

import { ChevronsUpDown, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { CopilotLogEntry, CopilotSettings } from '../../../shared/contracts'
import type { CopilotState } from '../../../shared/copilot'
import type { RunningApp } from '../../../shared/sense'
import { request } from '../api'
import { ModelMenu, Popover } from '../coder/Composer'
import { ModelLogo } from '../coder/icons'
import { shortTime } from '../coder/toolMeta'
import { copilotApi } from '../notch/api'
import { describeModel, useModels } from '../store/models'

const bridge = window.polly?.copilot

const SUGGEST: [keyof CopilotSettings['suggest'], string, string][] = [
  ['hints', 'Hints while you work', 'Reply drafts as you type, formulas, fixes for errors on screen.'],
  ['chips', 'Actions for the app in front', 'Summarize thread, Fill form, Write a formula and the like.'],
  ['todos', 'To-dos it spots', 'Things you are asked to do in email and chat, ready to accept.'],
  ['writing', 'Writing help on selected text', 'Select text anywhere to rewrite it in place.']
]

const LENS_LABEL: Record<string, string> = {
  email: 'Email',
  spreadsheet: 'Spreadsheets',
  pdf: 'PDFs',
  chat: 'Chat',
  document: 'Documents',
  code: 'Code',
  browser: 'Web pages',
  generic: 'Other apps'
}

const KIND_LABEL: Record<string, string> = {
  reply_draft: 'reply drafts',
  completion: 'completions',
  formula: 'formulas',
  fix: 'fixes'
}

/** Settings → Copilot: what the notch copilot may do, and what it never looks at. */
export function CopilotSettingsSections(): React.JSX.Element | null {
  const [prefs, setPrefs] = useState<CopilotSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [state, setState] = useState<CopilotState | null>(null)

  useEffect(() => {
    void copilotApi.settings().then((res) => {
      if (res.ok) setPrefs(res.data)
      else setError(res.error)
    })
    if (!bridge) return undefined
    void bridge.state().then(setState)
    return bridge.onState(setState)
  }, [])

  const save = useCallback(async (patch: Partial<CopilotSettings>, privacy = false) => {
    const res = await copilotApi.updateSettings(patch)
    if (res.ok) {
      setPrefs(res.data)
      if (privacy) await bridge?.privacyChanged()
    } else setError(res.error)
  }, [])

  if (!prefs) {
    return (
      <section>
        <div className="section-head">
          <h2>Copilot</h2>
        </div>
        <div className="list">
          <div className="row is-quiet">{error ?? 'Loading…'}</div>
        </div>
      </section>
    )
  }

  return (
    <>
      <section>
        <div className="section-head">
          <h2>Copilot</h2>
          <span>The assistant in your notch. It reads your screen only while it is on.</span>
        </div>
        <div className="list">
          {state && (
            <label className="row is-toggle">
              <div className="row-body">
                <div className="row-title">Watching</div>
                <div className="row-why">
                  Press <kbd>{state.shortcut}</kbd> anywhere to turn it on or off. Off, Polly reads
                  nothing; reminders still show in the notch.
                </div>
              </div>
              <input
                type="checkbox"
                className="switch"
                checked={state.watching}
                onChange={(e) => void bridge?.setWatching(e.target.checked)}
              />
            </label>
          )}
          {state && <HelperRow state={state} />}
          {SUGGEST.map(([key, title, why]) => (
            <label key={key} className="row is-toggle">
              <div className="row-body">
                <div className="row-title">{title}</div>
                <div className="row-why">{why}</div>
              </div>
              <input
                type="checkbox"
                className="switch"
                checked={prefs.suggest[key]}
                onChange={(e) =>
                  void save({ suggest: { ...prefs.suggest, [key]: e.target.checked } })
                }
              />
            </label>
          ))}
          <ModelRow
            label="Brain"
            why="Decides what to offer, drafts and answers."
            value={prefs.brain_model}
            onPick={(id) => void save({ brain_model: id })}
          />
          <ModelRow
            label="Eyes"
            why="Looks at a screenshot of the window when text is not enough."
            value={prefs.vision_model}
            vision
            onPick={(id) => void save({ vision_model: id })}
          />
        </div>
      </section>

      <PrivacySection prefs={prefs} save={save} />
      <RecallSection prefs={prefs} save={save} />
      <LogSection />
    </>
  )
}

function HelperRow({ state }: { state: CopilotState }): React.JSX.Element {
  const { helper, permissions } = state
  if (helper.state !== 'ready') {
    return (
      <div className="row is-setting">
        <span className="setting-label">Screen reader</span>
        <span className="row-body setting-value">
          {helper.state === 'missing'
            ? 'Not built yet: run npm run build:sense in the repo, then restart Polly.'
            : helper.state === 'starting'
              ? 'Starting…'
              : (helper.message ?? 'Stopped')}
        </span>
        {helper.state === 'error' && (
          <button className="btn" onClick={() => void bridge?.restartHelper()}>
            Restart
          </button>
        )}
      </div>
    )
  }
  const perms: [keyof typeof permissions, string, string][] = [
    ['accessibility', 'Accessibility', 'Reads text in apps and puts suggestions back.'],
    ['screenRecording', 'Screen Recording', 'Takes a screenshot of the window you are in.']
  ]
  return (
    <>
      {perms.map(([key, title, why]) => (
        <div key={key} className="row is-setting">
          <span className="setting-label">{title}</span>
          <span className="row-body setting-value">{why}</span>
          {permissions[key] ? (
            <span className="copilot-ok">Allowed</span>
          ) : (
            <button
              className="btn"
              onClick={() =>
                void bridge?.requestPermission(key === 'accessibility' ? 'accessibility' : 'screenRecording')
              }
            >
              Allow
            </button>
          )}
        </div>
      ))}
    </>
  )
}

function ModelRow({
  label,
  why,
  value,
  vision = false,
  onPick
}: {
  label: string
  why: string
  value: string
  vision?: boolean
  onPick: (id: string) => void
}): React.JSX.Element {
  const models = useModels((s) => s.models)
  const load = useModels((s) => s.load)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    void load()
  }, [load])
  const choices = vision ? models.filter((m) => m.vision) : models
  const current = describeModel(value, models)
  return (
    <div className="row is-setting">
      <span className="setting-label">{label}</span>
      <span className="row-body setting-value">{why}</span>
      <Popover
        open={open}
        onOpenChange={setOpen}
        align="end"
        placement="bottom"
        trigger={
          <button className="btn copilot-model" onClick={() => setOpen(!open)}>
            <ModelLogo vendor={current.vendor} model={value} size={15} />
            {current.label}
            <ChevronsUpDown />
          </button>
        }
      >
        <ModelMenu
          models={choices}
          value={value}
          onPick={(id) => {
            setOpen(false)
            onPick(id)
          }}
        />
      </Popover>
    </div>
  )
}

function PrivacySection({
  prefs,
  save
}: {
  prefs: CopilotSettings
  save: (patch: Partial<CopilotSettings>, privacy?: boolean) => Promise<void>
}): React.JSX.Element {
  const [icons, setIcons] = useState<Record<string, string | null>>({})
  const [picking, setPicking] = useState(false)
  const [running, setRunning] = useState<RunningApp[]>([])
  const [domain, setDomain] = useState('')

  useEffect(() => {
    for (const app of prefs.exclusions.apps) {
      if (app.bundle_id in icons) continue
      void bridge?.appIcon(app.bundle_id).then((png) =>
        setIcons((all) => ({ ...all, [app.bundle_id]: png }))
      )
    }
  }, [prefs.exclusions.apps, icons])

  const excluded = new Set(prefs.exclusions.apps.map((a) => a.bundle_id))
  const addDomain = (): void => {
    const host = domain
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
    setDomain('')
    if (!host || prefs.exclusions.domains.includes(host)) return
    void save({ exclusions: { ...prefs.exclusions, domains: [...prefs.exclusions.domains, host] } }, true)
  }

  return (
    <section>
      <div className="section-head">
        <h2>What the copilot never sees</h2>
        <span>Checked on your Mac before anything is read. Password fields are always skipped.</span>
      </div>
      <div className="list">
        <div className="row is-setting copilot-list-head">
          <span className="setting-label">Apps</span>
          <span className="row-body" />
          <Popover
            open={picking}
            onOpenChange={setPicking}
            align="end"
            placement="bottom"
            trigger={
              <button
                className="btn"
                onClick={() => {
                  if (!picking) void bridge?.runningApps().then(setRunning)
                  setPicking(!picking)
                }}
              >
                <Plus /> Add an app
              </button>
            }
          >
            <div className="menu copilot-apps">
              {running.filter((a) => !excluded.has(a.bundleId)).length === 0 && (
                <div className="menu-label">No other apps are open.</div>
              )}
              {running
                .filter((a) => !excluded.has(a.bundleId))
                .map((app) => (
                  <button
                    key={app.bundleId}
                    className="menu-item"
                    onClick={() => {
                      setPicking(false)
                      void save(
                        {
                          exclusions: {
                            ...prefs.exclusions,
                            apps: [...prefs.exclusions.apps, { bundle_id: app.bundleId, name: app.name }]
                          }
                        },
                        true
                      )
                    }}
                  >
                    {app.icon ? <img src={`data:image/png;base64,${app.icon}`} alt="" /> : <span />}
                    <span className="menu-text">
                      <b>{app.name}</b>
                    </span>
                  </button>
                ))}
            </div>
          </Popover>
        </div>
        {prefs.exclusions.apps.map((app) => (
          <div key={app.bundle_id} className="row copilot-item">
            {icons[app.bundle_id] ? (
              <img src={`data:image/png;base64,${icons[app.bundle_id]}`} alt="" />
            ) : (
              <span className="copilot-icon-blank" />
            )}
            <div className="row-body">
              <div className="row-title">{app.name}</div>
              <div className="row-why">{app.bundle_id}</div>
            </div>
            <button
              className="icon-btn"
              title="Let the copilot see this app"
              onClick={() =>
                void save(
                  {
                    exclusions: {
                      ...prefs.exclusions,
                      apps: prefs.exclusions.apps.filter((a) => a.bundle_id !== app.bundle_id)
                    }
                  },
                  true
                )
              }
            >
              <Trash2 />
            </button>
          </div>
        ))}

        <form
          className="row memory-add"
          onSubmit={(e) => {
            e.preventDefault()
            addDomain()
          }}
        >
          <input
            value={domain}
            placeholder="Add a website, such as mybank.com"
            aria-label="Add a website"
            onChange={(e) => setDomain(e.target.value)}
          />
          <button className="btn" type="submit" disabled={!domain.trim()}>
            <Plus /> Add
          </button>
        </form>
        {prefs.exclusions.domains.map((host) => (
          <div key={host} className="row copilot-item">
            <div className="row-body">
              <div className="row-title">{host}</div>
              <div className="row-why">and every subdomain</div>
            </div>
            <button
              className="icon-btn"
              title="Let the copilot see this site"
              onClick={() =>
                void save(
                  {
                    exclusions: {
                      ...prefs.exclusions,
                      domains: prefs.exclusions.domains.filter((d) => d !== host)
                    }
                  },
                  true
                )
              }
            >
              <Trash2 />
            </button>
          </div>
        ))}

        {prefs.hidden_windows.map((w) => (
          <div key={`${w.bundle_id}|${w.title}`} className="row copilot-item">
            <div className="row-body">
              <div className="row-title">{w.title || 'Untitled window'}</div>
              <div className="row-why">Hidden window · {w.app}</div>
            </div>
            <button
              className="btn"
              onClick={() =>
                void save(
                  {
                    hidden_windows: prefs.hidden_windows.filter(
                      (x) => !(x.bundle_id === w.bundle_id && x.title === w.title)
                    )
                  },
                  true
                )
              }
            >
              Show again
            </button>
          </div>
        ))}

        {prefs.muted.map((m) => (
          <div key={`${m.lens}|${m.kind}`} className="row copilot-item">
            <div className="row-body">
              <div className="row-title">
                No {KIND_LABEL[m.kind] ?? m.kind} in {(LENS_LABEL[m.lens] ?? m.lens).toLowerCase()}
              </div>
              <div className="row-why">Muted from the notch with "Don&apos;t show these"</div>
            </div>
            <button
              className="btn"
              onClick={() =>
                void save({
                  muted: prefs.muted.filter((x) => !(x.lens === m.lens && x.kind === m.kind))
                })
              }
            >
              Unmute
            </button>
          </div>
        ))}
      </div>
      <p className="hint">
        Hide a single window from the notch with <b>Hide this window</b>.
      </p>
    </section>
  )
}

function RecallSection({
  prefs,
  save
}: {
  prefs: CopilotSettings
  save: (patch: Partial<CopilotSettings>) => Promise<void>
}): React.JSX.Element {
  const [cleared, setCleared] = useState(false)
  return (
    <section>
      <div className="section-head">
        <h2>Recall</h2>
        <span>Ask the notch to find something you saw: "the email about the DPA".</span>
      </div>
      <div className="list">
        <label className="row is-toggle">
          <div className="row-body">
            <div className="row-title">Remember what was on screen</div>
            <div className="row-why">
              Text only, never screenshots, kept on this Mac. Searched by keywords and meaning.
            </div>
          </div>
          <input
            type="checkbox"
            className="switch"
            checked={prefs.recall.enabled}
            onChange={(e) => void save({ recall: { ...prefs.recall, enabled: e.target.checked } })}
          />
        </label>
        <div className="row is-setting">
          <span className="setting-label">Keep for</span>
          <span className="row-body">
            <span className="segmented">
              {[3, 7, 14, 30].map((days) => (
                <button
                  key={days}
                  className={prefs.recall.days === days ? 'is-active' : ''}
                  onClick={() => void save({ recall: { ...prefs.recall, days } })}
                >
                  {days} days
                </button>
              ))}
            </span>
          </span>
          <button
            className="btn"
            disabled={cleared}
            onClick={() => {
              if (!window.confirm('Delete everything the copilot remembers seeing?')) return
              void request<void>('DELETE', '/copilot/recall').then(() => setCleared(true))
            }}
          >
            {cleared ? 'Cleared' : 'Clear history'}
          </button>
        </div>
      </div>
    </section>
  )
}

function LogSection(): React.JSX.Element {
  const [entries, setEntries] = useState<CopilotLogEntry[] | null>(null)
  const load = useCallback(() => {
    void request<{ entries: CopilotLogEntry[] }>('GET', '/copilot/log?limit=60').then((res) =>
      setEntries(res.ok ? res.data.entries : [])
    )
  }, [])
  useEffect(load, [load])

  return (
    <section>
      <div className="section-head">
        <h2>What Polly saw</h2>
        <span>Every window the copilot read since the server started, and what came of it.</span>
        <button className="icon-btn" title="Refresh" onClick={load}>
          <RefreshCw />
        </button>
      </div>
      <div className="list">
        {entries?.length === 0 && (
          <div className="row is-quiet">Nothing yet. Turn the copilot on and switch windows.</div>
        )}
        {entries?.map((e) => (
          <div key={e.id} className="row copilot-log">
            <div className="row-body">
              <div className="row-title">
                {e.app}
                {e.window ? ` · ${e.window}` : ''}
              </div>
              <div className="row-why">
                {shortTime(e.at)} · {e.trigger} · {e.sent.ax_chars + e.sent.ocr_chars} characters
                {e.sent.screenshot ? ' and a screenshot' : ''} · {e.outcome} · {e.ms} ms
              </div>
              {e.scene && <div className="row-why copilot-scene">{e.scene}</div>}
            </div>
          </div>
        ))}
      </div>
      {entries && entries.length > 0 && (
        <p className="hint">
          <button
            className="link"
            onClick={() => void request<void>('DELETE', '/copilot/log').then(load)}
          >
            Clear this list
          </button>
        </p>
      )}
    </section>
  )
}

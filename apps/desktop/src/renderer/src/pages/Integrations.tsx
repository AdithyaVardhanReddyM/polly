import { PageHead } from '../components/PageHead'

const INTEGRATIONS = [
  { name: 'GitHub', what: 'Repos, issues and pull requests' },
  { name: 'Gmail', what: 'Read, triage and draft email' },
  { name: 'Google Calendar', what: 'Events, availability and scheduling' },
  { name: 'Slack', what: 'Channels, threads and messages' },
  { name: 'Notion', what: 'Pages and databases' },
  { name: 'Linear', what: 'Issues, projects and cycles' },
  { name: 'Google Drive', what: 'Docs, sheets and files' },
  { name: 'Tavily', what: 'Web search and extraction' }
]

export function Integrations(): React.JSX.Element {
  return (
    <div className="page">
      <PageHead
        title="Integrations"
        subtitle="Connect your accounts once; give each agent only the ones it needs."
      />
      <div className="integration-grid">
        {INTEGRATIONS.map((i) => (
          <div key={i.name} className="integration">
            <span className="integration-logo">{i.name.charAt(0)}</span>
            <div className="row-body">
              <div className="row-title">{i.name}</div>
              <div className="row-why">{i.what}</div>
            </div>
            <button className="btn" disabled>
              Connect
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

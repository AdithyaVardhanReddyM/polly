interface Props {
  title: string
  subtitle?: string
  children?: React.ReactNode
}

export function PageHead({ title, subtitle, children }: Props): React.JSX.Element {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="subtitle">{subtitle}</p>}
      </div>
      {children}
    </header>
  )
}

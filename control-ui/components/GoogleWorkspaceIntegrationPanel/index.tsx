import { SettingsIntegrationsNav } from '@components/SettingsIntegrationsNav'

export function GoogleWorkspaceIntegrationPanel() {
  return (
    <div className="cu-settings-integrations">
      <SettingsIntegrationsNav activeSection="google" />
      <section className="cu-settings-section">
        <div className="cu-settings-coming-soon">
          <img src="/brand/google.svg" alt="" width={28} height={28} aria-hidden="true" />
          <div>
            <span className="cu-settings-section__title">Google Workspace</span>
            <p>Coming soon</p>
          </div>
        </div>
      </section>
    </div>
  )
}

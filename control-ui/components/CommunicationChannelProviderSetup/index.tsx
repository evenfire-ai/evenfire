'use client'

import React, { useEffect, useMemo, useState } from 'react'
import Image from 'next/image'
import { SelectionDropdown } from '@components/SelectionDropdown'
import { TeamsSetupPrerequisites } from '@components/TeamsSetupPrerequisites'
import { useToast } from '@components/Toast'
import { IconCopy } from '@components/icons'
import { Button, Field, TextInput } from '@components/ui'
import { SLACK_NEW_APP_URL } from '@constants/slack'
import { copyTextToClipboard } from '@lib/clipboard'
import {
  COMMUNICATION_CHANNEL_PROVIDERS,
  COMMUNICATION_CHANNEL_PROVIDER_OPTIONS,
  communicationChannelProviderServiceLabel,
} from '@lib/communicationChannelProviders'
import {
  slackWebhookUrlForChannelName,
  teamsWebhookPathForChannelName,
  teamsWebhookUrlForChannelName,
} from '@lib/communicationChannels'
import { canGenerateSlackAppManifest, slackAppManifest } from '@lib/slackAppManifest'
import { toKebabCase } from '@lib/string'
import {
  LOCAL_TEAMS_ENDPOINT_ORIGIN,
  TEAMS_APP_NAME_MAX_LENGTH,
  buildTeamsAppCreateCommand,
  buildTeamsPackageDownloadCommand,
  buildTeamsSupportsFilesCommand,
  canGenerateTeamsCommand,
  teamsAppNameError,
  teamsInstallUrl,
  teamsPlaceholderEndpoint,
} from '@lib/teamsSetup'
import type {
  ChannelProviderSetupProps,
  CommandBlockProps,
  ProviderDraft,
  ProviderPanelProps,
  RequestUrlFieldProps,
} from './types'

export function CommunicationChannelProviderSetup({
  channelName,
  activeProvider,
  draft,
  onChange,
  onProviderChange: handleProviderChange,
  saving,
  credentials,
  slackRequestUrlOverride,
  teamsRequestUrlOverride,
  showRequestUrls = false,
}: ChannelProviderSetupProps) {
  const { showToast } = useToast()
  const [canUseBrowserWebhookOrigin, setCanUseBrowserWebhookOrigin] = useState(false)
  function setDraft(update: (current: ProviderDraft) => ProviderDraft) {
    onChange(update(draft))
  }

  const normalizedChannelName = toKebabCase(channelName)
  const derivedTeamsWebhookUrl = useMemo(
    () =>
      normalizedChannelName
        ? canUseBrowserWebhookOrigin
          ? teamsWebhookUrlForChannelName(normalizedChannelName)
          : teamsWebhookPathForChannelName(normalizedChannelName)
        : null,
    [canUseBrowserWebhookOrigin, normalizedChannelName]
  )
  const teamsWebhookUrl =
    teamsRequestUrlOverride === undefined ? derivedTeamsWebhookUrl : teamsRequestUrlOverride
  // A relative endpoint would register a Teams bot pointing at a host that does
  // not exist, so a deployment with no public webhook origin falls back to
  // teamsAppCreatePlaceholderCommand below instead of a command built from
  // that relative path.
  const teamsAppCreateCommand = useMemo(() => {
    if (!teamsWebhookUrl || !canGenerateTeamsCommand(teamsWebhookUrl)) return null
    return buildTeamsAppCreateCommand({ botName: draft.teamsAppName, endpoint: teamsWebhookUrl })
  }, [draft.teamsAppName, teamsWebhookUrl])
  // The minikube case: no public origin to build a real command from. Still
  // render a runnable-looking command rather than nothing, using the marker
  // origin LOCAL_TEAMS_ENDPOINT_ORIGIN, because substituting a real origin by
  // hand for that marker is the documented self-hosted workflow.
  const teamsAppCreatePlaceholderCommand = useMemo(() => {
    if (!teamsWebhookUrl || canGenerateTeamsCommand(teamsWebhookUrl)) return null
    return buildTeamsAppCreateCommand({
      botName: draft.teamsAppName,
      endpoint: teamsPlaceholderEndpoint(teamsWebhookUrl),
    })
  }, [draft.teamsAppName, teamsWebhookUrl])
  // Substituted with CLIENT_ID once it is pasted, which on a teams-managed bot IS
  // the app id (the Teams App ID, Bot ID and CLIENT_ID are one UUID). Before that
  // it renders a named placeholder rather than an angle-bracket one, which sh and
  // zsh would treat as a redirect and fail on confusingly.
  const teamsSupportsFilesCommand = useMemo(
    () => buildTeamsSupportsFilesCommand(draft.teamsAppId),
    [draft.teamsAppId]
  )
  // Built from the two ids the operator has already pasted, so the deep link is
  // handed over without a CLI round trip. Null until both are real UUIDs.
  const teamsInstallLink = useMemo(
    () => teamsInstallUrl(draft.teamsAppId, draft.teamsTenantId),
    [draft.teamsAppId, draft.teamsTenantId]
  )
  const teamsPackageDownloadCommand = useMemo(
    () => buildTeamsPackageDownloadCommand(draft.teamsAppId),
    [draft.teamsAppId]
  )
  // Slack's order is manifest first, credentials second: the bot token only exists
  // after the app is installed, so a manifest offered only once the channel is saved
  // arrives after the step it describes. The Request URL encodes namespace and name
  // only, so it is derivable here — from the NORMALIZED name, which is what the save
  // will persist. Deriving it from the raw input would hand over a URL for a channel
  // that never exists, which is the failure this manifest was written to remove.
  const derivedSlackRequestUrl = useMemo(
    () =>
      normalizedChannelName && canUseBrowserWebhookOrigin
        ? slackWebhookUrlForChannelName(normalizedChannelName)
        : null,
    [canUseBrowserWebhookOrigin, normalizedChannelName]
  )
  const slackRequestUrl =
    slackRequestUrlOverride === undefined ? derivedSlackRequestUrl : slackRequestUrlOverride
  // No app name, no manifest: the name becomes display_information.name, and a
  // placeholder would install an app under a name the operator never chose.
  const slackManifest = useMemo(() => {
    const appName = draft.slackBotHandle.trim()
    if (!appName || !slackRequestUrl || !canGenerateSlackAppManifest(slackRequestUrl)) return null
    return slackAppManifest(appName, slackRequestUrl)
  }, [draft.slackBotHandle, slackRequestUrl])
  const teamsBotNameError = teamsAppNameError(draft.teamsAppName)

  useEffect(() => {
    setCanUseBrowserWebhookOrigin(true)
  }, [])

  async function copyTeamsAppCreateCommand() {
    if (!teamsAppCreateCommand) return
    const copied = await copyTextToClipboard(teamsAppCreateCommand)
    showToast(
      copied
        ? 'Teams bot command copied.'
        : 'Could not copy to clipboard. Select the command and copy it manually.',
      { tone: copied ? 'success' : 'error' }
    )
  }

  async function copyTeamsAppCreatePlaceholderCommand() {
    if (!teamsAppCreatePlaceholderCommand) return
    const copied = await copyTextToClipboard(teamsAppCreatePlaceholderCommand)
    showToast(
      copied
        ? 'Teams bot command copied.'
        : 'Could not copy to clipboard. Select the command and copy it manually.',
      { tone: copied ? 'success' : 'error' }
    )
  }

  async function copyTeamsSupportsFilesCommand() {
    const copied = await copyTextToClipboard(teamsSupportsFilesCommand)
    showToast(
      copied
        ? 'Teams file support command copied.'
        : 'Could not copy to clipboard. Select the command and copy it manually.',
      { tone: copied ? 'success' : 'error' }
    )
  }

  async function copyTeamsPackageDownloadCommand() {
    const copied = await copyTextToClipboard(teamsPackageDownloadCommand)
    showToast(
      copied
        ? 'Teams package download command copied.'
        : 'Could not copy to clipboard. Select the command and copy it manually.',
      { tone: copied ? 'success' : 'error' }
    )
  }

  async function copySlackAppManifest() {
    if (!slackManifest) return
    const copied = await copyTextToClipboard(slackManifest)
    showToast(
      copied
        ? 'Slack app manifest copied.'
        : 'Could not copy to clipboard. Select the manifest and copy it manually.',
      { tone: copied ? 'success' : 'error' }
    )
  }

  return (
    <div className="cu-form-stack cu-agent-form-stack--wide">
      <Field htmlFor="ch-provider" label="Provider" required>
        <SelectionDropdown
          id="ch-provider"
          ariaLabel="Communication channel provider"
          multiple={false}
          searchable={false}
          value={[activeProvider]}
          disabled={saving}
          placeholder="Select a provider"
          onChange={next => {
            const provider = COMMUNICATION_CHANNEL_PROVIDERS.find(value => value === next[0])
            if (provider) handleProviderChange(provider)
          }}
          options={COMMUNICATION_CHANNEL_PROVIDER_OPTIONS.map(option => ({
            ...option,
            icon: (
              <Image
                src={`/brand/${option.value}.svg`}
                alt=""
                width={16}
                height={16}
                aria-hidden="true"
              />
            ),
          }))}
        />
      </Field>

      {activeProvider === 'telegram' ? (
        <ProviderPanel
          provider="telegram"
          checked={draft.telegramReplyOnlyWhenMentioned}
          disabled={saving}
          onCheckedChange={checked =>
            setDraft(current => ({
              ...current,
              telegramReplyOnlyWhenMentioned: checked,
            }))
          }
        >
          <Field
            description="Public bot username, with or without the leading @."
            htmlFor="telegram-bot-handle"
            label={
              <>
                Telegram bot handle{' '}
                <span
                  className="cu-help-tooltip"
                  tabIndex={0}
                  aria-label="We use this handle to show users which Telegram bot to message when connecting their account or a group."
                  data-tooltip="We use this handle to show users which Telegram bot to message when connecting their account or a group."
                >
                  ?
                </span>
              </>
            }
            required
          >
            <TextInput
              id="telegram-bot-handle"
              value={draft.telegramBotHandle}
              onChange={event =>
                setDraft(current => ({
                  ...current,
                  telegramBotHandle: event.target.value,
                }))
              }
              placeholder="@your_bot"
              disabled={saving}
              autoComplete="off"
            />
          </Field>
          {credentials}
        </ProviderPanel>
      ) : activeProvider === 'slack' ? (
        <ProviderPanel
          provider="slack"
          description="Install your Slack app in the workspace, then paste the Signing Secret and Bot User OAuth token. The workspace is detected when a user verifies a Slack conversation."
          checked={draft.slackReplyOnlyWhenMentioned}
          disabled={saving}
          onCheckedChange={checked =>
            setDraft(current => ({
              ...current,
              slackReplyOnlyWhenMentioned: checked,
            }))
          }
          replyInThreads={draft.slackReplyInThreads}
          onReplyInThreadsChange={checked =>
            setDraft(current => ({
              ...current,
              slackReplyInThreads: checked,
            }))
          }
        >
          <Field
            description="Shown to users so they know which Slack App to message."
            htmlFor="slack-bot-handle"
            label={
              <>
                Slack App Name{' '}
                <span
                  className="cu-help-tooltip"
                  tabIndex={0}
                  aria-label="We use this name to show users which Slack App to message"
                  data-tooltip="We use this name to show users which Slack App to message"
                >
                  ?
                </span>
              </>
            }
            required
          >
            <TextInput
              id="slack-bot-handle"
              value={draft.slackBotHandle}
              onChange={event =>
                onChange({ ...draft, slackBotHandle: event.target.value }, 'slackBotHandle')
              }
              placeholder="Your Slack App"
              disabled={saving}
              autoComplete="off"
            />
          </Field>
          {showRequestUrls ? (
            <RequestUrlField provider="Slack" url={slackRequestUrl} saving={saving} />
          ) : null}
          {slackManifest ? (
            <div className="cu-field">
              <span className="cu-field__label">Slack App Manifest</span>
              <div className="cu-command-block">
                <div className="cu-command-block__toolbar">
                  <span>YAML</span>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="cu-command-block__copy"
                    onClick={copySlackAppManifest}
                    disabled={saving}
                    aria-label="Copy Slack app manifest"
                  >
                    <IconCopy width={15} height={15} />
                    Copy
                  </Button>
                </div>
                <pre className="cu-command-block__pre cu-slack-manifest__pre">
                  <code>{slackManifest}</code>
                </pre>
              </div>
              <span className="cu-field__hint">
                Copy this, then{' '}
                <a className="cu-link" href={SLACK_NEW_APP_URL} target="_blank" rel="noreferrer">
                  create your Slack app
                </a>{' '}
                — choose <strong>From an app manifest</strong>, pick the workspace, and paste. It
                sets the scopes, the events, and both Request URLs, so the app is ready before you
                come back here for the token below. Opens in a new tab so this form keeps what you
                have typed.
              </span>
              <span className="cu-field__hint">
                The Request URLs point at <code>{normalizedChannelName}</code>.
              </span>
            </div>
          ) : draft.slackBotHandle.trim() &&
            normalizedChannelName &&
            (!showRequestUrls || slackRequestUrl) ? (
            // Named and ready, but no absolute URL resolved: a manifest with a
            // relative request_url is invalid to Slack. Say so rather than render
            // nothing -- the operator is following a guide that promises a manifest
            // here, and silence gives them no cause to chase.
            <div className="cu-banner cu-banner--warning">
              No app manifest: this deployment has no public webhook address, so the Request URL
              would be a path Slack cannot reach. Expose the webhook proxy publicly and set
              NEXT_PUBLIC_WORKFLOW_APPROVAL_READER_BASE_URL to that address, then reload this page.
            </div>
          ) : null}
          {credentials}
        </ProviderPanel>
      ) : (
        <>
          <section className="cu-channel-provider-panel">
            <TeamsSetupPrerequisites inline />
          </section>

          <section className="cu-channel-provider-panel">
            <div>
              <p className="cu-section-title">Create the Teams bot</p>
              <p className="cu-muted">
                Run the Teams CLI command, then copy the generated bot values into this channel.
              </p>
            </div>
            <Field
              description={`Display name for the bot, up to ${TEAMS_APP_NAME_MAX_LENGTH} characters. Spaces and capitals are fine.`}
              htmlFor="teams-app-name"
              label="Name"
              required
            >
              <TextInput
                id="teams-app-name"
                value={draft.teamsAppName}
                onChange={event =>
                  onChange({ ...draft, teamsAppName: event.target.value }, 'teamsAppName')
                }
                placeholder="Evenfire Bot"
                disabled={saving}
                autoComplete="off"
                invalid={Boolean(draft.teamsAppName) && Boolean(teamsBotNameError)}
              />
            </Field>
            <Field htmlFor="teams-reply-behavior" label="Reply behavior">
              <SelectionDropdown
                id="teams-reply-behavior"
                ariaLabel="Reply behavior"
                multiple={false}
                searchable={false}
                disabled={saving}
                placeholder="Select reply behavior"
                value={[draft.teamsReplyOnlyWhenMentioned ? 'mentions' : 'all']}
                options={[
                  { value: 'mentions', label: 'Only when mentioned' },
                  { value: 'all', label: 'All messages' },
                ]}
                onChange={next => {
                  if (!next[0]) return
                  setDraft(current => ({
                    ...current,
                    teamsReplyOnlyWhenMentioned: next[0] === 'mentions',
                  }))
                }}
              />
            </Field>
            {/*
                            Each step that has a command carries it directly, rather than
                            the list narrating three steps and the commands landing after
                            it: "run this" has to sit next to the thing it means, and step
                            3's command is a different one from step 1's.
                          */}
            {showRequestUrls ? (
              <RequestUrlField provider="Teams" url={teamsWebhookUrl} saving={saving} />
            ) : null}
            <ol className="cu-teams-setup__instructions">
              <li>
                Run this from any directory. The command writes CLIENT_ID, TENANT_ID and
                CLIENT_SECRET into .env in whichever directory you run it from.
                {teamsAppCreateCommand ? (
                  <CommandBlock
                    command={teamsAppCreateCommand}
                    onCopy={copyTeamsAppCreateCommand}
                    copyDisabled={saving || Boolean(teamsBotNameError)}
                    copyLabel="Copy Teams bot create command"
                  />
                ) : teamsWebhookUrl ? (
                  <>
                    <div className="cu-banner cu-banner--warning">
                      This deployment has no public webhook origin. The command below uses the
                      placeholder origin <code>{LOCAL_TEAMS_ENDPOINT_ORIGIN}</code>, which must be
                      replaced before running it, or set{' '}
                      <code>NEXT_PUBLIC_WORKFLOW_APPROVAL_READER_BASE_URL</code> to have it filled
                      in automatically.
                    </div>
                    {teamsAppCreatePlaceholderCommand && (
                      <CommandBlock
                        command={teamsAppCreatePlaceholderCommand}
                        onCopy={copyTeamsAppCreatePlaceholderCommand}
                        copyDisabled={saving || Boolean(teamsBotNameError)}
                        copyLabel="Copy Teams bot create command"
                      />
                    )}
                  </>
                ) : null}
              </li>
              <li>
                To deliver workflow files, enable them on the manifest{' '}
                <strong>before you install the app in Teams</strong>. An installed app keeps the
                manifest it was installed with, so doing this afterwards means reinstalling. The{' '}
                <code>--yes</code> is required; without it the command changes nothing and still
                looks like it worked. File delivery works in a direct chat only, not in a channel.
                The app id is the CLIENT_ID from <code>.env</code>, so pasting it below fills this
                command in.
                <CommandBlock
                  command={teamsSupportsFilesCommand}
                  onCopy={copyTeamsSupportsFilesCommand}
                  copyDisabled={saving}
                  copyLabel="Copy Teams file support command"
                />
              </li>
              <li>Paste CLIENT_ID, TENANT_ID, and CLIENT_SECRET below.</li>
              <li>
                Install the app in Teams, picking the channel during install rather than adding it
                afterwards.
                {teamsInstallLink ? (
                  <>
                    <a
                      className="cu-btn cu-btn--sm cu-teams-setup__install"
                      href={teamsInstallLink}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Install in Teams
                    </a>
                    <p className="cu-teams-setup__install-note">
                      A newly created app is not in the Teams catalog yet, so this link may say the
                      app cannot be found. That is expected, not a broken setup, and re-running the
                      create command would leave you with two bots. The wait is open ended, so to
                      install now, upload the package instead.
                    </p>
                    <details className="cu-advanced-details cu-teams-setup__fallback">
                      <summary>Install now by uploading the package</summary>
                      <p className="cu-advanced-details__hint">
                        This sideloads the app without waiting on the catalog. Run the command, then
                        in Teams choose Apps &gt; Manage your apps &gt; Upload an app &gt; Upload a
                        custom app, and pick the channel during install.
                      </p>
                      <CommandBlock
                        command={teamsPackageDownloadCommand}
                        onCopy={copyTeamsPackageDownloadCommand}
                        copyDisabled={saving}
                        copyLabel="Copy Teams package download command"
                      />
                    </details>
                  </>
                ) : (
                  <span className="cu-teams-setup__pending">
                    The install link appears here once CLIENT_ID and TENANT_ID are filled in,
                    because it is built from exactly those two values.
                  </span>
                )}
              </li>
            </ol>
          </section>
          <section className="cu-channel-provider-panel">
            <p className="cu-section-title">Bot credentials</p>
            <Field
              description="CLIENT_ID from the generated .env file."
              htmlFor="teams-app-id"
              label="CLIENT_ID"
              required
            >
              <TextInput
                id="teams-app-id"
                value={draft.teamsAppId}
                onChange={event =>
                  setDraft(current => ({
                    ...current,
                    teamsAppId: event.target.value,
                  }))
                }
                placeholder="00000000-0000-0000-0000-000000000000"
                disabled={saving}
                autoComplete="off"
              />
            </Field>
            <Field
              description="TENANT_ID from the generated .env file."
              htmlFor="teams-tenant-id"
              label="TENANT_ID"
              required
            >
              <TextInput
                id="teams-tenant-id"
                value={draft.teamsTenantId}
                onChange={event =>
                  setDraft(current => ({
                    ...current,
                    teamsTenantId: event.target.value,
                  }))
                }
                placeholder="00000000-0000-0000-0000-000000000000"
                disabled={saving}
                autoComplete="off"
              />
            </Field>
            {credentials}
          </section>
        </>
      )}
    </div>
  )
}

function CommandBlock({ command, copyDisabled, copyLabel, onCopy }: CommandBlockProps) {
  return (
    <div className="cu-command-block">
      <div className="cu-command-block__toolbar">
        <span>Bash</span>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="cu-command-block__copy"
          onClick={onCopy}
          disabled={copyDisabled}
          aria-label={copyLabel}
        >
          <IconCopy width={15} height={15} />
          Copy
        </Button>
      </div>
      <pre className="cu-command-block__pre">
        <code>{command}</code>
      </pre>
    </div>
  )
}

function ProviderPanel({
  checked,
  children,
  disabled,
  onCheckedChange,
  onReplyInThreadsChange,
  provider,
  replyInThreads,
  description,
}: ProviderPanelProps) {
  return (
    <section className="cu-channel-provider-panel">
      <div className="cu-channel-provider-panel__head">
        <div>
          <p className="cu-section-title">{communicationChannelProviderServiceLabel(provider)}</p>
          <p className="cu-muted">
            {description || 'Add credentials and default bot behavior for confirmed conversations.'}
          </p>
        </div>
      </div>
      <Field htmlFor={`${provider}-reply-behavior`} label="Reply behavior">
        <SelectionDropdown
          id={`${provider}-reply-behavior`}
          ariaLabel={`${provider === 'slack' ? 'Slack' : 'Telegram'} reply behavior`}
          multiple={false}
          searchable={false}
          disabled={disabled}
          placeholder="Select reply behavior"
          value={[checked ? 'mentions' : 'all']}
          options={[
            { value: 'mentions', label: 'Only when mentioned' },
            { value: 'all', label: 'All messages' },
          ]}
          onChange={next => {
            if (next[0]) onCheckedChange(next[0] === 'mentions')
          }}
        />
      </Field>
      {provider === 'slack' ? (
        <>
          {checked ? (
            <p className="cu-field__hint">
              Replies inside a thread still require a mention: even in a thread the app started, a
              follow-up that does not mention the app is ignored.
            </p>
          ) : null}
          <Field
            htmlFor="slack-reply-location"
            label={
              <>
                Reply location{' '}
                <span
                  className="cu-help-tooltip"
                  tabIndex={0}
                  aria-label="When enabled, app responses are posted in a Slack thread and follow-up messages in that thread continue there. New top-level messages start a new thread."
                  data-tooltip="When enabled, app responses are posted in a Slack thread and follow-up messages in that thread continue there. New top-level messages start a new thread."
                >
                  ?
                </span>
              </>
            }
          >
            <SelectionDropdown
              id="slack-reply-location"
              ariaLabel="Slack reply location"
              multiple={false}
              searchable={false}
              disabled={disabled}
              placeholder="Select reply location"
              value={[replyInThreads ? 'threads' : 'conversation']}
              options={[
                { value: 'threads', label: 'In threads' },
                { value: 'conversation', label: 'In the conversation' },
              ]}
              onChange={next => {
                if (next[0]) onReplyInThreadsChange?.(next[0] === 'threads')
              }}
            />
          </Field>
        </>
      ) : null}
      {children}
    </section>
  )
}

function RequestUrlField({ provider, url, saving }: RequestUrlFieldProps) {
  const { showToast } = useToast()
  return (
    <div className="cu-field">
      <span className="cu-field__label">{provider} Request URL</span>
      <div className="cu-copy-field">
        <div className="cu-readonly-field cu-copy-field__value">
          {url ||
            (provider === 'Slack'
              ? 'Available once this channel has a Slack App Name'
              : 'Unavailable')}
        </div>
        <Button
          type="button"
          disabled={!url || saving}
          onClick={async () => {
            if (!url) return
            const copied = await copyTextToClipboard(url)
            showToast(
              copied
                ? `${provider} Request URL copied.`
                : 'Could not copy to clipboard. Select the URL and copy it manually.',
              { tone: copied ? 'success' : 'error' }
            )
          }}
        >
          Copy
        </Button>
      </div>
      <span className="cu-field__hint">
        {url
          ? provider === 'Teams' && !canGenerateTeamsCommand(url)
            ? 'This is a path, not a full URL. Prefix it with your public webhook origin before using it as the Messaging endpoint.'
            : `Use this URL ${provider === 'Slack' ? 'for Slack Event Subscriptions and Interactivity.' : 'as the Messaging endpoint for the Teams bot app.'}`
          : provider === 'Slack'
            ? 'Enter the Slack App Name above and this channel gets its Request URL and app manifest.'
            : 'Enter the Name above and this channel gets its Teams Request URL.'}
      </span>
    </div>
  )
}

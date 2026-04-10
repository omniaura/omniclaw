import { Title } from '@solidjs/meta';
import { query, createAsync } from '@solidjs/router';
import { ErrorBoundary, Show } from 'solid-js';

import Badge from '~/components/shared/Badge';
import {
  BooleanRow,
  MetricCard,
  MetricRow,
} from '~/components/shared/MetricCard';
import { api } from '~/lib/api';
import ErrorFallback from '~/components/shared/ErrorFallback';
import PageLoading from '~/components/shared/PageLoading';

const fetchSettings = query(() => api.getSettings(), 'settings');

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  return `${Math.round(hours * 10) / 10}h`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${Math.round(mb * 10) / 10} MB`;
}

export default function Settings() {
  const settings = createAsync(() => fetchSettings());

  return (
    <>
      <Title>OmniClaw — Settings</Title>
      <div class="p-6">
        <div class="flex items-center gap-3 mb-6">
          <h2 class="text-text-bright text-lg font-medium">settings</h2>
          <Badge variant="default">read-only</Badge>
        </div>

        <ErrorBoundary
          fallback={(err, reset) => (
            <ErrorFallback error={err} reset={reset} context="Settings" />
          )}
        >
          <Show
            when={settings()}
            fallback={<PageLoading label="Loading settings..." />}
          >
            {(s) => (
              <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <MetricCard title="general">
                  <MetricRow label="timezone" value={s().general.timezone} />
                  <MetricRow
                    label="model override"
                    value={s().general.anthropicModel ?? 'default'}
                  />
                  <MetricRow
                    label="local runtime"
                    value={s().general.localRuntime}
                  />
                </MetricCard>

                <MetricCard title="web ui">
                  <MetricRow
                    label="port"
                    value={
                      s().webUi.port != null
                        ? String(s().webUi.port)
                        : 'disabled'
                    }
                  />
                  <MetricRow label="hostname" value={s().webUi.hostname} />
                  <BooleanRow label="auth" value={s().webUi.authEnabled} />
                  <MetricRow
                    label="cors origin"
                    value={s().webUi.corsOrigin ?? 'disabled'}
                  />
                </MetricCard>

                <MetricCard title="containers">
                  <MetricRow label="image" value={s().containers.image} />
                  <MetricRow label="memory" value={s().containers.memory} />
                  <MetricRow
                    label="timeout"
                    value={formatMs(s().containers.timeoutMs)}
                  />
                  <MetricRow
                    label="startup timeout"
                    value={formatMs(s().containers.startupTimeoutMs)}
                  />
                  <MetricRow
                    label="idle timeout"
                    value={formatMs(s().containers.idleTimeoutMs)}
                  />
                  <MetricRow
                    label="max output"
                    value={formatBytes(s().containers.maxOutputSize)}
                  />
                  <MetricRow
                    label="max active"
                    value={String(s().containers.maxActive)}
                  />
                  <MetricRow
                    label="max idle"
                    value={String(s().containers.maxIdle)}
                  />
                  <MetricRow
                    label="max task"
                    value={String(s().containers.maxTask)}
                  />
                </MetricCard>

                <MetricCard title="channels">
                  <MetricRow
                    label="discord bots"
                    value={String(s().channels.discordBots)}
                  />
                  <Show when={s().channels.discordBotIds.length > 0}>
                    <MetricRow
                      label="discord bot ids"
                      value={s().channels.discordBotIds.join(', ')}
                    />
                  </Show>
                  <Show when={s().channels.discordDefaultBot}>
                    {(bot) => (
                      <MetricRow label="discord default" value={bot()} />
                    )}
                  </Show>
                  <MetricRow
                    label="telegram bots"
                    value={String(s().channels.telegramBots)}
                  />
                  <MetricRow
                    label="slack bots"
                    value={String(s().channels.slackBots)}
                  />
                  <Show when={s().channels.slackDefaultBot}>
                    {(bot) => <MetricRow label="slack default" value={bot()} />}
                  </Show>
                </MetricCard>

                <MetricCard title="scheduling">
                  <MetricRow
                    label="session max age"
                    value={formatMs(s().scheduling.sessionMaxAgeMs)}
                  />
                  <BooleanRow
                    label="persistent state"
                    value={s().scheduling.persistentTaskState}
                    onLabel="on"
                    offLabel="off"
                  />
                  <MetricRow
                    label="poll interval"
                    value={formatMs(s().scheduling.pollIntervalMs)}
                  />
                </MetricCard>

                <MetricCard title="roster">
                  <MetricRow label="scope" value={s().roster.scope} />
                  <MetricRow
                    label="role filters"
                    value={
                      s().roster.roleFilters.length > 0
                        ? s().roster.roleFilters.join(', ')
                        : 'none'
                    }
                  />
                  <MetricRow
                    label="cache ttl"
                    value={formatMs(s().roster.cacheTtlMs)}
                  />
                  <MetricRow
                    label="refresh interval"
                    value={formatMs(s().roster.refreshIntervalMs)}
                  />
                </MetricCard>

                <MetricCard title="discovery">
                  <BooleanRow
                    label="enabled"
                    value={s().discovery.enabled}
                    onLabel="yes"
                    offLabel="no"
                  />
                  <MetricRow
                    label="instance name"
                    value={s().discovery.instanceName}
                  />
                  <BooleanRow
                    label="trust lan admin"
                    value={s().discovery.trustLanAdmin}
                    onLabel="yes"
                    offLabel="no"
                  />
                </MetricCard>

                <MetricCard title="github">
                  <MetricRow
                    label="webhook port"
                    value={
                      s().github.webhookPort > 0
                        ? String(s().github.webhookPort)
                        : 'disabled'
                    }
                  />
                  <MetricRow
                    label="webhook path"
                    value={s().github.webhookPath}
                  />
                  <BooleanRow
                    label="webhook secret"
                    value={s().github.secretConfigured}
                    onLabel="configured"
                    offLabel="not set"
                  />
                </MetricCard>

                <MetricCard title="paths">
                  <MetricRow label="store" value={s().paths.store} />
                  <MetricRow label="groups" value={s().paths.groups} />
                  <MetricRow label="data" value={s().paths.data} />
                </MetricCard>
              </div>
            )}
          </Show>
        </ErrorBoundary>
      </div>
    </>
  );
}

import { expect, test } from 'vitest'
import { statusOf, unitNames } from '../src/services.ts'

test('unit names from commands and unit file paths', () => {
  const text = [
    'npx tsc && systemctl --user restart speech-endpoint && systemctl --user is-active speech-endpoint',
    'systemctl --user enable --now blog-web.service blog-refresh.timer',
    "systemd-run --user --unit=feed-sync --on-active=30s node sync.js",
    'cat > ~/.config/systemd/user/backup-relay.service <<EOF',
  ].join('\n')
  expect([...unitNames(text)].sort()).toEqual(['backup-relay', 'blog-refresh', 'blog-web', 'feed-sync', 'speech-endpoint'])
})

test('status from systemd states', () => {
  expect(statusOf({ ActiveState: 'active', SubState: 'running' })).toBe('running')
  expect(statusOf({ ActiveState: 'active', SubState: 'waiting' })).toBe('waiting')
  expect(statusOf({ ActiveState: 'activating', SubState: 'auto-restart' })).toBe('restarting')
  expect(statusOf({ ActiveState: 'failed', SubState: 'failed' })).toBe('failed')
  expect(statusOf({ ActiveState: 'inactive', SubState: 'dead' })).toBe('stopped')
})

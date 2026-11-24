#!/usr/bin/env node
// A stand-in for `systemctl --user` in tests: units live in $FAKE_SYSTEMCTL_STATE (JSON).
import fs from 'node:fs'
const file = process.env.FAKE_SYSTEMCTL_STATE
const state = JSON.parse(fs.readFileSync(file, 'utf8'))
const args = process.argv.slice(2).filter((a) => a !== '--user' && a !== '--no-pager' && a !== '--all')
const [cmd, ...rest] = args
const save = () => fs.writeFileSync(file, JSON.stringify(state))
if (cmd === '--version') console.log('systemd 255 (fake)')
else if (cmd === 'list-units') console.log(JSON.stringify(state.units.map((u) => ({ unit: u.Id, load: 'loaded', active: u.ActiveState, sub: u.SubState, description: u.Description }))))
else if (cmd === 'list-timers') console.log(JSON.stringify(state.units.filter((u) => u.Id.endsWith('.timer')).map((u) => ({ unit: u.Id, next: u.next ?? null, activates: u.Triggers }))))
else if (cmd === 'show') console.log(state.units.filter((u) => rest.includes(u.Id)).map((u) => Object.entries(u).filter(([k]) => k !== 'next').map(([k, v]) => `${k}=${v}`).join('\n')).join('\n\n'))
else if (['start', 'stop', 'restart'].includes(cmd)) {
  const u = state.units.find((x) => x.Id === rest[0])
  if (!u) process.exit(5)
  Object.assign(u, cmd === 'stop' ? { ActiveState: 'inactive', SubState: 'dead', MainPID: 0, InactiveEnterTimestamp: new Date().toISOString() } : { ActiveState: 'active', SubState: 'running', MainPID: 4242 + Math.floor(Math.random() * 100), ActiveEnterTimestamp: new Date(Date.now() + 1000).toISOString() })
  save()
} else process.exit(1)

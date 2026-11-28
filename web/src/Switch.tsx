// The settings switch. Kept apart from SettingsKit so menus can use it without the store.
// `decorative`: only its look, inside a row that is itself the control (a sheet row).
export function Switch({ label, checked, disabled, onChange, decorative }: { label: string; checked: boolean; disabled?: boolean; onChange?: (on: boolean) => void; decorative?: boolean }) {
  if (decorative) return <i className={`settings-switch${checked ? ' on' : ''}`} aria-hidden="true" />
  return <button type="button" className={`settings-switch${checked ? ' on' : ''}`} role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange?.(!checked)} />
}

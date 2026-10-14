/** Small line icons for navigation (24px grid, drawn to match the ARC mark). */
const P = {
  overview: 'M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-3H4zM14 7h6V4h-6z',
  alerts: 'M6 17V11a6 6 0 1 1 12 0v6l1.5 2h-15zM10 21h4',
  team: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c.8-3.4 3.4-5.5 6.5-5.5s5.7 2.1 6.5 5.5M16 4.5a3.5 3.5 0 0 1 0 6.5M18 14.8c1.8.7 3 2.6 3.5 5.2',
  integrations: 'M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0zM12 16v5',
  firmware: 'M12 3v11M7.5 9.5 12 14l4.5-4.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3',
  usage: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  rejected: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM5.6 5.6l12.8 12.8',
  audit: 'M7 3h8l4 4v14H7zM15 3v4h4M10 12h6M10 16h6',
  admin: 'M12 3l8 3v6c0 4.5-3.3 8.3-8 9-4.7-.7-8-4.5-8-9V6zM9 12l2 2 4-4',
  channel: 'M3 12h3l2-5 4 10 2-5h7',
} as const;

export type IconName = keyof typeof P;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="icon">
      <path d={P[name]} />
    </svg>
  );
}

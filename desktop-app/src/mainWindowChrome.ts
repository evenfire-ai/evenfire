export function mainWindowRoundedCorners(platform: NodeJS.Platform = process.platform): boolean {
  // Electron 43 rounds frameless Linux windows by default; the app paints
  // square custom chrome to every edge, so only Linux opts out of that default.
  return platform !== 'linux'
}

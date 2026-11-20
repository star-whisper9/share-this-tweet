/** Desktop site mode changes the page UA, not the browser's actual platform. */
export async function isAndroidPlatform(): Promise<boolean> {
  return (await browser.runtime.getPlatformInfo()).os === 'android';
}

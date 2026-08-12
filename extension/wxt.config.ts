import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: '.',
  outDir: 'dist',
  manifest: {
    name: 'TabBell',
    description:
      'Watch anything on any page — hidden Apply buttons, prices, pipelines — and get pinged the moment it changes.',
    permissions: [
      'tabs',
      'storage',
      'notifications',
      'alarms',
      'contextMenus',
      'scripting',
      'offscreen',
    ],
    host_permissions: ['<all_urls>'],
    action: {
      default_title: 'TabBell — watch this page',
    },
    commands: {
      'watch-tab': {
        // Alt maps to Option on macOS; identical binding works on all OSes,
        // but declare mac explicitly so Chrome shows the right glyphs.
        suggested_key: { default: 'Alt+Shift+B', mac: 'Alt+Shift+B' },
        description: 'TabBell: watch the current tab',
      },
      'snip-element': {
        suggested_key: { default: 'Alt+Shift+S', mac: 'Alt+Shift+S' },
        description: 'TabBell: snip an area to watch',
      },
    },
  },
});
